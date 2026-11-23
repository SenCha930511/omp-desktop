import type { DesktopApi } from './api'

/**
 * The project-script bridge keeps its camelCase domain name but uses the
 * kebab-case wire namespace, so the contract below stays exact.
 */
type WireNamespace<Domain extends keyof DesktopApi> = Domain extends 'projectScripts' ? 'project-scripts' : Domain

/** Fixed channel names shared by main and preload; every bridge member must have an entry. */
export const IPC_CHANNELS = {
  app: {
    getMeta: 'app:get-meta',
    refreshHarnesses: 'app:refresh-harnesses',
    openExternal: 'app:open-external',
    revealPath: 'app:reveal-path',
    popupMenu: 'app:popup-menu',
    setTitleBarTheme: 'app:set-title-bar-theme',
    onOpenSettings: 'app:open-settings',
  },
  menu: {
    popup: 'menu:popup',
  },
  updates: {
    getState: 'updates:get-state',
    check: 'updates:check',
    checkLatestRelease: 'updates:check-latest-release',
    downloadAndInstall: 'updates:download-and-install',
    onChanged: 'updates:changed',
  },
  harnessUpdates: {
    getState: 'harnessUpdates:get-state',
    install: 'harnessUpdates:install',
    onChanged: 'harnessUpdates:changed',
  },
  projects: {
    list: 'projects:list',
    listFiles: 'projects:list-files',
    listCheckouts: 'projects:list-checkouts',
    executeCheckout: 'projects:execute-checkout',
    add: 'projects:add',
    grantInferred: 'projects:grant-inferred',
    relocate: 'projects:relocate',
    remove: 'projects:remove',
    touch: 'projects:touch',
    setPinned: 'projects:pin',
    updateScripts: 'projects:update-scripts',
    markSetupStarted: 'projects:mark-setup-started',
    finishSetup: 'projects:finish-setup',
  },
  files: {
    read: 'files:read',
    pick: 'files:pick',
  },
  sessions: {
    list: 'sessions:list',
    sync: 'sessions:sync',
    read: 'sessions:read',
    readPage: 'sessions:readPage',
    branch: 'sessions:branch',
    setPinned: 'sessions:setPinned',
    rename: 'sessions:rename',
    archive: 'sessions:archive',
    delete: 'sessions:delete',
    onChanged: 'sessions:changed',
  },
  agent: {
    start: 'agent:start',
    command: 'agent:command',
    refreshState: 'agent:refresh-state',
    stop: 'agent:stop',
    list: 'agent:list',
    onEvent: 'agent:event',
  },
  providers: {
    catalog: 'providers:catalog',
  },
  voice: {
    credentialStatus: 'voice:credential-status',
    saveApiKey: 'voice:save-api-key',
    deleteApiKey: 'voice:delete-api-key',
    createRealtimeCall: 'voice:create-realtime-call',
    transcribe: 'voice:transcribe',
    testSelfHosted: 'voice:test-self-hosted',
  },
  projectScripts: {
    start: 'project-scripts:start',
    stop: 'project-scripts:stop',
    onOutput: 'project-scripts:output',
    onExit: 'project-scripts:exit',
  },
  git: {
    status: 'git:status',
    diff: 'git:diff',
    stage: 'git:stage',
    unstage: 'git:unstage',
    restore: 'git:restore',
    commit: 'git:commit',
  },
  plugins: {
    list: 'plugins:list',
    install: 'plugins:install',
    installExtension: 'plugins:install-extension',
    connectMcp: 'plugins:connect-mcp',
    setMcpEnabled: 'plugins:set-mcp-enabled',
    mutateCapability: 'plugins:mutate-capability',
    refresh: 'plugins:refresh',
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    resetBrowserData: 'settings:reset-browser-data',
  },
  browser: {
    state: 'browser:state',
    attachTab: 'browser:attach-tab',
    selectTab: 'browser:select-tab',
    closeTab: 'browser:close-tab',
    setPreviewContext: 'browser:set-preview-context',
    navigateTab: 'browser:navigate-tab',
    onChanged: 'browser:changed',
    onPointer: 'browser:pointer',
    onActivity: 'browser:activity',
  },
  schedules: {
    list: 'schedules:list',
    get: 'schedules:get',
    preview: 'schedules:preview',
    create: 'schedules:create',
    update: 'schedules:update',
    pause: 'schedules:pause',
    resume: 'schedules:resume',
    delete: 'schedules:delete',
    runNow: 'schedules:run-now',
    onChanged: 'schedules:changed',
  },
} as const satisfies { [Domain in keyof DesktopApi]: { [Method in keyof DesktopApi[Domain]]: `${WireNamespace<Domain>}:${string}` } }

export type IpcChannel = { [Domain in keyof typeof IPC_CHANNELS]: typeof IPC_CHANNELS[Domain][keyof typeof IPC_CHANNELS[Domain]] }[keyof typeof IPC_CHANNELS]
