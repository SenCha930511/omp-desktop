#!/usr/bin/env node
/**
 * Partial real-OMP RPC protocol verification (phase 7 parity tool).
 *
 * Spawns a real `omp` binary in RPC mode inside an isolated temporary HOME
 * and validates the narrow protocol surface OMP Desktop depends on: the
 * ready frame, protocol negotiation (v2, including base64 rpc_chunk frames),
 * new_session with a physical empty session file, set_session_name, fork
 * identity semantics (source and fork both remain), the empty Stop queue
 * contract of abort_and_restore_queue, and a clean exit on stdin close.
 *
 * This is a PARTIAL protocol check only. It never sends a model prompt and
 * never reads live user sessions or credentials, so it demonstrates nothing
 * about GUI/TUI rendering parity or model-output equivalence.
 *
 * Usage:
 *   node scripts/verify-omp-parity.mjs --omp /opt/homebrew/bin/omp \
 *     [--expected-version 18.13.1] [--timeout-ms 120000]
 *
 * Output: one PASS/FAIL line per case on stderr, then a machine-readable,
 * sanitized JSON summary on stdout. Exit code 0 only when every case passed.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const PARITY_FIXTURE_API_KEY = 'parity-fixture-not-a-real-key'

/** The only variables inherited from the ambient environment. */
const ENV_ALLOWLIST = ['PATH', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'TERM']
const MODEL_SELECTOR = 'openai/gpt-4.1'
/** Same per-frame read bound as the desktop RPC runtime. */
const LINE_LIMIT_BYTES = 16 * 1024 * 1024
const MAX_CHUNK_COUNT = 4096
const MAX_CONCURRENT_CHUNKS = 4
const CHUNK_TOTAL_LIMIT_BYTES = 16 * 1024 * 1024
const CHUNK_INACTIVITY_MS = 30_000
const DIAGNOSTIC_LIMIT_CHARS = 600
const VERSION_OUTPUT_LIMIT_CHARS = 4096
const DEFAULT_OVERALL_TIMEOUT_MS = 120_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const READY_TIMEOUT_MS = 30_000
const EXIT_TIMEOUT_MS = 15_000
const VERSION_QUERY_TIMEOUT_MS = 20_000

export const PARITY_NOTES = [
  'Partial verification only: the listed RPC protocol cases ran against the real CLI binary in an isolated temporary HOME.',
  'No model prompt or inference command was sent. Network isolation was not verified, and no model-output or GUI/TUI rendering equivalence was tested.',
  'No credentials or live user sessions were read or copied; the child environment carried only the allowlisted PATH/TMPDIR/SHELL/LANG/LC_ALL/TERM plus a dummy API key fixture.',
]

const USAGE = `Usage: node scripts/verify-omp-parity.mjs --omp <absolute-path-to-omp> [--expected-version <version>] [--timeout-ms <milliseconds>]

  --omp <path>             Required. Absolute path to the real omp executable (never launched through a shell).
  --expected-version <ver> Optional. Fail the version case when omp --version reports a different version.
  --timeout-ms <ms>        Optional. Overall deadline (default ${DEFAULT_OVERALL_TIMEOUT_MS}).

Prints a sanitized JSON summary to stdout; per-case PASS/FAIL progress goes to stderr.
`

/** Collapses and redacts diagnostics so no secret or oversized payload can leak into the summary. */
export function sanitizeDiagnostic(value) {
  let text = String(value ?? '')
  text = text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[-_]?key|token|secret|password|authorization)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > DIAGNOSTIC_LIMIT_CHARS) {
    text = `${text.slice(0, DIAGNOSTIC_LIMIT_CHARS)}…[truncated ${text.length - DIAGNOSTIC_LIMIT_CHARS} chars]`
  }
  return text
}

/** Fresh environment: isolated HOME, dummy key fixture, and nothing else from the ambient process. */
export function buildIsolatedEnv(homeDir) {
  const env = { HOME: homeDir, OPENAI_API_KEY: PARITY_FIXTURE_API_KEY }
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/** The fixed, prompt-free RPC argv used for every parity run. */
export function buildRpcArgs(workspace, sessionsDir) {
  return [
    '--mode', 'rpc',
    '--model', MODEL_SELECTOR,
    '--cwd', workspace,
    '--session-dir', sessionsDir,
    '--no-extensions',
    '--no-skills',
    '--no-rules',
    '--no-context-files',
    '--no-lsp',
    '--no-title',
  ]
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Splits a stream into newline-delimited frames, failing fast when a frame exceeds the bound instead of buffering forever. */
export class BoundedLineReader {
  constructor(stream, { limitBytes = LINE_LIMIT_BYTES, onLine, onFatal }) {
    this.stream = stream
    this.limitBytes = limitBytes
    this.onLine = onLine
    this.onFatal = onFatal
    this.buffer = Buffer.alloc(0)
    this.failed = false
    stream.on('data', (chunk) => this.consume(chunk))
    stream.on('error', (error) => {
      if (this.failed) return
      this.failed = true
      onFatal(error)
    })
  }

  consume(chunk) {
    if (this.failed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    let newlineIndex = this.buffer.indexOf(0x0a)
    while (newlineIndex >= 0) {
      const line = this.buffer.subarray(0, newlineIndex).toString('utf8')
      this.buffer = this.buffer.subarray(newlineIndex + 1)
      newlineIndex = this.buffer.indexOf(0x0a)
      if (line.trim().length > 0) this.onLine(line)
    }
    if (this.buffer.length > this.limitBytes) {
      this.failed = true
      this.buffer = Buffer.alloc(0)
      this.stream.destroy()
      this.onFatal(new Error(`frame exceeded ${this.limitBytes} bytes without a newline`))
    }
  }
}

/** Reassembles v2 base64 rpc_chunk sequences with the same bounds as the desktop runtime. */
export class ChunkReassembler {
  constructor({ maxCount = MAX_CHUNK_COUNT, maxConcurrent = MAX_CONCURRENT_CHUNKS, maxTotalBytes = CHUNK_TOTAL_LIMIT_BYTES, inactivityMs = CHUNK_INACTIVITY_MS, now = () => Date.now() } = {}) {
    this.maxCount = maxCount
    this.maxConcurrent = maxConcurrent
    this.maxTotalBytes = maxTotalBytes
    this.inactivityMs = inactivityMs
    this.now = now
    this.assemblies = new Map()
  }

  /**
   * Feeds one rpc_chunk frame. Returns the decoded frame once its sequence
   * completes, null while it is still partial, and throws on malformed or
   * bound-violating sequences (the partial sequence is dropped safely).
   */
  accept(frame) {
    if (typeof frame !== 'object' || frame === null) throw new Error('chunked frame was not an object')
    const chunkId = frame.chunkId
    if (typeof chunkId !== 'string' || chunkId.length === 0 || chunkId.length > 128) throw new Error('chunked frame carried an invalid chunkId')
    const index = frame.index
    const count = frame.count
    if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(count) || count < 1 || count > this.maxCount || typeof frame.data !== 'string') {
      throw new Error('chunked frame carried invalid sequencing')
    }
    this.expireIdle()
    let assembly = this.assemblies.get(chunkId)
    if (assembly === undefined) {
      if (index !== 0) throw new Error('chunk indices arrived out of order')
      if (this.assemblies.size >= this.maxConcurrent) throw new Error('too many concurrent chunk reassemblies')
      assembly = { count, nextIndex: 0, bytes: 0, parts: [], expiresAt: 0 }
      this.assemblies.set(chunkId, assembly)
    } else if (index !== assembly.nextIndex || count !== assembly.count) {
      this.assemblies.delete(chunkId)
      throw new Error('chunk indices arrived out of order')
    }
    if (frame.data.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(frame.data)) {
      this.assemblies.delete(chunkId)
      throw new Error('chunk data was not valid base64')
    }
    const decoded = Buffer.from(frame.data, 'base64')
    if (frame.byteLength !== undefined && frame.byteLength !== decoded.length) {
      this.assemblies.delete(chunkId)
      throw new Error('chunk byteLength did not match its data')
    }
    if (assembly.bytes + decoded.length > this.maxTotalBytes) {
      this.assemblies.delete(chunkId)
      throw new Error('chunked frame exceeded the maximum frame size')
    }
    assembly.bytes += decoded.length
    assembly.parts.push(decoded)
    assembly.nextIndex += 1
    if (decoded.length > 0) assembly.expiresAt = this.now() + this.inactivityMs
    if (assembly.nextIndex < assembly.count) return null
    this.assemblies.delete(chunkId)
    let value
    try {
      value = JSON.parse(Buffer.concat(assembly.parts).toString('utf8'))
    } catch {
      throw new Error('reassembled chunked frame was not valid JSON')
    }
    return value
  }

  expireIdle() {
    const current = this.now()
    for (const [chunkId, assembly] of this.assemblies) {
      if (assembly.expiresAt > 0 && assembly.expiresAt < current) this.assemblies.delete(chunkId)
    }
  }
}

/** Owns one spawned omp RPC child: framed reads, chunk reassembly, requests, and teardown. */
export class OmpRpcClient {
  constructor({ executable, args, cwd, env, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, remainingTime = () => Number.POSITIVE_INFINITY }) {
    this.requestTimeoutMs = requestTimeoutMs
    this.remainingTime = remainingTime
    this.pending = new Map()
    this.readyFrame = null
    this.transportError = null
    this.transportNotes = []
    this.chunkedFramesReassembled = 0
    this.chunkErrors = []
    this.exitInfo = null
    this.detached = process.platform !== 'win32'
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
    this.child = spawn(executable, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: this.detached, windowsHide: true })
    new BoundedLineReader(this.child.stdout, {
      onLine: (line) => this.handleLine(line),
      onFatal: (error) => this.failTransport(error),
    })
    // Drain stderr without retaining arbitrary provider diagnostics or credentials.
    this.child.stderr.on('data', () => undefined)
    this.child.stderr.on('error', () => undefined)
    // EPIPE while tearing down a child that already exited is expected, never fatal here.
    this.child.stdin.on('error', () => undefined)
    this.child.once('error', (error) => this.failTransport(error))
    this.child.once('close', (code, signal) => {
      this.exitInfo = { code, signal }
      this.resolveClosed(this.exitInfo)
      this.failAllRequests(new Error(`RPC process exited (${code ?? signal ?? 'unknown'})`))
      if (this.readyFrame === null) this.rejectReady(new Error(`RPC process exited before the ready frame (${code ?? signal ?? 'unknown'})`))
    })
    this.reassembler = new ChunkReassembler()
  }

  handleLine(line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      this.note('omp emitted a stdout line that was not valid JSON')
      return
    }
    if (frame?.type === 'rpc_chunk') {
      let value = null
      try {
        value = this.reassembler.accept(frame)
      } catch (error) {
        this.recordChunkError(error)
        return
      }
      if (value === null) return
      this.chunkedFramesReassembled += 1
      this.dispatchFrame(value)
      return
    }
    this.dispatchFrame(frame)
  }

  dispatchFrame(frame) {
    if (typeof frame !== 'object' || frame === null || typeof frame.type !== 'string') return
    if (frame.type === 'ready') {
      if (this.readyFrame === null) {
        this.readyFrame = frame
        this.resolveReady(frame)
      }
      return
    }
    if (frame.type === 'response' && typeof frame.id === 'string') {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return // late or orphaned response: consume silently
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.command !== pending.command) {
        pending.reject(new Error(`omp returned a mismatched response for ${pending.command}`))
        return
      }
      pending.resolve(frame)
      return
    }
    // Unsolicited event frames (available_commands_update, ...) are ignored.
  }

  request(command) {
    const commandType = String(command.type)
    if (this.transportError !== null) return Promise.reject(new Error(`RPC transport failed: ${this.transportError}`))
    if (!this.child.stdin.writable) return Promise.reject(new Error('RPC stdin is no longer writable'))
    const id = randomUUID()
    const timeoutMs = Math.max(250, Math.min(this.requestTimeoutMs, this.remainingTime()))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC command ${commandType} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { command: commandType, timer, resolve, reject })
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  async waitForReady() {
    const timeoutMs = Math.max(250, Math.min(READY_TIMEOUT_MS, this.remainingTime()))
    await Promise.race([this.readyPromise, delay(timeoutMs).then(() => { throw new Error(`ready frame was not received within ${timeoutMs} ms`) })])
    return this.readyFrame
  }

  async endInputAndWaitForExit() {
    const timeoutMs = Math.max(250, Math.min(EXIT_TIMEOUT_MS, this.remainingTime()))
    this.child.stdin.end()
    return await Promise.race([this.closed, delay(timeoutMs).then(() => { throw new Error(`RPC process did not exit within ${timeoutMs} ms after stdin close`) })])
  }

  failTransport(error) {
    if (this.transportError !== null) return
    this.transportError = sanitizeDiagnostic(error instanceof Error ? error.message : String(error))
    this.child.stdout.pause()
    this.failAllRequests(new Error(`RPC transport failed: ${this.transportError}`))
    if (this.readyFrame === null) this.rejectReady(new Error(`RPC transport failed: ${this.transportError}`))
  }

  failAllRequests(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  note(message) {
    if (this.transportNotes.length < 16) this.transportNotes.push(sanitizeDiagnostic(message))
  }

  recordChunkError(error) {
    if (this.chunkErrors.length < 16) this.chunkErrors.push(sanitizeDiagnostic(error instanceof Error ? error.message : String(error)))
  }

  settle(waitMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), waitMs)
      timer.unref?.()
      void this.closed.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  signalGroup(signal) {
    const pid = this.child.pid
    if (pid === undefined) return
    try {
      if (this.detached) process.kill(-pid, signal)
      else this.child.kill(signal)
    } catch {
      // The child already exited; the close event settles the wait.
    }
  }

  /** Guaranteed teardown: graceful stdin close, then a SIGTERM/SIGKILL ladder for the whole process group. */
  async dispose(cleanup) {
    if (this.exitInfo !== null) {
      cleanup.exit = 'already-exited'
      return
    }
    try {
      this.child.stdin.end()
    } catch {
      // stdin may already be closed after a transport failure.
    }
    if (await this.settle(750)) {
      cleanup.exit = 'stdin-close'
    } else {
      this.signalGroup('SIGTERM')
      if (await this.settle(2000)) {
        cleanup.exit = 'sigterm'
      } else {
        this.signalGroup('SIGKILL')
        cleanup.exit = (await this.settle(1500)) ? 'sigkill' : 'still-running'
      }
    }
    cleanup.stillRunning = this.exitInfo === null
  }
}

async function queryOmpVersion(executable, env, cwd, timeoutMs) {
  const detached = process.platform !== 'win32'
  const child = spawn(executable, ['--version'], { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'ignore'], detached, windowsHide: true })
  let output = ''
  let spawnFailed = false
  let outputFailed = false
  let exitInfo = null
  child.once('error', () => { spawnFailed = true })
  child.stdout.on('error', () => { outputFailed = true })
  child.stdout.on('data', (chunk) => {
    if (output.length < VERSION_OUTPUT_LIMIT_CHARS) output += chunk.toString('utf8').slice(0, VERSION_OUTPUT_LIMIT_CHARS - output.length)
  })
  const closed = /** @type {Promise<void>} */ (new Promise((resolve) => child.once('close', (code, signal) => {
    exitInfo = { code, signal }
    resolve()
  })))
  const waitForClose = (waitMs) => {
    if (exitInfo !== null) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), waitMs)
      timer.unref?.()
      void closed.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }
  let timedOut = false
  try {
    timedOut = !(await waitForClose(timeoutMs))
  } finally {
    // The command deadline excludes this bounded shutdown grace. A resistant
    // executable must not survive merely because it ignored the first signal.
    for (const [signal, graceMs] of /** @type {Array<[NodeJS.Signals, number]>} */ ([['SIGTERM', 750], ['SIGKILL', 1500]])) {
      if (exitInfo !== null) break
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // The close event remains authoritative if the process already exited.
        }
      }
      if (await waitForClose(graceMs)) break
    }
  }
  const processStopped = exitInfo !== null
  if (!processStopped) return { ok: false, version: null, processStopped, detail: '--version process did not stop within the cleanup deadline' }
  if (spawnFailed) return { ok: false, version: null, processStopped, detail: '--version executable could not be spawned' }
  if (outputFailed) return { ok: false, version: null, processStopped, detail: '--version stdout transport failed' }
  if (timedOut) return { ok: false, version: null, processStopped, detail: `--version did not finish within ${timeoutMs} ms` }
  if (exitInfo.code !== 0) return { ok: false, version: null, processStopped, detail: '--version did not exit successfully' }
  const firstLine = output.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  const match = firstLine.match(/(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/)
  if (match === null || match[1].length > 80) return { ok: false, version: null, processStopped, detail: 'could not parse a bounded version identifier from --version output' }
  return { ok: true, version: match[1], processStopped, detail: `omp --version reported ${match[1]}` }
}

function assertSuccess(response) {
  if (response.success !== true) throw new Error('RPC command returned a failure response')
}

async function getState(client) {
  const response = await client.request({ type: 'get_state' })
  assertSuccess(response)
  const data = typeof response.data === 'object' && response.data !== null ? response.data : {}
  if (typeof data.sessionId !== 'string' || data.sessionId.length === 0) throw new Error('get_state did not report a sessionId')
  return { sessionId: data.sessionId, sessionFile: typeof data.sessionFile === 'string' && data.sessionFile.length > 0 ? data.sessionFile : null }
}

/**
 * @typedef {{ sessionId: string, sessionFile: string | null }} RpcStateSnapshot
 * @typedef {{ ready?: Record<string, unknown>, initial?: RpcStateSnapshot, source?: RpcStateSnapshot, sourceDigest?: string, fork?: RpcStateSnapshot }} RpcSuiteContext
 */

/** The ordered, prompt-free RPC parity cases. Each step either returns a detail string or throws. */
function rpcSuiteSteps(client) {
  return /** @type {Array<[string, (ctx: RpcSuiteContext) => Promise<string> | string]>} */ ([
    ['rpc-ready', async (ctx) => {
      const ready = await client.waitForReady()
      ctx.ready = ready
      return 'ready frame received'
    }],
    ['ready-protocol-versions', (ctx) => {
      const supported = Array.isArray(ctx.ready.supportedProtocolVersions) ? ctx.ready.supportedProtocolVersions : []
      if (!supported.includes(1) || !supported.includes(2)) throw new Error('ready did not advertise both protocol versions 1 and 2')
      return 'ready advertises protocol versions 1 and 2'
    }],
    ['negotiate-protocol-v2', async () => {
      const response = await client.request({ type: 'negotiate_protocol', protocolVersion: 2 })
      assertSuccess(response)
      return 'negotiate_protocol v2 accepted'
    }],
    ['initial-get-state', async (ctx) => {
      ctx.initial = await getState(client)
      return `initial get_state reports a session identity${ctx.initial.sessionFile ? ' with a session file' : ' without a session file yet'}`
    }],
    ['new-session', async () => {
      const response = await client.request({ type: 'new_session' })
      assertSuccess(response)
      const data = typeof response.data === 'object' && response.data !== null ? response.data : {}
      if (data.cancelled !== false) throw new Error('new_session returned an unexpected shape; expected { cancelled: false }')
      return 'new_session returned { cancelled: false }'
    }],
    ['new-session-file-empty', async (ctx) => {
      ctx.source = await getState(client)
      if (ctx.source.sessionFile === null) throw new Error('get_state reported no sessionFile after new_session')
      if (!existsSync(ctx.source.sessionFile)) throw new Error(`session file was not created at ${path.basename(ctx.source.sessionFile)}`)
      const content = readFileSync(ctx.source.sessionFile, 'utf8')
      const lines = content.split('\n').filter((line) => line.trim().length > 0)
      let metadataEntries = 0
      for (const line of lines) {
        let entry
        try {
          entry = JSON.parse(line)
        } catch {
          throw new Error(`session file line is not valid JSON (${path.basename(ctx.source.sessionFile)})`)
        }
        if (entry?.type === 'message' || (typeof entry?.role === 'string' && entry.role.length > 0)) {
          throw new Error(`fresh session file already contains message entries (${path.basename(ctx.source.sessionFile)})`)
        }
        metadataEntries += 1
      }
      return `physical session file ${path.basename(ctx.source.sessionFile)} exists with metadata only (${metadataEntries} entries, ${Buffer.byteLength(content)} bytes)`
    }],
    ['set-session-name', async () => {
      const response = await client.request({ type: 'set_session_name', name: 'OMP parity verification' })
      assertSuccess(response)
      return 'set_session_name accepted'
    }],
    ['fork', async (ctx) => {
      // Rename may legitimately change title metadata. Snapshot only after it
      // completes, immediately before fork, and never expose bytes or digest.
      try {
        ctx.sourceDigest = createHash('sha256').update(readFileSync(ctx.source.sessionFile)).digest('hex')
      } catch {
        throw new Error('could not read source session bytes before fork')
      }
      const response = await client.request({ type: 'fork' })
      assertSuccess(response)
      const data = typeof response.data === 'object' && response.data !== null ? response.data : {}
      if (data.cancelled !== false) throw new Error('fork returned an unexpected shape; expected { cancelled: false }')
      return 'fork returned { cancelled: false }'
    }],
    ['fork-identity-change', async (ctx) => {
      ctx.fork = await getState(client)
      if (ctx.fork.sessionId === ctx.source.sessionId || ctx.fork.sessionFile === ctx.source.sessionFile) {
        throw new Error('get_state still reports the pre-fork identity after fork')
      }
      return 'get_state moved to a distinct forked session identity'
    }],
    ['source-and-fork-files-remain', (ctx) => {
      if (!existsSync(ctx.source.sessionFile ?? '') || !existsSync(ctx.fork.sessionFile ?? '')) throw new Error('the source or forked session file disappeared')
      let sourceDigest
      try {
        sourceDigest = createHash('sha256').update(readFileSync(ctx.source.sessionFile)).digest('hex')
      } catch {
        throw new Error('could not read source session bytes after fork')
      }
      if (sourceDigest !== ctx.sourceDigest) throw new Error('fork changed source session bytes')
      return 'source and forked session files both remain on disk; source bytes are unchanged'
    }],
    ['abort-and-restore-queue', async () => {
      const response = await client.request({ type: 'abort_and_restore_queue' })
      assertSuccess(response)
      const data = typeof response.data === 'object' && response.data !== null ? response.data : {}
      if (!Array.isArray(data.steering) || !Array.isArray(data.followUp)) {
        throw new Error('abort_and_restore_queue returned an unexpected shape; expected { steering: [], followUp: [] }')
      }
      if (data.steering.length !== 0 || data.followUp.length !== 0) {
        throw new Error(`Stop queue was not empty (steering ${data.steering.length}, followUp ${data.followUp.length})`)
      }
      return 'abort_and_restore_queue returned empty steering and followUp queues'
    }],
    ['clean-exit', async () => {
      const exit = await client.endInputAndWaitForExit()
      if (exit.code !== 0) throw new Error(`omp exited with code ${String(exit.code)} after stdin close`)
      return 'omp exited 0 after a clean stdin close'
    }],
  ])
}

/**
 * Runs the partial parity verification against a real omp executable.
 * Returns a sanitized, machine-readable summary; never throws without first
 * cleaning up the subprocess and the temporary HOME.
 */
export async function runParityVerification(options = {}) {
  const ompPath = options.ompPath
  if (typeof ompPath !== 'string' || ompPath.length === 0) throw new TypeError('ompPath is required')
  if (!path.isAbsolute(ompPath)) throw new TypeError('ompPath must be an absolute executable path; the child is never launched through a shell')
  try {
    accessSync(ompPath, fsConstants.X_OK)
  } catch {
    throw new Error(`ompPath is not executable: ${ompPath}`)
  }
  const expectedVersion = typeof options.expectedVersion === 'string' && options.expectedVersion.length > 0 ? options.expectedVersion : null
  const overallTimeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_OVERALL_TIMEOUT_MS
  const requestTimeoutMs = typeof options.requestTimeoutMs === 'number' && Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0 ? options.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS
  const onCase = typeof options.onCase === 'function' ? options.onCase : null

  const cases = []
  const record = (name, ok, detail = '') => {
    const entry = { name, ok: ok === true, detail: sanitizeDiagnostic(detail) }
    cases.push(entry)
    onCase?.(entry)
  }

  const homeDir = mkdtempSync(path.join(tmpdir(), 'omp-parity-'))
  const workspace = path.join(homeDir, 'workspace')
  const sessionsDir = path.join(homeDir, 'sessions')
  const deadline = Date.now() + overallTimeoutMs
  const remainingTime = () => Math.max(0, deadline - Date.now())

  const cleanup = { exit: 'not-started', stillRunning: false, tempDirRemoved: false }
  let client = null
  let versionInfo = { ok: false, version: null, detail: 'not queried' }
  let rpcSuiteRun = false

  try {
    mkdirSync(workspace, { recursive: true })
    mkdirSync(sessionsDir, { recursive: true })
    const env = buildIsolatedEnv(homeDir)
    versionInfo = await queryOmpVersion(ompPath, env, workspace, Math.min(VERSION_QUERY_TIMEOUT_MS, Math.max(1000, remainingTime())))
    if (!versionInfo.processStopped) {
      cleanup.stillRunning = true
      cleanup.exit = 'version-still-running'
    }
    if (!versionInfo.ok) {
      record('version', false, versionInfo.detail)
    } else {
      const matches = expectedVersion === null || versionInfo.version === expectedVersion
      record('version', matches, `${versionInfo.detail}${expectedVersion !== null ? `, expected ${expectedVersion}` : ''}`)
    }

    if (cases.every((entry) => entry.ok)) {
      rpcSuiteRun = true
      client = new OmpRpcClient({ executable: ompPath, args: buildRpcArgs(workspace, sessionsDir), cwd: workspace, env, requestTimeoutMs, remainingTime })
      const ctx = {}
      let failed = false
      for (const [name, step] of rpcSuiteSteps(client)) {
        if (failed) {
          record(name, false, 'skipped: an earlier case failed')
          continue
        }
        try {
          record(name, true, await step(ctx))
        } catch (error) {
          record(name, false, error instanceof Error ? error.message : String(error))
          failed = true
        }
      }
    }
  } finally {
    try {
      if (client !== null) await client.dispose(cleanup)
    } catch {
      cleanup.exit = 'cleanup-error'
      cleanup.stillRunning = true
    } finally {
      try {
        rmSync(homeDir, { recursive: true, force: true })
        cleanup.tempDirRemoved = !existsSync(homeDir)
      } catch {
        cleanup.tempDirRemoved = false
      }
    }
  }

  if (cleanup.stillRunning || !cleanup.tempDirRemoved) {
    record('cleanup', false, `subprocess stopped: ${!cleanup.stillRunning}; temporary HOME removed: ${cleanup.tempDirRemoved}`)
  }
  const ok = cases.length > 0 && cases.every((entry) => entry.ok) && cleanup.stillRunning === false && cleanup.tempDirRemoved === true
  return {
    tool: 'verify-omp-parity',
    ok,
    ompPath,
    model: MODEL_SELECTOR,
    version: versionInfo.version,
    expectedVersion,
    rpcSuiteRun,
    cases,
    transport: client === null ? null : {
      chunkedFramesReassembled: client.chunkedFramesReassembled,
      chunkErrors: client.chunkErrors,
      transportError: client.transportError,
      stderrTail: null, // Never serialize arbitrary stderr; redaction patterns cannot prove it contains no credentials.
    },
    cleanup,
    notes: PARITY_NOTES,
  }
}

function parsePositiveInt(text, flag) {
  const value = Number.parseInt(text, 10)
  if (!Number.isFinite(value) || value <= 0 || String(value) !== text.trim()) throw new Error(`${flag} expects a positive integer milliseconds value`)
  return value
}

export function parseArgs(argv) {
  const options = { ompPath: null, expectedVersion: null, timeoutMs: DEFAULT_OVERALL_TIMEOUT_MS, help: false }
  const requireValue = (index, flag) => {
    const value = argv[index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      return options
    }
    if (arg === '--omp') { index += 1; options.ompPath = requireValue(index, arg) }
    else if (arg === '--expected-version') { index += 1; options.expectedVersion = requireValue(index, arg) }
    else if (arg === '--timeout-ms') { index += 1; options.timeoutMs = parsePositiveInt(requireValue(index, arg), arg) }
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (options.ompPath === null) throw new Error('--omp is required')
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }
  try {
    const summary = await runParityVerification({
      ...options,
      onCase: (entry) => process.stderr.write(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}\n`),
    })
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    process.exitCode = summary.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`verify-omp-parity failed: ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}\n`)
    process.exitCode = 1
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) void main()
