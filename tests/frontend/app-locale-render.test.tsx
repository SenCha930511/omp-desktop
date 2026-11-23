// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import '../../src/pages/SettingsPage'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import type { AppMeta, AppSettings, DesktopApi, HarnessUpdateState, LocalePreference } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  Object.defineProperty(window, 'desktop', { configurable: true, value: undefined })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Object.defineProperty(window, 'desktop', { configurable: true, value: undefined })
  vi.restoreAllMocks()
})

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await act(async () => { await Promise.resolve() })
}

function selectLocale(locale: LocalePreference): void {
  const select = [...container.querySelectorAll('select')].find((candidate) =>
    ['en', 'zh-TW', 'zh-CN'].every((value) => [...candidate.options].some((option) => option.value === value)),
  )
  expect(select, 'language selector').toBeDefined()
  select!.value = locale
  select!.dispatchEvent(new Event('change', { bubbles: true }))
}

function rootLabel(): string | null {
  return container.querySelector('.panel-scrim--sidebar')?.getAttribute('aria-label') ?? null
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  return Promise.withResolvers<T>()
}

function createUpdateBridge(install: Promise<HarnessUpdateState>, settings: AppSettings): DesktopApi {
  const meta: AppMeta = {
    version: 'test', platform: 'linux', homeDir: '/home/test',
    harnesses: { omp: { path: '/usr/bin/omp', version: '17.2.15' } },
  }
  return {
    app: {
      getMeta: vi.fn(async () => meta), refreshHarnesses: vi.fn(async () => ({ meta, settings })),
      openExternal: vi.fn(async () => true), revealPath: vi.fn(async () => true), setTitleBarTheme: vi.fn(async () => true),
      onOpenSettings: vi.fn(() => () => undefined),
    },
    updates: {
      getState: vi.fn(async () => ({ phase: 'idle' as const })), check: vi.fn(async () => ({ phase: 'idle' as const })),
      downloadAndInstall: vi.fn(async () => true), onChanged: vi.fn(() => () => undefined),
    },
    harnessUpdates: {
      getState: vi.fn(async () => ({ phase: 'available' as const, availableVersion: '17.3.0' })),
      install: vi.fn(() => install), onChanged: vi.fn(() => () => undefined),
    },
    projects: {
      list: vi.fn(async () => []), listCheckouts: vi.fn(async () => ({ strategy: 'worktree' as const, activePath: '/repo', checkouts: [] })),
      listFiles: vi.fn(async () => ({ entries: [], skipped: 0 })), add: vi.fn(async () => null), grantInferred: vi.fn(async () => null),
      executeCheckout: vi.fn(async () => ({ kind: 'unchanged' as const })), relocate: vi.fn(async () => null), remove: vi.fn(async () => true),
      touch: vi.fn(async () => true), setPinned: vi.fn(async () => true), updateScripts: vi.fn(async () => ({ setup: '', run: '' })),
      markSetupStarted: vi.fn(async () => ({ setup: '', run: '' })), finishSetup: vi.fn(async () => undefined),
    },
    projectScripts: { start: vi.fn(), stop: vi.fn(async () => true), onExit: vi.fn(() => () => undefined) },
    sessions: {
      list: vi.fn(async () => []), sync: vi.fn(async () => ({ revision: 0, sessions: [] })), read: vi.fn(async () => []),
      rename: vi.fn(async () => true), archive: vi.fn(async () => true), branch: vi.fn(async () => ({})), setPinned: vi.fn(async () => undefined),
      delete: vi.fn(async () => true), onChanged: vi.fn(() => () => undefined),
    },
    agent: {
      list: vi.fn(async () => []), start: vi.fn(async () => undefined), command: vi.fn(async () => ({})), refreshState: vi.fn(async () => ({})),
      stop: vi.fn(async () => true), onEvent: vi.fn(() => () => undefined),
    },
    providers: { catalog: vi.fn(async () => ({ models: [], providers: [] })) },
    plugins: {
      list: vi.fn(async () => ({ skills: [], warnings: [] })), refresh: vi.fn(async () => ({ skills: [], warnings: [] })),
      install: vi.fn(), installExtension: vi.fn(), connectMcp: vi.fn(), setMcpEnabled: vi.fn(), mutateCapability: vi.fn(),
    },
    browser: {
      state: vi.fn(async () => ({ tabs: [] })), attachTab: vi.fn(), selectTab: vi.fn(), closeTab: vi.fn(), setPreviewContext: vi.fn(), navigateTab: vi.fn(),
      onChanged: vi.fn(() => () => undefined), onPointer: vi.fn(() => () => undefined), onActivity: vi.fn(() => () => undefined),
    },
    schedules: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => undefined) },
    settings: {
      get: vi.fn(async () => settings), update: vi.fn(async (patch) => ({ ...settings, ...patch })), resetBrowserData: vi.fn(async () => true),
    },
    git: { status: vi.fn(async () => ({ isRepo: false, files: [] })) },
    voice: { credentialStatus: vi.fn(async () => ({ providers: [] })) },
    menu: { popup: vi.fn(async () => null) },
  } as unknown as DesktopApi
}

describe('root App locale rendering', () => {
  it('changes root labels en → zh-TW → en without a bridge or stale stable-callback paint', async () => {
    await act(async () => root.render(<App />))
    expect(rootLabel()).toBe('Close sidebar')

    const settingsButton = container.querySelector<HTMLButtonElement>('button[title="Settings"]')
    expect(settingsButton).not.toBeNull()
    await act(async () => { settingsButton!.click() })
    await flushPromises()
    const appearanceButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Appearance')
    expect(appearanceButton).toBeDefined()
    await act(async () => { appearanceButton!.click() })
    await act(async () => { selectLocale('zh-TW') })
    expect(rootLabel()).toBe('關閉側欄')
    expect(container.querySelector('[aria-label="調整側欄大小"]')).not.toBeNull()

    await act(async () => { selectLocale('en') })
    expect(rootLabel()).toBe('Close sidebar')
    expect(container.querySelector('[aria-label="Resize sidebar"]')).not.toBeNull()
  })

  it('uses the locale at a deferred harness-install settlement and preserves exact version data', async () => {
    const installation = deferred<HarnessUpdateState>()
    const settings = { ...DEFAULT_SETTINGS, activeHarness: 'omp' as const, locale: 'en' as const }
    const bridge = createUpdateBridge(installation.promise, settings)
    Object.defineProperty(window, 'desktop', { configurable: true, value: bridge })
    await act(async () => root.render(<App />))
    await flushPromises()

    const updateButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Update now')
    expect(updateButton).toBeDefined()
    await act(async () => { updateButton!.click() })
    expect(vi.mocked(bridge.harnessUpdates.install)).toHaveBeenCalledTimes(1)

    const settingsButton = container.querySelector<HTMLButtonElement>('button[title="Settings"]')
    expect(settingsButton).not.toBeNull()
    await act(async () => { settingsButton!.click() })
    await flushPromises()
    const appearanceButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Appearance')
    expect(appearanceButton).toBeDefined()
    await act(async () => { appearanceButton!.click() })
    await act(async () => { selectLocale('zh-TW') })
    await act(async () => { installation.resolve({ phase: 'installed', availableVersion: '17.3.0' }); await installation.promise })
    await flushPromises()

    expect(container.querySelector('.toast')?.textContent).toContain('OMP 已更新至 17.3.0。')
    expect(container.querySelector('.toast')?.textContent).not.toContain('OMP updated to 17.3.0.')
  })
})
