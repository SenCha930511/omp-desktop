import { execFile } from 'node:child_process'
import { get } from 'node:https'
import { promisify } from 'node:util'
import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { AppUpdateState } from '../../src/types/api'

export const DEFAULT_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000
const INITIAL_CHECK_DELAY_MS = 8_000

const execFileAsync = promisify(execFile)

/**
 * ShipIt installs never survive ad-hoc signatures: the designated requirement
 * of an ad-hoc bundle bakes in the build's cdHash, which changes every build,
 * so every update fails validation only after a full download. Detecting the
 * arrangement up front spares the user a doomed retry loop.
 */
export interface CodesignRunner { (command: string, args: readonly string[]): Promise<unknown> }

export async function isDeveloperIdSigned(bundlePath: string, run: CodesignRunner = execFileAsync): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  try {
    const result = await run('codesign', ['-dv', bundlePath])
    const output = typeof result === 'object' && result !== null && 'stdout' in result ? String(result.stdout) : ''
    const extra = typeof result === 'object' && result !== null && 'stderr' in result ? String(result.stderr) : ''
    return !/Signature\s*=\s*adhoc/i.test(`${output}\n${extra}`)
  } catch {
    return false
  }
}

/**
 * Unsigned (ad-hoc) bundles cannot self-update, but a manual "check for
 * updates" still deserves a real answer: ask GitHub for the newest published
 * release and compare it with the running version so the About page can point
 * the user at a concrete download instead of a static disclaimer.
 */
export const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/SenCha930511/omp-desktop/releases/latest'
export const GITHUB_RELEASES_URL = 'https://github.com/SenCha930511/omp-desktop/releases'
const LATEST_RELEASE_TIMEOUT_MS = 10_000

export interface LatestRelease { version: string; url: string }

export interface LatestReleaseCheck {
  currentVersion: string
  latestVersion: string
  newer: boolean
  url: string
}

export interface ReleaseFetchResult { status: number; body: string }
export interface ReleaseFetcher { (url: string): Promise<ReleaseFetchResult> }

/** Plain dotted-numeric compare; pre-release/build suffixes are ignored. */
export function compareReleaseVersions(a: string, b: string): number {
  const normalize = (value: string) => value.trim().replace(/^v/i, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const left = normalize(a)
  const right = normalize(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta < 0 ? -1 : 1
  }
  return 0
}

export function parseLatestRelease(body: string): LatestRelease | null {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.tag_name !== 'string') return null
  const version = record.tag_name.trim().replace(/^v/i, '')
  if (!version) return null
  const url = typeof record.html_url === 'string' && /^https:\/\//.test(record.html_url) ? record.html_url : GITHUB_RELEASES_URL
  return { version, url }
}

function nodeReleaseFetch(url: string): Promise<ReleaseFetchResult> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'omp-desktop' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.setTimeout(LATEST_RELEASE_TIMEOUT_MS, () => { request.destroy(new Error('Latest release check timed out')) })
  })
}

export async function fetchLatestRelease(fetch: ReleaseFetcher = nodeReleaseFetch, url = GITHUB_RELEASES_API_URL): Promise<LatestRelease | null> {
  const result = await fetch(url)
  if (result.status !== 200) return null
  return parseLatestRelease(result.body)
}

export interface UpdateAdapter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'checking-for-update', listener: () => void): this
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfo) => void): this
  on(event: 'download-progress', listener: (progress: ProgressInfo) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateServiceOptions {
  enabled: boolean
  /** Developer ID status of this running bundle on macOS; false gates updates off. */
  signed?: boolean
  /** Running app version, used by the manual GitHub latest-release check. */
  currentVersion?: string
  /** Injected seam for tests; defaults to the network fetch against GitHub. */
  fetchLatestRelease?: () => Promise<LatestRelease | null>
  checkIntervalMs?: number
  initialCheckDelayMs?: number
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
  setTimeout?: typeof globalThis.setTimeout
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 240) || 'Update check failed'
}

export interface ManualUpdateNotification {
  type: 'info' | 'error'
  message: string
  detail?: string
}

export function manualUpdateNotification(state: AppUpdateState): ManualUpdateNotification {
  if (state.phase === 'error') return {
    type: 'error',
    message: 'OMP Desktop Update Check Failed',
    detail: state.message,
  }
  if (state.phase === 'unsupported') return {
    type: 'info',
    message: 'OMP Desktop Updates Unavailable',
    detail: state.message ?? 'Automatic updates are available in installed builds.',
  }
  const available = state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded'
  return {
    type: 'info',
    message: available ? 'OMP Desktop Update Available' : 'No OMP Desktop Update Available',
  }
}

/** Coalesces manual "Check for Updates…" clicks so concurrent clicks cannot queue dialogs. */
export function createManualUpdateCheck(
  check: () => Promise<AppUpdateState>,
  notify: (notification: ManualUpdateNotification) => void | Promise<void>,
): () => void {
  let inFlight = false
  return () => {
    if (inFlight) return
    inFlight = true
    void check()
      .then((state) => notify(manualUpdateNotification(state)))
      .catch((error) => notify({ type: 'error', message: 'OMP Desktop Update Check Failed', detail: errorMessage(error) }))
      .finally(() => { inFlight = false })
  }
}

export function getAutoUpdater(): AppUpdater {
  // electron-updater is CommonJS; accessing through its default export keeps
  // the bundled Electron ESM output compatible with both Node module modes.
  return electronUpdater.autoUpdater
}

export class UpdateService {
  private state: AppUpdateState
  private sink: ((state: AppUpdateState) => void) | null = null
  private checkPromise: Promise<AppUpdateState> | null = null
  private downloadPromise: Promise<boolean> | null = null
  private installAfterDownload = false
  /** Version of the discovered update, kept independent of the last published phase. */
  private discoveredVersion: string | undefined
  private interval: ReturnType<typeof globalThis.setInterval> | null = null
  private initialTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  private readonly setIntervalFn: typeof globalThis.setInterval
  private readonly clearIntervalFn: typeof globalThis.clearInterval
  private readonly setTimeoutFn: typeof globalThis.setTimeout

  constructor(private readonly updater: UpdateAdapter, private readonly options: UpdateServiceOptions) {
    this.state = !options.enabled
      ? { phase: 'unsupported', message: 'Automatic updates are available in installed builds.' }
      : options.signed === false
        ? { phase: 'unsupported', message: 'Automatic updates need a Developer ID signed build. Download the newest OMP Desktop release from GitHub.' }
        : { phase: 'idle' }
    this.setIntervalFn = options.setInterval ?? globalThis.setInterval
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout
    if (!options.enabled) return

    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.on('checking-for-update', () => this.publish({ phase: 'checking' }))
    updater.on('update-available', (info) => {
      this.discoveredVersion = info.version
      this.publish({ phase: 'available', version: info.version })
    })
    updater.on('download-progress', (progress) => this.publish({
      phase: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    }))
    updater.on('update-downloaded', (info) => {
      this.discoveredVersion = info.version
      this.stopScheduledChecks()
      this.publish({ phase: 'downloaded', version: info.version })
      if (!this.installAfterDownload) return
      this.installAfterDownload = false
      this.updater.quitAndInstall(false, true)
    })
    updater.on('update-not-available', (info) => {
      this.discoveredVersion = undefined
      this.publish({ phase: 'not-available', version: info.version })
    })
    updater.on('error', (error) => {
      this.installAfterDownload = false
      this.publish({ phase: 'error', message: errorMessage(error) })
    })
  }

  start(): void {
    if (!this.options.enabled || this.options.signed === false || this.interval || this.initialTimer) return
    this.initialTimer = this.setTimeoutFn(() => {
      this.initialTimer = null
      this.runScheduledCheck()
    }, this.options.initialCheckDelayMs ?? INITIAL_CHECK_DELAY_MS)
    this.initialTimer.unref?.()
    this.interval = this.setIntervalFn(() => { this.runScheduledCheck() }, this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS)
    this.interval.unref?.()
  }

  isEnabled(): boolean {
    return this.options.enabled
  }

  dispose(): void {
    this.stopScheduledChecks()
    this.sink = null
  }

  getState(): AppUpdateState {
    return structuredClone(this.state)
  }

  setEventSink(sink: ((state: AppUpdateState) => void) | null): void {
    this.sink = sink
  }

  check(): Promise<AppUpdateState> {
    if (!this.options.enabled || this.options.signed === false) return Promise.resolve(this.getState())
    if (this.state.phase === 'available' || this.state.phase === 'downloading' || this.state.phase === 'downloaded') return Promise.resolve(this.getState())
    if (this.checkPromise) return this.checkPromise
    this.checkPromise = this.updater.checkForUpdates()
      .then(() => this.getState())
      .catch((error) => {
        this.publish({ phase: 'error', message: errorMessage(error) })
        return this.getState()
      })
      .finally(() => { this.checkPromise = null })
    return this.checkPromise
  }

  /**
   * Manual "check for updates" fallback for unsigned/dev builds: the static
   * unsupported message stays the updater state, but the About page can still
   * answer with a concrete GitHub release comparison.
   */
  async checkLatestRelease(): Promise<LatestReleaseCheck> {
    const fetcher = this.options.fetchLatestRelease ?? (() => fetchLatestRelease())
    const release = await fetcher()
    if (!release) throw new Error('Could not read the latest OMP Desktop release from GitHub')
    const currentVersion = this.options.currentVersion ?? '0.0.0'
    return {
      currentVersion,
      latestVersion: release.version,
      newer: compareReleaseVersions(release.version, currentVersion) > 0,
      url: release.url,
    }
  }

  downloadAndInstall(): Promise<boolean> {
    if (!this.options.enabled) return Promise.resolve(false)
    if (this.downloadPromise) return this.downloadPromise
    if (this.state.phase === 'downloaded') {
      this.updater.quitAndInstall(false, true)
      return Promise.resolve(true)
    }
    if (this.state.phase !== 'available') return Promise.resolve(false)

    this.installAfterDownload = true
    // Progress stays undefined until the first download-progress event so the
    // renderer can show a busy state instead of a stuck 0%.
    this.publish({ phase: 'downloading' })
    this.downloadPromise = this.updater.downloadUpdate()
      .then(() => true)
      .catch((error) => {
        this.installAfterDownload = false
        this.publish({ phase: 'error', message: errorMessage(error) })
        return false
      })
      .finally(() => { this.downloadPromise = null })
    return this.downloadPromise
  }

  private runScheduledCheck(): void {
    if (this.state.phase === 'downloaded') {
      this.stopScheduledChecks()
      return
    }
    void this.check()
  }

  private stopScheduledChecks(): void {
    if (this.interval) this.clearIntervalFn(this.interval)
    if (this.initialTimer) clearTimeout(this.initialTimer)
    this.interval = null
    this.initialTimer = null
  }

  private publish(state: AppUpdateState): void {
    const version = state.version ?? this.discoveredVersion
    this.state = version ? { ...state, version } : state
    this.sink?.(this.getState())
  }
}
