import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  app: {
    getAppPath: vi.fn(() => '/tmp/omp-desktop'),
    isPackaged: false,
    on: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => false),
  },
  BrowserWindow: class {},
  dialog: { showMessageBoxSync: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: {},
  Tray: class {},
}))

vi.mock('electron', () => electron)

import { extensionRuntimeEnvironment, type CapabilityExtensionPaths } from '../../electron/main/index'
import { OMP_RPC_ADAPTER } from '../../electron/main/agent-rpc'

const extensionPaths: CapabilityExtensionPaths = {
  schedule: '/app/extensions/omp-work-schedules.ts',
  browser: '/app/extensions/omp-work-browser.ts',
  askUser: '/app/extensions/omp-work-ask-user.ts',
}

/** What the schedule and browser bridges hand every runtime of the harness. */
const scheduleBridgeEnvironment = {
  OMP_DESKTOP_SCHEDULE_URL: 'http://127.0.0.1:45001',
  OMP_DESKTOP_SCHEDULE_TOKEN: 'schedule-token',
  OMP_DESKTOP_SCHEDULE_SKILL_PATH: '/app/skills/omp-desktop-schedules',
}
const browserBridgeEnvironment = {
  OMP_DESKTOP_BROWSER_URL: 'http://127.0.0.1:45002',
  OMP_DESKTOP_BROWSER_TOKEN: 'browser-token',
  OMP_DESKTOP_BROWSER_EXTENSION_PATH: '/app/extensions/omp-desktop-browser.ts',
  OMP_DESKTOP_BROWSER_SKILL_PATH: '/app/skills/omp-desktop-browser',
}

describe('capability extension environment', () => {
  it('populates the three shared extension paths and strips the legacy skill paths', () => {
    const environment = extensionRuntimeEnvironment(scheduleBridgeEnvironment, () => browserBridgeEnvironment, extensionPaths)

    expect(environment.OMP_DESKTOP_SCHEDULE_EXTENSION_PATH).toBe('/app/extensions/omp-work-schedules.ts')
    expect(environment.OMP_DESKTOP_BROWSER_EXTENSION_PATH).toBe('/app/extensions/omp-work-browser.ts')
    expect(environment.OMP_DESKTOP_ASK_USER_EXTENSION_PATH).toBe('/app/extensions/omp-work-ask-user.ts')
    expect(environment.GOOEYPI_MANAGES_ASK_USER).toBe('1')
    // The legacy --skill inputs never reach the extension-based harness.
    expect(environment.OMP_DESKTOP_SCHEDULE_SKILL_PATH).toBeUndefined()
    expect(environment.OMP_DESKTOP_BROWSER_SKILL_PATH).toBeUndefined()
    // The loopback-broker contract from both bridges is preserved untouched.
    expect(environment.OMP_DESKTOP_SCHEDULE_URL).toBe('http://127.0.0.1:45001')
    expect(environment.OMP_DESKTOP_SCHEDULE_TOKEN).toBe('schedule-token')
    expect(environment.OMP_DESKTOP_BROWSER_URL).toBe('http://127.0.0.1:45002')
    expect(environment.OMP_DESKTOP_BROWSER_TOKEN).toBe('browser-token'
    )
  })

  it('turns the shared environment into all three --extension injections for omp runtimes', () => {
    const environment = extensionRuntimeEnvironment(scheduleBridgeEnvironment, () => browserBridgeEnvironment, extensionPaths)
    const args = OMP_RPC_ADAPTER.buildStartArgs({ cwd: '/work', environment })

    const injected: string[] = []
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === '--extension') injected.push(args[index + 1])
    }
    expect(injected).toEqual([
      '/app/extensions/omp-work-schedules.ts',
      '/app/extensions/omp-work-browser.ts',
      '/app/extensions/omp-work-ask-user.ts',
    ])
    // The extension-based harness never receives --skill injections.
    expect(args).not.toContain('--skill')
  })

  it('keeps standalone copies suppressed while omitting the bundled tool when disabled', () => {
    const environment = extensionRuntimeEnvironment(scheduleBridgeEnvironment, () => browserBridgeEnvironment, extensionPaths, false)
    expect(environment.GOOEYPI_MANAGES_ASK_USER).toBe('1')
    expect(environment.OMP_DESKTOP_ASK_USER_EXTENSION_PATH).toBeUndefined()
    expect(OMP_RPC_ADAPTER.buildStartArgs({ cwd: '/work', environment })).not.toContain(extensionPaths.askUser)
  })

  it('does not mint or inject a browser claim when Browser is disabled', () => {
    const mintBrowserClaim = vi.fn(() => browserBridgeEnvironment)
    const environment = extensionRuntimeEnvironment(scheduleBridgeEnvironment, mintBrowserClaim, extensionPaths, true, false)
    expect(mintBrowserClaim).not.toHaveBeenCalled()
    expect(environment.OMP_DESKTOP_BROWSER_EXTENSION_PATH).toBeUndefined()
    expect(environment.OMP_DESKTOP_BROWSER_URL).toBeUndefined()
    expect(environment.OMP_DESKTOP_BROWSER_TOKEN).toBeUndefined()
    expect(OMP_RPC_ADAPTER.buildStartArgs({ cwd: '/work', environment })).not.toContain(extensionPaths.browser)
  })

  it('injects session collaboration without accepting an unsafe path', () => {
    const args = OMP_RPC_ADAPTER.buildStartArgs({ cwd: '/work', environment: { GOOEYPI_COLLABORATION_EXTENSION_PATH: '/app/extensions/omp-work-collaboration.ts' } })
    expect(args.slice(-2)).toEqual(['--extension', '/app/extensions/omp-work-collaboration.ts'])
    const unsafe = OMP_RPC_ADAPTER.buildStartArgs({ cwd: '/work', environment: { GOOEYPI_COLLABORATION_EXTENSION_PATH: '--session-injection' } })
    expect(unsafe).not.toContain('--session-injection')
  })
})
