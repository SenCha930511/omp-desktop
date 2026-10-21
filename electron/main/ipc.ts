import { IPC_CHANNELS } from '../../src/types/ipc'
import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readModelPresets } from './model-presets'
import type { ApplicationMenuName, AppMeta, AppSettings, HarnessId, SessionChangeEvent, ThemeMode } from '../../src/types/api'
import type { AgentRpcManager } from './agent-rpc'
import type { GitService } from './git'
import type { CuaDriverService } from './cua-driver'
import type { ModelCatalogProvider } from './model-catalog'
import { OPT_IN_PROVIDERS } from './model-visibility'
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
import { deleteProjectSessions, resolveProjectRoots } from './project-sessions'

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

  const broadcast = (channel: typeof IPC_CHANNELS.sessions.onChanged | typeof IPC_CHANNELS.schedules.onChanged
    | typeof IPC_CHANNELS.browser.onChanged | typeof IPC_CHANNELS.browser.onPointer | typeof IPC_CHANNELS.browser.onActivity, payload: unknown): void => {
    if (closed) return
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send(channel, payload)
    }
  }

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

  handle(IPC_CHANNELS.app.getMeta, () => {
    announceRendererReady?.()
    announceRendererReady = null
    return services.meta
  })
  handle(IPC_CHANNELS.app.refreshHarnesses, () => services.refreshHarnesses())
  handle(IPC_CHANNELS.app.popupMenu, (event, menu, x, y) => services.popupApplicationMenu(event.sender, requireApplicationMenu(menu), requireMenuCoordinate(x), requireMenuCoordinate(y)))
  handle(IPC_CHANNELS.app.setTitleBarTheme, (event, theme) => services.setTitleBarTheme(event.sender, requireResolvedTheme(theme)))
  handle(IPC_CHANNELS.app.openExternal, async (_event, url) => {
    try { await shell.openExternal(requireWebUrl(url, { mailto: true }), { activate: true }); return true } catch (error) {
      console.warn('Rejected app:open-external:', error instanceof Error ? error.message : error)
      return false
    }
  })
  handle(IPC_CHANNELS.app.revealPath, async (_event, path) => {
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
  handle(IPC_CHANNELS.updates.getState, () => services.updates.getState())
  handle(IPC_CHANNELS.updates.check, () => services.updates.check())
  handle(IPC_CHANNELS.updates.checkLatestRelease, () => services.updates.checkLatestRelease())
  handle(IPC_CHANNELS.updates.downloadAndInstall, () => services.updates.downloadAndInstall())

  handle(IPC_CHANNELS.projects.list, () => services.projects.list())
  handle(IPC_CHANNELS.projects.listFiles, (_event, root) => services.projects.listFiles(root))
  handle(IPC_CHANNELS.projects.listCheckouts, (_event, projectId) => services.checkouts.list(projectId))
  handle(IPC_CHANNELS.projects.executeCheckout, (_event, projectId, action) => services.checkouts.execute(projectId, action))
  handle(IPC_CHANNELS.projects.add, () => services.projects.add())
  handle(IPC_CHANNELS.projects.grantInferred, (_event, path) => services.projects.grantInferred(path))
  handle(IPC_CHANNELS.projects.relocate, (_event, id) => services.projects.relocate(id))
  handle(IPC_CHANNELS.projects.remove, async (_event, id) => {
    // Capture the project's folders before the removal dismisses them; the
    // renderer only knows the id, so the main process derives what to purge.
    const target = (await services.projects.list()).find((project) => project.id === id)
    const removed = await services.projects.remove(id)
    if (!removed) return false
    if (target) {
      await deleteProjectSessions({
        listSessions: () => services.sessions.list(undefined, true, true),
        deleteSession: (filePath) => services.sessions.delete(filePath),
        closeBrowserView: (filePath) => services.browser.closeForSession(filePath),
        killTerminal: (filePath) => services.terminals.killForSession(filePath),
      }, await resolveProjectRoots(target.folders))
    }
    return true
  })
  handle(IPC_CHANNELS.projects.touch, (_event, id) => services.projects.touch(id))
  handle(IPC_CHANNELS.projects.setPinned, (_event, id, pinned) => services.projects.setPinned(id, pinned))
  handle(IPC_CHANNELS.projects.updateScripts, (_event, id, scripts) => services.projects.updateScripts(id, scripts))
  handle(IPC_CHANNELS.projects.markSetupStarted, (_event, id, setup) => services.projects.markSetupStarted(id, setup))
  handle(IPC_CHANNELS.projects.finishSetup, (_event, id, setup, exitCode) => services.projects.finishSetup(id, setup, exitCode))

  handle(IPC_CHANNELS.sessions.list, (_event, projectPath, includeArchived, harness, force) => {
    requireHarness(harness)
    return services.sessions.list(projectPath, includeArchived, force)
  })
  handle(IPC_CHANNELS.sessions.sync, (_event, revision, harness) => {
    requireHarness(harness)
    return services.sessions.sync(revision)
  })
  handle(IPC_CHANNELS.sessions.read, async (_event, filePath) => (await sessionsForPath(filePath)).service.read(filePath))
  handle(IPC_CHANNELS.sessions.rename, async (_event, filePath, title) => (await sessionsForPath(filePath)).service.rename(filePath, title))
  handle(IPC_CHANNELS.sessions.delete, async (_event, filePath) => {
    const routed = await sessionsForPath(filePath)
    const result = await routed.service.delete(filePath)
    services.browser.closeForSession(filePath)
    await services.terminals.killForSession(filePath)
    return result
  })
  handle(IPC_CHANNELS.sessions.archive, async (_event, filePath, archived) => {
    const routed = await sessionsForPath(filePath)
    const result = await routed.service.archive(filePath, archived)
    if (archived === true) {
      services.browser.closeForSession(filePath)
      await services.terminals.killForSession(filePath)
    }
    return result
  })

  handle(IPC_CHANNELS.agent.start, (_event, rawOptions) => {
    const options = requireRecord(rawOptions, 'options')
    requireHarness(options.harness)
    // The manager start schema rejects unknown keys; the routing field must
    // not reach it.
    const { harness: _harness, ...startOptions } = options
    return services.agents.start(startOptions)
  })
  handle(IPC_CHANNELS.agent.command, (_event, runtimeId, command) => services.agents.command(runtimeId, command))
  handle(IPC_CHANNELS.agent.stop, (_event, runtimeId) => services.agents.stop(runtimeId))
  handle(IPC_CHANNELS.agent.list, () => services.agents.list())

  const providerCatalog = async (force = false) => {
    const catalog = await services.catalog.catalog(force, new Set(services.settings.get().ompDisabledProviders), new Set(services.settings.get().ompDisabledModels))
    const presets = await readModelPresets(join(homedir(), '.omp', 'agent', 'config.yml'))
    return presets.length > 0 ? { ...catalog, presets } : catalog
  }
  handle(IPC_CHANNELS.providers.catalog, (_event, force, harness) => {
    requireHarness(harness)
    return providerCatalog(force === true)
  })
  handle(IPC_CHANNELS.providers.setEnabled, async (_event, providerId, enabled, harness) => {
    requireHarness(harness)
    const id = requireString(providerId, 'providerId', { min: 1, max: 128, trim: true })
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    const catalog = await providerCatalog()
    if (!catalog.providers.some((provider) => provider.id === id)) throw new Error('Provider was not found')
    const settings = services.settings.get()
    const disabledProviders = new Set(settings.ompDisabledProviders)
    const disabledModels = new Set(settings.ompDisabledModels)
    const enabledProviders = new Set(settings.ompEnabledProviders)
    if (OPT_IN_PROVIDERS.has(id)) {
      // Opt-in providers (e.g. apple) toggle only the affirmative list so a
      // bulk disable elsewhere can never re-show an unconfigured provider.
      if (enabled) {
        enabledProviders.add(id)
        // Mirrors the regular branch: an individual model hidden earlier must
        // not dead-end the provider toggle.
        for (const model of catalog.models) if (model.provider === id) disabledModels.delete(model.key)
      } else enabledProviders.delete(id)
    } else if (enabled) {
      disabledProviders.delete(id)
      for (const model of catalog.models) if (model.provider === id) disabledModels.delete(model.key)
    } else disabledProviders.add(id)
    await services.settings.update({
      ompDisabledProviders: [...disabledProviders].sort(),
      ompEnabledProviders: [...enabledProviders].sort(),
      ompDisabledModels: [...disabledModels].sort(),
    })
    return providerCatalog()
  })
  handle(IPC_CHANNELS.providers.setDisabled, async (_event, providerIds, harness) => {
    requireHarness(harness)
    if (!Array.isArray(providerIds) || providerIds.length > 256) throw new TypeError('providerIds must be a bounded array')
    const ids = [...new Set(providerIds.map((value, index) => requireString(value, `providerIds[${index}]`, { min: 1, max: 128, trim: true })))].sort()
    const catalog = await providerCatalog()
    const known = new Set(catalog.providers.map((provider) => provider.id))
    if (ids.some((id) => !known.has(id))) throw new Error('Provider was not found')
    const disabledModels = ids.length ? services.settings.get().ompDisabledModels : []
    // Opt-in providers in the bulk-list mean "hide again" (drop from the
    // affirmative set); absent ones keep their explicit state untouched.
    const optInIds = ids.filter((id) => OPT_IN_PROVIDERS.has(id))
    const nextEnabledProviders = optInIds.length ? services.settings.get().ompEnabledProviders.filter((id) => !optInIds.includes(id)) : services.settings.get().ompEnabledProviders
    await services.settings.update({ ompDisabledProviders: ids.filter((id) => !OPT_IN_PROVIDERS.has(id)), ompEnabledProviders: nextEnabledProviders, ompDisabledModels: disabledModels })
    return providerCatalog()
  })
  handle(IPC_CHANNELS.providers.setModelEnabled, async (_event, modelKey, enabled, harness) => {
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

  handle(IPC_CHANNELS.voice.credentialStatus, () => services.voice.credentialStatus())
  handle(IPC_CHANNELS.voice.saveApiKey, (_event, provider, apiKey) => services.voice.saveApiKey(provider, apiKey))
  handle(IPC_CHANNELS.voice.deleteApiKey, (_event, provider) => services.voice.deleteApiKey(provider))
  handle(IPC_CHANNELS.voice.createRealtimeCall, (_event, request) => services.voice.createRealtimeCall(request))
  handle(IPC_CHANNELS.voice.transcribe, (_event, request) => services.voice.transcribe(request))
  handle(IPC_CHANNELS.voice.testSelfHosted, (_event, request) => services.voice.testSelfHosted(request))

  handle(IPC_CHANNELS.terminal.create, (event, options) => services.terminals.create(event.sender, options))
  handle(IPC_CHANNELS.terminal.bindSession, (event, terminalId, sessionPath) => services.terminals.bindSession(event.sender, terminalId, sessionPath))
  on(IPC_CHANNELS.terminal.input, (event, terminalId, data) => services.terminals.input(event.sender, terminalId, data))
  on(IPC_CHANNELS.terminal.acknowledge, (event, terminalId, consumedChars) => services.terminals.acknowledge(event.sender, terminalId, consumedChars))
  on(IPC_CHANNELS.terminal.resize, (event, terminalId, cols, rows) => services.terminals.resize(event.sender, terminalId, cols, rows))
  on(IPC_CHANNELS.terminal.setActiveContext, (event, terminalId, context) => services.terminals.setActiveContext(event.sender, terminalId, context))
  on(IPC_CHANNELS.terminal.clearActiveContext, (event, terminalId) => services.terminals.clearActiveContext(event.sender, terminalId))
  handle(IPC_CHANNELS.terminal.kill, (event, terminalId) => services.terminals.kill(event.sender, terminalId))

  handle(IPC_CHANNELS.git.status, (_event, cwd) => services.git.status(cwd))
  handle(IPC_CHANNELS.git.diff, (_event, cwd, path, staged) => services.git.diff(cwd, path, staged))
  handle(IPC_CHANNELS.git.stage, (_event, cwd, paths) => services.git.stage(cwd, paths))
  handle(IPC_CHANNELS.git.unstage, (_event, cwd, paths) => services.git.unstage(cwd, paths))
  handle(IPC_CHANNELS.git.restore, (_event, cwd, paths) => services.git.restore(cwd, paths))
  handle(IPC_CHANNELS.git.commit, (_event, cwd, message) => services.git.commit(cwd, message))

  handle(IPC_CHANNELS.plugins.list, (_event, projectPath, harness) => {
    requireHarness(harness)
    return services.plugins.list(projectPath)
  })
  handle(IPC_CHANNELS.plugins.install, (_event, source, harness) => {
    requireHarness(harness)
    return services.plugins.install(source)
  })
  handle(IPC_CHANNELS.plugins.installExtension, (_event, input, harness) => {
    requireHarness(harness)
    return services.plugins.installExtension(input)
  })
  handle(IPC_CHANNELS.plugins.connectMcp, (_event, input, harness) => {
    requireHarness(harness)
    return services.plugins.connectMcp(input)
  })
  handle(IPC_CHANNELS.plugins.setMcpEnabled, (_event, input, harness) => {
    requireHarness(harness)
    return services.plugins.setMcpEnabled(input)
  })
  handle(IPC_CHANNELS.plugins.mutateCapability, (_event, input, harness) => {
    requireHarness(harness)
    return services.plugins.mutateCapability(input)
  })
  handle(IPC_CHANNELS.plugins.refresh, (_event, harness) => {
    requireHarness(harness)
    return services.plugins.refresh()
  })

  handle(IPC_CHANNELS.settings.get, () => services.settings.get())
  handle(IPC_CHANNELS.settings.update, async (_event, patch) => {
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
  handle(IPC_CHANNELS.settings.resetBrowserData, () => services.settings.resetBrowserData())

  handle(IPC_CHANNELS.browser.state, () => services.browser.state())
  handle(IPC_CHANNELS.browser.attachTab, (_event, tabId, webContentsId) => services.browser.attachTab(tabId, webContentsId))
  handle(IPC_CHANNELS.browser.selectTab, (_event, tabId) => services.browser.selectTab(tabId))
  handle(IPC_CHANNELS.browser.closeTab, (_event, tabId) => services.browser.closeTab(tabId))
  handle(IPC_CHANNELS.browser.setPreviewContext, (_event, webContentsId, sessionFile) => services.browser.setPreviewContext(webContentsId, sessionFile))
  handle(IPC_CHANNELS.browser.navigateTab, (_event, tabId, action, url) => services.browser.navigateTab(tabId, action, url))


  handle(IPC_CHANNELS.schedules.list, (_event, harness) => services.schedules.list(requireHarness(harness)))
  handle(IPC_CHANNELS.schedules.get, (_event, id) => services.schedules.get(id))
  handle(IPC_CHANNELS.schedules.preview, (_event, timing, count) => services.schedules.preview(timing, count))
  handle(IPC_CHANNELS.schedules.create, (_event, input, harness) => services.schedules.create(input, 'user', requireHarness(harness)))
  handle(IPC_CHANNELS.schedules.update, (_event, id, patch) => services.schedules.update(id, patch))
  handle(IPC_CHANNELS.schedules.pause, (_event, id) => services.schedules.pause(id))
  handle(IPC_CHANNELS.schedules.resume, (_event, id) => services.schedules.resume(id))
  handle(IPC_CHANNELS.schedules.delete, (_event, id) => services.schedules.delete(id))
  handle(IPC_CHANNELS.schedules.runNow, (_event, id) => services.schedules.runNow(id))

  const forwardSessionChange = (change: SessionChangeEvent): void => {
    broadcast(IPC_CHANNELS.sessions.onChanged, change)
  }
  const unsubscribeSessionChanges = services.sessions.onDidChange(forwardSessionChange)
  const scheduleSubscription = services.schedules.onDidChange((change) => {
    broadcast(IPC_CHANNELS.schedules.onChanged, change)
  })
  const unsubscribeScheduleChanges = typeof scheduleSubscription === 'function' ? scheduleSubscription : () => undefined
  const browserSubscription = services.browser.onDidChange((state) => {
    broadcast(IPC_CHANNELS.browser.onChanged, state)
  })
  const unsubscribeBrowserChanges = typeof browserSubscription === 'function' ? browserSubscription : () => undefined
  const pointerSubscription = services.browser.onPointer((event) => {
    broadcast(IPC_CHANNELS.browser.onPointer, event)
  })
  const unsubscribeBrowserPointer = typeof pointerSubscription === 'function' ? pointerSubscription : () => undefined
  const activitySubscription = services.browser.onActivity((event) => {
    broadcast(IPC_CHANNELS.browser.onActivity, event)
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
