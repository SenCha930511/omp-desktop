// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import type { AppMeta, DesktopApi, ProjectRecord, ProjectScriptExitEvent, ProjectScriptStartOptions } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project-1',
  harness: 'omp',
  name: 'GooeyPi',
  path: '/repo',
  folders: ['/repo'],
  primaryFolder: '/repo',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-02-01T00:00:00.000Z',
  sessionCount: 0,
  scripts: { setup: 'npm install', run: 'npm run dev' },
}

const meta: AppMeta = {
  version: 'test',
  platform: 'linux',
  homeDir: '/home/test',
  harnesses: {
    omp: { path: '/usr/bin/omp', version: 'test' },
  },
}

let settings = { ...DEFAULT_SETTINGS, activeHarness: 'omp' as const }
let bridge: DesktopApi
let container: HTMLDivElement
let root: Root
let emitExit: (event: ProjectScriptExitEvent) => void

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS, activeHarness: 'omp' }
  const start = vi.fn(async (options: ProjectScriptStartOptions) => ({ runId: options.runId }))
  const stop = vi.fn(async () => true)
  const markSetupStarted = vi.fn(async () => ({ setup: 'npm install', run: 'npm run dev', setupLastRun: 'npm install' }))
  const finishSetup = vi.fn(async () => ({ setup: 'npm install', run: 'npm run dev', setupLastRun: 'npm install', setupLastExitCode: 0 }))
  bridge = {
    app: {
      getMeta: vi.fn(async () => meta),
      refreshHarnesses: vi.fn(async () => ({ meta, settings })),
      openExternal: vi.fn(async () => true),
      revealPath: vi.fn(async () => true),
      popupMenu: vi.fn(async () => true),
      setTitleBarTheme: vi.fn(async () => true),
      onOpenSettings: vi.fn(() => () => undefined),
    },
    updates: {
      getState: vi.fn(async () => ({ phase: 'idle' as const })),
      check: vi.fn(async () => ({ phase: 'idle' as const })),
      downloadAndInstall: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
    },
    harnessUpdates: {
      getState: vi.fn(async () => ({ phase: 'idle' as const })),
      install: vi.fn(async () => ({ phase: 'idle' as const })),
      onChanged: vi.fn(() => () => undefined),
    },
    projects: {
      list: vi.fn(async () => [project]),
      listFiles: vi.fn(async () => ({ entries: [], skipped: 0 })),
      listCheckouts: vi.fn(async () => ({ strategy: 'worktree' as const, activePath: '/repo', checkouts: [] })),
      executeCheckout: vi.fn(async () => ({ kind: 'unchanged' as const })),
      add: vi.fn(async () => null),
      grantInferred: vi.fn(async () => project),
      relocate: vi.fn(async () => project),
      remove: vi.fn(async () => true),
      touch: vi.fn(async () => true),
      setPinned: vi.fn(async () => true),
      updateScripts: vi.fn(async () => ({ setup: 'npm install', run: 'npm run dev' })),
      markSetupStarted,
      finishSetup,
    },
    projectScripts: {
      start,
      stop,
      onOutput: vi.fn(() => () => undefined),
      onExit: vi.fn((callback: (event: ProjectScriptExitEvent) => void) => {
        emitExit = callback
        return () => undefined
      }),
    },
    menu: { popup: vi.fn(async () => null) },
    sessions: {
      list: vi.fn(async () => []),
      sync: vi.fn(async () => ({ revision: 0, sessions: [] })),
      read: vi.fn(async () => []),
      rename: vi.fn(async () => true),
      archive: vi.fn(async () => true),
      branch: vi.fn(async () => ({})),
      setPinned: vi.fn(async () => undefined),
      delete: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
    },
    agent: {
      start: vi.fn(async () => undefined),
      command: vi.fn(async () => ({})),
      refreshState: vi.fn(async () => ({})),
      stop: vi.fn(async () => true),
      list: vi.fn(async () => []),
      onEvent: vi.fn(() => () => undefined),
    },
    providers: { catalog: vi.fn(async () => ({ models: [], providers: [] })) },
    voice: {
      credentialStatus: vi.fn(async () => ({ providers: [] })),
      saveApiKey: vi.fn(async () => ({ providers: [] })),
      deleteApiKey: vi.fn(async () => ({ providers: [] })),
      createRealtimeCall: vi.fn(async () => ''),
      transcribe: vi.fn(async () => ''),
      testSelfHosted: vi.fn(async () => true),
    },
    terminal: {
      create: vi.fn(async () => ({ terminalId: 'terminal', shell: '/bin/sh' })),
      bindSession: vi.fn(async () => true),
      input: vi.fn(),
      acknowledge: vi.fn(),
      resize: vi.fn(),
      setActiveContext: vi.fn(),
      clearActiveContext: vi.fn(),
      kill: vi.fn(async () => true),
      onData: vi.fn(() => () => undefined),
      onExit: vi.fn(() => () => undefined),
    },
    plugins: {
      list: vi.fn(async () => ({ skills: [], warnings: [] })),
      install: vi.fn(async () => ({ ok: true, output: '' })),
      installExtension: vi.fn(async () => ({ ok: true, output: '' })),
      connectMcp: vi.fn(async () => ({ ok: true, output: '' })),
      setMcpEnabled: vi.fn(async () => ({ ok: true, output: '' })),
      mutateCapability: vi.fn(async () => ({ ok: true, output: '' })),
      refresh: vi.fn(async () => ({ skills: [], warnings: [] })),
    },
    browser: {
      state: vi.fn(async () => ({ tabs: [] })),
      attachTab: vi.fn(async () => true),
      selectTab: vi.fn(async () => true),
      closeTab: vi.fn(async () => true),
      setPreviewContext: vi.fn(async () => true),
      navigateTab: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
      onPointer: vi.fn(() => () => undefined),
      onActivity: vi.fn(() => () => undefined),
    },
    schedules: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({})),
      create: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      pause: vi.fn(async () => true),
      resume: vi.fn(async () => true),
      delete: vi.fn(async () => true),
      runNow: vi.fn(async () => true),
      preview: vi.fn(async (timing) => ({ timing, occurrences: [] })),
      onChanged: vi.fn(() => () => undefined),
    },
    settings: {
      get: vi.fn(async () => settings),
      update: vi.fn(async (patch) => {
        settings = { ...settings, ...patch }
        return settings
      }),
      resetBrowserData: vi.fn(async () => true),
    },
    git: {
      status: vi.fn(async () => ({ isRepo: false, files: [] })),
      diff: vi.fn(async () => ({ staged: false, text: '', truncated: false })),
      stage: vi.fn(async () => true),
      unstage: vi.fn(async () => true),
      restore: vi.fn(async () => true),
      commit: vi.fn(async () => ({ ok: true, output: '' })),
    },
  } as unknown as DesktopApi
  Object.defineProperty(window, 'desktop', { configurable: true, value: bridge })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  // Bootstrap promises resolve after the assertions; let their state updates
  // land inside act() instead of racing the worker teardown.
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 30)) })
  await act(async () => root.unmount())
  await new Promise((resolve) => window.setTimeout(resolve, 10))
  container.remove()
  Object.defineProperty(window, 'desktop', { configurable: true, value: undefined })
  vi.restoreAllMocks()
})

async function waitFor<T>(read: () => T | null | undefined): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < 4_000) {
    const value = read()
    if (value) return value
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)) })
  }
  throw new Error('Timed out waiting for the app')
}

describe('project script wiring in App', () => {
  it('runs the pending setup script through the headless bridge and records its exit', async () => {
    await act(async () => root.render(<App />))
    await waitFor(() => vi.mocked(bridge.projectScripts.start).mock.calls.length > 0)

    const options = vi.mocked(bridge.projectScripts.start).mock.calls[0][0]
    expect(options).toMatchObject({ projectId: 'project-1', kind: 'setup', cwd: '/repo', command: 'npm install' })
    expect(options.runId).toEqual(expect.any(String))
    expect(vi.mocked(bridge.projects.markSetupStarted).mock.calls[0]).toEqual(['project-1', 'npm install', 'omp'])
    expect(vi.mocked(bridge.projects.markSetupStarted).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(bridge.projectScripts.start).mock.invocationCallOrder[0])

    await act(async () => { emitExit({ runId: options.runId, exitCode: 0, cancelled: false }) })
    await waitFor(() => container.querySelector('.toast'))

    expect(vi.mocked(bridge.projects.finishSetup).mock.calls[0]).toEqual(['project-1', 'npm install', 0, 'omp'])
    expect(container.querySelector('.toast')?.textContent).toContain('Setup completed')
  })

  it('stops the headless run when the thread view is left', async () => {
    await act(async () => root.render(<App />))
    await waitFor(() => vi.mocked(bridge.projectScripts.start).mock.calls.length > 0)
    const runId = vi.mocked(bridge.projectScripts.start).mock.calls[0][0].runId

    const projectsNav = await waitFor(() => container.querySelector<HTMLButtonElement>('button[title="Projects"]'))
    await act(async () => {
      projectsNav.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      projectsNav.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => vi.mocked(bridge.projectScripts.stop).mock.calls.length > 0)
    expect(vi.mocked(bridge.projectScripts.stop).mock.calls[0][0]).toBe(runId)
    expect(vi.mocked(bridge.projects.finishSetup)).not.toHaveBeenCalled()
  })
})
