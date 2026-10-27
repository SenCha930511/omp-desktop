import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  app: {},
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
}))

vi.mock('electron', () => electronMocks)

import { registerIpc, type IpcRegistration } from '../../electron/main/ipc'
import type { PrimeModelDescriptor } from '../../src/types/api'

const EXPECTED_URL = 'omp-desktop://app/'
const OMP_SESSION = '/home/user/.omp/agent/sessions/bucket/session.jsonl'


function serviceStub(): Record<string, unknown> {
  return new Proxy({}, { get: () => vi.fn(async () => undefined) })
}

interface TestServices {
  refreshHarnesses: Mock
  agents: { start: Mock; command: Mock; refreshState: Mock; stop: Mock; list: Mock }
  sessions: { list: Mock; read: Mock; rename: Mock; archive: Mock; branch: Mock; setPinned: Mock }
  projects: { list: Mock; grantInferred: Mock }
  checkouts: { list: Mock; execute: Mock }
  plugins: Record<string, Mock>
  catalog: { catalog: Mock }
  settings: { get: Mock; update: Mock }
  schedules: { list: Mock; create: Mock }
  browser: { closeForSession: Mock }
  terminals: { killForSession: Mock }
  harnessUpdates: { getState: Mock; install: Mock }
}

interface Harness {
  invoke(channel: string, ...args: unknown[]): unknown
  services: TestServices
  registration: IpcRegistration
}

function buildServices() {
  const settingsState: Record<string, unknown> = {}
  const catalog = (from: string) => {
    const models: PrimeModelDescriptor[] = [
      { key: 'anthropic/claude', provider: 'anthropic', id: 'claude', name: 'Claude', reasoning: true, input: ['text'], contextWindow: 128_000, maxTokens: 16_000, availableThinkingLevels: ['low', 'high', 'max'], fastModeSupported: true, available: true },
      { key: 'openai/gpt', provider: 'openai', id: 'gpt', name: 'GPT', reasoning: true, input: ['text'], contextWindow: 128_000, maxTokens: 16_000, availableThinkingLevels: ['low', 'high', 'max'], fastModeSupported: true, available: true },
      { key: 'openai/gpt-mini', provider: 'openai', id: 'gpt-mini', name: 'GPT Mini', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_000, availableThinkingLevels: ['off'], fastModeSupported: false, available: true },
    ]
    return {
      from,
      models,
      providers: [
        { id: 'anthropic', name: 'Anthropic', authMethod: 'api_key' as const, configured: true, modelCount: 1, availableModelCount: 1 },
        { id: 'openai', name: 'OpenAI', authMethod: 'api_key' as const, configured: true, modelCount: 2, availableModelCount: 2 },
      ],
      primeVersion: 'test', refreshedAt: '2026-01-01T00:00:00.000Z',
    }
  }
  const ompSessionGate = vi.fn(async (path: unknown) => {
    if (path === OMP_SESSION) return path
    throw new TypeError('Session path is outside the OMP session directory')
  })
  return {
    meta: { version: '0.0.0-test' },
    refreshHarnesses: vi.fn(async () => ({ meta: { version: '0.0.0-refreshed' }, settings: settingsState })),
    projects: { ...serviceStub(), list: vi.fn(async () => ['omp-projects']), grantInferred: vi.fn(async () => 'omp-grant') },
    checkouts: {
      list: vi.fn(async () => 'omp-checkouts'),
      execute: vi.fn(async () => 'omp-checkout'),
    },
    sessions: {
      ...serviceStub(),
      onDidChange: vi.fn(() => () => undefined),
      requireSessionPath: ompSessionGate,
      list: vi.fn(async () => ['omp-sessions']),
      read: vi.fn(async () => ['omp-transcript']),
      rename: vi.fn(async () => false),
      archive: vi.fn(async () => true),
      branch: vi.fn(async () => ({ id: 'omp-branched' })),
      setPinned: vi.fn(async () => undefined),
    },
    agents: {
      ...serviceStub(),
      has: vi.fn((id: string) => id === 'omp-runtime'),
      start: vi.fn(async (options: unknown) => ({ started: 'omp', options })),
      command: vi.fn(async () => ({ ok: 'omp' })),
      refreshState: vi.fn(async () => ({ runtimeId: 'omp-runtime', harness: 'omp', synchronized: true })),
      stop: vi.fn(async () => true),
      list: vi.fn(() => [{ runtimeId: 'omp-runtime', harness: 'omp' }]),
    },
    terminals: { ...serviceStub(), killForSession: vi.fn(async () => undefined) },
    git: serviceStub(),
    plugins: { ...serviceStub(), list: vi.fn(async () => 'omp-plugins'), install: vi.fn(async () => undefined), installExtension: vi.fn(async () => undefined), connectMcp: vi.fn(async () => undefined), setMcpEnabled: vi.fn(async () => undefined), refresh: vi.fn(async () => 'omp-plugins') },
    catalog: { catalog: vi.fn(async (_force: unknown) => catalog('omp')) },
    settings: {
      ...serviceStub(),
      get: vi.fn(() => settingsState),
      update: vi.fn(async (patch: Record<string, unknown>) => { Object.assign(settingsState, patch); return settingsState }),
    },
    schedules: { ...serviceStub(), onDidChange: vi.fn(() => () => undefined), list: vi.fn(() => 'scheduled'), create: vi.fn(async () => 'created') },
    browser: { ...serviceStub(), closeForSession: vi.fn(() => true), onDidChange: vi.fn(() => vi.fn()), onPointer: vi.fn(() => vi.fn()), onActivity: vi.fn(() => vi.fn()) },
    harnessUpdates: { ...serviceStub(), getState: vi.fn(async () => ({ phase: 'idle' })), install: vi.fn(async () => ({ phase: 'idle' })) },
  }
}

describe('harness-aware IPC routing', () => {
  let harness: Harness

  beforeEach(() => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    electronMocks.ipcMain.handle.mockReset()
    electronMocks.ipcMain.on.mockReset()
    electronMocks.ipcMain.handle.mockImplementation((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    })
    const services = buildServices()
    const registration = registerIpc(services as never, EXPECTED_URL)
    const mainFrame = { url: EXPECTED_URL }
    const sender = { id: 1, isDestroyed: () => false, getURL: () => EXPECTED_URL, mainFrame }
    registration.authorize(sender as never)
    const event = { sender, senderFrame: mainFrame }
    harness = {
      invoke: (channel, ...args) => handlers.get(channel)!(event, ...args),
      services,
      registration,
    }
  })

  afterEach(() => {
    harness.registration.dispose()
  })

  it('exposes harness refresh through the fixed authorized app channel', async () => {
    await expect(harness.invoke('app:refresh-harnesses')).resolves.toMatchObject({ meta: { version: '0.0.0-refreshed' } })
    expect(harness.services.refreshHarnesses).toHaveBeenCalledTimes(1)
  })

  it('rejects harness values outside the strict enum on every routed channel', async () => {
    await expect(async () => harness.invoke('sessions:list', undefined, false, 'OMP')).rejects.toThrow('Invalid harness')
    await expect(async () => harness.invoke('providers:catalog', false, 'prime')).rejects.toThrow('Invalid harness')
    await expect(async () => harness.invoke('agent:start', { cwd: '/tmp', harness: 1 })).rejects.toThrow('Invalid harness')
    await expect(async () => harness.invoke('sessions:list', undefined, false, 'PI')).rejects.toThrow('Invalid harness')
    await expect(async () => harness.invoke('plugins:list', undefined, 'pi')).rejects.toThrow('Invalid harness')
    await expect(async () => harness.invoke('schedules:list', 'prime')).rejects.toThrow('Invalid harness')
    expect(harness.services.agents.start).not.toHaveBeenCalled()
  })

  it('routes agent:start to the single manager and strips the routing field before it sees the options', async () => {
    await expect(harness.invoke('agent:start', { cwd: '/work', harness: 'omp' })).resolves.toEqual({ started: 'omp', options: { cwd: '/work' } })
    expect(harness.services.agents.start).toHaveBeenCalledWith({ cwd: '/work' })
    await expect(harness.invoke('agent:start', { cwd: '/work' })).resolves.toEqual({ started: 'omp', options: { cwd: '/work' } })
    expect(harness.services.agents.start).toHaveBeenLastCalledWith({ cwd: '/work' })
  })

  it('routes agent:command and agent:stop through the single manager', async () => {
    await expect(harness.invoke('agent:command', 'omp-runtime', { type: 'abort' })).resolves.toEqual({ ok: 'omp' })
    expect(harness.services.agents.command).toHaveBeenCalledWith('omp-runtime', { type: 'abort' })

    // An id the manager does not own still reaches it, preserving its exact
    // requireRuntime error semantics.
    await harness.invoke('agent:command', 'missing-runtime', { type: 'abort' })
    expect(harness.services.agents.command).toHaveBeenCalledWith('missing-runtime', { type: 'abort' })

    await expect(harness.invoke('agent:stop', 'omp-runtime')).resolves.toBe(true)
    expect(harness.services.agents.stop).toHaveBeenCalledWith('omp-runtime')
  })

  it('routes agent:refresh-state with a validated runtime id for the sync-pending retry', async () => {
    await expect(harness.invoke('agent:refresh-state', 'omp-runtime')).resolves.toEqual({ runtimeId: 'omp-runtime', harness: 'omp', synchronized: true })
    expect(harness.services.agents.refreshState).toHaveBeenCalledWith('omp-runtime')

    await expect(async () => harness.invoke('agent:refresh-state', 42)).rejects.toThrow('runtimeId must be a string')
    await expect(async () => harness.invoke('agent:refresh-state', '')).rejects.toThrow('runtimeId is too short')
    // Both malformed calls failed validation before reaching the manager.
    expect(harness.services.agents.refreshState).toHaveBeenCalledTimes(1)
  })

  it('returns the single manager list for agent:list', () => {
    expect(harness.invoke('agent:list')).toEqual([{ runtimeId: 'omp-runtime', harness: 'omp' }])
  })

  it('routes sessions:list and projects channels with an optional omp harness argument', async () => {
    await expect(harness.invoke('sessions:list', undefined, false)).resolves.toEqual(['omp-sessions'])
    await expect(harness.invoke('sessions:list', undefined, false, 'omp')).resolves.toEqual(['omp-sessions'])
    await expect(harness.invoke('sessions:list', '/repo', true, 'omp', true)).resolves.toEqual(['omp-sessions'])
    expect(harness.services.sessions.list).toHaveBeenLastCalledWith('/repo', true, true)
    await expect(harness.invoke('projects:list')).resolves.toEqual(['omp-projects'])
    await expect(harness.invoke('projects:list', 'omp')).resolves.toEqual(['omp-projects'])
    await expect(harness.invoke('projects:grant-inferred', '/somewhere', 'omp')).resolves.toBe('omp-grant')
    expect(harness.services.projects.grantInferred).toHaveBeenCalledWith('/somewhere')
    await expect(harness.invoke('projects:list-checkouts', 'project', 'omp')).resolves.toBe('omp-checkouts')
    await expect(harness.invoke('projects:execute-checkout', 'project', { strategy: 'branch', operation: 'switch', branch: 'feature' }, 'omp')).resolves.toBe('omp-checkout')
    expect(harness.services.checkouts.list).toHaveBeenCalledWith('project')
    expect(harness.services.checkouts.execute).toHaveBeenCalledWith('project', { strategy: 'branch', operation: 'switch', branch: 'feature' })
  })

  it('routes plugin catalog, installation, and MCP configuration with the omp harness argument', async () => {
    await harness.invoke('plugins:list', '/repo', 'omp')
    expect(harness.services.plugins.list).toHaveBeenCalledWith('/repo')

    await harness.invoke('plugins:install', 'npm:example', 'omp')
    expect(harness.services.plugins.install).toHaveBeenCalledWith('npm:example')
    await harness.invoke('plugins:install-extension', { source: '/tmp/example.ts', scope: 'user' }, 'omp')
    expect(harness.services.plugins.installExtension).toHaveBeenCalledWith({ source: '/tmp/example.ts', scope: 'user' })
    await harness.invoke('plugins:connect-mcp', { name: 'docs' }, 'omp')
    expect(harness.services.plugins.connectMcp).toHaveBeenCalledWith({ name: 'docs' })
    await harness.invoke('plugins:set-mcp-enabled', { name: 'docs', scope: 'user', enabled: false }, 'omp')
    expect(harness.services.plugins.setMcpEnabled).toHaveBeenCalledWith({ name: 'docs', scope: 'user', enabled: false })
    await harness.invoke('plugins:refresh', 'omp')
    expect(harness.services.plugins.refresh).toHaveBeenCalledOnce()

    await expect(async () => harness.invoke('plugins:list', undefined, 'OMP')).rejects.toThrow('Invalid harness')
  })

  it('routes session file operations through the omp session root authorization', async () => {
    await expect(harness.invoke('sessions:read', OMP_SESSION)).resolves.toEqual(['omp-transcript'])
    expect(harness.services.sessions.read).toHaveBeenCalledWith(OMP_SESSION)

    // A path the root does not contain fails with the session service's own error.
    await expect(async () => harness.invoke('sessions:read', '/etc/passwd')).rejects.toThrow('outside the OMP session directory')

    await expect(harness.invoke('sessions:rename', OMP_SESSION, 'Title')).resolves.toBe(false)
    expect(harness.services.sessions.rename).toHaveBeenCalledWith(OMP_SESSION, 'Title')
    await expect(harness.invoke('sessions:archive', OMP_SESSION, true)).resolves.toBe(true)
    expect(harness.services.sessions.archive).toHaveBeenCalledWith(OMP_SESSION, true)
    expect(harness.services.browser.closeForSession).toHaveBeenCalledWith(OMP_SESSION)
    expect(harness.services.terminals.killForSession).toHaveBeenCalledWith(OMP_SESSION)

    harness.services.browser.closeForSession.mockClear()
    harness.services.terminals.killForSession.mockClear()
    await expect(harness.invoke('sessions:archive', OMP_SESSION, false)).resolves.toBe(true)
    expect(harness.services.browser.closeForSession).not.toHaveBeenCalled()
    expect(harness.services.terminals.killForSession).not.toHaveBeenCalled()
  })

  it('does not register the removed follow-up, credential, or heartbeat channels', () => {
    for (const channel of ['sessions:follow-up', 'providers:save-api-key', 'providers:logout', 'providers:start-oauth', 'providers:respond-oauth', 'providers:cancel-oauth', 'providers:set-enabled', 'providers:set-disabled', 'providers:set-model-enabled', 'plugins:set-mcp-support', 'heartbeats:list', 'heartbeats:manage']) {
      expect(electronMocks.ipcMain.handle).not.toHaveBeenCalledWith(channel, expect.any(Function))
    }
  })

  it('routes providers:catalog', async () => {
    await expect(harness.invoke('providers:catalog', true)).resolves.toMatchObject({ from: 'omp' })
    expect(harness.services.catalog.catalog).toHaveBeenCalledWith(true)

    await expect(harness.invoke('providers:catalog', true, 'omp')).resolves.toMatchObject({ from: 'omp' })
    expect(harness.services.catalog.catalog).toHaveBeenCalledWith(true)
  })

  it('does not register MCP-specific authentication or credential cleanup channels', () => {
    expect(electronMocks.ipcMain.handle).not.toHaveBeenCalledWith('providers:start-mcp-oauth', expect.any(Function))
    expect(electronMocks.ipcMain.handle).not.toHaveBeenCalledWith('providers:logout-mcp', expect.any(Function))
  })

  it('routes the harness update channels to the omp update service', async () => {
    await expect(harness.invoke('harnessUpdates:get-state')).resolves.toEqual({ phase: 'idle' })
    await expect(harness.invoke('harnessUpdates:install')).resolves.toEqual({ phase: 'idle' })
    expect(harness.services.harnessUpdates.getState).toHaveBeenCalledTimes(1)
    expect(harness.services.harnessUpdates.install).toHaveBeenCalledTimes(1)
  })

  it('routes schedules channels with the omp harness argument', async () => {
    expect(harness.invoke('schedules:list', 'omp')).toBe('scheduled')
    expect(harness.services.schedules.list).toHaveBeenCalledWith('omp')
    await expect(harness.invoke('schedules:create', { prompt: 'p' }, 'omp')).resolves.toBe('created')
    expect(harness.services.schedules.create).toHaveBeenCalledWith({ prompt: 'p' }, 'user', 'omp')
  })

  it('routes sessions:branch and sessions:setPinned through the omp session root authorization', async () => {
    await expect(harness.invoke('sessions:branch', OMP_SESSION)).resolves.toEqual({ id: 'omp-branched' })
    expect(harness.services.sessions.branch).toHaveBeenCalledWith(OMP_SESSION)
    await expect(harness.invoke('sessions:setPinned', OMP_SESSION, true)).resolves.toBeUndefined()
    expect(harness.services.sessions.setPinned).toHaveBeenCalledWith(OMP_SESSION, true)
    await expect(async () => harness.invoke('sessions:branch', '/etc/passwd')).rejects.toThrow('outside the OMP session directory')
    await expect(async () => harness.invoke('sessions:setPinned', '/etc/passwd', true)).rejects.toThrow('outside the OMP session directory')
  })

  it('rejects malformed menu:popup payloads before any native menu is built', async () => {
    const buildFromTemplate = electronMocks.Menu.buildFromTemplate
    buildFromTemplate.mockReset()
    await expect(async () => harness.invoke('menu:popup', 'not-an-array')).rejects.toThrow('items must be an array')
    await expect(async () => harness.invoke('menu:popup', Array.from({ length: 25 }, () => ({ id: 'a', label: 'A' })))).rejects.toThrow('items must be an array')
    await expect(async () => harness.invoke('menu:popup', ['item'])).rejects.toThrow('items[0] must be an object')
    await expect(async () => harness.invoke('menu:popup', [{ label: 'A' }])).rejects.toThrow('items[0].id must be a string')
    await expect(async () => harness.invoke('menu:popup', [{ id: '', label: 'A' }])).rejects.toThrow('items[0].id is too short')
    await expect(async () => harness.invoke('menu:popup', [{ id: 'a'.repeat(65), label: 'A' }])).rejects.toThrow('items[0].id is too long')
    await expect(async () => harness.invoke('menu:popup', [{ id: 'a', label: 'A' }, { id: 'b' }])).rejects.toThrow('items[1].label is too short')
    await expect(async () => harness.invoke('menu:popup', [{ id: 'a', label: 'x'.repeat(201) }])).rejects.toThrow('items[0].label is too long')
    await expect(async () => harness.invoke('menu:popup', [{ id: 'a', label: 'A', enabled: 'yes' }])).rejects.toThrow('items[0].enabled must be a boolean')
    await expect(async () => harness.invoke('menu:popup', [{ id: 'a', label: 'A', separator: 1 }])).rejects.toThrow('items[0].separator must be a boolean')
    await expect(async () => harness.invoke('menu:popup', [{ id: 'a', label: 'A', role: 'cut' }])).rejects.toThrow('items[0].role is not supported')
    expect(buildFromTemplate).not.toHaveBeenCalled()
  })

  it('builds the native menu from validated items and resolves the first settle only', async () => {
    const buildFromTemplate = electronMocks.Menu.buildFromTemplate
    const popup = vi.fn()
    buildFromTemplate.mockReset()
    buildFromTemplate.mockReturnValue({ popup })
    const items = [
      { id: 'branch', label: 'Branch' },
      { id: 'sep', label: '', separator: true },
      { id: 'pin', label: 'Pin', enabled: false },
    ]

    const pending = harness.invoke('menu:popup', items)
    const template = buildFromTemplate.mock.calls[0]?.[0] as Array<Record<string, unknown>>
    expect(template).toEqual([
      { label: 'Branch', enabled: true, click: expect.any(Function) },
      { type: 'separator' },
      { label: 'Pin', enabled: false, click: expect.any(Function) },
    ])
    expect(popup).toHaveBeenCalledWith({ callback: expect.any(Function) })

    ;(template[0].click as () => void)()
    const firstPopupOptions = popup.mock.calls[0]?.[0] as { callback: () => void } | undefined
    firstPopupOptions?.callback()
    await expect(pending).resolves.toBe('branch')

    const dismissed = harness.invoke('menu:popup', [])
    const lastPopupOptions = popup.mock.calls.at(-1)?.[0] as { callback: () => void } | undefined
    lastPopupOptions?.callback()
    await expect(dismissed).resolves.toBeNull()
  })
})
