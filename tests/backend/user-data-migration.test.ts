import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_USER_DATA_DIR_NAME, migrateLegacyUserData } from '../../electron/main/user-data-migration'
import { CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME } from '../../electron/main/store'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function layout() {
  const appDataPath = mkdtempSync(join(tmpdir(), 'omp-desktop-migration-appdata-'))
  const userDataPath = mkdtempSync(join(tmpdir(), 'omp-desktop-migration-userdata-'))
  directories.push(appDataPath, userDataPath)
  const legacyDir = join(appDataPath, LEGACY_USER_DATA_DIR_NAME)
  return { appDataPath, userDataPath, legacyDir }
}

describe('migrateLegacyUserData', () => {
  it('copies app-owned files from the legacy GooeyPi directory and renames the state files', async () => {
    const { appDataPath, userDataPath, legacyDir } = layout()
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, 'agent-message-signing.key'), 'signing-key')
    writeFileSync(join(legacyDir, 'voice-secrets.json'), '{}')
    writeFileSync(join(legacyDir, 'crash.log'), 'a crash')
    writeFileSync(join(legacyDir, 'prime-work-state-v4.json'), '{"version":4}')
    writeFileSync(join(legacyDir, 'prime-work-state.json'), '{"version":2}')

    const report = await migrateLegacyUserData(appDataPath, userDataPath)

    expect(report.migrated).toBe(true)
    expect(report.copiedFiles.sort()).toEqual([
      join(userDataPath, CURRENT_DESKTOP_STATE_FILENAME),
      join(userDataPath, LEGACY_DESKTOP_STATE_FILENAME),
      join(userDataPath, 'agent-message-signing.key'),
      join(userDataPath, 'crash.log'),
      join(userDataPath, 'voice-secrets.json'),
    ].sort())
    expect(readFileSync(join(userDataPath, CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).toBe('{"version":4}')
    expect(readFileSync(join(userDataPath, LEGACY_DESKTOP_STATE_FILENAME), 'utf8')).toBe('{"version":2}')
    expect(readFileSync(join(userDataPath, 'agent-message-signing.key'), 'utf8')).toBe('signing-key')
    // The legacy directory is left untouched so nothing is lost on failure.
    expect(readFileSync(join(legacyDir, 'prime-work-state-v4.json'), 'utf8')).toBe('{"version":4}')
    expect(readFileSync(join(legacyDir, 'prime-work-state.json'), 'utf8')).toBe('{"version":2}')
  })

  it('skips migration when the new state file already exists', async () => {
    const { appDataPath, userDataPath, legacyDir } = layout()
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, 'voice-secrets.json'), '{}')
    writeFileSync(join(userDataPath, CURRENT_DESKTOP_STATE_FILENAME), '{"version":4,"fresh":true}')

    const report = await migrateLegacyUserData(appDataPath, userDataPath)

    expect(report).toEqual({ migrated: false, reason: 'new-state-exists', copiedFiles: [] })
    expect(readFileSync(join(userDataPath, CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).toBe('{"version":4,"fresh":true}')
  })

  it('skips migration when the legacy directory is missing or holds nothing copyable', async () => {
    const { appDataPath, userDataPath } = layout()
    await expect(migrateLegacyUserData(appDataPath, userDataPath)).resolves.toEqual({
      migrated: false, reason: 'legacy-dir-missing', copiedFiles: [],
    })

    const legacyDir = join(appDataPath, LEGACY_USER_DATA_DIR_NAME)
    mkdirSync(legacyDir)
    mkdirSync(join(legacyDir, 'Cache'))
    writeFileSync(join(legacyDir, 'Cache', 'Data_1'), 'cache') // Unrelated trees stay behind.

    await expect(migrateLegacyUserData(appDataPath, userDataPath)).resolves.toEqual({
      migrated: false, reason: 'empty', copiedFiles: [],
    })
  })

  it('never overwrites an existing target file and keeps oversized files behind', async () => {
    const { appDataPath, userDataPath, legacyDir } = layout()
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, 'voice-secrets.json'), 'legacy-secret')
    writeFileSync(join(legacyDir, 'crash.log'), 'x'.repeat(65 * 1024 * 1024))
    writeFileSync(join(userDataPath, 'voice-secrets.json'), 'current-secret')

    const report = await migrateLegacyUserData(appDataPath, userDataPath)

    expect(report.migrated).toBe(true)
    expect(report.copiedFiles).toEqual([])
    expect(readFileSync(join(userDataPath, 'voice-secrets.json'), 'utf8')).toBe('current-secret')
    expect(readFileSync(join(legacyDir, 'crash.log')).length).toBe(65 * 1024 * 1024)
  })

  it('keeps the total migrated bytes bounded across files', async () => {
    const { appDataPath, userDataPath, legacyDir } = layout()
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, 'agent-message-signing.key'), 'k'.repeat(40 * 1024 * 1024))
    writeFileSync(join(legacyDir, 'voice-secrets.json'), 'v'.repeat(40 * 1024 * 1024))

    const report = await migrateLegacyUserData(appDataPath, userDataPath)

    expect(report.migrated).toBe(true)
    // The second file exceeds the total budget after the first one is counted.
    expect(report.copiedFiles).toEqual([join(userDataPath, 'agent-message-signing.key')])
  })

  it('seeds the dev profile from the packaged OMP Desktop profile when asked', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'omp-desktop-appdata-'))
    const packagedDir = join(appData, 'OMP Desktop')
    const devDir = join(appData, 'OMP Desktop Dev')
    mkdirSync(packagedDir, { recursive: true })
    const state = JSON.stringify({ version: 4, workspace: {} })
    writeFileSync(join(packagedDir, CURRENT_DESKTOP_STATE_FILENAME), state, 'utf8')
    writeFileSync(join(packagedDir, 'voice-secrets.json'), '{}', 'utf8')

    const report = await migrateLegacyUserData(appData, devDir, [LEGACY_USER_DATA_DIR_NAME, 'OMP Desktop'])

    expect(report.migrated).toBe(true)
    expect(readFileSync(join(devDir, CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).toBe(state)
    expect(readFileSync(join(devDir, 'voice-secrets.json'), 'utf8')).toBe('{}')
    // the packaged profile source remains untouched
    expect(readFileSync(join(packagedDir, CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).toBe(state)
    rmSync(appData, { recursive: true, force: true })
  })
})
