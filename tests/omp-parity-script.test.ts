import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  BoundedLineReader,
  ChunkReassembler,
  OmpRpcClient,
  PARITY_FIXTURE_API_KEY,
  PARITY_NOTES,
  buildIsolatedEnv,
  buildRpcArgs,
  parseArgs,
  runParityVerification,
  sanitizeDiagnostic,
} from '../scripts/verify-omp-parity.mjs'

interface ParityCase {
  name: string
  ok: boolean
  detail: string
}

interface ParitySummary {
  tool: string
  ok: boolean
  ompPath: string
  version: string | null
  expectedVersion: string | null
  rpcSuiteRun: boolean
  cases: ParityCase[]
  transport: { chunkedFramesReassembled: number; chunkErrors: string[]; transportError: string | null; stderrTail: string | null } | null
  cleanup: { exit: string; stillRunning: boolean; tempDirRemoved: boolean }
  notes: string[]
}

interface FakeOmpOptions {
  version?: string
  versionIgnoresSigterm?: boolean
  forkMutatesSource?: boolean
  sensitiveCommand?: 'negotiate_protocol' | 'new_session' | 'fork' | 'abort_and_restore_queue'
  /** happy speaks the full parity protocol; the others simulate lifecycle failures. */
  mode?: 'happy' | 'silent' | 'oversize' | 'corrupt-chunk'
  /** happy mode only: deliver get_state responses as v2 rpc_chunk sequences. */
  chunked?: boolean
}

const fakeDirs: string[] = []

function fakeOmp(options: FakeOmpOptions = {}): string {
  const version = options.version ?? '18.13.1'
  const mode = options.mode ?? 'happy'
  const chunked = options.chunked === true
  const dir = mkdtempSync(join(tmpdir(), 'omp-parity-test-'))
  fakeDirs.push(dir)
  const executable = join(dir, 'fake-omp')
  const source = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const args = process.argv.slice(2)',
    ...(options.versionIgnoresSigterm
      ? [
          "if (args[0] === '--version') {",
          "  fs.writeFileSync(process.argv[1] + '.version-pid', String(process.pid))",
          "  process.on('SIGTERM', () => {})",
          '  setInterval(() => {}, 1000)',
          '  return',
          '}',
        ]
      : [`if (args[0] === '--version') { process.stdout.write('omp/${version}\\n'); process.exit(0) }`]),
    ...(options.sensitiveCommand ? ["process.stderr.write('parity-private-sentinel-credential-material')"] : []),
    "process.stdout.on('error', () => process.exit(0))",
    "const sessionsDir = args[args.indexOf('--session-dir') + 1]",
    "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')",
    'const sendChunked = (value) => {',
    "  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64')",
    '  const pieces = []',
    '  for (let offset = 0; offset < encoded.length; offset += 32) pieces.push(encoded.slice(offset, offset + 32))',
    "  pieces.forEach((data, index) => send({ type: 'rpc_chunk', chunkId: 'parity-chunk', index, count: pieces.length, data, byteLength: Buffer.from(data, 'base64').length }))",
    '}',
    `const deliver = (value) => (${chunked ? 'sendChunked(value)' : 'send(value)'})`,
    "let sessionId = 'boot-session'",
    'let sessionFile = null',
    ...(mode === 'silent' ? [] : ["send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })"]),
    ...(mode === 'silent'
      ? [
          'process.stdin.resume()',
          'setInterval(() => {}, 1000)',
          "process.on('SIGTERM', () => process.exit(0))",
        ]
      : [
          "require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {",
          ...(mode === 'oversize'
            ? [
                "  process.stdout.write('x'.repeat(17 * 1024 * 1024))",
                '  return',
                '})',
                'setInterval(() => {}, 1000)',
                "process.on('SIGTERM', () => process.exit(0))",
              ]
            : [
                '  const command = JSON.parse(line)',
                '  const reply = (data) => (command.type === \'get_state\' ? deliver : send)({ id: command.id, type: \'response\', command: command.type, success: true, data })',
                ...(options.sensitiveCommand
                  ? [
                      `  if (command.type === ${JSON.stringify(options.sensitiveCommand)}) {`,
                      `    send({ id: command.id, type: 'response', command: command.type, success: ${options.sensitiveCommand !== 'negotiate_protocol'}, error: 'parity-private-sentinel-credential-material', data: { cancelled: 'parity-private-sentinel-credential-material', steering: 'parity-private-sentinel-credential-material' } })`,
                      '    return',
                      '  }',
                    ]
                  : []),
                ...(mode === 'corrupt-chunk'
                  ? [
                      "  if (command.type === 'get_state') {",
                      '    const encoded = Buffer.from(JSON.stringify({ id: command.id, type: \'response\', command: \'get_state\', success: true, data: { sessionId } })).toString(\'base64\')',
                      "    send({ type: 'rpc_chunk', chunkId: 'parity-chunk', index: 1, count: 2, data: encoded.slice(encoded.length - 4) })",
                      "    send({ type: 'rpc_chunk', chunkId: 'parity-chunk', index: 0, count: 2, data: encoded.slice(0, encoded.length - 4) })",
                      '    return',
                      '  }',
                    ]
                  : []),
                "  if (command.type === 'negotiate_protocol') { reply({ protocolVersion: 2 }); return }",
                "  if (command.type === 'get_state') { reply({ sessionId, ...(sessionFile ? { sessionFile } : {}) }); return }",
                "  if (command.type === 'new_session') { sessionFile = path.join(sessionsDir, 'new.jsonl'); fs.writeFileSync(sessionFile, ''); sessionId = 'new-session'; reply({ cancelled: false }); return }",
                "  if (command.type === 'set_session_name') { fs.appendFileSync(sessionFile, JSON.stringify({ type: 'title', title: command.name }) + '\\n'); reply({}); return }",
                ...(options.forkMutatesSource ? ["  if (command.type === 'fork') fs.appendFileSync(sessionFile, 'parity-source-mutation-sensitive-sentinel\\n')"] : []),
                "  if (command.type === 'fork') { const forkFile = path.join(sessionsDir, 'fork.jsonl'); fs.writeFileSync(forkFile, ''); sessionFile = forkFile; sessionId = 'fork-session'; reply({ cancelled: false }); return }",
                "  if (command.type === 'abort_and_restore_queue') { reply({ steering: [], followUp: [] }); return }",
                "  send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unknown command ' + command.type })",
                '})',
                "process.stdin.on('close', () => process.exit(0))",
              ]),
        ]),
  ].join('\n')
  writeFileSync(executable, `${source}\n`)
  chmodSync(executable, 0o755)
  return executable
}

afterAll(() => {
  for (const dir of fakeDirs) rmSync(dir, { recursive: true, force: true })
})

describe('verify-omp-parity diagnostics and argv helpers', () => {
  it('redacts key material and bounds diagnostics', () => {
    expect(sanitizeDiagnostic('leaked sk-abcdefghijklmnopqrstuvwxyz123456 now')).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
    expect(sanitizeDiagnostic('api_key=supersecretvalue')).toBe('api_key=[REDACTED]')
    expect(sanitizeDiagnostic('Bearer abc.def.ghi-jkl')).toBe('Bearer [REDACTED]')
    expect(sanitizeDiagnostic('line\nbreak\ttab')).toBe('line break tab')
    expect(sanitizeDiagnostic('x'.repeat(2000)).length).toBeLessThan(700)
    expect(sanitizeDiagnostic(null)).toBe('')
  })

  it('builds an isolated environment with only the allowlisted variables', () => {
    const env = buildIsolatedEnv('/tmp/parity-home')
    expect(env.HOME).toBe('/tmp/parity-home')
    expect(env.OPENAI_API_KEY).toBe(PARITY_FIXTURE_API_KEY)
    const allowed = new Set(['HOME', 'OPENAI_API_KEY', 'PATH', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'TERM'])
    for (const key of Object.keys(env)) expect(allowed.has(key)).toBe(true)
  })

  it('builds the fixed prompt-free RPC argv', () => {
    expect(buildRpcArgs('/w', '/s')).toEqual([
      '--mode', 'rpc',
      '--model', 'openai/gpt-4.1',
      '--cwd', '/w',
      '--session-dir', '/s',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--no-context-files',
      '--no-lsp',
      '--no-title',
    ])
  })

  it('parses CLI arguments strictly', () => {
    expect(parseArgs(['--omp', '/usr/local/bin/omp'])).toEqual({ ompPath: '/usr/local/bin/omp', expectedVersion: null, timeoutMs: 120000, help: false })
    expect(parseArgs(['--omp', '/x', '--expected-version', '18.13.1', '--timeout-ms', '5000'])).toEqual({ ompPath: '/x', expectedVersion: '18.13.1', timeoutMs: 5000, help: false })
    expect(parseArgs(['--help']).help).toBe(true)
    expect(() => parseArgs([])).toThrow('--omp is required')
    expect(() => parseArgs(['--omp'])).toThrow('requires a value')
    expect(() => parseArgs(['--omp', '/x', '--timeout-ms', 'abc'])).toThrow('positive integer')
    expect(() => parseArgs(['--omp', '/x', '--nope'])).toThrow('Unknown argument')
  })

  it('requires an absolute executable path that exists', async () => {
    await expect(runParityVerification({ ompPath: 'omp' })).rejects.toThrow('absolute')
    await expect(runParityVerification({ ompPath: '/nonexistent/path/to/omp' })).rejects.toThrow('not executable')
  })
})

describe('verify-omp-parity frame parsers', () => {
  it('splits newline-delimited frames and fails when a frame exceeds the bound', async () => {
    const lines: string[] = []
    const fatals: Error[] = []
    const stream = new PassThrough()
    new BoundedLineReader(stream, { limitBytes: 16, onLine: (line: string) => lines.push(line), onFatal: (error: Error) => fatals.push(error) })
    stream.write('{"a":1}\n{"b":2}\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    stream.write('x'.repeat(20))
    await new Promise((resolve) => setImmediate(resolve))
    expect(fatals.map((error) => error.message)).toEqual(['frame exceeded 16 bytes without a newline'])
    stream.write('more data after the failure')
    await new Promise((resolve) => setImmediate(resolve))
    expect(fatals.length).toBe(1)
  })

  it('reassembles chunked frames in order and rejects malformed sequences safely', () => {
    const reassembler = new ChunkReassembler()
    const payload = { type: 'response', id: 'x', command: 'get_state', success: true, data: { sessionId: 's1' } }
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    const head = encoded.slice(0, encoded.length - 4)
    const tail = encoded.slice(encoded.length - 4)
    expect(reassembler.accept({ type: 'rpc_chunk', chunkId: 'a', index: 0, count: 2, data: head })).toBeNull()
    expect(reassembler.accept({ type: 'rpc_chunk', chunkId: 'a', index: 1, count: 2, data: tail })).toEqual(payload)
    expect(() => reassembler.accept({ type: 'rpc_chunk', chunkId: 'b', index: 3, count: 4, data: 'AAAA' })).toThrow('out of order')
    expect(() => reassembler.accept({ type: 'rpc_chunk', chunkId: 'c', index: 0, count: 1, data: '!!!!' })).toThrow('base64')
    expect(() => reassembler.accept({ type: 'rpc_chunk', chunkId: 'd', index: 0, count: 1, data: Buffer.from('not json').toString('base64') })).toThrow('not valid JSON')
  })
})

describe('verify-omp-parity against an injectable fake executable', () => {
  it('passes every protocol case and cleans up after a clean exit', async () => {
    const summary = (await runParityVerification({ ompPath: fakeOmp(), expectedVersion: '18.13.1', timeoutMs: 30000 })) as ParitySummary
    expect(summary.ok).toBe(true)
    expect(summary.version).toBe('18.13.1')
    expect(summary.rpcSuiteRun).toBe(true)
    expect(summary.cases.map((entry) => entry.name)).toEqual([
      'version',
      'rpc-ready',
      'ready-protocol-versions',
      'negotiate-protocol-v2',
      'initial-get-state',
      'new-session',
      'new-session-file-empty',
      'set-session-name',
      'fork',
      'fork-identity-change',
      'source-and-fork-files-remain',
      'abort-and-restore-queue',
      'clean-exit',
    ])
    expect(summary.cases.every((entry) => entry.ok)).toBe(true)
    expect(summary.transport?.chunkErrors).toEqual([])
    expect(summary.transport?.transportError).toBeNull()
    expect(summary.cleanup.exit).toBe('already-exited')
    expect(summary.cleanup.stillRunning).toBe(false)
    expect(summary.cleanup.tempDirRemoved).toBe(true)
    expect(summary.notes).toEqual(PARITY_NOTES)
    expect(summary.notes.some((note) => note.includes('GUI/TUI'))).toBe(true)
  }, 30000)

  it('fails the summary when cleanup reports a still-running child even after protocol cases passed', async () => {
    const originalDispose = OmpRpcClient.prototype.dispose
    const dispose = vi.spyOn(OmpRpcClient.prototype, 'dispose').mockImplementation(async function (this: OmpRpcClient, cleanup: ParitySummary['cleanup']) {
      // Actually dispose the fixture child before simulating a failed cleanup report.
      await originalDispose.call(this, cleanup)
      cleanup.exit = 'still-running'
      cleanup.stillRunning = true
    })
    try {
      const summary = (await runParityVerification({ ompPath: fakeOmp(), timeoutMs: 30000 })) as ParitySummary
      expect(summary.cases.filter((entry) => entry.name !== 'cleanup').every((entry) => entry.ok)).toBe(true)
      expect(summary.cleanup.stillRunning).toBe(true)
      expect(summary.cleanup.tempDirRemoved).toBe(true)
      expect(summary.ok).toBe(false)
      expect(summary.cases.find((entry) => entry.name === 'cleanup')?.ok).toBe(false)
    } finally {
      dispose.mockRestore()
    }
  }, 30000)

  it.each(['negotiate_protocol', 'new_session', 'fork', 'abort_and_restore_queue'] as const)('does not serialize arbitrary version/stderr or %s response payloads', async (sensitiveCommand) => {
    const sentinel = 'parity-private-sentinel-credential-material'
    const summary = (await runParityVerification({
      ompPath: fakeOmp({ version: `18.13.1 ${sentinel}`, sensitiveCommand }),
      expectedVersion: '18.13.1',
      timeoutMs: 30000,
    })) as ParitySummary
    expect(summary.ok).toBe(false)
    expect(summary.version).toBe('18.13.1')
    expect(JSON.stringify(summary)).not.toContain(sentinel)
    expect(summary.cleanup.stillRunning).toBe(false)
    expect(summary.cleanup.tempDirRemoved).toBe(true)
  }, 30000)

  it('reassembles v2 chunked get_state responses', async () => {
    const summary = (await runParityVerification({ ompPath: fakeOmp({ chunked: true }), timeoutMs: 30000 })) as ParitySummary
    expect(summary.ok).toBe(true)
    expect(summary.transport?.chunkedFramesReassembled).toBeGreaterThan(0)
    expect(summary.cleanup.tempDirRemoved).toBe(true)
  }, 30000)

  it('rejects a fork that changes source bytes while leaving both source and fork files present', async () => {
    const summary = (await runParityVerification({ ompPath: fakeOmp({ forkMutatesSource: true }), timeoutMs: 30000 })) as ParitySummary
    expect(summary.cases.find((entry) => entry.name === 'set-session-name')?.ok).toBe(true)
    expect(summary.cases.find((entry) => entry.name === 'fork')?.ok).toBe(true)
    expect(summary.cases.find((entry) => entry.name === 'fork-identity-change')?.ok).toBe(true)
    expect(summary.cases.find((entry) => entry.name === 'source-and-fork-files-remain')?.ok).toBe(false)
    expect(summary.ok).toBe(false)
    expect(JSON.stringify(summary)).not.toContain('parity-source-mutation-sensitive-sentinel')
    expect(summary.cleanup.stillRunning).toBe(false)
    expect(summary.cleanup.tempDirRemoved).toBe(true)
  }, 30000)

  it('fails safely on a version mismatch without running the RPC suite', async () => {
    const summary = (await runParityVerification({ ompPath: fakeOmp({ version: '9.9.9' }), expectedVersion: '18.13.1', timeoutMs: 30000 })) as ParitySummary
    expect(summary.ok).toBe(false)
    expect(summary.rpcSuiteRun).toBe(false)
    expect(summary.cases.find((entry) => entry.name === 'version')?.ok).toBe(false)
    expect(summary.cases.some((entry) => entry.name === 'rpc-ready')).toBe(false)
    expect(summary.cleanup.tempDirRemoved).toBe(true)
  }, 30000)

  it('handles a version executable spawn error without an uncaught child error', async () => {
    // Directories pass X_OK access checks but cannot be executed as an OMP binary.
    const summary = (await runParityVerification({ ompPath: dirname(fakeOmp()), timeoutMs: 1000 })) as ParitySummary
    expect(summary.ok).toBe(false)
    expect(summary.rpcSuiteRun).toBe(false)
    expect(summary.cases.find((entry) => entry.name === 'version')?.detail).toContain('could not be spawned')
    expect(summary.cleanup.stillRunning).toBe(false)
    expect(summary.cleanup.tempDirRemoved).toBe(true)
  }, 10000)

  it('kills a SIGTERM-resistant --version process after its bounded deadline', async () => {
    const executable = fakeOmp({ versionIgnoresSigterm: true })
    let pid: number | undefined
    try {
      const summary = (await runParityVerification({ ompPath: executable, timeoutMs: 1000 })) as ParitySummary
      pid = Number(readFileSync(`${executable}.version-pid`, 'utf8'))
      expect(Number.isSafeInteger(pid)).toBe(true)
      expect(summary.ok).toBe(false)
      expect(summary.rpcSuiteRun).toBe(false)
      expect(summary.cleanup.tempDirRemoved).toBe(true)
      let alive = false
      try {
        process.kill(pid, 0)
        alive = true
      } catch {
        // ESRCH is the expected result once the version process is reaped.
      }
      expect(alive).toBe(false)
    } finally {
      // Clean up even against the unfixed implementation so the regression cannot leak its resistant fixture.
      if (pid === undefined) {
        try {
          pid = Number(readFileSync(`${executable}.version-pid`, 'utf8'))
        } catch {
          // Spawn failed before the fixture could publish its pid.
        }
      }
      if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // Already reaped by the implementation under test.
        }
      }
    }
  }, 10000)

  it('times out a silent binary, kills the subprocess, and still removes the temporary HOME', async () => {
    const summary = (await runParityVerification({ ompPath: fakeOmp({ mode: 'silent' }), timeoutMs: 1500 })) as ParitySummary
    expect(summary.ok).toBe(false)
    expect(summary.cases.find((entry) => entry.name === 'rpc-ready')?.ok).toBe(false)
    expect(['sigterm', 'sigkill', 'stdin-close']).toContain(summary.cleanup.exit)
    expect(summary.cleanup.stillRunning).toBe(false)
    expect(summary.cleanup.tempDirRemoved).toBe(true)
  }, 30000)

  it('fails the transport when a frame exceeds the line bound instead of hanging', async () => {
    const summary = (await runParityVerification({ ompPath: fakeOmp({ mode: 'oversize' }), timeoutMs: 30000, requestTimeoutMs: 2000 })) as ParitySummary
    expect(summary.ok).toBe(false)
    expect(summary.transport?.transportError).toContain('exceeded')
    expect(summary.cleanup.stillRunning).toBe(false)
    expect(summary.cleanup.tempDirRemoved).toBe(true)
  }, 30000)

  it('rejects out-of-order chunked frames safely and fails the pending request by timeout', async () => {
    const summary = (await runParityVerification({ ompPath: fakeOmp({ mode: 'corrupt-chunk' }), timeoutMs: 15000, requestTimeoutMs: 600 })) as ParitySummary
    expect(summary.ok).toBe(false)
    expect(summary.transport?.chunkErrors.length ?? 0).toBeGreaterThan(0)
    expect(summary.cases.find((entry) => entry.name === 'negotiate-protocol-v2')?.ok).toBe(true)
    expect(summary.cases.find((entry) => entry.name === 'initial-get-state')?.ok).toBe(false)
    expect(summary.cases.find((entry) => entry.name === 'clean-exit')?.ok).toBe(false)
    expect(summary.cleanup.stillRunning).toBe(false)
    expect(summary.cleanup.tempDirRemoved).toBe(true)
  }, 30000)
})
