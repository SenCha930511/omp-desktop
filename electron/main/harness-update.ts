import type { HarnessUpdateState } from '../../src/types/api'
import { runProcess, type ProcessResult } from './process-utils'

/**
 * Drives `omp update` on behalf of the desktop shell.
 *
 * The omp CLI owns its own update path (npm registry metadata, brew/mise/bun/
 * npm/binary install routing), so this service only shells out: `omp update
 * --check` reports availability, `omp update` performs the install. Output
 * wording comes from omp's update-cli.ts; every unparsed or failing answer
 * maps to a silent state so a flaky registry can never nag the user.
 */

/** Wall-clock bound for one `omp update --check`; omp itself allows 30s for registry metadata. */
const DEFAULT_CHECK_TIMEOUT_MS = 45_000
/** `omp update` may download and verify a release binary; omp caps that at 15 minutes. */
const DEFAULT_INSTALL_TIMEOUT_MS = 20 * 60_000
const MAX_OUTPUT_BYTES = 64 * 1024

/** Injectable seam over runProcess so tests never spawn a real omp. */
export type HarnessUpdateRunner = (executable: string, args: readonly string[], options: { timeoutMs: number; maxBytes: number }) => Promise<ProcessResult>

export interface HarnessUpdateParse {
  status: 'up-to-date' | 'available' | 'unmanaged' | 'failed'
  currentVersion?: string
  availableVersion?: string
}

/** Removes ANSI escape sequences chalk may still emit for piped output. */
export function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

/**
 * Parses `omp update --check` output. Wording is matched loosely (the CLI
 * wraps lines and colors them), and anything unrecognized reads as `failed`
 * so an omp output change can never fabricate an update notification.
 */
export function parseHarnessUpdateCheck(output: string): HarnessUpdateParse {
  const text = stripAnsiCodes(output)
  const currentVersion = /Current version:\s*(\S+)/.exec(text)?.[1]
  if (/is installed and kept up to date by/.test(text)) return { status: 'unmanaged', currentVersion }
  const available = /New version available:\s*(\S+)/.exec(text)
  if (available) return { status: 'available', currentVersion, availableVersion: available[1] }
  if (/Already up to date/.test(text)) return { status: 'up-to-date', currentVersion }
  return { status: 'failed', currentVersion }
}

function resultText(result: ProcessResult): string {
  return `${result.stdout}\n${result.stderr}`
}

function processFailureDetail(result: ProcessResult): string {
  if (result.timedOut) return 'The update command timed out.'
  const detail = stripAnsiCodes(resultText(result)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
  return detail?.slice(0, 240) || `The update command exited with code ${result.code}.`
}

export interface HarnessUpdateServiceOptions {
  /** Resolves the omp executable; a null answer skips the check silently. */
  resolveExecutable(): string | null
  /** Injectable seam for tests; defaults to the real bounded process runner. */
  run?: HarnessUpdateRunner
  checkTimeoutMs?: number
  installTimeoutMs?: number
}

export class HarnessUpdateService {
  private state: HarnessUpdateState = { phase: 'idle' }
  private sink: ((state: HarnessUpdateState) => void) | null = null
  private checkPromise: Promise<HarnessUpdateState> | null = null
  private installPromise: Promise<HarnessUpdateState> | null = null
  private readonly run: HarnessUpdateRunner
  private readonly checkTimeoutMs: number
  private readonly installTimeoutMs: number

  constructor(private readonly options: HarnessUpdateServiceOptions) {
    this.run = options.run ?? ((executable, args, runOptions) => runProcess(executable, args, runOptions))
    this.checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
    this.installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  }

  getState(): HarnessUpdateState {
    return { ...this.state }
  }

  setEventSink(sink: ((state: HarnessUpdateState) => void) | null): void {
    this.sink = sink
  }

  /** Runs `omp update --check`; concurrent callers share one invocation. */
  check(): Promise<HarnessUpdateState> {
    if (this.installPromise) return Promise.resolve(this.getState())
    this.checkPromise ??= this.runCheck().finally(() => { this.checkPromise = null })
    return this.checkPromise
  }

  /**
   * Runs `omp update`. Only meaningful from the available or error phase —
   * omp re-checks before installing, so an error retry is safe. Concurrent
   * callers share one invocation.
   */
  install(): Promise<HarnessUpdateState> {
    if (this.state.phase !== 'available' && this.state.phase !== 'error') return Promise.resolve(this.getState())
    this.installPromise ??= this.runInstall().finally(() => { this.installPromise = null })
    return this.installPromise
  }

  private async runCheck(): Promise<HarnessUpdateState> {
    const executable = this.options.resolveExecutable()
    if (!executable) return this.publish({ phase: 'up-to-date' })
    let result: ProcessResult
    try {
      result = await this.run(executable, ['update', '--check'], { timeoutMs: this.checkTimeoutMs, maxBytes: MAX_OUTPUT_BYTES })
    } catch (error) {
      // Startup checks must stay quiet: an unreachable registry is not news.
      return this.publish({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
    if (result.code !== 0 || result.timedOut || result.outputExceeded) {
      return this.publish({ phase: 'error', message: processFailureDetail(result) })
    }
    const parsed = parseHarnessUpdateCheck(resultText(result))
    if (parsed.status === 'available') {
      return this.publish({ phase: 'available', currentVersion: parsed.currentVersion, availableVersion: parsed.availableVersion })
    }
    // Unmanaged installs (a manager keeps omp current) and up-to-date answers
    // both mean "nothing to do from here".
    return this.publish({ phase: 'up-to-date', currentVersion: parsed.currentVersion })
  }

  private async runInstall(): Promise<HarnessUpdateState> {
    const executable = this.options.resolveExecutable()
    const availableVersion = this.state.availableVersion
    const currentVersion = this.state.currentVersion
    if (!executable) return this.publish({ phase: 'error', message: 'No OMP executable was found.', currentVersion, availableVersion })
    this.publish({ phase: 'installing', currentVersion, availableVersion })
    let result: ProcessResult
    try {
      result = await this.run(executable, ['update'], { timeoutMs: this.installTimeoutMs, maxBytes: MAX_OUTPUT_BYTES })
    } catch (error) {
      return this.publish({ phase: 'error', message: error instanceof Error ? error.message : String(error), currentVersion, availableVersion })
    }
    if (result.code !== 0 || result.timedOut || result.outputExceeded) {
      return this.publish({ phase: 'error', message: processFailureDetail(result), currentVersion, availableVersion })
    }
    return this.publish({ phase: 'installed', currentVersion, availableVersion })
  }

  private publish(next: HarnessUpdateState): HarnessUpdateState {
    this.state = next
    this.sink?.(next)
    return { ...next }
  }
}
