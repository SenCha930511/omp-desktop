import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '../../src/types/api'
import { compareReleaseVersions, createManualUpdateCheck, DEFAULT_CHECK_INTERVAL_MS, fetchLatestRelease, isDeveloperIdSigned, manualUpdateNotification, parseLatestRelease, UpdateService, type UpdateAdapter } from '../../electron/main/updates'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  checkForUpdates = vi.fn(async () => undefined)
  downloadUpdate = vi.fn(async (): Promise<void> => undefined)
  quitAndInstall = vi.fn()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('automatic update service', () => {
  it('uses explicit system messages for manual update checks', () => {
    expect(manualUpdateNotification({ phase: 'not-available' })).toMatchObject({ type: 'info', message: 'No OMP Desktop Update Available' })
    expect(manualUpdateNotification({ phase: 'available', version: '0.2.0' })).toMatchObject({ type: 'info', message: 'OMP Desktop Update Available' })
    expect(manualUpdateNotification({ phase: 'downloaded', version: '0.2.0' })).toMatchObject({ type: 'info', message: 'OMP Desktop Update Available' })
  })

  it('explains that builds without an update service cannot check', () => {
    expect(manualUpdateNotification({ phase: 'unsupported', message: 'Automatic updates are available in installed builds.' })).toEqual({
      type: 'info',
      message: 'OMP Desktop Updates Unavailable',
      detail: 'Automatic updates are available in installed builds.',
    })
  })

  it('marks an ad-hoc signed bundle as unsupported without ever querying the updater', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater, { enabled: true, signed: false })

    expect(service.getState()).toMatchObject({ phase: 'unsupported', message: expect.stringContaining('Developer ID signed build') })
    service.start()
    await expect(service.check()).resolves.toMatchObject({ phase: 'unsupported' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('reads ad-hoc bundles from the codesign output and tolerates probe failures', async () => {
    const adhoc = vi.fn(async () => ({ stdout: '', stderr: 'Signature=adhoc\nTeamIdentifier=not set\n' }))
    const signed = vi.fn(async () => ({ stdout: 'Authority=Developer ID Application: Example (TEAM12AB3C)\nTeamIdentifier=TEAM12AB3C\n', stderr: '' }))
    const broken = vi.fn(async () => { throw new Error('codesign missing') })
    if (process.platform === 'darwin') {
      await expect(isDeveloperIdSigned('/tmp/Lie.app', adhoc)).resolves.toBe(false)
      await expect(isDeveloperIdSigned('/tmp/Truth.app', signed)).resolves.toBe(true)
      await expect(isDeveloperIdSigned('/tmp/Lost.app', broken)).resolves.toBe(false)
    } else {
      await expect(isDeveloperIdSigned('/tmp/Truth.app', signed)).resolves.toBe(true)
    }
  })

  it('coalesces concurrent manual update checks into one dialog', async () => {
    let finishCheck!: () => void
    const check = vi.fn(() => new Promise<AppUpdateState>((resolve) => { finishCheck = () => resolve({ phase: 'not-available' }) }))
    const notify = vi.fn()
    const checkForUpdates = createManualUpdateCheck(check, notify)

    checkForUpdates()
    checkForUpdates()
    checkForUpdates()
    expect(check).toHaveBeenCalledOnce()

    finishCheck()
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce())
    expect(notify).toHaveBeenCalledWith({ type: 'info', message: 'No OMP Desktop Update Available' })

    checkForUpdates()
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('automatically checks installed builds without downloading or installing on quit', async () => {
    vi.useFakeTimers()
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true, initialCheckDelayMs: 25, checkIntervalMs: 100 })
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)

    service.start()
    await vi.advanceTimersByTimeAsync(25)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('checks for a new release every three hours by default', async () => {
    vi.useFakeTimers()
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true })

    service.start()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS - 8_001)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('does not download or restart until the available update is explicitly accepted', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true })
    const changed = vi.fn()
    service.setEventSink(changed)

    updater.emit('update-available', { version: '0.2.0' })
    expect(service.getState()).toEqual({ phase: 'available', version: '0.2.0' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    let finishDownload!: () => void
    updater.downloadUpdate.mockImplementation(() => new Promise<void>((resolve) => { finishDownload = resolve }))
    const accepted = service.downloadAndInstall()
    expect(service.getState()).toEqual({ phase: 'downloading', version: '0.2.0' })
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()

    expect(service.downloadAndInstall()).toBe(accepted)
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()

    updater.emit('download-progress', { percent: 48.6 })
    expect(service.getState()).toEqual({ phase: 'downloading', version: '0.2.0', percent: 49 })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    updater.emit('update-downloaded', { version: '0.2.0' })
    expect(service.getState()).toEqual({ phase: 'downloaded', version: '0.2.0' })
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    finishDownload()
    await expect(accepted).resolves.toBe(true)
    expect(changed).toHaveBeenCalled()
  })

  it('does not restart for a downloaded event that was not user-approved', () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true })

    updater.emit('update-downloaded', { version: '0.2.0' })
    expect(service.getState()).toEqual({ phase: 'downloaded', version: '0.2.0' })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('keeps an active release state while a manual check is requested', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true })

    updater.emit('update-available', { version: '0.2.0' })
    await expect(service.check()).resolves.toEqual({ phase: 'available', version: '0.2.0' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('keeps development builds offline and explains why updates are unavailable', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: false })
    service.start()
    await expect(service.check()).resolves.toMatchObject({ phase: 'unsupported' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await expect(service.downloadAndInstall()).resolves.toBe(false)
  })

  it('restarts immediately when the update is already downloaded', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true })

    updater.emit('update-downloaded', { version: '0.2.0' })
    await expect(service.downloadAndInstall()).resolves.toBe(true)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('keeps the discovered version and allows a retry after a failed download', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true })
    updater.downloadUpdate.mockRejectedValueOnce(new Error('network went\naway'))

    updater.emit('update-available', { version: '0.2.0' })
    await expect(service.downloadAndInstall()).resolves.toBe(false)
    expect(service.getState()).toEqual({ phase: 'error', version: '0.2.0', message: 'network went away' })

    // Retrying re-checks, and the second download attempt is accepted.
    updater.checkForUpdates.mockImplementation(async () => { updater.emit('update-available', { version: '0.2.0' }); return undefined })
    await expect(service.check()).resolves.toEqual({ phase: 'available', version: '0.2.0' })
    await expect(service.downloadAndInstall()).resolves.toBe(true)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('clears consent when the updater reports an error and keeps the version for a retry', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true })
    updater.downloadUpdate.mockImplementation(() => new Promise<void>(() => {}))

    updater.emit('update-available', { version: '0.3.0' })
    void service.downloadAndInstall()
    updater.emit('error', new Error('signature mismatch'))
    expect(service.getState()).toEqual({ phase: 'error', version: '0.3.0', message: 'signature mismatch' })

    updater.emit('update-downloaded', { version: '0.3.0' })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('reports progress only once the updater emits it', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true })
    updater.downloadUpdate.mockImplementation(() => new Promise<void>(() => {}))

    updater.emit('update-available', { version: '0.2.0' })
    void service.downloadAndInstall()
    expect(service.getState().percent).toBeUndefined()

    updater.emit('download-progress', { percent: 12.4 })
    expect(service.getState()).toEqual({ phase: 'downloading', version: '0.2.0', percent: 12 })
  })

  it('stops the periodic check once an update has been downloaded', async () => {
    vi.useFakeTimers()
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true, initialCheckDelayMs: 25, checkIntervalMs: 100 })

    service.start()
    await vi.advanceTimersByTimeAsync(25)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)

    updater.emit('update-downloaded', { version: '0.2.0' })
    await vi.advanceTimersByTimeAsync(500)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('reports that development builds cannot check for updates', () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: false })
    expect(service.isEnabled()).toBe(false)
    expect(manualUpdateNotification(service.getState())).toMatchObject({ type: 'info', message: 'OMP Desktop Updates Unavailable' })
  })
})

describe('latest release check for unsigned builds', () => {
  it('compares dotted versions numerically across segment counts and prefixes', () => {
    expect(compareReleaseVersions('1.3.0', '1.2.0')).toBe(1)
    expect(compareReleaseVersions('v1.2.0', '1.2.0')).toBe(0)
    expect(compareReleaseVersions('1.2.0', '1.2.1')).toBe(-1)
    expect(compareReleaseVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareReleaseVersions('1.2', '1.2.0')).toBe(0)
    expect(compareReleaseVersions('1.3.0-beta.1', '1.3.0')).toBe(1)
  })

  it('parses a GitHub latest-release payload and falls back to the releases page', () => {
    expect(parseLatestRelease('{"tag_name":"v1.3.0","html_url":"https://github.com/SenCha930511/omp-desktop/releases/tag/v1.3.0"}'))
      .toEqual({ version: '1.3.0', url: 'https://github.com/SenCha930511/omp-desktop/releases/tag/v1.3.0' })
    expect(parseLatestRelease('{"tag_name":"v0.9.1"}'))
      .toEqual({ version: '0.9.1', url: 'https://github.com/SenCha930511/omp-desktop/releases' })
    expect(parseLatestRelease('not json')).toBeNull()
    expect(parseLatestRelease('{"name":"missing tag"}')).toBeNull()
    expect(parseLatestRelease('{"tag_name":"   "}')).toBeNull()
  })

  it('ignores non-200 responses from the releases API', async () => {
    const fetch = vi.fn(async () => ({ status: 403, body: 'rate limited' }))
    await expect(fetchLatestRelease(fetch)).resolves.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    const ok = vi.fn(async () => ({ status: 200, body: '{"tag_name":"v2.0.0","html_url":"https://github.com/SenCha930511/omp-desktop/releases/tag/v2.0.0"}' }))
    await expect(fetchLatestRelease(ok)).resolves.toEqual({ version: '2.0.0', url: 'https://github.com/SenCha930511/omp-desktop/releases/tag/v2.0.0' })
  })

  it('reports a newer GitHub release relative to the running version', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, {
      enabled: true,
      signed: false,
      currentVersion: '1.2.0',
      fetchLatestRelease: async () => ({ version: '1.3.0', url: 'https://github.com/SenCha930511/omp-desktop/releases/tag/v1.3.0' }),
    })
    await expect(service.checkLatestRelease()).resolves.toEqual({
      currentVersion: '1.2.0',
      latestVersion: '1.3.0',
      newer: true,
      url: 'https://github.com/SenCha930511/omp-desktop/releases/tag/v1.3.0',
    })
  })

  it('reports up to date when GitHub latest matches the running version', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, {
      enabled: true,
      signed: false,
      currentVersion: '1.3.0',
      fetchLatestRelease: async () => ({ version: '1.3.0', url: 'https://github.com/SenCha930511/omp-desktop/releases/tag/v1.3.0' }),
    })
    await expect(service.checkLatestRelease()).resolves.toMatchObject({ latestVersion: '1.3.0', newer: false })
  })

  it('fails the manual check when GitHub does not yield a release', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, {
      enabled: true,
      signed: false,
      currentVersion: '1.2.0',
      fetchLatestRelease: async () => null,
    })
    await expect(service.checkLatestRelease()).rejects.toThrow('Could not read the latest OMP Desktop release from GitHub')
  })
})
