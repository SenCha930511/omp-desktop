import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { ApplicationMenuName, AppMeta, AppSettings, HarnessId, SessionChangeEvent, ThemeMode } from '../../src/types/api'
import type { AgentRpcManager } from './agent-rpc'
import type { GitService } from './git'
import type { CuaDriverService } from './cua-driver'
import type { ModelCatalogProvider } from './model-catalog'
import type { PluginService } from './plugins'
import type { ProjectService } from './projects'
import type { CheckoutService } from './checkouts'
import type { SettingsService } from './settings-schedules'
import type { AutomationService } from './schedules/service'
import type { SessionService } from './sessions'
import type { TerminalService } from './terminal'
import type { VoiceService } from './voice'
import type { UpdateService } from './updates'
import type { AgentBrowserService } from './browser/agent-service'
import { requireExistingPath, requireRecord, requireString, requireWebUrl } from './validation'

interface Services {
  meta: AppMeta
  refreshHarnesses(): Promise<{ meta: AppMeta; settings: AppSettings }>
  popupApplicationMenu(sender: WebContents, menuName: ApplicationMenuName, x: number, y: number): boolean
  setTitleBarTheme(sender: WebContents, theme: Exclude<ThemeMode, 'system'>): boolean
  projects: ProjectService
  checkouts: CheckoutService
  sessions: SessionService
  agents: AgentRpcManager
  terminals: TerminalService
  git: GitService
  plugins: PluginService
  catalog: ModelCatalogProvider
  settings: SettingsService
  updates: UpdateService
  cuaDriver: CuaDriverService
  schedules: AutomationService
  browser: AgentBrowserService
  voice: VoiceService
  /** Applies the persisted interface scale to every live app renderer. */
  applyInterfaceZoom?(scale: number): void
}

/** Strict gate for the untrusted optional harness argument; only 'omp' is accepted. */
function requireHarness(value: unknown): HarnessId {
  if (value === undefined || value === 'omp') return 'omp'
  throw new TypeError('Invalid harness')
}

function requireApplicationMenu(value: unknown): ApplicationMenuName {
  if (value === 'file' || value === 'edit' || value === 'view' || value === 'window' || value === 'help') return value
  throw new TypeError('Invalid application menu')
}

function requireMenuCoordinate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10_000) throw new TypeError('Invalid menu coordinate')
  return Math.round(value)
}

function requireResolvedTheme(value: unknown): Exclude<ThemeMode, 'system'> {
  if (value === 'light' || value === 'dark') return value
  throw new TypeError('Invalid resolved theme')
}

type IpcEvent = IpcMainInvokeEvent | IpcMainEvent

export function isTrustedRendererUrl(url: string, expectedRendererUrl: string): boolean {
  try {
    const actual = new URL(url)
    const expected = new URL(expectedRendererUrl)
    // Fragments never cross the document/security boundary; allow in-document anchors only.
    actual.hash = ''
    expected.hash = ''
    return actual.href === expected.href
  } catch { return false }
}

export interface IpcRegistration {
  authorize(webContents: WebContents): void
  revoke(webContentsId: number): void
  dispose(): void
  /**
   * Resolves on the renderer bootstrap's first `app:get-meta` invoke, which
   * only reaches its handler once `verify` has admitted an authorized sender on
   * the trusted main frame. Nothing else observes it, so no verification work
   * is added to the shared invoke path.
   */
  whenRendererReady: Promise<void>
}

let activeIpcRegistration: IpcRegistration | null = null

export function registerIpc(services: Services, expectedRendererUrl: string): IpcRegistration {
  if (activeIpcRegistration) {
    console.warn('registerIpc called while a previous registration was still active; disposing the previous registration')
    activeIpcRegistration.dispose()
  }
  const authorized = new Map<number, WebContents>()
  const invokeChannels: string[] = []
  const eventChannels: string[] = []
  let closed = false
  let announceRendererReady: (() => void) | null = null
  const whenRendererReady = new Promise<void>((resolve) => { announceRendererReady = resolve })

  const verify = (event: IpcEvent): void => {
    const trustedFrame = event.senderFrame === event.sender.mainFrame
      && isTrustedRendererUrl(event.senderFrame.url, expectedRendererUrl)
      && isTrustedRendererUrl(event.sender.getURL(), expectedRendererUrl)
    if (closed || !authorized.has(event.sender.id) || event.sender.isDestroyed() || !trustedFrame) throw new Error('IPC sender is not authorized')
  }
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) => { verify(event); return listener(event, ...args) })
    invokeChannels.push(channel)
  }
  const on = (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void => {
    const wrapped = (event: IpcMainEvent, ...args: unknown[]) => {
      try { verify(event); listener(event, ...args) } catch (error) { console.warn(`Rejected ${channel}:`, error instanceof Error ? error.message : error) }
    }
    // Symmetric with handle(): these are private fixed channels, so any prior listener is stale.
    ipcMain.removeAllListeners(channel)
    ipcMain.on(channel, wrapped)
    eventChannels.push(channel)
  }

  /** Routes a session file through the OMP session service's canonicalizing path authorization. */
  const sessionsForPath = async (filePath: unknown): Promise<{ harness: HarnessId; service: SessionService }> => {
    await services.sessions.requireSessionPath(filePath)
    return { harness: 'omp', service: services.sessions }
  }

  handle('app:get-meta', () => {
    announceRendererReady?.()
    announceRendererReady = null
    return services.meta
  })
  handle('app:refresh-harnesses', () => services.refreshHarnesses())
  handle('app:popup-menu', (event, menu, x, y) => services.popupApplicationMenu(event.sender, requireApplicationMenu(menu), requireMenuCoordinate(x), requireMenuCoordinate(y)))
  handle('app:set-title-bar-theme', (event, theme) => services.setTitleBarTheme(event.sender, requireResolvedTheme(theme)))
  handle('app:open-external', async (_event, url) => {
    try { await shell.openExternal(requireWebUrl(url, { mailto: true }), { activate: true }); return true } catch (error) {
      console.warn('Rejected app:open-external:', error instanceof Error ? error.message : error)
      return false
    }
  })
  handle('app:reveal-path', async (_event, path) => {
    let requested: string
    try { requested = await requireExistingPath(path) } catch (error) {
      console.warn('Rejected app:reveal-path:', error instanceof Error ? error.message : error)
      return false
    }
    const authorizations: Array<() => Promise<string> | string> = [
      () => services.projects.authorizePath(requested),
      () => services.sessions.requireSessionPath(requested),
      () => services.plugins.authorizeReveal(requested),
    ]
    for (const authorize of authorizations) {
      let authorized: string
      try { authorized = await authorize() } catch { continue /* denial here defers to the next authorization domain */ }
      try {
        shell.showItemInFolder(authorized)
        return true
      } catch (error) {
        console.warn('Rejected app:reveal-path:', error instanceof Error ? error.message : error)
        return false
      }
    }
    console.warn('Rejected app:reveal-path: no authorization domain covers the path')
    return false
  })
  handle('updates:get-state', () => services.updates.getState())
  handle('updates:check', () => services.updates.check())
  handle('updates:download-and-install', () => services.updates.downloadAndInstall())

  handle('projects:list', () => services.projects.list())
  handle('projects:list-files', (_event, root) => services.projects.listFiles(root))
  handle('projects:list-checkouts', (_event, projectId) => services.checkouts.list(projectId))
  handle('projects:execute-checkout', (_event, projectId, action) => services.checkouts.execute(projectId, action))
  handle('projects:add', () => services.projects.add())
  handle('projects:grant-inferred', (_event, path) => services.projects.grantInferred(path))
  handle('projects:remove', (_event, id) => services.projects.remove(id))
  handle('projects:touch', (_event, id) => services.projects.touch(id))
  handle('projects:pin', (_event, id, pinned) => services.projects.setPinned(id, pinned))
  handle('projects:update-scripts', (_event, id, scripts) => services.projects.updateScripts(id, scripts))
  handle('projects:mark-setup-started', (_event, id, setup) => services.projects.markSetupStarted(id, setup))
  handle('projects:finish-setup', (_event, id, setup, exitCode) => services.projects.finishSetup(id, setup, exitCode))

  handle('sessions:list', (_event, projectPath, includeArchived, harness, force) => {
    requireHarness(harness)
    return services.sessions.list(projectPath, includeArchived, force)
  })
  handle('sessions:read', async (_event, filePath) => (await sessionsForPath(filePath)).service.read(filePath))
  handle('sessions:rename', async (_event, filePath, title) => (await sessionsForPath(filePath)).service.rename(filePath, title))
  handle('sessions:delete', async (_event, filePath) => {
    const routed = await sessionsForPath(filePath)
    const result = await routed.service.delete(filePath)
    services.browser.closeForSession(filePath)
    await services.terminals.killForSession(filePath)
    return result
  })
  handle('sessions:archive', async (_event, filePath, archived) => {
    const routed = await sessionsForPath(filePath)
    const result = await routed.service.archive(filePath, archived)
    if (archived === true) {
      services.browser.closeForSession(filePath)
      await services.terminals.killForSession(filePath)
    }
    return result
  })

  handle('agent:start', (_event, rawOptions) => {
    const options = requireRecord(rawOptions, 'options')
    requireHarness(options.harness)
    // The manager start schema rejects unknown keys; the routing field must
    // not reach it.
    const { harness: _harness, ...startOptions } = options
    return services.agents.start(startOptions)
  })
  handle('agent:command', (_event, runtimeId, command) => services.agents.command(runtimeId, command))
  handle('agent:stop', (_event, runtimeId) => services.agents.stop(runtimeId))
  handle('agent:list', () => services.agents.list())

  const providerCatalog = (force = false) => services.catalog.catalog(force, new Set(services.settings.get().ompDisabledProviders), new Set(services.settings.get().ompDisabledModels))
  handle('providers:catalog', (_event, force, harness) => {
    requireHarness(harness)
    return providerCatalog(force === true)
  })
  handle('providers:set-enabled', async (_event, providerId, enabled, harness) => {
    requireHarness(harness)
    const id = requireString(providerId, 'providerId', { min: 1, max: 128, trim: true })
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    const catalog = await providerCatalog()
    if (!catalog.providers.some((provider) => provider.id === id)) throw new Error('Provider was not found')
    const settings = services.settings.get()
    const disabledProviders = new Set(settings.ompDisabledProviders)
    const disabledModels = new Set(settings.ompDisabledModels)
    if (enabled) {
      disabledProviders.delete(id)
      for (const model of catalog.models) if (model.provider === id) disabledModels.delete(model.key)
    } else disabledProviders.add(id)
    await services.settings.update({
      ompDisabledProviders: [...disabledProviders].sort(),
      ompDisabledModels: [...disabledModels].sort(),
    })
    return providerCatalog()
  })
  handle('providers:set-disabled', async (_event, providerIds, harness) => {
    requireHarness(harness)
    if (!Array.isArray(providerIds) || providerIds.length > 256) throw new TypeError('providerIds must be a bounded array')
    const ids = [...new Set(providerIds.map((value, index) => requireString(value, `providerIds[${index}]`, { min: 1, max: 128, trim: true })))].sort()
    const catalog = await providerCatalog()
    const known = new Set(catalog.providers.map((provider) => provider.id))
    if (ids.some((id) => !known.has(id))) throw new Error('Provider was not found')
    const disabledModels = ids.length ? services.settings.get().ompDisabledModels : []
    await services.settings.update({ ompDisabledProviders: ids, ompDisabledModels: disabledModels })
    return providerCatalog()
  })
  handle('providers:set-model-enabled', async (_event, modelKey, enabled, harness) => {
    requireHarness(harness)
    const key = requireString(modelKey, 'modelKey', { min: 3, max: 385, trim: true })
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    const catalog = await providerCatalog()
    const model = catalog.models.find((candidate) => candidate.key === key)
    if (!model) throw new Error('Model was not found')
    const provider = catalog.providers.find((candidate) => candidate.id === model.provider)
    if (!provider) throw new Error('Provider was not found')
    const settings = services.settings.get()
    const disabledProviders = new Set(settings.ompDisabledProviders)
    const disabledModels = new Set(settings.ompDisabledModels)
    const siblingKeys = catalog.models.filter((candidate) => candidate.provider === model.provider).map((candidate) => candidate.key)
    if (enabled) {
      if (!provider.enabled) {
        disabledProviders.delete(model.provider)
        for (const siblingKey of siblingKeys) if (siblingKey !== key) disabledModels.add(siblingKey)
      }
      disabledModels.delete(key)
    } else {
      disabledModels.add(key)
      if (!siblingKeys.some((siblingKey) => !disabledModels.has(siblingKey))) disabledProviders.add(model.provider)
    }
    await services.settings.update({
      ompDisabledProviders: [...disabledProviders].sort(),
      ompDisabledModels: [...disabledModels].sort(),
    })
    return providerCatalog()
  })

  handle('voice:credential-status', () => services.voice.credentialStatus())
  handle('voice:save-api-key', (_event, provider, apiKey) => services.voice.saveApiKey(provider, apiKey))
  handle('voice:delete-api-key', (_event, provider) => services.voice.deleteApiKey(provider))
  handle('voice:create-realtime-call', (_event, request) => services.voice.createRealtimeCall(request))
  handle('voice:transcribe', (_event, request) => services.voice.transcribe(request))
  handle('voice:test-self-hosted', (_event, request) => services.voice.testSelfHosted(request))

  handle('terminal:create', (event, options) => services.terminals.create(event.sender, options))
  handle('terminal:bind-session', (event, terminalId, sessionPath) => services.terminals.bindSession(event.sender, terminalId, sessionPath))
  on('terminal:input', (event, terminalId, data) => services.terminals.input(event.sender, terminalId, data))
  on('terminal:resize', (event, terminalId, cols, rows) => services.terminals.resize(event.sender, terminalId, cols, rows))
  on('terminal:set-active-context', (event, terminalId, context) => services.terminals.setActiveContext(event.sender, terminalId, context))
  on('terminal:clear-active-context', (event, terminalId) => services.terminals.clearActiveContext(event.sender, terminalId))
  handle('terminal:kill', (event, terminalId) => services.terminals.kill(event.sender, terminalId))

  handle('git:status', (_event, cwd) => services.git.status(cwd))
  handle('git:diff', (_event, cwd, path, staged) => services.git.diff(cwd, path, staged))
  handle('git:stage', (_event, cwd, paths) => services.git.stage(cwd, paths))
  handle('git:unstage', (_event, cwd, paths) => services.git.unstage(cwd, paths))
  handle('git:restore', (_event, cwd, paths) => services.git.restore(cwd, paths))
  handle('git:commit', (_event, cwd, message) => services.git.commit(cwd, message))

  handle('plugins:list', (_event, projectPath, harness) => {
    requireHarness(harness)
    return services.plugins.list(projectPath)
  })
  handle('plugins:install', (_event, source, harness) => {
    requireHarness(harness)
    return services.plugins.install(source)
  })
  handle('plugins:install-extension', (_event, input, harness) => {
    requireHarness(harness)
    return services.plugins.installExtension(input)
  })
  handle('plugins:connect-mcp', (_event, input, harness) => {
    requireHarness(harness)
    return services.plugins.connectMcp(input)
  })
  handle('plugins:set-mcp-enabled', (_event, input, harness) => {
    requireHarness(harness)
    return services.plugins.setMcpEnabled(input)
  })
  handle('plugins:mutate-capability', (_event, input, harness) => {
    requireHarness(harness)
    return services.plugins.mutateCapability(input)
  })
  handle('plugins:refresh', (_event, harness) => {
    requireHarness(harness)
    return services.plugins.refresh()
  })

  handle('settings:get', () => services.settings.get())
  handle('settings:update', async (_event, patch) => {
    const previous = services.settings.get()
    const patchRecord = requireRecord(patch, 'settings patch')
    if (patchRecord.computerUseEnabled === true && !previous.computerUseEnabled) await services.cuaDriver.requireAvailable()
    const settings = await services.settings.update(patch)
    if (settings.interfaceFontScale !== previous.interfaceFontScale) services.applyInterfaceZoom?.(settings.interfaceFontScale)
    if (settings.askUserEnabled !== previous.askUserEnabled || settings.browserEnabled !== previous.browserEnabled || settings.computerUseEnabled !== previous.computerUseEnabled) {
      await services.agents.requestRuntimeEnvironmentRefresh()
    }
    return settings
  })
  handle('settings:reset-browser-data', () => services.settings.resetBrowserData())

  handle('browser:state', () => services.browser.state())
  handle('browser:attach-tab', (_event, tabId, webContentsId) => services.browser.attachTab(tabId, webContentsId))
  handle('browser:select-tab', (_event, tabId) => services.browser.selectTab(tabId))
  handle('browser:close-tab', (_event, tabId) => services.browser.closeTab(tabId))
  handle('browser:set-preview-context', (_event, webContentsId, sessionFile) => services.browser.setPreviewContext(webContentsId, sessionFile))
  handle('browser:navigate-tab', (_event, tabId, action, url) => services.browser.navigateTab(tabId, action, url))


  handle('schedules:list', (_event, harness) => services.schedules.list(requireHarness(harness)))
  handle('schedules:get', (_event, id) => services.schedules.get(id))
  handle('schedules:preview', (_event, timing, count) => services.schedules.preview(timing, count))
  handle('schedules:create', (_event, input, harness) => services.schedules.create(input, 'user', requireHarness(harness)))
  handle('schedules:update', (_event, id, patch) => services.schedules.update(id, patch))
  handle('schedules:pause', (_event, id) => services.schedules.pause(id))
  handle('schedules:resume', (_event, id) => services.schedules.resume(id))
  handle('schedules:delete', (_event, id) => services.schedules.delete(id))
  handle('schedules:run-now', (_event, id) => services.schedules.runNow(id))

  const forwardSessionChange = (change: SessionChangeEvent): void => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('sessions:changed', change)
    }
  }
  const unsubscribeSessionChanges = services.sessions.onDidChange(forwardSessionChange)
  const scheduleSubscription = services.schedules.onDidChange((change) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('schedules:changed', change)
    }
  })
  const unsubscribeScheduleChanges = typeof scheduleSubscription === 'function' ? scheduleSubscription : () => undefined
  const browserSubscription = services.browser.onDidChange((state) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('browser:changed', state)
    }
  })
  const unsubscribeBrowserChanges = typeof browserSubscription === 'function' ? browserSubscription : () => undefined
  const pointerSubscription = services.browser.onPointer((event) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('browser:pointer', event)
    }
  })
  const unsubscribeBrowserPointer = typeof pointerSubscription === 'function' ? pointerSubscription : () => undefined
  const activitySubscription = services.browser.onActivity((event) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('browser:activity', event)
    }
  })
  const unsubscribeBrowserActivity = typeof activitySubscription === 'function' ? activitySubscription : () => undefined

  const registration: IpcRegistration = {
    whenRendererReady,
    authorize(webContents) { if (!closed) authorized.set(webContents.id, webContents) },
    revoke(webContentsId) { authorized.delete(webContentsId); void services.terminals.killOwner(webContentsId) },
    dispose() {
      if (closed) return
      closed = true
      if (activeIpcRegistration === registration) activeIpcRegistration = null
      authorized.clear()
      unsubscribeSessionChanges()
      if (typeof unsubscribeScheduleChanges === 'function') unsubscribeScheduleChanges()
      if (typeof unsubscribeBrowserChanges === 'function') unsubscribeBrowserChanges()
      if (typeof unsubscribeBrowserPointer === 'function') unsubscribeBrowserPointer()
      if (typeof unsubscribeBrowserActivity === 'function') unsubscribeBrowserActivity()
      for (const channel of invokeChannels) ipcMain.removeHandler(channel)
      // Event listeners are removed wholesale only for our private fixed channels.
      for (const channel of eventChannels) ipcMain.removeAllListeners(channel)
    },
  }
  activeIpcRegistration = registration
  return registration
}
