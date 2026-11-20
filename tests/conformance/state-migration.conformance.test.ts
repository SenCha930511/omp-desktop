import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ConformanceClient, type ConformanceSandbox, createConformanceSandbox, requireCapability } from './client'
import type { AdapterInfo, WorkspaceResetParams } from './protocol'

const CURRENT_STATE_FILE = 'omp-desktop-state-v4.json'
const LEGACY_STATE_FILE = 'omp-desktop-state.json'

let client: ConformanceClient
let info: AdapterInfo
let sandbox: ConformanceSandbox | null = null

async function setupWorkspace(autoOpen = true, extra?: Partial<WorkspaceResetParams>): Promise<ConformanceSandbox> {
  sandbox?.cleanup()
  sandbox = createConformanceSandbox('omp-conf-state-')
  await client.call('workspace.reset', {
    rootDir: sandbox.rootDir,
    homeDir: sandbox.homeDir,
    userDataDir: sandbox.userDataDir,
    appDataDir: sandbox.appDataDir,
    ompExecutable: sandbox.ompExecutable,
    autoOpen,
    ...extra,
  })
  return sandbox
}

beforeAll(async () => {
  client = await ConformanceClient.launch()
  info = await client.info()
})

afterEach(async () => {
  await client.call('state.close').catch(() => undefined)
  sandbox?.cleanup()
  sandbox = null
})

afterAll(async () => {
  await client.close()
})

describe('conformance: state & migrations', () => {
  it('initializes v4 state, validates settings updates, and persists across restart', async () => {
    if (!requireCapability(info, 'state')) return
    const currentSandbox = await setupWorkspace(true)

    const initial = await client.call<{ activeHarness: string; theme: string; conversationDensity: string; messageEnterAction: string }>('state.getSettings')
    expect(initial.activeHarness).toBe('omp')
    expect(initial.messageEnterAction).toBe('steer')

    const updated = await client.call<{ theme: string; conversationDensity: string; ompApprovalMode: string; interfaceFontScale: number }>('state.updateSettings', {
      patch: {
        theme: 'dark',
        conversationDensity: 'compact',
        ompApprovalMode: 'write',
        interfaceFontScale: 115,
      },
    })
    expect(updated).toMatchObject({
      theme: 'dark',
      conversationDensity: 'compact',
      ompApprovalMode: 'write',
      interfaceFontScale: 115,
    })

    await client.callExpectError('state.updateSettings', { patch: { conversationDensity: 'dense' } })
    await client.callExpectError('state.updateSettings', { patch: { ompApprovalMode: 'invalid-mode' } })
    await client.callExpectError('state.updateSettings', { patch: { interfaceFontScale: 200 } })
    await client.callExpectError('state.updateSettings', { patch: { runtimePaths: { omp: 'relative/omp' } } })

    await client.call('state.close')
    await client.call('state.open')

    const reloaded = await client.call<{ theme: string; conversationDensity: string; ompApprovalMode: string; interfaceFontScale: number }>('state.getSettings')
    expect(reloaded).toMatchObject({
      theme: 'dark',
      conversationDensity: 'compact',
      ompApprovalMode: 'write',
      interfaceFontScale: 115,
    })

    const persisted = JSON.parse(readFileSync(join(currentSandbox.userDataDir, CURRENT_STATE_FILE), 'utf8')) as { version: number; settings: Record<string, unknown> }
    expect(persisted.version).toBe(4)
    expect(persisted.settings.ompApprovalMode).toBe('write')
  })

  it('migrates legacy v2/v3 harness records, enforces TUI shortcut migration, and retires POSIX legacy state', async () => {
    if (!requireCapability(info, 'state')) return
    const currentSandbox = await setupWorkspace(false)
    const legacyPath = join(currentSandbox.userDataDir, LEGACY_STATE_FILE)

    const legacyV2 = {
      version: 2,
      projects: [
        { id: 'p-prime', harness: 'prime', name: 'Prime Project', path: '/tmp/a', folders: ['/tmp/a'], primaryFolder: '/tmp/a' },
        { id: 'p-pi', harness: 'pi', name: 'Pi Project', path: '/tmp/b', folders: ['/tmp/b'], primaryFolder: '/tmp/b' },
        { id: 'p-none', name: 'Pre-harness Project', path: '/tmp/c', folders: ['/tmp/c'], primaryFolder: '/tmp/c' },
        { id: 'p-bad', harness: 'unknown-harness', name: 'Hostile Project', path: '/tmp/d', folders: ['/tmp/d'], primaryFolder: '/tmp/d' },
      ],
      settings: {
        activeHarness: 'prime',
        messageEnterAction: 'queue',
      },
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }
    const rawLegacy = `${JSON.stringify(legacyV2, null, 2)}\n`
    writeFileSync(legacyPath, rawLegacy, 'utf8')

    await client.call('state.open')
    const snapshot = await client.call<{
      version: number
      projects: Array<{ id: string; harness: string }>
      settings: { activeHarness: string; messageEnterAction: string; inputShortcutsVersion?: number }
    }>('state.getSnapshot')
    expect(snapshot.version).toBe(4)
    expect(snapshot.projects.map((project) => [project.id, project.harness])).toEqual([
      ['p-prime', 'omp'],
      ['p-pi', 'omp'],
      ['p-none', 'omp'],
    ])
    expect(snapshot.settings.activeHarness).toBe('omp')
    expect(snapshot.settings.messageEnterAction).toBe('steer')
    expect(snapshot.settings.inputShortcutsVersion).toBe(1)

    if (process.platform !== 'win32') {
      expect(existsSync(legacyPath)).toBe(false)
      const backups = readdirSync(currentSandbox.userDataDir).filter((name) => name.startsWith(`${LEGACY_STATE_FILE}.migrated-v4-`))
      expect(backups).toHaveLength(1)
      expect(readFileSync(join(currentSandbox.userDataDir, backups[0]!), 'utf8')).toBe(rawLegacy)
    }

    await client.call('state.updateSettings', { patch: { messageEnterAction: 'queue' } })
    await client.call('state.close')
    await client.call('state.open')
    const explicitChoice = await client.call<{ messageEnterAction: string }>('state.getSettings')
    expect(explicitChoice.messageEnterAction).toBe('queue')
  })

  it('enforces the Windows tombstone migration, recovery, and downgrade quarantine protocol', async () => {
    if (!requireCapability(info, 'state')) return

    // 1. Fresh install writes v4 + completed zero-authority tombstone.
    const freshSandbox = await setupWorkspace(true, { platformOverride: 'win32' })
    const freshLegacyPath = join(freshSandbox.userDataDir, LEGACY_STATE_FILE)
    expect(existsSync(join(freshSandbox.userDataDir, CURRENT_STATE_FILE))).toBe(true)
    const freshTombstone = JSON.parse(readFileSync(freshLegacyPath, 'utf8')) as {
      version: number
      projects: unknown[]
      gooeyPiV4Migration: { status: string; backupFile: string | null; reason: string }
    }
    expect(freshTombstone).toMatchObject({
      version: 3,
      projects: [],
      gooeyPiV4Migration: { status: 'complete', backupFile: null, reason: 'fresh' },
    })

    // 2. Legacy migration creates byte-exact backup + completed tombstone, then quarantines downgraded writes.
    const migSandbox = await setupWorkspace(false, { platformOverride: 'win32' })
    const migLegacyPath = join(migSandbox.userDataDir, LEGACY_STATE_FILE)
    const migV4Path = join(migSandbox.userDataDir, CURRENT_STATE_FILE)
    const legacyBytes = `${JSON.stringify({
      version: 2,
      projects: [{ id: 'win-proj', name: 'Win', path: 'C:\\win', folders: ['C:\\win'], primaryFolder: 'C:\\win' }],
      settings: {},
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    })}\n`
    writeFileSync(migLegacyPath, legacyBytes, 'utf8')
    await client.call('state.open')
    const migSnap = await client.call<{ projects: Array<{ id: string }> }>('state.getSnapshot')
    expect(migSnap.projects.map((p) => p.id)).toEqual(['win-proj'])
    const migTombstone = JSON.parse(readFileSync(migLegacyPath, 'utf8')) as {
      gooeyPiV4Migration: { status: string; backupFile: string; reason: string }
    }
    expect(migTombstone.gooeyPiV4Migration.status).toBe('complete')
    expect(migTombstone.gooeyPiV4Migration.reason).toBe('migration')
    expect(readFileSync(join(migSandbox.userDataDir, migTombstone.gooeyPiV4Migration.backupFile), 'utf8')).toBe(legacyBytes)

    // Simulate a downgraded binary recreating legacy authority; v4 startup must quarantine it.
    await client.call('state.close')
    writeFileSync(migLegacyPath, JSON.stringify({ version: 2, projects: [{ id: 'downgraded', name: 'Old', path: 'C:\\old', folders: ['C:\\old'], primaryFolder: 'C:\\old' }] }))
    await client.call('state.open')
    const afterQuarantine = JSON.parse(readFileSync(migLegacyPath, 'utf8')) as {
      gooeyPiV4Migration: { status: string; reason: string; backupFile: string | null }
    }
    expect(afterQuarantine.gooeyPiV4Migration).toMatchObject({ status: 'complete', reason: 'quarantine' })
    expect(afterQuarantine.gooeyPiV4Migration.backupFile).toBeTruthy()
    expect((await client.call<{ projects: Array<{ id: string }> }>('state.getSnapshot')).projects.map((p) => p.id)).toEqual(['win-proj'])

    // 3. Pending tombstone resumes from backup; complete tombstone with missing v4 fails closed.
    await client.call('state.close')
    const backupName = migTombstone.gooeyPiV4Migration.backupFile
    writeFileSync(
      migLegacyPath,
      JSON.stringify({
        version: 3,
        projects: [],
        schedules: [],
        gooeyPiV4Migration: {
          schemaVersion: 1,
          status: 'pending',
          currentStateFile: CURRENT_STATE_FILE,
          backupFile: backupName,
          reason: 'migration',
        },
      }),
    )
    writeFileSync(migV4Path, '')
    await import('node:fs/promises').then(({ unlink }) => unlink(migV4Path))
    await client.call('state.open')
    expect((await client.call<{ projects: Array<{ id: string }> }>('state.getSnapshot')).projects.map((p) => p.id)).toEqual(['win-proj'])

    // Completed tombstone + missing v4 must fail closed.
    await client.call('state.close')
    await import('node:fs/promises').then(({ unlink }) => unlink(migV4Path))
    await client.callExpectError('state.open')
  })

  it('fails closed on future schema versions without modifying the state file', async () => {
    if (!requireCapability(info, 'state')) return
    const currentSandbox = await setupWorkspace(false)
    const v4Path = join(currentSandbox.userDataDir, CURRENT_STATE_FILE)
    const futureBytes = `${JSON.stringify({ version: 99, projects: [], settings: {} }, null, 2)}\n`
    writeFileSync(v4Path, futureBytes, 'utf8')

    const error = await client.callExpectError('state.open')
    expect(error.message).toMatch(/newer|99|supported/i)
    expect(readFileSync(v4Path, 'utf8')).toBe(futureBytes)
  })

  it('migrates legacy GooeyPi userData files safely and skips when v4 already exists', async () => {
    if (!requireCapability(info, 'state')) return
    const currentSandbox = await setupWorkspace(false)
    const legacyDir = join(currentSandbox.appDataDir, 'GooeyPi')
    mkdirSync(join(legacyDir, 'Cache'), { recursive: true })
    mkdirSync(join(legacyDir, 'Partitions', 'p1'), { recursive: true })

    const legacyV4State = {
      version: 4,
      projects: [{ id: 'from-gooeypi', harness: 'omp', name: 'Migrated', path: '/tmp/m', folders: ['/tmp/m'], primaryFolder: '/tmp/m' }],
      settings: { theme: 'light' },
      archivedSessions: [],
      pinnedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }
    writeFileSync(join(legacyDir, 'prime-work-state-v4.json'), JSON.stringify(legacyV4State), 'utf8')
    writeFileSync(join(legacyDir, 'agent-message-signing.key'), Buffer.alloc(32, 7))
    writeFileSync(join(legacyDir, 'voice-secrets.json'), '{"openai":"enc"}', 'utf8')
    writeFileSync(join(legacyDir, 'crash.log'), 'previous crash\n', 'utf8')
    writeFileSync(join(legacyDir, 'Cache', 'blob'), 'skip-me', 'utf8')
    writeFileSync(join(legacyDir, 'Partitions', 'p1', 'cookie'), 'skip-me', 'utf8')

    const report = await client.call<{ migrated: boolean; copiedFiles: string[] }>('state.migrateUserData')
    expect(report.migrated).toBe(true)
    expect(existsSync(join(currentSandbox.userDataDir, CURRENT_STATE_FILE))).toBe(true)
    expect(existsSync(join(currentSandbox.userDataDir, 'agent-message-signing.key'))).toBe(true)
    expect(existsSync(join(currentSandbox.userDataDir, 'voice-secrets.json'))).toBe(true)
    expect(existsSync(join(currentSandbox.userDataDir, 'crash.log'))).toBe(true)
    expect(existsSync(join(currentSandbox.userDataDir, 'Cache'))).toBe(false)
    expect(existsSync(join(currentSandbox.userDataDir, 'Partitions'))).toBe(false)
    expect(existsSync(join(legacyDir, 'prime-work-state-v4.json'))).toBe(true)

    await client.call('state.open')
    const snapshot = await client.call<{ projects: Array<{ id: string }> }>('state.getSnapshot')
    expect(snapshot.projects.map((p) => p.id)).toEqual(['from-gooeypi'])

    // Second migration run must skip because omp-desktop-state-v4.json now exists.
    const skipped = await client.call<{ migrated: boolean; reason?: string }>('state.migrateUserData')
    expect(skipped).toMatchObject({ migrated: false, reason: 'new-state-exists' })
  })
})
