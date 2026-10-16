import { app, BrowserWindow, dialog, Menu, nativeTheme, protocol, safeStorage, session, webContents } from 'electron'
import type { BrowserWindowConstructorOptions, Input, WebContents } from 'electron'
import { extname, isAbsolute, join, relative, resolve, win32 as win32Path } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { assertNoMcpAuthenticationCommand } from '../../src/lib/mcp-policy'
import { BROWSER_PARTITION, type ApplicationMenuName, type AppMeta, type AppUpdateState, type PrimeEventEnvelope, type RuntimeInfo, type ThemeMode } from '../../src/types/api'
import { AgentRpcManager, OMP_RPC_ADAPTER } from './agent-rpc'
import { installApplicationMenu } from './application-menu'
import { MacBackgroundController, shouldStartInBackground } from './background'
import { BrowserDownloadGuard } from './browser-downloads'
import { installCrashGuards } from './crash-guard'
import { CuaDriverService } from './cua-driver'
import { GitService } from './git'
import { CheckoutService } from './checkouts'
import { isTrustedRendererUrl, registerIpc, type IpcRegistration } from './ipc'
import { HarnessDiscoveryService, reconcileActiveHarness } from './harness-discovery'
import { beginProcessShutdown, runProcess, stopChildProcesses } from './process-utils'
import { PluginService, beginPluginDiscoveryShutdown } from './plugins'
import { OmpModelCatalogService } from './providers-omp'
import { PACKAGED_RENDERER_URL, PACKAGED_SMOKE_READY_EVENT, packagedSmokeMarker, packagedSmokeMarkerPath, serializePackagedSmokeMarker } from './packaged-smoke'
import { ProjectService } from './projects'
import { SettingsService } from './settings-schedules'
import { ScheduledRunExecutor } from './schedules/executor'
import { AutomationService } from './schedules/service'
import { AgentScheduleBridge } from './schedules/agent-bridge'
import { AgentBrowserBridge } from './browser/agent-bridge'
import { AgentBrowserService } from './browser/agent-service'
import { AgentCollaborationBridge } from './collaboration/agent-bridge'
import { configureGooeyPiAgentMessageSigning, loadOrCreateGooeyPiAgentMessageKey } from './collaboration/message-envelope'
import { extensionInjection, resolveExtensionPath } from './extension-manifest'
import { SessionService } from './sessions'
import { ompSessionServiceOptions } from './sessions/omp'
import { type JsonStateStore, openDesktopStateStore, StateCompatibilityError, StateMigrationError } from './store'
import { TerminalService } from './terminal'
import { RepositoryUseGate } from './repository-use-gate'
import { migrateLegacyUserData } from './user-data-migration'
import { VoiceService, voiceSecretStorageStatus } from './voice'
import { isAllowedRendererAudioPermission } from './voice-permissions'
import { createManualUpdateCheck, getAutoUpdater, UpdateService } from './updates'

protocol.registerSchemesAsPrivileged([{ scheme: 'omp-desktop', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

let mainWindow: BrowserWindow | null = null
let ipc: IpcRegistration | null = null
let agents: AgentRpcManager | null = null
let terminals: TerminalService | null = null
let downloads: BrowserDownloadGuard | null = null
let updateService: UpdateService | null = null
let store: JsonStateStore | null = null
let automation: AutomationService | null = null
let agentScheduleBridge: AgentScheduleBridge | null = null
let agentBrowser: AgentBrowserService | null = null
let agentBrowserBridge: AgentBrowserBridge | null = null
let agentCollaborationBridge: AgentCollaborationBridge | null = null
let backgroundMode: MacBackgroundController | null = null
let shutdownStarted = false
let shutdownApproved = false
let confirmingShutdown = false
let trustedRendererUrl = ''
let packagedSmokeMarkerFile: string | null = null
let windowCreation: Promise<BrowserWindow | null> | null = null
let startInBackground = false
const keepTestWindowsHidden = process.env.OMP_DESKTOP_E2E_HIDE_WINDOWS === '1'

installCrashGuards({
  logPath: () => {
    try { return join(app.getPath('userData'), 'crash.log') } catch { return null }
  },
  cleanup: async () => {
    agents?.beginShutdown()
    beginProcessShutdown()
    await Promise.allSettled([agents?.stopAll() ?? Promise.resolve(), stopChildProcesses()])
  },
})

function appIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'assets', 'icon.png')
}

// One policy for every surface that serves renderer content: the app protocol
// response headers and the packaged browser-session header rewrite.
const RENDERER_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

const rendererContentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
}

function registerRendererProtocol(): void {
  if (!app.isPackaged) return
  const rendererRoot = resolve(__dirname, '../renderer')
  protocol.handle('omp-desktop', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'app' || url.username || url.password || url.search || url.hash) return new Response('Not found', { status: 404 })
      const decoded = decodeURIComponent(url.pathname)
      const candidate = resolveRendererAssetPath(rendererRoot, decoded)
      if (!candidate) return new Response('Not found', { status: 404 })
      const body = await readFile(candidate)
      return new Response(body, { headers: {
        'Content-Type': rendererContentTypes[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        'Content-Security-Policy': RENDERER_CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
      } })
    } catch { return new Response('Not found', { status: 404 }) }
  })
}

/** Resolves a renderer URL path without relying on a platform-specific separator. */
export function resolveRendererAssetPath(rendererRoot: string, decodedPath: string): string | null {
  if (!decodedPath.startsWith('/') || decodedPath.includes('\0') || decodedPath.includes('\\')) return null
  const pathApi = /^[A-Za-z]:[\\/]/.test(rendererRoot) ? win32Path : { resolve, relative, isAbsolute }
  const candidate = pathApi.resolve(rendererRoot, `.${decodedPath === '/' ? '/index.html' : decodedPath}`)
  const relativePath = pathApi.relative(rendererRoot, candidate)
  if (!relativePath || relativePath.startsWith('..') || pathApi.isAbsolute(relativePath)) return null
  return candidate
}

function resolveRendererUrl(): string {
  const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  if (!developmentUrl) return app.isPackaged ? PACKAGED_RENDERER_URL : pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const parsed = new URL(developmentUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('ELECTRON_RENDERER_URL must use an uncredentialed loopback HTTP(S) origin')
  }
  return parsed.href
}

function isAllowedBrowserUrl(raw: string): boolean {
  if (raw === 'about:blank') return true
  try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}

export function hardenRenderer(window: BrowserWindow, trustedUrl: () => string = () => trustedRendererUrl): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('context-menu', (_event, params) => {
    if (params.mediaType !== 'image' || !params.hasImageContents) return
    const contents = window.webContents
    Menu.buildFromTemplate([{
      label: 'Copy Image',
      click: () => { if (!window.isDestroyed() && !contents.isDestroyed()) contents.copyImageAt(params.x, params.y) },
    }]).popup({ window })
  })
  window.webContents.on('will-attach-webview', (event, preferences, params) => {
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.nodeIntegrationInSubFrames = false
    preferences.contextIsolation = true
    preferences.sandbox = true
    preferences.webSecurity = true
    preferences.allowRunningInsecureContent = false
    // A guest page must never be able to attach a nested guest of its own.
    preferences.webviewTag = false
    const partition = typeof params.partition === 'string' ? params.partition : ''
    if (partition !== BROWSER_PARTITION || !isAllowedBrowserUrl(params.src)) event.preventDefault()
  })
  window.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, target) => { if (!isAllowedBrowserUrl(target)) event.preventDefault() })
    contents.on('will-redirect', (event) => { if (!isAllowedBrowserUrl(event.url)) event.preventDefault() })
    contents.on('will-frame-navigate', (event) => { if (!isAllowedBrowserUrl(event.url)) event.preventDefault() })
    contents.once('destroyed', () => downloads?.cancelOwner(contents.id))
    // Guests reaching this point passed the will-attach-webview partition and
    // URL gates above, which makes them eligible for agent control.
    agentBrowser?.approveGuest(contents)
  })
  window.webContents.on('will-navigate', (event, target) => {
    const current = window.webContents.getURL()
    if (target !== current) event.preventDefault()
  })
  // Server redirects and sub-frame navigations bypass will-navigate; hold them
  // to the same trusted-renderer predicate the IPC gate uses.
  window.webContents.on('will-redirect', (event) => {
    if (!isTrustedRendererUrl(event.url, trustedUrl())) event.preventDefault()
  })
  window.webContents.on('will-frame-navigate', (event) => {
    if (!isTrustedRendererUrl(event.url, trustedUrl())) event.preventDefault()
  })
}

interface InitialRendererWindow {
  loadURL(url: string): Promise<unknown>
  isDestroyed(): boolean
  destroy(): void
}

export async function loadInitialRenderer(window: InitialRendererWindow, rendererUrl: string): Promise<void> {
  try {
    await window.loadURL(rendererUrl)
  } catch (error) {
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
}

/** Work that would be lost by quitting: in-flight agent turns and armed schedules. */
export interface ActiveShutdownWork {
  runningAgents: number
  activeSchedules: boolean
}

export interface ShutdownPrompt {
  message: string
  detail: string
}

export function activeShutdownWork(runtimes: readonly RuntimeInfo[], hasActiveSchedules: boolean): ActiveShutdownWork {
  const running = runtimes.filter((runtime) => runtime.isStreaming
    || runtime.isCompacting === true
    || runtime.sessionActions?.active !== undefined
    || (runtime.sessionActions?.queuedCount ?? 0) > 0)
  return { runningAgents: running.length, activeSchedules: hasActiveSchedules }
}

/** Null when nothing is active, which is the signal to close without a prompt. */
export function shutdownPrompt(work: ActiveShutdownWork): ShutdownPrompt | null {
  const details: string[] = []
  if (work.runningAgents > 0) {
    details.push(work.runningAgents === 1
      ? 'An agent run is still in progress and will be stopped.'
      : `${work.runningAgents} agent runs are still in progress and will be stopped.`)
  }
  if (work.activeSchedules) details.push('Scheduled automations will not run while OMP Desktop is closed.')
  if (details.length === 0) return null
  return {
    message: work.runningAgents > 0 ? 'Close OMP Desktop while an agent is running?' : 'Close OMP Desktop?',
    detail: details.join(' '),
  }
}

export async function confirmAppClose(window: BrowserWindow | null, prompt: ShutdownPrompt): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Close OMP Desktop'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'OMP Desktop',
    ...prompt,
  }
  const { response } = window && !window.isDestroyed()
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  return response === 1
}

function pendingShutdownPrompt(): ShutdownPrompt | null {
  const runtimes = agents?.list() ?? []
  return shutdownPrompt(activeShutdownWork(runtimes, automation?.hasActiveSchedules() ?? false))
}

/**
 * The one confirmation path for both ✕ and Quit: the dialog is async so agent
 * RPC, IPC, and schedule ticks keep running while it is open, and the approved
 * flag lets the programmatic quit through without re-asking.
 */
function requestShutdown(window: BrowserWindow | null, prompt: ShutdownPrompt): void {
  confirmingShutdown = true
  void confirmAppClose(window, prompt).then((approved) => {
    if (!approved) return
    shutdownApproved = true
    app.quit()
  }).catch((error: unknown) => {
    console.error(`OMP Desktop close confirmation failed: ${boundedErrorMessage(error)}`)
  }).finally(() => { confirmingShutdown = false })
}

export function interfaceZoomFactor(): number {
  return (store?.getSettings().interfaceFontScale ?? 110) / 100
}

/**
 * App windows only: embedded browser guests and their views keep their own
 * zoom, so the app scale is applied through the window list rather than to
 * every webContents in the process.
 */
function applyInterfaceZoom(scale: number): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    const contents = window.webContents
    if (!contents.isDestroyed()) contents.setZoomFactor(scale / 100)
  }
}

type ResolvedTheme = Exclude<ThemeMode, 'system'>

function windowsTitleBarOverlay(theme: ResolvedTheme): { color: string; symbolColor: string; height: number } {
  return theme === 'dark'
    ? { color: '#171716', symbolColor: '#f1f1ee', height: 32 }
    : { color: '#ffffff', symbolColor: '#20201e', height: 32 }
}

function resolvedWindowTheme(theme: ThemeMode | undefined): ResolvedTheme {
  if (theme === 'dark') return 'dark'
  if (theme === 'system' && nativeTheme.shouldUseDarkColors) return 'dark'
  return 'light'
}

export function mainWindowChromeOptions(platform: NodeJS.Platform = process.platform, theme: ResolvedTheme = 'light'): BrowserWindowConstructorOptions {
  if (platform === 'darwin') return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
  }
  if (platform === 'win32') return {
    // The native caption controls share a dedicated menu row. OMP Desktop's own
    // 52px toolbar remains a separate application surface below it.
    titleBarStyle: 'hidden',
    titleBarOverlay: windowsTitleBarOverlay(theme),
    autoHideMenuBar: true,
  }
  if (platform === 'linux') return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: 52 },
    autoHideMenuBar: true,
  }
  return { titleBarStyle: 'default' }
}

export function isMacWindowCloseShortcut(
  input: Pick<Input, 'type' | 'key' | 'shift' | 'control' | 'alt' | 'meta'>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin'
    && input.type === 'keyDown'
    && input.key.toLowerCase() === 'q'
    && input.meta
    && !input.shift
    && !input.control
    && !input.alt
}

export function popupApplicationMenu(sender: WebContents, menuName: ApplicationMenuName, x: number, y: number): boolean {
  const window = BrowserWindow.fromWebContents(sender)
  const applicationMenu = Menu.getApplicationMenu()
  const menuItem = applicationMenu?.items.find((item) => item.label.replaceAll('&', '').toLowerCase() === menuName)
  if (!window || window.isDestroyed() || !menuItem?.submenu) return false
  const zoom = sender.getZoomFactor()
  menuItem.submenu.popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom) })
  return true
}

export function setTitleBarTheme(sender: WebContents, theme: ResolvedTheme): boolean {
  const window = BrowserWindow.fromWebContents(sender)
  if (process.platform !== 'win32' || !window || window.isDestroyed()) return false
  window.setTitleBarOverlay(windowsTitleBarOverlay(theme))
  return true
}

async function createWindow(): Promise<BrowserWindow | null> {
  if (shutdownStarted) return null
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f5f4',
    icon: appIconPath(),
    ...mainWindowChromeOptions(process.platform, resolvedWindowTheme(store?.getSettings().theme)),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      zoomFactor: interfaceZoomFactor(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  })
  mainWindow = window
  const renderer = window.webContents
  const rendererId = renderer.id
  hardenRenderer(window)
  renderer.on('before-input-event', (event, input) => {
    if (!isMacWindowCloseShortcut(input)) return
    event.preventDefault()
    if (!window.isDestroyed()) window.close()
  })
  renderer.on('did-finish-load', () => {
    if (renderer.isDestroyed()) return
    // A reload resets the zoom factor, so the persisted scale is re-applied
    // on every load rather than only at window creation.
    renderer.setZoomFactor(interfaceZoomFactor())
    if (isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)) ipc?.authorize(renderer)
  })
  renderer.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !isTrustedRendererUrl(url, trustedRendererUrl)) ipc?.revoke(rendererId)
  })
  renderer.on('render-process-gone', () => ipc?.revoke(rendererId))
  let rendererLoaded = false
  let readyToShow = false
  window.once('ready-to-show', () => {
    readyToShow = true
    if (!keepTestWindowsHidden && !backgroundMode?.isBackgrounded() && rendererLoaded && !shutdownStarted && !window.isDestroyed() && mainWindow === window) window.show()
  })
  window.on('close', (event) => {
    if (shutdownStarted || shutdownApproved) return
    if (backgroundMode?.handleWindowClose(window)) {
      event.preventDefault()
      return
    }
    const prompt = pendingShutdownPrompt()
    if (!prompt) return
    event.preventDefault()
    if (!confirmingShutdown) requestShutdown(window, prompt)
  })
  window.on('closed', () => {
    ipc?.revoke(rendererId)
    if (mainWindow === window) mainWindow = null
  })
  try {
    await loadInitialRenderer(window, trustedRendererUrl)
  } catch (error) {
    ipc?.revoke(rendererId)
    if (mainWindow === window) mainWindow = null
    throw error
  }
  if (shutdownStarted || window.isDestroyed() || mainWindow !== window) {
    ipc?.revoke(rendererId)
    if (!window.isDestroyed()) window.destroy()
    if (mainWindow === window) mainWindow = null
    return null
  }
  rendererLoaded = true
  if (!keepTestWindowsHidden && !backgroundMode?.isBackgrounded() && readyToShow) window.show()
  return window
}

function ensureWindow(): Promise<BrowserWindow | null> {
  if (shutdownStarted) return Promise.resolve(null)
  if (mainWindow && !mainWindow.isDestroyed()) return windowCreation ?? Promise.resolve(mainWindow)
  if (windowCreation) return windowCreation
  const creation = createWindow()
  windowCreation = creation
  const clearCreation = () => { if (windowCreation === creation) windowCreation = null }
  void creation.then(clearCreation, clearCreation)
  return creation
}

function boundedErrorMessage(error: unknown, maxLength = 512): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, maxLength) || 'Unknown error'
}

export interface StartupFailureDialog {
  title: string
  detail: string
}

export function startupFailureDialog(error: unknown): StartupFailureDialog | null {
  if (error instanceof StateMigrationError) {
    return { title: 'OMP Desktop state migration failed', detail: boundedErrorMessage(error, 2_048) }
  }
  if (error instanceof StateCompatibilityError) {
    return { title: 'OMP Desktop update required', detail: boundedErrorMessage(error, 2_048) }
  }
  return null
}

/** Filesystem locations of the three shared capability extensions injected into extension-based harnesses. */
export interface CapabilityExtensionPaths {
  schedule: string
  browser: string
  askUser: string
}

/**
 * Runtime environment for the extension-injected OMP harness: the
 * capability-broker variables from the schedule bridge and lazily enabled
 * browser bridge, plus the OMP_DESKTOP_*_EXTENSION_PATH variables the
 * harness adapter turns into --extension argv.
 */
export function extensionRuntimeEnvironment(
  scheduleBridgeEnvironment: NodeJS.ProcessEnv,
  browserBridgeEnvironment: () => NodeJS.ProcessEnv,
  extensionPaths: CapabilityExtensionPaths,
  askUserEnabled = true,
  browserEnabled = true,
): NodeJS.ProcessEnv {
  const { OMP_DESKTOP_SCHEDULE_SKILL_PATH: _scheduleSkill, ...scheduleEnvironment } = scheduleBridgeEnvironment
  const browserEnvironment = browserEnabled ? browserBridgeEnvironment() : {}
  const { OMP_DESKTOP_BROWSER_SKILL_PATH: _browserSkill, ...runtimeBrowserEnvironment } = browserEnvironment
  return {
    ...scheduleEnvironment,
    ...runtimeBrowserEnvironment,
    OMP_DESKTOP_SCHEDULE_EXTENSION_PATH: extensionPaths.schedule,
    OMP_DESKTOP_BROWSER_EXTENSION_PATH: browserEnabled ? extensionPaths.browser : undefined,
    OMP_DESKTOP_ASK_USER_EXTENSION_PATH: askUserEnabled ? extensionPaths.askUser : undefined,
    GOOEYPI_MANAGES_ASK_USER: '1',
  }
}

export async function settleShutdown(
  steps: ReadonlyArray<PromiseLike<unknown>>,
  options: { watchdogMs?: number; log?: (message: string) => void } = {},
): Promise<void> {
  const log = options.log ?? ((message: string) => console.error(message))
  const watchdogMs = options.watchdogMs ?? 10_000
  const settled = Promise.allSettled(steps).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') log(`OMP Desktop shutdown step failed: ${boundedErrorMessage(result.reason)}`)
    }
  })
  let timer: NodeJS.Timeout | undefined
  const watchdog = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log(`OMP Desktop shutdown did not finish within ${watchdogMs} ms; quitting anyway`)
      resolve()
    }, watchdogMs)
    timer.unref?.()
  })
  try {
    await Promise.race([settled, watchdog])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function requestWindow(reason: 'activation' | 'second instance' | 'menu bar' | 'settings', afterOpen?: (window: BrowserWindow) => void): void {
  void ensureWindow().then((window) => {
    if (!window || shutdownStarted || window.isDestroyed()) return
    if (!keepTestWindowsHidden) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
    afterOpen?.(window)
  }).catch((error: unknown) => {
    if (!shutdownStarted) console.error(`OMP Desktop failed to open a window after ${reason}: ${boundedErrorMessage(error)}`)
  })
}

function revealApplication(reason: 'activation' | 'second instance'): void {
  if (backgroundMode) backgroundMode.open()
  else requestWindow(reason)
}

export function routeAllWindowsClosed(
  shutdownInProgress: boolean,
  background: Pick<MacBackgroundController, 'handleAllWindowsClosed'> | null,
  quit: () => void,
): void {
  if (shutdownInProgress) return
  if (!background?.handleAllWindowsClosed()) quit()
}

async function bootstrap(): Promise<void> {
  const userDataPath = app.getPath('userData')
  await migrateLegacyUserData(app.getPath('appData'), userDataPath)
  configureGooeyPiAgentMessageSigning(loadOrCreateGooeyPiAgentMessageKey(join(userDataPath, 'agent-message-signing.key')))
  const stateStore = await openDesktopStateStore(userDataPath)
  store = stateStore
  backgroundMode = new MacBackgroundController({
    iconPath: appIconPath(),
    getSettings: () => stateStore.getSettings(),
    onOpen: () => requestWindow('menu bar'),
    onSettings: () => requestWindow('settings', (window) => {
      if (!window.webContents.isDestroyed()) window.webContents.send('app:open-settings')
    }),
    onQuit: () => app.quit(),
    startInBackground,
  })
  const discovery = new HarnessDiscoveryService(() => stateStore.getSettings().runtimePaths)
  const initialHarnesses = await discovery.refresh()
  await reconcileActiveHarness(stateStore, initialHarnesses)
  if (shutdownStarted) return
  const ompExecutable = () => discovery.executable('omp')
  // OMP has no live-CLI overlay (`omp list --json` does not exist), so the
  // catalog is constructed with a null executable and JSONL-only metadata.
  const sessions = new SessionService(stateStore, null, undefined, ompSessionServiceOptions())
  const projects = new ProjectService(stateStore, () => mainWindow)
  const repositoryUseGate = new RepositoryUseGate()
  const checkouts = new CheckoutService(() => stateStore.getSettings().checkoutStrategy, projects, repositoryUseGate)
  // Git and terminals authorize against the OMP project grants.
  const git = new GitService((cwd) => projects.authorizeCwd(cwd), (cwd) => projects.authorizeReadOnlyCwd(cwd))
  // This matches the renderer's startup query so both consumers share SessionService's coalesced catalog scan.
  const listCatalogSessions = (): ReturnType<SessionService['list']> => sessions.list(undefined, true)

  const ompDisabledProviders = () => new Set(stateStore.getSettings().ompDisabledProviders)
  const ompDisabledModels = () => new Set(stateStore.getSettings().ompDisabledModels)
  const catalog = new OmpModelCatalogService(ompExecutable)
  // The OMP manager exists whether or not the omp CLI is installed; starting a
  // runtime without it fails with the adapter's not-found error. OMP provider
  // visibility is desktop-owned and independent from OMP's own CLI
  // configuration.
  const ompManager = new AgentRpcManager(
    ompExecutable,
    (cwd) => projects.authorizeCwd(cwd),
    (path) => sessions.requireSessionPath(path),
    catalog,
    ompDisabledProviders,
    OMP_RPC_ADAPTER,
    () => {
      const mode = stateStore.getSettings().ompApprovalMode
      return mode === 'inherit' ? undefined : mode
    },
  )
  ompManager.setDisabledModelsProvider(ompDisabledModels)
  ompManager.setWorkspaceUseProvider((cwd, owner, retireIfIdle) => repositoryUseGate.beginWorkspaceUse(cwd, owner, retireIfIdle))
  agents = ompManager
  sessions.bindRuntimeHooks({
    get: (path) => agents?.getForSession(path),
    all: () => agents?.list() ?? [],
    stop: async (path) => { await agents?.stopForSession(path) },
    rename: async (path, title) => agents?.renameForSession(path, title) ?? false,
  })
  terminals = new TerminalService(
    (cwd) => projects.authorizeCwd(cwd),
    () => stateStore.getSettings().terminalShell,
    (path) => sessions.requireSessionPath(path),
    (cwd, owner) => repositoryUseGate.beginWorkspaceUse(cwd, owner),
  )
  projects.bindProviders({
    sessions: listCatalogSessions,
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => {
      plugins.evictProjects(roots)
      await Promise.all([ompManager.stopForProjectRoots(roots), terminals!.killForProjectRoots(roots)])
    },
  })
  downloads = new BrowserDownloadGuard(isAllowedBrowserUrl, app.getPath('downloads'))
  const settings = new SettingsService(
    stateStore,
    (shell) => terminals!.validateShell(shell),
    () => downloads?.cancelAll(true),
    (previous, next) => backgroundMode?.applySettings(previous, next),
  )
  const cuaDriver = new CuaDriverService()
  // The disabled-by-default integration probes PATH and may spawn a version
  // command. Defer that work until it is enabled or its settings UI is opened.
  if (stateStore.getSettings().computerUseEnabled) await cuaDriver.status()
  const voice = new VoiceService({
    secretPath: join(app.getPath('userData'), 'voice-secrets.json'),
    secretCodec: {
      status: () => voiceSecretStorageStatus(
        process.platform,
        safeStorage.isEncryptionAvailable(),
        process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined,
      ),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    },
    settings: () => stateStore.getSettings(),
    runProcess,
  })

  const browserProfile = session.fromPartition(BROWSER_PARTITION)
  browserProfile.on('will-download', (event, item, owner) => downloads?.handle(event, item, owner, settings.get().browserAskForDownloads))
  const computerUseSkillPath = app.isPackaged
    ? join(process.resourcesPath, 'skills', 'gooeypi-computer-use', 'SKILL.md')
    : join(app.getAppPath(), 'assets', 'skills', 'gooeypi-computer-use', 'SKILL.md')
  const extensionPathContext = {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  }
  const extensionPathFor = (capability: 'schedule' | 'browser' | 'askUser' | 'collaboration'): string =>
    resolveExtensionPath(extensionInjection('omp', capability).filename, extensionPathContext)
  const ompBrowserExtensionPath = extensionPathFor('browser')
  const ompScheduleExtensionPath = extensionPathFor('schedule')
  const ompAskUserExtensionPath = extensionPathFor('askUser')
  const collaborationExtensionPath = extensionPathFor('collaboration')
  const computerUseSkill = async () => {
    const status = await cuaDriver.status()
    return {
      id: 'gooeypi-computer-use', name: 'Computer Use | TryCUA',
      description: 'Drive native apps through a separately installed TryCUA driver. Install the driver before enabling.',
      kind: 'extension' as const, location: 'system' as const, path: computerUseSkillPath,
      enabled: stateStore.getSettings().computerUseEnabled,
      availability: { available: status.available, detail: status.detail, actionUrl: status.available ? undefined : status.installUrl },
    }
  }
  const plugins = new PluginService(ompExecutable, (path) => projects.authorizeProjectRoot(path), {
    harness: 'omp',
    builtInSkills: async () => [{
      id: 'omp-work-schedules', name: 'Scheduled tasks',
      description: 'OMP extension for durable project and thread schedules managed by OMP Desktop.',
      kind: 'extension', location: 'system', path: ompScheduleExtensionPath, enabled: true,
    }, {
      id: 'omp-work-browser', name: 'Browser',
      description: 'OMP extension for driving this thread\'s in-app browser.',
      kind: 'extension', location: 'system', path: ompBrowserExtensionPath, enabled: stateStore.getSettings().browserEnabled,
    }, {
      id: 'gooeypi-ask-user', name: 'Ask user',
      description: 'OMP extension for asking focused multiple-choice questions in the OMP Desktop app.',
      kind: 'extension', location: 'system', path: ompAskUserExtensionPath, enabled: stateStore.getSettings().askUserEnabled,
    }, await computerUseSkill()],
  })
  const scheduledRuns = new ScheduledRunExecutor(
    projects,
    sessions,
    ompManager,
    catalog,
    ompDisabledProviders,
    ompDisabledModels,
  )
  const schedules = new AutomationService(stateStore, {
    validateTarget: (target) => scheduledRuns.validateTarget(target),
    validateExecution: (execution) => scheduledRuns.validateExecution(execution),
    validatePrompt: assertNoMcpAuthenticationCommand,
    run: (task) => scheduledRuns.run(task),
  })
  automation = schedules
  await schedules.start()
  const scheduleBridge = new AgentScheduleBridge({
    service: schedules,
    harness: 'omp',
    skillPath: ompScheduleExtensionPath,
    resolveScope: async ({ cwd, sessionPath }) => {
      const catalogList = await projects.list()
      const canonicalCwd = resolve(cwd)
      const project = catalogList.find((candidate) => !candidate.inferred && candidate.folders.some((folder) => {
        const root = resolve(folder)
        return canonicalCwd === root || canonicalCwd.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)
      }))
      if (!project) throw new Error('The agent is not running in an explicitly granted OMP Desktop project')
      if (!sessionPath) return { projectId: project.id }
      const scheduledSession = (await sessions.list(undefined, true)).find((candidate) => resolve(candidate.filePath) === resolve(sessionPath))
      return { projectId: project.id, sessionId: scheduledSession?.id }
    },
  })
  const browserService = new AgentBrowserService({
    getGuest: (webContentsId) => {
      const contents = webContents.fromId(webContentsId)
      return contents && !contents.isDestroyed() ? contents : undefined
    },
  })
  agentBrowser = browserService
  const browserBridge = new AgentBrowserBridge({ service: browserService, terminals, extensionPath: ompBrowserExtensionPath, skillPath: computerUseSkillPath })
  const collaborationBridge = new AgentCollaborationBridge({
    extensionPath: collaborationExtensionPath,
    sessions: { omp: sessions },
    agents: { omp: ompManager },
    catalogs: { omp: catalog },
    disabledProviders: { omp: ompDisabledProviders },
    disabledModels: { omp: ompDisabledModels },
  })
  await Promise.all([
    scheduleBridge.start(),
    browserBridge.start(),
    collaborationBridge.start(),
  ])
  agentScheduleBridge = scheduleBridge
  agentBrowserBridge = browserBridge
  agentCollaborationBridge = collaborationBridge
  const revokeRuntimeCapabilities = (environment: NodeJS.ProcessEnv): void => {
    const claims: Array<[string, { revoke(token: string | undefined): boolean }, string | undefined]> = [
      ['schedule', scheduleBridge, environment.OMP_DESKTOP_SCHEDULE_TOKEN],
      ['browser', browserBridge, environment.OMP_DESKTOP_BROWSER_TOKEN],
      ['collaboration', collaborationBridge, environment.GOOEYPI_COLLABORATION_TOKEN],
    ]
    for (const [name, bridge, token] of claims) {
      try { bridge.revoke(token) } catch (error) {
        console.error(`OMP Desktop failed to revoke ${name} runtime capability: ${boundedErrorMessage(error)}`)
      }
    }
  }
  // OMP runtimes get the capability-scoped brokers through OMP-flavored
  // extensions. OMP has no --skill flag, so their tool descriptions carry the
  // app-specific usage guidance while OMP's own skills stay discovery-based.
  const capabilityExtensionPaths: CapabilityExtensionPaths = {
    schedule: ompScheduleExtensionPath,
    browser: ompBrowserExtensionPath,
    askUser: ompAskUserExtensionPath,
  }
  ompManager.setRuntimeEnvironmentProvider((scope) => ({
    ...extensionRuntimeEnvironment(scheduleBridge.environmentFor(scope), () => browserBridge.environmentFor(scope), capabilityExtensionPaths, stateStore.getSettings().askUserEnabled && scope.interactive, stateStore.getSettings().browserEnabled),
    ...collaborationBridge.environmentFor({ ...scope, harness: 'omp' }),
    GOOEYPI_CUA_DRIVER_PATH: stateStore.getSettings().computerUseEnabled ? cuaDriver.executable() ?? undefined : undefined,
    GOOEYPI_COMPUTER_USE_SKILL_PATH: stateStore.getSettings().computerUseEnabled && cuaDriver.executable() ? computerUseSkillPath : undefined,
  }))
  ompManager.setRuntimeStartListener((environment, info) => {
    browserBridge.bindSession(environment.OMP_DESKTOP_BROWSER_TOKEN, info.sessionFile)
    collaborationBridge.bindSession(environment.GOOEYPI_COLLABORATION_TOKEN, info.sessionFile, info.runtimeId)
  })
  ompManager.setRuntimeEndListener((environment) => revokeRuntimeCapabilities(environment))
  if (shutdownStarted) return
  const meta: AppMeta = {
    version: app.getVersion(),
    platform: process.platform,
    homeDir: homedir(),
    harnesses: initialHarnesses,
  }
  const updates = new UpdateService(getAutoUpdater(), { enabled: app.isPackaged })
  updateService = updates
  const refreshHarnesses = async () => {
    const harnesses = await discovery.refresh()
    const currentSettings = await reconcileActiveHarness(stateStore, harnesses)
    meta.harnesses = harnesses
    return { meta: structuredClone(meta), settings: currentSettings }
  }
  trustedRendererUrl = resolveRendererUrl()
  ipc = registerIpc({
    meta, refreshHarnesses, projects, checkouts, sessions, agents: ompManager, terminals, git, plugins, catalog, settings, updates, cuaDriver, schedules, browser: browserService, voice,
    popupApplicationMenu, setTitleBarTheme,
    applyInterfaceZoom,
  }, trustedRendererUrl)
  // The manager forwards envelopes to the renderer; envelopes carry the
  // runtimeId and RuntimeInfo carries the harness, so the renderer can route.
  const forwardAgentEvent = (envelope: PrimeEventEnvelope): void => {
    const renderer = mainWindow?.webContents
    if (!shutdownStarted && renderer && !renderer.isDestroyed()
      && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
      && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
      renderer.send('agent:event', envelope)
    }
  }
  ompManager.setEventSink(forwardAgentEvent)
  updates.setEventSink((state: AppUpdateState) => {
    const renderer = mainWindow?.webContents
    if (!shutdownStarted && renderer && !renderer.isDestroyed()
      && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
      && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
      renderer.send('updates:changed', state)
    }
  })
  installApplicationMenu({
    appName: 'OMP Desktop',
    updatesEnabled: updates.isEnabled(),
    closeWindow: () => {
      const window = mainWindow
      if (!window || window.isDestroyed()) app.quit()
      else window.close()
    },
    checkForUpdates: createManualUpdateCheck(() => updates.check(), async (notification) => {
      await dialog.showMessageBox({
        type: notification.type,
        title: 'OMP Desktop',
        message: notification.message,
        detail: notification.detail,
      })
    }),
  })
  backgroundMode.start()
  const window = await ensureWindow()
  if (packagedSmokeMarkerFile) {
    await runPackagedSmoke(window, packagedSmokeMarkerFile)
    return
  }
  updates.start()
}

/**
 * Reports packaged readiness once the trusted renderer has completed an
 * authorized IPC round trip, then quits. The launcher owns the deadline, so
 * nothing here polls or waits on a timer.
 */
async function runPackagedSmoke(window: BrowserWindow | null, markerPath: string): Promise<void> {
  if (!window || window.isDestroyed()) throw new Error('Packaged smoke mode could not open the renderer window')
  if (!ipc) throw new Error('Packaged smoke mode has no registered IPC surface to observe')
  await ipc.whenRendererReady
  const marker = serializePackagedSmokeMarker(packagedSmokeMarker(trustedRendererUrl, app.getVersion()))
  await writeFile(markerPath, marker, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  console.log(`${PACKAGED_SMOKE_READY_EVENT} ${trustedRendererUrl}`)
  shutdownApproved = true
  app.quit()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
else void app.whenReady().then(async () => {
  // Parsed from the first instance's own argv only: a second-instance command
  // line must never be able to make a running application write a marker and quit.
  const requestedSmokeMarker = packagedSmokeMarkerPath(process.argv)
  if (requestedSmokeMarker) {
    if (!app.isPackaged) throw new Error('Packaged smoke mode is only available in packaged builds')
    packagedSmokeMarkerFile = requestedSmokeMarker
  }
  registerRendererProtocol()
  let wasOpenedAtLogin = false
  if (process.platform === 'darwin' && app.isPackaged) {
    try { wasOpenedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin } catch { /* The explicit flag remains available if the OS lookup fails. */ }
  }
  startInBackground = shouldStartInBackground(process.argv, wasOpenedAtLogin)
  if (process.platform === 'darwin') {
    app.setActivationPolicy(startInBackground ? 'accessory' : 'regular')
    if (!startInBackground) app.dock?.setIcon(appIconPath())
  }
  const browserSession = session.defaultSession
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = permission === 'media' && 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(permission === 'media' && isAllowedRendererAudioPermission(contents.getURL(), contents.mainFrame.url, trustedRendererUrl, mediaTypes))
  })
  browserSession.setPermissionCheckHandler((contents, permission, _origin, details) => Boolean(contents && permission === 'media' && details.isMainFrame
    && isAllowedRendererAudioPermission(contents.getURL(), contents.mainFrame.url, trustedRendererUrl, details.mediaType ? [details.mediaType] : undefined)))
  const browserProfile = session.fromPartition(BROWSER_PARTITION)
  browserProfile.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  browserProfile.setPermissionCheckHandler(() => false)
  if (app.isPackaged) {
    browserSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [RENDERER_CONTENT_SECURITY_POLICY],
        },
      })
    })
  }
  await bootstrap()
  app.on('second-instance', () => {
    if (!shutdownStarted) revealApplication('second instance')
  })
  app.on('activate', () => {
    if (!shutdownStarted && (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible())) revealApplication('activation')
  })
}).catch((error: unknown) => {
  const failureDialog = startupFailureDialog(error)
  if (failureDialog) dialog.showErrorBox(failureDialog.title, failureDialog.detail)
  if (!shutdownStarted) console.error(`OMP Desktop failed to start: ${boundedErrorMessage(error)}`)
  app.quit()
})

app.on('window-all-closed', () => {
  routeAllWindowsClosed(shutdownStarted, backgroundMode, () => app.quit())
})

app.on('before-quit', (event) => {
  if (shutdownStarted) return
  if (!shutdownApproved) {
    const prompt = pendingShutdownPrompt()
    if (prompt) {
      event.preventDefault()
      if (!confirmingShutdown) requestShutdown(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null, prompt)
      return
    }
  }
  event.preventDefault()
  shutdownStarted = true

  const registration = ipc
  ipc = null
  registration?.dispose()
  backgroundMode?.dispose()
  updateService?.dispose()
  agents?.beginShutdown()
  beginProcessShutdown()
  beginPluginDiscoveryShutdown()
  downloads?.cancelAll()
  agentBrowser?.beginShutdown()
  void settleShutdown([
    agentScheduleBridge?.stop() ?? Promise.resolve(),
    agentBrowserBridge?.stop() ?? Promise.resolve(),
    agentCollaborationBridge?.stop() ?? Promise.resolve(),
    automation?.stop() ?? Promise.resolve(),
    terminals?.killAll() ?? Promise.resolve(),
    agents?.stopAll() ?? Promise.resolve(),
    stopChildProcesses(),
  ]).then(async () => {
    // Await the drain so the final persist lands before the process exits.
    try { await store?.beginShutdown() } catch (error) { console.error(`OMP Desktop store shutdown failed: ${boundedErrorMessage(error)}`) }
  }).finally(() => app.quit())
})
