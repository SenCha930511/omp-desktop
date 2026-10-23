import { describe, expect, it, vi } from 'vitest'
import { HarnessUpdateService, parseHarnessUpdateCheck, stripAnsiCodes, type HarnessUpdateRunner } from '../../electron/main/harness-update'
import type { ProcessResult } from '../../electron/main/process-utils'

const result = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  outputExceeded: false,
  ...overrides,
} as ProcessResult)

describe('parseHarnessUpdateCheck', () => {
  it('reads the up-to-date answer', () => {
    expect(parseHarnessUpdateCheck('Current version: 18.12.6\n✔ Already up to date\n')).toEqual({
      status: 'up-to-date',
      currentVersion: '18.12.6',
    })
  })

  it('reads the available answer with its version', () => {
    expect(parseHarnessUpdateCheck('Current version: 18.12.6\nNew version available: 18.13.0\n')).toEqual({
      status: 'available',
      currentVersion: '18.12.6',
      availableVersion: '18.13.0',
    })
  })

  it('treats an externally managed install as nothing to do', () => {
    expect(parseHarnessUpdateCheck('/opt/omp is installed and kept up to date by Tern; update it from Tern.')).toEqual({
      status: 'unmanaged',
    })
  })

  it('ignores ANSI color codes', () => {
    expect(parseHarnessUpdateCheck('\x1b[2mCurrent version: 1.0.0\x1b[22m\n\x1b[36mNew version available: 1.1.0\x1b[39m\n')).toEqual({
      status: 'available',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
    })
  })

  it('reads unrecognized output as failed so a wording change cannot fabricate a prompt', () => {
    expect(parseHarnessUpdateCheck('Something unexpected happened')).toEqual({ status: 'failed' })
  })

  it('strips escape sequences', () => {
    expect(stripAnsiCodes('\x1b[32mgreen\x1b[39m plain')).toBe('green plain')
  })
})

function service(run: HarnessUpdateRunner, executable: string | null = '/opt/omp') {
  return new HarnessUpdateService({ resolveExecutable: () => executable, run })
}

describe('HarnessUpdateService', () => {
  it('publishes availability with both versions', async () => {
    const run = vi.fn(async () => result({ stdout: 'Current version: 18.12.6\nNew version available: 18.13.0\n' }))
    const updates = service(run)
    const sink = vi.fn()
    updates.setEventSink(sink)

    await expect(updates.check()).resolves.toEqual({ phase: 'available', currentVersion: '18.12.6', availableVersion: '18.13.0' })
    expect(run).toHaveBeenCalledWith('/opt/omp', ['update', '--check'], expect.objectContaining({ timeoutMs: expect.any(Number) }))
    expect(sink).toHaveBeenCalledWith({ phase: 'available', currentVersion: '18.12.6', availableVersion: '18.13.0' })
  })

  it('maps up-to-date and unmanaged answers to the quiet phase', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(result({ stdout: 'Current version: 1.0.0\n✔ Already up to date\n' }))
      .mockResolvedValueOnce(result({ stdout: '/x/omp is installed and kept up to date by Tern; update it from Tern.' }))
    const updates = service(run)

    await expect(updates.check()).resolves.toMatchObject({ phase: 'up-to-date', currentVersion: '1.0.0' })
    await expect(updates.check()).resolves.toMatchObject({ phase: 'up-to-date' })
  })

  it('stays quiet when the executable is missing or the check fails', async () => {
    const missing = service(vi.fn(), null)
    await expect(missing.check()).resolves.toEqual({ phase: 'up-to-date' })

    const failing = service(vi.fn(async () => result({ code: 1, stderr: 'Failed to check for updates: registry unreachable' })))
    await expect(failing.check()).resolves.toMatchObject({ phase: 'error' })
  })

  it('coalesces concurrent checks into one invocation', async () => {
    const run = vi.fn(async () => result({ stdout: 'Already up to date\n' }))
    const updates = service(run)
    await Promise.all([updates.check(), updates.check(), updates.check()])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('installs through omp update and reports the installed phase', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(result({ stdout: 'Current version: 18.12.6\nNew version available: 18.13.0\n' }))
      .mockResolvedValueOnce(result({ stdout: 'Installing update...\nVerified 18.13.0\nRestart omp to use the new version\n' }))
    const updates = service(run)
    await updates.check()

    await expect(updates.install()).resolves.toEqual({ phase: 'installed', currentVersion: '18.12.6', availableVersion: '18.13.0' })
    expect(run).toHaveBeenLastCalledWith('/opt/omp', ['update'], expect.objectContaining({ timeoutMs: expect.any(Number) }))
  })

  it('refuses to install without a prior availability or error', async () => {
    const run = vi.fn()
    const updates = service(run)
    await expect(updates.install()).resolves.toEqual({ phase: 'idle' })
    expect(run).not.toHaveBeenCalled()
  })

  it('surfaces an install failure with the command output', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(result({ stdout: 'New version available: 18.13.0\n' }))
      .mockResolvedValueOnce(result({ code: 1, stderr: 'Update failed: could not replace the binary' }))
    const updates = service(run)
    await updates.check()

    await expect(updates.install()).resolves.toMatchObject({ phase: 'error', message: 'Update failed: could not replace the binary' })
  })

  it('keeps the installing phase visible to late subscribers through getState', async () => {
    let release!: (value: ProcessResult) => void
    const run = vi.fn()
      .mockResolvedValueOnce(result({ stdout: 'New version available: 18.13.0\n' }))
      .mockImplementationOnce(() => new Promise<ProcessResult>((resolve) => { release = resolve }))
    const updates = service(run)
    await updates.check()

    const installing = updates.install()
    expect(updates.getState()).toMatchObject({ phase: 'installing' })
    release(result({ stdout: 'Restart omp to use the new version\n' }))
    await expect(installing).resolves.toMatchObject({ phase: 'installed' })
  })

  it('shares one install across concurrent callers', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(result({ stdout: 'New version available: 18.13.0\n' }))
      .mockResolvedValueOnce(result({ stdout: 'done\n' }))
    const updates = service(run)
    await updates.check()

    await Promise.all([updates.install(), updates.install()])
    expect(run).toHaveBeenCalledTimes(2)
  })
})
