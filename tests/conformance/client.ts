import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createOmpFixtureExecutable } from './fixtures/launcher'
import { type AdapterInfo, CONFORMANCE_CAPABILITIES, CONFORMANCE_PROTOCOL_VERSION, type ConformanceCapability, type ConformanceErrorPayload, type ConformanceResponse } from './protocol'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_ADAPTER_PATH = join(PROJECT_ROOT, 'out', 'conformance', 'node-adapter.mjs')
const BUILD_ADAPTER_SCRIPT = join(PROJECT_ROOT, 'scripts', 'conformance', 'build-node-adapter.mjs')
const MAX_STDERR_BYTES = 16 * 1024

function splitCommandLine(command: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false
  for (const ch of command.trim()) {
    if (escaping) {
      current += ch
      escaping = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaping = true
      continue
    }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? null : ch
      continue
    }
    if (!quote && /\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (quote) throw new Error(`Unterminated quote in OMP_CONFORMANCE_ADAPTER_CMD: ${command}`)
  if (current.length > 0) args.push(current)
  if (args.length === 0) throw new Error('OMP_CONFORMANCE_ADAPTER_CMD cannot be empty')
  return args
}

function resolveAdapterCommand(): { command: string; args: string[] } {
  const rawArgv = process.env.OMP_CONFORMANCE_ADAPTER_ARGV?.trim()
  if (rawArgv) {
    const parsed: unknown = JSON.parse(rawArgv)
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string' || !item)) {
      throw new Error('OMP_CONFORMANCE_ADAPTER_ARGV must be a non-empty JSON array of strings')
    }
    return { command: parsed[0], args: parsed.slice(1) }
  }
  const rawCmd = process.env.OMP_CONFORMANCE_ADAPTER_CMD?.trim()
  if (rawCmd) {
    const parts = splitCommandLine(rawCmd)
    return { command: parts[0], args: parts.slice(1) }
  }
  if (!existsSync(DEFAULT_ADAPTER_PATH)) {
    const built = spawnSync(process.execPath, [BUILD_ADAPTER_SCRIPT], { cwd: PROJECT_ROOT, encoding: 'utf8' })
    if (built.status !== 0) {
      throw new Error(`Failed to build reference node conformance adapter: ${built.stdout}\n${built.stderr}`)
    }
  }
  return { command: process.execPath, args: [DEFAULT_ADAPTER_PATH] }
}

export class ConformanceClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`)
    this.name = 'ConformanceClientError'
  }
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class ConformanceClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly rl: Interface
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private closed = false
  private stderrTail = ''
  private cachedInfo: AdapterInfo | null = null

  private constructor(command: string, args: string[]) {
    this.child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail += chunk
      if (Buffer.byteLength(this.stderrTail, 'utf8') > MAX_STDERR_BYTES) {
        this.stderrTail = this.stderrTail.slice(-MAX_STDERR_BYTES)
      }
    })
    this.rl = createInterface({ input: this.child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
    this.rl.on('line', (line) => this.handleLine(line))
    this.child.on('error', (error) => this.failAll(`Adapter spawn error: ${error.message}`))
    this.child.on('close', (code, signal) => {
      if (!this.closed) {
        this.failAll(`Adapter exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'})`)
      }
    })
  }

  static async launch(): Promise<ConformanceClient> {
    const { command, args } = resolveAdapterCommand()
    const client = new ConformanceClient(command, args)
    const info = await client.info()
    if (info.protocolVersion !== CONFORMANCE_PROTOCOL_VERSION) {
      await client.close()
      throw new Error(`Expected protocolVersion ${CONFORMANCE_PROTOCOL_VERSION}, received ${info.protocolVersion}`)
    }
    for (const capability of requiredCapabilities()) {
      if (!(CONFORMANCE_CAPABILITIES as readonly string[]).includes(capability)) {
        await client.close()
        throw new Error(`OMP_CONFORMANCE_REQUIRED_CAPABILITIES names an unknown capability: ${capability}`)
      }
      if (!info.capabilities.includes(capability)) {
        await client.close()
        throw new Error(`Adapter ${info.implementation} is missing required conformance capability: ${capability}`)
      }
    }
    if (process.env.OMP_CONFORMANCE_INFO_FILE) {
      writeFileSync(process.env.OMP_CONFORMANCE_INFO_FILE, `${JSON.stringify({ ...info, requiredCapabilities: requiredCapabilities() }, null, 2)}\n`, 'utf8')
    }
    return client
  }

  async info(): Promise<AdapterInfo> {
    if (!this.cachedInfo) {
      this.cachedInfo = await this.call<AdapterInfo>('adapter.info')
    }
    return this.cachedInfo
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    if (this.closed) throw new Error(`Conformance client already closed before calling ${method}`)
    const id = this.nextId++
    return new Promise<T>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectCall(new Error(`Conformance call ${method} (id=${id}) timed out after ${timeoutMs}ms${this.formattedStderr()}`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, {
        method,
        resolve: (value) => resolveCall(value as T),
        reject: rejectCall,
        timer,
      })
      const payload = `${JSON.stringify({ id, method, params })}\n`
      this.child.stdin.write(payload, 'utf8', (error) => {
        if (error) {
          const entry = this.pending.get(id)
          if (entry) {
            clearTimeout(entry.timer)
            this.pending.delete(id)
            entry.reject(new Error(`Failed writing ${method} to adapter stdin: ${error.message}`))
          }
        }
      })
    })
  }

  async callExpectError(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<ConformanceErrorPayload> {
    try {
      const result = await this.call(method, params, timeoutMs)
      throw new Error(`Expected ${method} to fail, but it succeeded with: ${JSON.stringify(result)}`)
    } catch (error) {
      if (error instanceof ConformanceClientError) {
        return { code: error.code, message: error.message.replace(/^\[[^\]]+\]\s*/, '') }
      }
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    try {
      await this.call('workspace.shutdown', {}, 3_000).catch(() => undefined)
    } finally {
      this.closed = true
      this.failAll('Conformance client closed')
      this.rl.close()
      try {
        this.child.stdin.end()
      } catch {}
      if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/T', '/F', '/PID', String(this.child.pid)], { stdio: 'ignore', windowsHide: true })
        } else {
          this.child.kill('SIGTERM')
          await new Promise<void>((resolveWait) => {
            const timer = setTimeout(() => {
              if (this.child.exitCode === null) {
                try {
                  this.child.kill('SIGKILL')
                } catch {}
              }
              resolveWait()
            }, 1_000)
            timer.unref()
            this.child.once('close', () => {
              clearTimeout(timer)
              resolveWait()
            })
          })
        }
      }
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let parsed: ConformanceResponse
    try {
      parsed = JSON.parse(line) as ConformanceResponse
    } catch {
      this.failAll(`Adapter emitted malformed JSONL on stdout: ${line.slice(0, 300)}`)
      return
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'number') return
    const pending = this.pending.get(parsed.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(parsed.id)
    if (parsed.ok) {
      pending.resolve(parsed.result)
    } else {
      pending.reject(new ConformanceClientError(parsed.error?.code || 'Error', parsed.error?.message || `Method ${pending.method} failed`))
    }
  }

  private failAll(reason: string): void {
    const suffix = this.formattedStderr()
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(new Error(`${reason} while waiting for ${pending.method}${suffix}`))
    }
  }

  private formattedStderr(): string {
    const trimmed = this.stderrTail.trim()
    return trimmed ? `\n--- adapter stderr ---\n${trimmed}` : ''
  }
}

export interface ConformanceSandbox {
  rootDir: string
  homeDir: string
  userDataDir: string
  appDataDir: string
  fixtureBinDir: string
  ompExecutable: string
  cleanup: () => void
}

export function createConformanceSandbox(prefix = 'omp-conformance-'): ConformanceSandbox {
  const rawRoot = mkdtempSync(join(tmpdir(), prefix))
  const rootDir = realpathSync(rawRoot)
  const homeDir = join(rootDir, 'home')
  const userDataDir = join(rootDir, 'user-data')
  const appDataDir = join(rootDir, 'app-data')
  const fixtureBinDir = join(rootDir, 'bin')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(appDataDir, { recursive: true })
  const ompExecutable = createOmpFixtureExecutable(fixtureBinDir)
  return {
    rootDir,
    homeDir,
    userDataDir,
    appDataDir,
    fixtureBinDir,
    ompExecutable,
    cleanup: () => {
      rmSync(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
}

export function requiredCapabilities(): string[] {
  return (process.env.OMP_CONFORMANCE_REQUIRED_CAPABILITIES ?? '')
    .split(',')
    .map((capability) => capability.trim())
    .filter((capability) => capability.length > 0)
}

/**
 * Partial mode may skip capabilities outside the required set, but never one
 * named in OMP_CONFORMANCE_REQUIRED_CAPABILITIES: a phase gate must not be
 * satisfiable by silently skipping its own required capability.
 */
export function requireCapability(info: AdapterInfo, capability: ConformanceCapability): boolean {
  if (info.capabilities.includes(capability)) return true
  if (requiredCapabilities().includes(capability)) {
    throw new Error(`Adapter ${info.implementation} is missing required conformance capability: ${capability}`)
  }
  if (process.env.OMP_CONFORMANCE_PARTIAL === '1') return false
  throw new Error(`Adapter ${info.implementation} is missing required conformance capability: ${capability}`)
}
