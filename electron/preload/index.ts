import { IPC_CHANNELS, type IpcChannel } from '../../src/types/ipc'
import { contextBridge, ipcRenderer } from 'electron'
import type { AgentBrowserActivityEvent, AgentBrowserPointerEvent, AgentBrowserState, AppUpdateState, HarnessUpdateState, PrimeEventEnvelope, DesktopApi, ScheduleChangeEvent, SessionChangeEvent, TerminalDataEvent, TerminalExitEvent } from '../../src/types/api'

function subscribe<T>(channel: IpcChannel, callback: (payload: T) => void): () => void {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
    if (typeof payload === 'object' && payload !== null) callback(payload as T)
  }
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

function subscribeSignal(channel: IpcChannel, callback: () => void): () => void {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const listener = (): void => callback()
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

function invoke<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    if (!(error instanceof Error)) throw error
    const match = /^Error invoking remote method '[^']+': ([A-Za-z_$][\w$]*): ([\s\S]*)$/.exec(error.message)
    if (!match) throw error
    console.error('Electron IPC invocation failed:', error)
    const unwrapped = new Error(match[2])
    Object.setPrototypeOf(unwrapped, Object.getPrototypeOf(error))
    unwrapped.name = error.name
    Object.defineProperty(unwrapped, 'cause', { value: error, configurable: true })
    throw unwrapped
  })
}

const api: DesktopApi = {
  app: {
    getMeta: () => invoke(IPC_CHANNELS.app.getMeta),
    refreshHarnesses: () => invoke(IPC_CHANNELS.app.refreshHarnesses),
    openExternal: (url) => invoke(IPC_CHANNELS.app.openExternal, url),
    revealPath: (path) => invoke(IPC_CHANNELS.app.revealPath, path),
    popupMenu: (menu, x, y) => invoke(IPC_CHANNELS.app.popupMenu, menu, x, y),
    setTitleBarTheme: (theme) => invoke(IPC_CHANNELS.app.setTitleBarTheme, theme),
    onOpenSettings: (callback) => subscribeSignal(IPC_CHANNELS.app.onOpenSettings, callback),
  },
  menu: {
    popup: (items) => invoke(IPC_CHANNELS.menu.popup, items),
  },
  updates: {
    getState: () => invoke(IPC_CHANNELS.updates.getState),
    check: () => invoke(IPC_CHANNELS.updates.check),
    checkLatestRelease: () => invoke(IPC_CHANNELS.updates.checkLatestRelease),
    downloadAndInstall: () => invoke(IPC_CHANNELS.updates.downloadAndInstall),
    onChanged: (callback) => subscribe<AppUpdateState>(IPC_CHANNELS.updates.onChanged, callback),
  },
  harnessUpdates: {
    getState: () => invoke(IPC_CHANNELS.harnessUpdates.getState),
    install: () => invoke(IPC_CHANNELS.harnessUpdates.install),
    onChanged: (callback) => subscribe<HarnessUpdateState>(IPC_CHANNELS.harnessUpdates.onChanged, callback),
  },
  projects: {
    list: (harness) => invoke(IPC_CHANNELS.projects.list, harness),
    listFiles: (root, harness) => invoke(IPC_CHANNELS.projects.listFiles, root, harness),
    listCheckouts: (projectId, harness) => invoke(IPC_CHANNELS.projects.listCheckouts, projectId, harness),
    executeCheckout: (projectId, action, harness) => invoke(IPC_CHANNELS.projects.executeCheckout, projectId, action, harness),
    add: (harness) => invoke(IPC_CHANNELS.projects.add, harness),
    grantInferred: (path, harness) => invoke(IPC_CHANNELS.projects.grantInferred, path, harness),
    relocate: (id, harness) => invoke(IPC_CHANNELS.projects.relocate, id, harness),
    remove: (id, harness) => invoke(IPC_CHANNELS.projects.remove, id, harness),
    touch: (id, harness) => invoke(IPC_CHANNELS.projects.touch, id, harness),
    setPinned: (id, pinned, harness) => invoke(IPC_CHANNELS.projects.setPinned, id, pinned, harness),
    updateScripts: (id, scripts, harness) => invoke(IPC_CHANNELS.projects.updateScripts, id, scripts, harness),
    markSetupStarted: (id, setup, harness) => invoke(IPC_CHANNELS.projects.markSetupStarted, id, setup, harness),
    finishSetup: (id, setup, exitCode, harness) => invoke(IPC_CHANNELS.projects.finishSetup, id, setup, exitCode, harness),
  },
  sessions: {
    list: (projectPath, includeArchived, harness, force) => invoke(IPC_CHANNELS.sessions.list, projectPath, includeArchived, harness, force),
    sync: (revision, harness) => invoke(IPC_CHANNELS.sessions.sync, revision, harness),
    read: (filePath) => invoke(IPC_CHANNELS.sessions.read, filePath),
    rename: (filePath, title) => invoke(IPC_CHANNELS.sessions.rename, filePath, title),
    archive: (filePath, archived) => invoke(IPC_CHANNELS.sessions.archive, filePath, archived),
    branch: (filePath) => invoke(IPC_CHANNELS.sessions.branch, filePath),
    setPinned: (filePath, pinned) => invoke(IPC_CHANNELS.sessions.setPinned, filePath, pinned),
    delete: (filePath) => invoke(IPC_CHANNELS.sessions.delete, filePath),
    onChanged: (callback) => subscribe<SessionChangeEvent>(IPC_CHANNELS.sessions.onChanged, callback),
  },
  agent: {
    start: (options) => invoke(IPC_CHANNELS.agent.start, options),
    command: (runtimeId, command) => invoke(IPC_CHANNELS.agent.command, runtimeId, command),
    stop: (runtimeId) => invoke(IPC_CHANNELS.agent.stop, runtimeId),
    list: () => invoke(IPC_CHANNELS.agent.list),
    onEvent: (callback) => subscribe<PrimeEventEnvelope>(IPC_CHANNELS.agent.onEvent, callback),
  },
  providers: {
    catalog: (force, harness) => invoke(IPC_CHANNELS.providers.catalog, force, harness),
    setEnabled: (providerId, enabled, harness) => invoke(IPC_CHANNELS.providers.setEnabled, providerId, enabled, harness),
    setDisabled: (providerIds, harness) => invoke(IPC_CHANNELS.providers.setDisabled, providerIds, harness),
    setModelEnabled: (modelKey, enabled, harness) => invoke(IPC_CHANNELS.providers.setModelEnabled, modelKey, enabled, harness),
  },
  voice: {
    credentialStatus: () => invoke(IPC_CHANNELS.voice.credentialStatus),
    saveApiKey: (provider, apiKey) => invoke(IPC_CHANNELS.voice.saveApiKey, provider, apiKey),
    deleteApiKey: (provider) => invoke(IPC_CHANNELS.voice.deleteApiKey, provider),
    createRealtimeCall: (request) => invoke(IPC_CHANNELS.voice.createRealtimeCall, request),
    transcribe: (request) => invoke(IPC_CHANNELS.voice.transcribe, request),
    testSelfHosted: (request) => invoke(IPC_CHANNELS.voice.testSelfHosted, request),
  },
  terminal: {
    create: (options) => invoke(IPC_CHANNELS.terminal.create, options),
    bindSession: (terminalId, sessionPath) => invoke(IPC_CHANNELS.terminal.bindSession, terminalId, sessionPath),
    input: (terminalId, data) => { ipcRenderer.send(IPC_CHANNELS.terminal.input, terminalId, data) },
    acknowledge: (terminalId, consumedChars) => { ipcRenderer.send(IPC_CHANNELS.terminal.acknowledge, terminalId, consumedChars) },
    resize: (terminalId, cols, rows) => { ipcRenderer.send(IPC_CHANNELS.terminal.resize, terminalId, cols, rows) },
    setActiveContext: (terminalId, context) => { ipcRenderer.send(IPC_CHANNELS.terminal.setActiveContext, terminalId, context) },
    clearActiveContext: (terminalId) => { ipcRenderer.send(IPC_CHANNELS.terminal.clearActiveContext, terminalId) },
    kill: (terminalId) => invoke(IPC_CHANNELS.terminal.kill, terminalId),
    onData: (callback) => subscribe<TerminalDataEvent>(IPC_CHANNELS.terminal.onData, callback),
    onExit: (callback) => subscribe<TerminalExitEvent>(IPC_CHANNELS.terminal.onExit, callback),
  },
  git: {
    status: (cwd) => invoke(IPC_CHANNELS.git.status, cwd),
    diff: (cwd, path, staged) => invoke(IPC_CHANNELS.git.diff, cwd, path, staged),
    stage: (cwd, paths) => invoke(IPC_CHANNELS.git.stage, cwd, paths),
    unstage: (cwd, paths) => invoke(IPC_CHANNELS.git.unstage, cwd, paths),
    restore: (cwd, paths) => invoke(IPC_CHANNELS.git.restore, cwd, paths),
    commit: (cwd, message) => invoke(IPC_CHANNELS.git.commit, cwd, message),
  },
  plugins: {
    list: (projectPath, harness) => invoke(IPC_CHANNELS.plugins.list, projectPath, harness),
    install: (source, harness) => invoke(IPC_CHANNELS.plugins.install, source, harness),
    installExtension: (input, harness) => invoke(IPC_CHANNELS.plugins.installExtension, input, harness),
    connectMcp: (input, harness) => invoke(IPC_CHANNELS.plugins.connectMcp, input, harness),
    setMcpEnabled: (input, harness) => invoke(IPC_CHANNELS.plugins.setMcpEnabled, input, harness),
    mutateCapability: (input, harness) => invoke(IPC_CHANNELS.plugins.mutateCapability, input, harness),
    refresh: (harness) => invoke(IPC_CHANNELS.plugins.refresh, harness),
  },
  settings: {
    get: () => invoke(IPC_CHANNELS.settings.get),
    update: (patch) => invoke(IPC_CHANNELS.settings.update, patch),
    resetBrowserData: () => invoke(IPC_CHANNELS.settings.resetBrowserData),
  },
  browser: {
    state: () => invoke(IPC_CHANNELS.browser.state),
    attachTab: (tabId, webContentsId) => invoke(IPC_CHANNELS.browser.attachTab, tabId, webContentsId),
    selectTab: (tabId) => invoke(IPC_CHANNELS.browser.selectTab, tabId),
    closeTab: (tabId) => invoke(IPC_CHANNELS.browser.closeTab, tabId),
    setPreviewContext: (webContentsId, sessionFile) => invoke(IPC_CHANNELS.browser.setPreviewContext, webContentsId, sessionFile),
    navigateTab: (tabId, action, url) => invoke(IPC_CHANNELS.browser.navigateTab, tabId, action, url),
    onChanged: (callback) => subscribe<AgentBrowserState>(IPC_CHANNELS.browser.onChanged, callback),
    onPointer: (callback) => subscribe<AgentBrowserPointerEvent>(IPC_CHANNELS.browser.onPointer, callback),
    onActivity: (callback) => subscribe<AgentBrowserActivityEvent>(IPC_CHANNELS.browser.onActivity, callback),
  },
  schedules: {
    list: (harness) => invoke(IPC_CHANNELS.schedules.list, harness),
    get: (id) => invoke(IPC_CHANNELS.schedules.get, id),
    preview: (timing, count) => invoke(IPC_CHANNELS.schedules.preview, timing, count),
    create: (input, harness) => invoke(IPC_CHANNELS.schedules.create, input, harness),
    update: (id, patch) => invoke(IPC_CHANNELS.schedules.update, id, patch),
    pause: (id) => invoke(IPC_CHANNELS.schedules.pause, id),
    resume: (id) => invoke(IPC_CHANNELS.schedules.resume, id),
    delete: (id) => invoke(IPC_CHANNELS.schedules.delete, id),
    runNow: (id) => invoke(IPC_CHANNELS.schedules.runNow, id),
    onChanged: (callback) => subscribe<ScheduleChangeEvent>(IPC_CHANNELS.schedules.onChanged, callback),
  },
}

for (const domain of Object.values(api)) Object.freeze(domain)
contextBridge.exposeInMainWorld('desktop', Object.freeze(api))
