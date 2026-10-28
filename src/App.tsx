import type { CSSProperties } from 'react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { activityNotificationSignature, readClearedActivity, readClearedAttention, sessionCompanionNotificationSignature } from '@/app/session-attention'
import { AgentBrowserLayer, type AgentSlotRect } from '@/components/AgentBrowserLayer'
import { Composer, type HarnessQueuedPreview } from '@/components/Composer'
import { ExtensionUiPresentation } from '@/components/ExtensionUiPresentation'
import { readComposerDraft } from '@/lib/composer-draft'
import { ReasoningExpandedContext } from '@/components/ReasoningDisclosure'
import { ConversationDock } from '@/components/ConversationDock'
import { CommandOutputPanel } from '@/components/CommandOutputPanel'
import { useCommandOutput } from '@/hooks/useCommandOutput'
import { SubagentsPanel } from '@/components/SubagentsPanel'
import { conversationExecution } from '@/lib/execution-state'
import { useSideQuestions } from '@/hooks/useSideQuestions'
import { useSubagents } from '@/hooks/useSubagents'
import { NoHarnessPrompt } from '@/components/NoHarnessPrompt'
import type { ProjectScriptKind } from '@/components/ProjectRunControl'
import { ResizeHandle } from '@/components/ResizeHandle'
import { SessionTreeDialog } from '@/components/SessionTreeDialog'
import { Sidebar } from '@/components/Sidebar'
import type { TerminalDrawerHandle } from '@/components/TerminalDrawer'
import { TitleToolbar } from '@/components/TitleToolbar'
import { useAgentBrowserTabs } from '@/hooks/useAgentBrowserTabs'
import { useAgentEvents } from '@/hooks/useAgentEvents'
import { useGitStatus } from '@/hooks/useGitStatus'
import { useAppSettings } from '@/hooks/useAppSettings'
import { useAppUpdates } from '@/hooks/useAppUpdates'
import { useHarnessUpdates } from '@/hooks/useHarnessUpdates'
import { Modal } from '@/components/ui'
import { useBootstrap } from '@/hooks/useBootstrap'
import { useBrowserAnnotations } from '@/hooks/useBrowserAnnotations'
import { useExtensionUi } from '@/hooks/useExtensionUi'
import { INSPECTOR_DEFAULT, INSPECTOR_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, TERMINAL_DEFAULT, TERMINAL_MIN, usePanelLayout } from '@/hooks/usePanelLayout'
import { usePluginSkills } from '@/hooks/usePluginSkills'
import { useProviderAccounts } from '@/hooks/useProviderAccounts'
import { useProviderCatalog } from '@/hooks/useProviderCatalog'
import { useSessionSettings } from '@/hooks/useSessionSettings'
import { useSidebarActions } from '@/hooks/useSidebarActions'
import { useStableCallback } from '@/hooks/useStableCallback'
import { useToast } from '@/hooks/useToast'
import { useWorkspaceActions } from '@/hooks/useWorkspaceActions'
import { useWorkspaceRuntime } from '@/hooks/useWorkspaceRuntime'
import { createAppKeydownHandler } from '@/lib/app-shortcuts'
import { SAMPLE_GIT, SAMPLE_PROJECTS, SAMPLE_SCHEDULES, SAMPLE_SESSIONS, SAMPLE_SKILLS, SAMPLE_TRANSCRIPT } from '@/lib/data'
import { openExternalUrl, revealPath } from '@/lib/desktop-actions'
import { errorMessage } from '@/lib/errors'
import { HARNESS_AGENT_NAMES, HARNESS_PRODUCT_NAMES, HARNESS_SHORT_NAMES } from '@/lib/harness'
import { continuedSessionKeys } from '@/lib/session-lineage'
import { isBackgroundedSlashCommand, type SlashCommand } from '@/lib/slash-commands'
import { I18nProvider, useI18n } from '@/lib/i18n'
import { detectRendererPlatform } from '@/lib/platform-shortcuts'
import { activeProjectScriptKind, ProjectScriptBusyError, setupNeedsRun } from '@/lib/project-scripts'
import { createSingleFlightAdmission, findProjectForSession, shouldRefreshGitOnSessionTransition, turnFileDeltas, workspaceCwd } from '@/lib/workspace'
import {
  type AutomationScheduleRecord,
  type CheckoutAction,
  type CheckoutCatalog,
  type GitFileChange,
  HARNESS_IDS,
  type HarnessId,
  type MessagePart,
  type PrimeModelDescriptor,
  type PrimeProviderDescriptor,
  type ProjectRecord,
  type PromptDeliveryIntent,
  type PromptImage,
  type QueuedPrompt,
  type ScheduleTiming,
  type SessionRecord,
  type TerminalSelectionContext,
  type WorkspaceView,
} from '@/types/api'

const Transcript = lazy(() => import('@/components/ConversationTranscript').then((module) => ({ default: module.ConversationTranscript })))
const Inspector = lazy(() => import('@/components/WorkspaceInspector').then((module) => ({ default: module.WorkspaceInspector })))
const SideChatPanel = lazy(() => import('@/components/SideChatPanel').then((module) => ({ default: module.SideChatPanel })))
const TerminalDrawer = lazy(() => import('@/components/TerminalDrawer').then((module) => ({ default: module.TerminalDrawer })))
const CommandPalette = lazy(() => import('@/components/CommandPalette').then((module) => ({ default: module.CommandPalette })))
const ExtensionUiModal = lazy(() => import('@/components/ExtensionUiModal').then((module) => ({ default: module.ExtensionUiModal })))
const ProjectsPage = lazy(() => import('@/pages/ProjectsPage').then((module) => ({ default: module.ProjectsPage })))
const ActivityPage = lazy(() => import('@/pages/ActivityPage').then((module) => ({ default: module.ActivityPage })))
const ScheduledPage = lazy(() => import('@/pages/ScheduledPage').then((module) => ({ default: module.ScheduledPage })))
const PluginsPage = lazy(() => import('@/pages/PluginsPage').then((module) => ({ default: module.PluginsPage })))
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((module) => ({ default: module.SettingsPage })))

const hasBridge = () => typeof window !== 'undefined' && typeof window.desktop !== 'undefined'
// Stable fallback identities keep memoized children from re-rendering while the catalog loads.
const EMPTY_MODELS: PrimeModelDescriptor[] = []
const EMPTY_PROVIDERS: PrimeProviderDescriptor[] = []
const HARNESS_PROVIDER_DOCS: Record<HarnessId, string> = {
  omp: 'https://github.com/can1357/oh-my-pi/blob/main/docs/providers.md',
}
const LoadingPanel = ({ label }: { label: string }) => {
  const { t } = useI18n()
  return (
    <div className="empty-state" role="status">
      {t('app.loading', { label })}
    </div>
  )
}
const TerminalLoadingPanel = () => {
  const { t } = useI18n()
  return (
    <div className="terminal-drawer terminal-drawer--loading" role="status">
      {t('app.loadingTerminal')}
    </div>
  )
}

interface TerminalSessionMount {
  id: string
  workspaceKey: string
  cwd?: string
  sessionPath?: string
  initialCommand?: { id: string; command: string; label: string; onExit(exitCode: number): void }
}
interface ActiveProjectScriptRun {
  requestId: string
  projectId: string
  kind: ProjectScriptKind
  command: string
  harness: HarnessId
  drawerId?: string
  tabId?: string
  ownsDrawer: boolean
}
type ProjectScriptRunOutcome = { cancelled: true } | { exitCode: number }

export default function App() {
  const bridge = hasBridge() ? window.desktop : null
  const { t } = useI18n()
  const initialProject = bridge ? undefined : SAMPLE_PROJECTS[0]
  const initialSession = bridge ? undefined : SAMPLE_SESSIONS[0]
  const [projects, setProjects] = useState<ProjectRecord[]>(() => (bridge ? [] : SAMPLE_PROJECTS))
  const [sessions, setSessions] = useState<SessionRecord[]>(() => (bridge ? [] : SAMPLE_SESSIONS))
  const [clearedAttention, setClearedAttention] = useState<Record<string, string>>(() => readClearedAttention())
  const [clearedActivity, setClearedActivity] = useState<Record<string, string>>(() => readClearedActivity())
  const [schedules, setSchedules] = useState<AutomationScheduleRecord[]>(() => (bridge ? [] : SAMPLE_SCHEDULES))
  const [scheduleFocusId, setScheduleFocusId] = useState<string | null>(null)
  const [scheduleError, setScheduleError] = useState('')
  const [checkoutCatalog, setCheckoutCatalog] = useState<CheckoutCatalog>()
  const [checkoutsLoading, setCheckoutsLoading] = useState(false)
  const [view, setView] = useState<WorkspaceView>('session')
  const [settingsSectionRequest, setSettingsSectionRequest] = useState<{ section: 'general' | 'agent'; id: number }>({ section: 'general', id: 0 })
  const [noHarnessPromptDismissed, setNoHarnessPromptDismissed] = useState(false)
  const [browserGeneration, setBrowserGeneration] = useState(0)
  const [browserNavigationRequest, setBrowserNavigationRequest] = useState<{ id: number; url: string }>()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [restorePrompt, setRestorePrompt] = useState<{ owner: number; id: number; text: string }>()
  const [sessionTreeOpen, setSessionTreeOpen] = useState(false)
  const submissionGenerationRef = useRef<number | undefined>(undefined)
  const { toast, toastTone, setToast, setToastHovered } = useToast()
  const [changesCardDismissed, setChangesCardDismissed] = useState(false)
  /** Edits attributed to the last completed turn; null until a turn finishes in this window. */
  const [turnChanges, setTurnChanges] = useState<GitFileChange[] | null>(null)
  const turnBaselineRef = useRef<GitFileChange[] | null>(null)
  const turnInFlightRef = useRef(false)
  const turnResultPendingRef = useRef(false)
  const turnOwnerRef = useRef('')
  const submissionAdmissionRef = useRef(createSingleFlightAdmission())
  const queuedFlushRef = useRef(false)
  const checkoutRequestRef = useRef(0)
  const scheduleRequestRef = useRef(0)
  const demoTimerRef = useRef<number[]>([])
  // config_warnings_changed 觸發功能目錄重新探索;useAgentEvents 在
  // usePluginSkills 之前初始化,故以 ref 延後解析。
  const pluginSkillsRefreshRef = useRef<(() => Promise<void>) | null>(null)
  const [activeProjectScriptRun, setActiveProjectScriptRun] = useState<ActiveProjectScriptRun>()
  const activeProjectScriptRunRef = useRef<ActiveProjectScriptRun | undefined>(undefined)
  const projectScriptStartingRef = useRef(false)
  activeProjectScriptRunRef.current = activeProjectScriptRun

  const reportError = useCallback((error: unknown) => {
    setToast(errorMessage(error), 'error')
  }, [])
  // The shell handlers answer with false instead of rejecting, so the refusal
  // reaches the user as a toast rather than disappearing into a dropped result.
  const openExternal = useCallback(
    (url: string) => {
      if (!bridge) return
      void openExternalUrl(bridge.app, url).then((failure) => {
        if (failure) setToast(failure)
      })
    },
    [bridge],
  )
  const revealInFileManager = useCallback(
    (path: string) => {
      if (!bridge) return
      void revealPath(bridge.app, path).then((failure) => {
        if (failure) setToast(failure)
      })
    },
    [bridge],
  )
  const harnessUpdates = useHarnessUpdates(bridge, reportError)
  const [harnessUpdatePromptOpen, setHarnessUpdatePromptOpen] = useState(false)
  const harnessUpdatePromptShownRef = useRef(false)
  // The startup omp-update check opens its prompt exactly once per launch;
  // later availability (a retry) stays reachable through the sidebar row.
  useEffect(() => {
    if (harnessUpdates.state.phase === 'available' && !harnessUpdatePromptShownRef.current) {
      harnessUpdatePromptShownRef.current = true
      setHarnessUpdatePromptOpen(true)
    }
  }, [harnessUpdates.state.phase])
  const runHarnessUpdate = useCallback(() => {
    setHarnessUpdatePromptOpen(false)
    void harnessUpdates.install().then((state) => {
      if (state?.phase === 'installed') setToast(t('sidebar.harnessUpdate.installedToast', { version: state.availableVersion ?? '' }))
    })
  }, [harnessUpdates, setToast, t])
  const openHarnessUpdatePrompt = useCallback(() => {
    // The error row retries directly: omp re-checks before installing anyway.
    if (harnessUpdates.state.phase === 'error') runHarnessUpdate()
    else setHarnessUpdatePromptOpen(true)
  }, [harnessUpdates.state.phase, runHarnessUpdate])
  const appUpdates = useAppUpdates(bridge, reportError)
  useEffect(() => {
    window.localStorage.setItem('omp-desktop.cleared-session-attention', JSON.stringify(clearedAttention))
  }, [clearedAttention])
  useEffect(() => {
    window.localStorage.setItem('omp-desktop.cleared-activity', JSON.stringify(clearedActivity))
  }, [clearedActivity])
  const clearSessionAttention = useCallback((session: SessionRecord) => {
    const signature = sessionCompanionNotificationSignature(session)
    if (!signature) return
    setClearedAttention((current) => (current[session.id] === signature ? current : { ...current, [session.id]: signature }))
  }, [])
  const clearActivity = useCallback((activitySessions: SessionRecord[]) => {
    if (!activitySessions.length) return
    const ids = new Set(activitySessions.map((session) => session.id))
    setClearedActivity((current) => {
      const next = { ...current }
      for (const session of activitySessions) {
        const signature = activityNotificationSignature(session)
        if (signature) next[session.id] = signature
      }
      return next
    })
    setClearedAttention((current) => {
      const next = { ...current }
      for (const session of activitySessions) {
        const signature = sessionCompanionNotificationSignature(session)
        if (signature) next[session.id] = signature
      }
      return next
    })
    setSessions((items) => items.map((session) => (ids.has(session.id) ? { ...session, unread: false } : session)))
  }, [])
  const settingsState = useAppSettings({ bridge, reportError })
  const activeHarness = settingsState.settings.activeHarness
  const browserAnnotations = useBrowserAnnotations()
  const workspace = useWorkspaceRuntime({
    bridge,
    harness: activeHarness,
    initialProject,
    initialSession,
    sessions,
    initialMessages: bridge ? [] : SAMPLE_TRANSCRIPT,
    reportError,
  })
  const syncProviderRuntime = useCallback(
    async (runtimeId: string) => {
      if (!bridge) return
      const generation = workspace.workspaceRef.current.generation
      const next = (await bridge.agent.list()).find((candidate) => candidate.runtimeId === runtimeId)
      if (next && workspace.workspaceRef.current.generation === generation) workspace.attachRuntime(next, generation)
    },
    [bridge, workspace.attachRuntime, workspace.workspaceRef],
  )
  const rememberSelectedModel = useCallback(
    (modelKey: string) => {
      void settingsState.updateSettings({
        lastSelectedModels: { ...settingsState.settings.lastSelectedModels, [activeHarness]: modelKey },
      })
    },
    [activeHarness, settingsState.settings.lastSelectedModels, settingsState.updateSettings],
  )
  const activeSession = useMemo(() => sessions.find((session) => session.id === workspace.activeSessionId), [sessions, workspace.activeSessionId])
  const subagents = useSubagents(bridge, workspace.runtime?.runtimeId, view === 'session')
  // Key side questions under the app's own session identity, not the harness
  // state dump: real OMP get_state omits sessionFile (only its TUI fixture
  // reported one), which had kept the probe — and the whole feature — from
  // ever firing against a live harness.
  const sideChatSessionId = workspace.activeSessionId ?? workspace.runtime?.sessionId ?? null
  const sideQuestions = useSideQuestions(bridge, sideChatSessionId, workspace.runtime?.runtimeId ?? null)
  const [sideChatOpen, setSideChatOpen] = useState(false)
  const [btwHint, setBtwHint] = useState(false)
  const activeSideChat = sideChatSessionId ? sideQuestions.session(sideChatSessionId) : undefined
  // The /btw-without-runtime hint lives in the conversation; the first real
  // message covers it, exactly like a stale system note being pushed away.
  useEffect(() => {
    if (btwHint && workspace.messages.length > 0) setBtwHint(false)
  }, [btwHint, workspace.messages.length])
  useEffect(() => setBtwHint(false), [workspace.activeSessionId])
  const commandOutput = useCommandOutput(workspace.workspaceGeneration)
  const backgroundCommandDepthRef = useRef(0)
  const commandOutputBegin = useCallback(
    (command: string, onAbort?: () => void) => {
      if (isBackgroundedSlashCommand(command)) backgroundCommandDepthRef.current += 1
      else commandOutput.begin(command, onAbort)
    },
    [commandOutput],
  )
  const commandOutputFinish = useCallback(
    (failure?: string, agentInvoked?: boolean) => {
      if (backgroundCommandDepthRef.current > 0) backgroundCommandDepthRef.current -= 1
      else commandOutput.finish(failure, agentInvoked)
    },
    [commandOutput],
  )
  const commandOutputAppend = useCallback(
    (text: string, failed = false) => {
      // Harness echoes for a backgrounded command must stay silent too: without
      // a begun entry, append would otherwise open the panel on its own.
      if (backgroundCommandDepthRef.current > 0) return
      commandOutput.append(text, failed)
    },
    [commandOutput],
  )
  const provider = useProviderCatalog({
    bridge,
    ready: settingsState.initialized,
    harness: activeHarness,
    runtime: workspace.runtime,
    activeSession,
    lastSelectedModel: settingsState.settings.lastSelectedModels[activeHarness],
    defaultEffort: settingsState.settings.defaultEffort,
    rememberModel: rememberSelectedModel,
    syncRuntime: syncProviderRuntime,
    reportError,
  })
  // Session 設定(context popover):值透傳 runtime 快照,切換即送上游 RPC。
  const sessionSettingsCtl = useSessionSettings(bridge, workspace.runtime, reportError)
  const activeProject = useMemo(
    () => findProjectForSession(projects, activeSession) ?? projects.find((project) => project.id === workspace.activeProjectId) ?? projects[0],
    [projects, activeSession, workspace.activeProjectId],
  )
  const activeCwd = workspaceCwd(activeProject, activeSession)
  // Mention list follows the sidebar's lineage collapse (session-lineage.ts):
  // the chain's live continuation is mentionable, the folded original is not.
  // A continuation file itself (parentSession set, depth 1) is a real
  // top-level conversation — unlike rlm subagent files — so it stays eligible.
  const mentionableSessions = useMemo(() => {
    const continuedBy = continuedSessionKeys(sessions)
    return sessions.filter(
      (session) =>
        !session.archived &&
        (session.depth === 0 || session.parentSession !== undefined) &&
        !(continuedBy.has(session.id) || continuedBy.has(session.filePath)) &&
        session.id !== activeSession?.id &&
        session.projectPath === activeCwd,
    )
  }, [activeCwd, activeSession?.id, sessions])
  const terminalSessionKey = workspace.activeSessionId
    ? `${activeProject?.id ?? 'no-project'}:${workspace.activeSessionId}`
    : `${activeProject?.id ?? 'no-project'}:new:${workspace.workspaceGeneration}`
  const activeTerminalSessionPath = workspace.runtime?.sessionFile ?? activeSession?.filePath
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionMount[]>([])
  const [terminalDrawerRevision, setTerminalDrawerRevision] = useState(0)
  const activeTerminalSession = useMemo(
    () => terminalSessions.find((terminal) => terminal.workspaceKey === terminalSessionKey || Boolean(activeTerminalSessionPath && terminal.sessionPath === activeTerminalSessionPath)),
    [activeTerminalSessionPath, terminalSessionKey, terminalSessions],
  )
  const terminalOpen = Boolean(activeTerminalSession)
  const { git, refreshGit } = useGitStatus({
    bridge,
    cwd: activeCwd,
    generation: workspace.workspaceGeneration,
    workspaceRef: workspace.workspaceRef,
    reportError,
    initial: { cwd: initialProject?.primaryFolder, status: bridge ? { isRepo: false, files: [] } : SAMPLE_GIT },
  })
  useEffect(() => {
    setChangesCardDismissed(false)
  }, [activeCwd])
  useEffect(() => {
    if (!turnChanges?.length || !settingsState.settings.showFileChangesPopup) setChangesCardDismissed(false)
  }, [turnChanges?.length, settingsState.settings.showFileChangesPopup])
  const closeSmallestPanels = useCallback(
    (patch: { sidebarOpen?: false; inspectorOpen?: false }) => {
      void settingsState.updateSettings(patch)
    },
    [settingsState.updateSettings],
  )
  const layout = usePanelLayout({
    sidebarOpen: settingsState.sidebarOpen,
    inspectorOpen: settingsState.inspectorOpen,
    setInspectorOpen: settingsState.setInspectorOpen,
    closeSmallestPanels,
    terminalOpen,
    view,
  })
  const sidebarVisible = settingsState.sidebarOpen && !layout.sidebarSuppressed
  const inspectorVisible = settingsState.inspectorOpen && !layout.inspectorSuppressed
  // The side-question dock shares the right panel slot with the inspector:
  // opening it hides the inspector chrome but keeps its open state so the
  // inspector toggle restores the same tab.
  const sideChatSupported = activeSideChat?.supported === true
  // The harness advertises /btw only to its TUI; the dock owns it here, so it
  // joins the composer's catalog while the session supports side questions.
  const visibleSlashCommands = useMemo(() => {
    const base = workspace.runtime?.availableCommands
    if (!base) return base
    // Some commands the desktop implements have no text-mode handler upstream,
    // so the live catalog never advertises them. Merge them back like /btw so
    // they stay discoverable alongside the harness-provided entries.
    const injected: SlashCommand[] = [
      ...(sideChatSupported ? [{ name: 'btw', description: 'Open side questions', source: 'builtin' }] : []),
      { name: 'goal', description: 'Create or manage the session goal', source: 'builtin', input: { hint: '[set|show|pause|resume|drop] <objective>' } },
      { name: 'pause', description: 'Pause the session goal', source: 'builtin' },
      { name: 'status', description: 'Show the current session status', source: 'builtin' },
    ]
    const present = new Set(base.map((command: SlashCommand) => command.name))
    const missing = injected.filter((command) => !present.has(command.name))
    return missing.length ? [...base, ...missing] : base
  }, [workspace.runtime?.availableCommands, sideChatSupported])
  const sideChatVisible = view === 'session' && sideChatOpen && !layout.inspectorSuppressed
  const extension = useExtensionUi({
    bridge,
    activeRuntimeId: workspace.runtime?.runtimeId,
    runtimeSessionsRef: workspace.runtimeSessionsRef,
    setSessions,
    setRuntime: workspace.setRuntime,
    reportError,
  })
  // /login /logout 的 GUI 驅動殼:provider 帳號面板掛在 Capabilities 頁,
  // 取消登入 = 對上游等待中的 extension_ui dialog 回 cancelled(上游中止
  // OAuth flow);憑證全程 OMP custody,panel 資料已白名單解析。
  const providerAccounts = useProviderAccounts({
    bridge,
    activeRuntimeId: workspace.runtime?.runtimeId,
    cancelActiveDialog: () => {
      if (extension.extensionUi) void extension.respondToExtensionUi({ cancelled: true })
    },
  })
  // 登入中的 open_url:上游語意是「直接開系統瀏覽器」(rpc.md),但既有
  // presentation 是工作階段檢視裡的點擊卡。從 Capabilities 頁發起的登入
  // 看不到該卡,因此登入進行中時對同一個 open_url 請求自動開一次;卡片
  // 仍保留作為後備(瀏覽器被關掉時可再點)。
  const autoOpenedAuthUrlRef = useRef<unknown>(null)
  useEffect(() => {
    const request = extension.openUrlRequest
    if (!providerAccounts.loginInFlight) {
      autoOpenedAuthUrlRef.current = null
      return
    }
    if (!request || !bridge || autoOpenedAuthUrlRef.current === request) return
    autoOpenedAuthUrlRef.current = request
    void openExternalUrl(bridge.app, request.url).then((failure) => {
      if (failure) setToast(failure)
    })
  }, [extension.openUrlRequest, providerAccounts.loginInFlight, bridge])
  // Stable identity: the harness-switch reset lives inside the bootstrap
  // effect, and an unstable callback would re-run the whole bootstrap.
  // Shared views stay in place while their harness-scoped data refreshes.
  const onHarnessSwitch = useCallback(() => {
    setScheduleFocusId(null)
  }, [])
  const { meta, initialized, refreshHarnesses } = useBootstrap({
    bridge,
    ready: settingsState.initialized,
    harness: activeHarness,
    setProjects,
    setSessions,
    setSchedules,
    setScheduleError,
    runtimeSessionsRef: workspace.runtimeSessionsRef,
    workspaceRef: workspace.workspaceRef,
    activateWorkspace: workspace.activateWorkspace,
    attachRuntime: workspace.attachRuntime,
    sessionHasOpenExtensionUi: extension.hasOpenRequestForSession,
    onHarnessSwitch,
    reportError,
  })
  const platform = meta?.platform ?? detectRendererPlatform()
  const detectedHarnesses = useMemo(() => (meta ? HARNESS_IDS.filter((harness) => Boolean(meta.harnesses[harness].path)) : []), [meta])
  const refreshDetectedHarnesses = useCallback(async () => {
    const result = await settingsState.reconcileExternalSettings(refreshHarnesses)
    if (!result) return
    if (result.settings.activeHarness === activeHarness && result.meta.harnesses[activeHarness].path) {
      await provider.refresh(true)
    }
  }, [activeHarness, provider.refresh, refreshHarnesses, settingsState.reconcileExternalSettings])
  useEffect(() => {
    if (detectedHarnesses.length) setNoHarnessPromptDismissed(false)
  }, [detectedHarnesses.length])
  useEffect(() => {
    if (view !== 'settings') {
      setSettingsSectionRequest((current) => (current.section === 'general' ? current : { section: 'general', id: current.id + 1 }))
    }
  }, [view])

  useAgentEvents({
    bridge,
    runtimeIdRef: workspace.runtimeIdRef,
    runtimeSessionsRef: workspace.runtimeSessionsRef,
    runtimeOwnerRef: workspace.runtimeOwnerRef,
    workspaceRef: workspace.workspaceRef,
    setSessions,
    setRuntime: workspace.setRuntime,
    reconcileQueuedPrompts: workspace.reconcileQueuedPrompts,
    clearQueuedPromptFlushFailures: workspace.clearQueuedPromptFlushFailures,
    clearQueuedPrompts: workspace.clearQueuedPrompts,
    queueAgentEvent: workspace.queueAgentEvent,
    onNotice: setToast,
    onConfigWarningsChanged: () => {
      void pluginSkillsRefreshRef.current?.()
    },
    onCommandOutput: commandOutputAppend,
    reconcileTranscriptForEvent: workspace.reconcileTranscriptForEvent,
    showExtensionUi: extension.showExtensionUi,
    clearExtensionUi: extension.clearExtensionUi,
    refreshGit,
    refreshGitOnTerminalEvent: Boolean(activeCwd),
    activeSessionVisible: view === 'session',
  })

  const refreshCheckouts = useCallback(async () => {
    const requestId = ++checkoutRequestRef.current
    if (!bridge || !activeProject || activeProject.inferred) {
      setCheckoutCatalog(undefined)
      setCheckoutsLoading(false)
      return
    }
    setCheckoutsLoading(true)
    try {
      const next = await bridge.projects.listCheckouts(activeProject.id, activeProject.harness)
      if (checkoutRequestRef.current === requestId) setCheckoutCatalog(next)
    } catch (error) {
      if (checkoutRequestRef.current === requestId) {
        setCheckoutCatalog(undefined)
        reportError(error)
      }
    } finally {
      if (checkoutRequestRef.current === requestId) setCheckoutsLoading(false)
    }
  }, [activeProject, bridge, reportError, settingsState.settings.checkoutStrategy])
  useEffect(() => {
    void refreshCheckouts()
    return () => {
      checkoutRequestRef.current += 1
    }
  }, [refreshCheckouts])
  const previousSessionStatusRef = useRef<SessionRecord['status'] | undefined>(undefined)
  const activeSessionStatus = activeSession?.status
  const locallyOwnedActiveSession = Boolean(activeSession && workspace.runtime?.sessionFile === activeSession.filePath)
  useEffect(() => {
    const previousStatus = previousSessionStatusRef.current
    previousSessionStatusRef.current = activeSessionStatus
    if (shouldRefreshGitOnSessionTransition(previousStatus, activeSessionStatus, locallyOwnedActiveSession)) void refreshGit()
  }, [activeSessionStatus, locallyOwnedActiveSession, refreshGit])
  const agentBrowser = useAgentBrowserTabs({ bridge, reportError })
  const terminalDrawerRefs = useRef(new Map<string, TerminalDrawerHandle>())
  const [terminalSelection, setTerminalSelection] = useState<TerminalSelectionContext>()
  const [agentPreviewSelected, setAgentPreviewSelected] = useState(true)
  const [agentSlotRect, setAgentSlotRect] = useState<AgentSlotRect | null>(null)
  const activeRuntimeSessionFile = workspace.runtime?.sessionFile
  const activeSessionFilePath = activeSession?.filePath
  const activeAgentTabs = useMemo(() => {
    const keys = new Set<string>()
    if (activeRuntimeSessionFile) keys.add(activeRuntimeSessionFile)
    if (activeSessionFilePath) keys.add(activeSessionFilePath)
    return agentBrowser.tabs.filter((tab) => keys.has(tab.sessionFile))
  }, [agentBrowser.tabs, activeRuntimeSessionFile, activeSessionFilePath])
  const activeAgentTabId = activeAgentTabs.find((tab) => tab.active)?.tabId ?? activeAgentTabs[0]?.tabId ?? null
  // Every agent browser action in the active thread surfaces the Browser
  // panel: open the inspector, select the Browser tab, and show the tab being
  // driven (the user's Preview or an agent tab), whatever was showing before.
  useEffect(() => {
    const activity = agentBrowser.activityEvent
    if (!activity) return
    if (activity.sessionFile !== activeRuntimeSessionFile && activity.sessionFile !== activeSessionFilePath) return
    setAgentPreviewSelected(activity.tabId === 'preview')
    settingsState.setInspectorOpen(true)
    settingsState.selectInspectorTab('browser')
  }, [agentBrowser.activityEvent, activeRuntimeSessionFile, activeSessionFilePath, settingsState.setInspectorOpen, settingsState.selectInspectorTab])
  useEffect(() => {
    if (!activeAgentTabs.length) setAgentPreviewSelected(true)
  }, [activeAgentTabs.length])
  const agentTabVisible = view === 'session' && settingsState.inspectorOpen && settingsState.inspectorTab === 'browser' && !agentPreviewSelected && activeAgentTabId !== null
  const pluginScope = activeProject?.primaryFolder && !activeProject.inferred ? activeProject.primaryFolder : undefined
  const pluginSkills = usePluginSkills({ bridge, harness: activeHarness, scope: pluginScope, generation: workspace.workspaceGeneration, initialSkills: bridge ? [] : SAMPLE_SKILLS, reportError })
  pluginSkillsRefreshRef.current = pluginSkills.refresh
  useEffect(
    () => () => {
      demoTimerRef.current.forEach(window.clearTimeout)
    },
    [],
  )

  const refreshSchedules = useCallback(async () => {
    if (!bridge) return
    const requestId = ++scheduleRequestRef.current
    try {
      const next = await bridge.schedules.list(activeHarness)
      if (scheduleRequestRef.current === requestId) {
        setSchedules(next)
        setScheduleError('')
      }
    } catch (error) {
      if (scheduleRequestRef.current === requestId) setScheduleError(errorMessage(error))
      reportError(error)
    }
  }, [activeHarness, bridge, reportError])
  useEffect(() => {
    if (!bridge) return
    return bridge.schedules.onChanged(() => {
      void refreshSchedules()
    })
  }, [bridge, refreshSchedules])
  const patchProjectScripts = useCallback((projectId: string, scripts: NonNullable<ProjectRecord['scripts']>) => {
    setProjects((current) => current.map((project) => (project.id === projectId ? { ...project, scripts } : project)))
  }, [])
  const finishProjectScriptRun = useCallback(
    (run: ActiveProjectScriptRun, outcome: ProjectScriptRunOutcome) => {
      if (activeProjectScriptRunRef.current?.requestId !== run.requestId) return
      activeProjectScriptRunRef.current = undefined
      setActiveProjectScriptRun(undefined)
      if ('cancelled' in outcome) return
      const message =
        outcome.exitCode === 0
          ? run.kind === 'setup'
            ? t('app.toast.setupCompleted')
            : t('app.toast.runCompleted')
          : run.kind === 'setup'
            ? t('app.toast.setupExited', { code: outcome.exitCode })
            : t('app.toast.runExited', { code: outcome.exitCode })
      if (run.kind === 'setup' && bridge) {
        void bridge.projects
          .finishSetup(run.projectId, run.command, outcome.exitCode, run.harness)
          .then((scripts) => {
            if (!scripts) return
            patchProjectScripts(run.projectId, scripts)
            setToast(message)
          })
          .catch(reportError)
        return
      }
      setToast(message)
    },
    [bridge, patchProjectScripts, reportError, t],
  )

  // 使用即最近:開啟 session 的時間戳(僅記憶體),側欄據此把剛使用的
  // session 排到所屬群組最上面,所屬專案也會跳到「最近活動」排序頂端。
  const [recentSessionOpens, setRecentSessionOpens] = useState<ReadonlyMap<string, number>>(() => new Map())
  const bumpRecentSessionOpen = useCallback((sessionId: string) => {
    setRecentSessionOpens((current) => {
      const next = new Map(current)
      next.set(sessionId, Date.now())
      return next
    })
  }, [])
  const {
    toggleSidebar,
    toggleInspector,
    grantProject,
    selectProject,
    selectSession,
    newSession,
    openDraftSession,
    discardDraftSession,
    navigate,
    renameSession,
    deleteSession,
    branchSession,
    togglePinSession,
    addProject,
    relocateProject,
    removeProject,
    togglePinProject,
    setProjectSortMode,
    sendPrompt,
    stopRuntime,
    installSkill,
    installExtension,
    connectMcp,
    setMcpEnabled,
    mutateCapability,
    createSchedule,
    updateSchedule,
    mutateSchedule,
    openScheduledSession,
    openBrowser,
    openChanges,
    reloadCapabilities,
  } = useWorkspaceActions({
    bridge,
    initialized,
    projects,
    sessions,
    activeProject,
    workspace,
    settingsState,
    layout,
    provider,
    pluginSkills,
    submissionAdmissionRef,
    refreshGit,
    demoTimerRef,
    setProjects,
    setSessions,
    setView,
    setPaletteOpen,
    setToast,
    setSubmitting: (value) => {
      if (value === true) submissionGenerationRef.current = workspace.workspaceRef.current.generation
      setSubmitting(value)
    },
    onCommandStart: commandOutputBegin,
    onCommandFinish: commandOutputFinish,
    openSessionTree: () => setSessionTreeOpen(true),
    refreshSchedules,
    resetBrowserView: () => setBrowserGeneration((value) => value + 1),
    closeTerminalForSession: (sessionPath) => {
      const removed = terminalSessions.find((terminal) => terminal.sessionPath === sessionPath)
      const projectRun = activeProjectScriptRunRef.current
      if (removed && projectRun?.drawerId === removed.id) finishProjectScriptRun(projectRun, { cancelled: true })
      setTerminalSessions((current) => current.filter((terminal) => terminal.sessionPath !== sessionPath))
    },
    clearSessionAttention,
    bumpRecentSessionOpen,
    reportError,
  })
  // Side chats are transient: closing the panel (its × button or a session
  // switch) drops the visible topics so reopening starts blank, like
  // ChatGPT's temporary side conversation. Harness history is unaffected.
  // The dock has no toolbar toggle — it opens exclusively via /btw.
  const closeSideChat = useCallback(() => {
    setSideChatOpen(false)
    if (workspace.activeSessionId) sideQuestions.clear(workspace.activeSessionId)
  }, [workspace.activeSessionId, sideQuestions])
  const toggleInspectorPanel = useCallback(() => {
    setSideChatOpen(false)
    toggleInspector()
  }, [toggleInspector])
  const askSideQuestion = useCallback(
    (question: string, topicId?: string) => {
      if (!sideChatSessionId) return
      void sideQuestions
        .ask(sideChatSessionId, question, topicId)
        .then((answered) => {
          if (!answered) reportError(new Error('Side questions are unavailable for this session'))
        })
        .catch(reportError)
    },
    [sideChatSessionId, sideQuestions, reportError],
  )
  const cancelSideQuestion = useCallback(
    (topicId?: string) => {
      if (!sideChatSessionId) return
      void sideQuestions.cancel(sideChatSessionId, topicId).catch(reportError)
    },
    [sideChatSessionId, sideQuestions, reportError],
  )
  const selectSideQuestionTopic = useCallback(
    (topicId: string | null) => {
      if (!sideChatSessionId) return
      sideQuestions.setActiveTopic(sideChatSessionId, topicId)
    },
    [sideChatSessionId, sideQuestions],
  )
  // Intercept /btw before it ever reaches the harness: bare opens the dock,
  // `/btw <question>` opens it and fires the question as a new topic. The
  // intercept also runs while the support probe is still resolving — the
  // probe only hides the button, not the command — and regardless of the
  // composer's delivery intent: with messageEnterAction 'steer' a plain
  // Enter produces a steer, which would otherwise ride the steer channel
  // into the harness's turn queue instead of opening the dock. A /btw typed
  // in the composer always means the side chat. In a fresh, never-sent
  // session there is no runtime to ride yet, so the command is consumed
  // with a hint instead of leaking into the conversation as a stray prompt.
  // The intercept no longer depends on the support probe: a once-failed probe
  // would otherwise strand /btw into the harness queue. An unsupported harness
  // surfaces through the ask error instead.
  const sideChatIntercept = true
  const sendVisiblePrompt = useCallback(
    (prompt: string, images: PromptImage[] = [], intent: PromptDeliveryIntent = 'queue') => {
      const trimmed = prompt.trim()
      if (sideChatIntercept && /^\/btw(?:\s|$)/.test(trimmed)) {
        if (!sideChatSessionId) {
          // No runtime to ride yet — surface the hint inside the conversation;
          // the first real message covers it (effect below).
          setBtwHint(true)
          return Promise.resolve()
        }
        const question = trimmed.slice(4).trim()
        setSideChatOpen(true)
        if (question) askSideQuestion(question)
        return Promise.resolve()
      }
      // Any real prompt (slash command or message) covers the hint.
      if (intent !== 'steer') setBtwHint(false)
      return sendPrompt(prompt, images, intent)
    },
    [sideChatIntercept, sideChatSessionId, askSideQuestion, sendPrompt],
  )
  const openTerminalLink = useCallback(
    (url: string, external: boolean) => {
      if (external) {
        openExternal(url)
        return
      }
      setAgentPreviewSelected(true)
      setBrowserNavigationRequest((current) => ({ id: (current?.id ?? 0) + 1, url }))
      openBrowser()
    },
    [openBrowser, openExternal],
  )
  const handleBrowserNavigationRequest = useCallback((id: number) => {
    setBrowserNavigationRequest((current) => (current?.id === id ? undefined : current))
  }, [])
  useEffect(() => {
    const onOpenSettings = bridge?.app.onOpenSettings
    if (!onOpenSettings) return
    return onOpenSettings(() => {
      setSettingsSectionRequest((current) => ({ section: 'general', id: current.id + 1 }))
      navigate('settings')
    })
  }, [bridge, navigate])
  const addOrReplaceProject = useCallback((project: ProjectRecord) => {
    setProjects((current) => {
      const absorbed = new Set([project.path, project.primaryFolder, ...project.folders])
      const kept = current.filter((item) => item.id === project.id || (!absorbed.has(item.path) && !absorbed.has(item.primaryFolder)))
      const existing = kept.findIndex((item) => item.id === project.id)
      if (existing < 0) return [...kept, project]
      return kept.map((item, index) => (index === existing ? project : item))
    })
  }, [])
  const executeCheckout = useCallback(
    async (action: CheckoutAction) => {
      if (!bridge || !activeProject) return
      try {
        const result = await bridge.projects.executeCheckout(activeProject.id, action, activeProject.harness)
        if (result.kind === 'refused') throw new Error(result.message)
        if (result.kind !== 'applied') return
        addOrReplaceProject(result.project)
        newSession(result.project)
      } catch (error) {
        reportError(error)
        throw error
      }
    },
    [activeProject, addOrReplaceProject, bridge, newSession, reportError],
  )

  const closeTerminal = useCallback(
    (id: string) => {
      const projectRun = activeProjectScriptRunRef.current
      if (projectRun?.drawerId === id) finishProjectScriptRun(projectRun, { cancelled: true })
      terminalDrawerRefs.current.delete(id)
      setTerminalSessions((current) => current.filter((terminal) => terminal.id !== id))
      if (activeTerminalSession?.id === id) setTerminalSelection(undefined)
    },
    [activeTerminalSession?.id, finishProjectScriptRun],
  )
  const toggleTerminal = useCallback(async () => {
    if (activeTerminalSession) {
      closeTerminal(activeTerminalSession.id)
      return
    }
    if (!activeProject || !activeCwd) return
    if (activeProject.inferred) {
      try {
        await grantProject(activeProject)
      } catch (error) {
        reportError(error)
        return
      }
    }
    setTerminalSessions((current) => {
      const existing = current.find((terminal) => terminal.workspaceKey === terminalSessionKey || Boolean(activeTerminalSessionPath && terminal.sessionPath === activeTerminalSessionPath))
      if (existing) return current
      return [...current, { id: crypto.randomUUID(), workspaceKey: terminalSessionKey, cwd: activeCwd, sessionPath: activeTerminalSessionPath }]
    })
  }, [activeCwd, activeProject, activeTerminalSession, activeTerminalSessionPath, closeTerminal, grantProject, reportError, terminalSessionKey])
  useEffect(() => {
    settingsState.setTerminalOpen(terminalOpen)
  }, [settingsState.setTerminalOpen, terminalOpen])
  useEffect(() => {
    if (!activeTerminalSession) {
      setTerminalSelection(undefined)
      return
    }
    setTerminalSessions((current) =>
      current.map((terminal) => {
        if (terminal.id !== activeTerminalSession.id) return terminal
        const sessionPath = activeTerminalSessionPath ?? terminal.sessionPath
        if (terminal.cwd === activeCwd && terminal.sessionPath === sessionPath) return terminal
        return { ...terminal, cwd: activeCwd, sessionPath }
      }),
    )
    setTerminalSelection(terminalDrawerRefs.current.get(activeTerminalSession.id)?.readSelectionContext())
  }, [activeCwd, activeTerminalSession?.id, activeTerminalSessionPath])
  // Stable identities keep the memoized Inspector and Composer from
  // re-rendering at streaming-frame rate; useStableCallback always dispatches
  // to the latest render's closures.
  const inspectorAutomations = useMemo(
    () => (activeSession ? schedules.filter((task) => task.harness === activeHarness && task.target.kind === 'session' && task.target.sessionId === activeSession.id) : []),
    [activeHarness, activeSession, schedules],
  )
  const openAutomation = useCallback((id: string) => {
    setScheduleFocusId(id)
    setView('scheduled')
  }, [])
  const selectAgentTab = useStableCallback((tabId: string) => {
    setAgentPreviewSelected(false)
    agentBrowser.select(tabId)
  })
  const showBrowserPreview = useCallback(() => setAgentPreviewSelected(true), [])
  const previewContext = useStableCallback((webContentsId: number | null, sessionFile: string | null) => {
    if (bridge) void bridge.browser.setPreviewContext(webContentsId, sessionFile).catch(() => undefined)
  })
  const navigateAgentTab = useStableCallback((tabId: string, action: 'back' | 'forward' | 'reload') => {
    if (bridge) void bridge.browser.navigateTab(tabId, action).catch(reportError)
  })
  const grantActiveProject = useStableCallback(() =>
    activeProject
      ? grantProject(activeProject)
          .then(() => undefined)
          .catch(reportError)
      : undefined,
  )
  const getTerminalContext = useStableCallback(() => (activeTerminalSession ? terminalDrawerRefs.current.get(activeTerminalSession.id)?.readSelectionContext() : undefined))
  const removeQueuedMessage = useStableCallback((message: QueuedPrompt) => workspace.removeQueuedPrompt(message.id))
  const sendQueuedMessage = useStableCallback(async (message: QueuedPrompt) => {
    workspace.updateQueuedPromptDelivery(message.id, true)
    try {
      await sendPrompt(message.text, [], 'steer', message.id)
      workspace.removeQueuedPrompt(message.id)
    } catch (error) {
      workspace.markQueuedPromptFlushFailed(message.id)
      throw error
    } finally {
      workspace.updateQueuedPromptDelivery(message.id, false)
    }
  })

  // Harness-held rows act through omp's own queue commands; the hook applies
  // the sessionActions snapshot each reply carries, so the refreshed runtime
  // state stays the display authority.
  const removeHarnessQueuedMessage = useStableCallback((message: string, queue: 'steering' | 'followUp') => workspace.removeHarnessQueuedMessage(message, queue))
  const promoteHarnessQueuedMessage = useStableCallback((message: string) => workspace.promoteHarnessQueuedMessage(message))
  const reclaimHarnessQueuedMessage = useStableCallback((message: string, queue: 'steering' | 'followUp', images: MessagePart[], imagesDropped?: boolean) => {
    const runtime = workspace.runtime
    if (!runtime?.runtimeId) return
    const promptImages = images.flatMap((part) =>
      part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string' ? [{ type: 'image' as const, data: part.data, mimeType: part.mimeType }] : [],
    )
    // The occupied draft keeps its place: the reclaimed message returns as an
    // unaccepted local row that only an explicit chip send can deliver.
    workspace.restoreWithdrawnQueue(
      {
        steering: queue === 'steering' ? [{ text: message, ...(promptImages.length ? { images: promptImages } : {}) }] : [],
        followUp: queue === 'followUp' ? [{ text: message, ...(promptImages.length ? { images: promptImages } : {}) }] : [],
        skipped: 0,
        ...(imagesDropped ? { imagesDropped: true } : {}),
      },
      { harness: runtime.harness, sessionFile: runtime.sessionFile, runtimeId: runtime.runtimeId },
    )
    if (imagesDropped) {
      // A lossy reclaim stays visible, exactly like the stop-withdraw flow.
      workspace.setMessages((items) => [
        ...items,
        {
          id: `reclaim-images-${Date.now()}`,
          role: 'system',
          timestamp: Date.now(),
          parts: [{ type: 'text', text: 'Some images from the reclaimed message exceeded the transport limit and could not be restored.' }],
        },
      ])
    }
  })
  const clearTerminalSelection = useStableCallback(() => {
    if (activeTerminalSession) terminalDrawerRefs.current.get(activeTerminalSession.id)?.clearSelection()
  })
  const startProjectScript = useCallback(
    async (kind: ProjectScriptKind) => {
      if (!bridge || !activeProject || !activeCwd) throw new Error('Project scripts are available in the desktop app for an active project.')
      if (activeProjectScriptRunRef.current || projectScriptStartingRef.current) throw new ProjectScriptBusyError()
      projectScriptStartingRef.current = true
      try {
        const project = activeProject.inferred ? await grantProject(activeProject) : activeProject
        const command = project.scripts?.[kind]?.trim() ?? ''
        if (!command) throw new Error(`Configure a ${kind} command first.`)
        if (kind === 'setup') {
          const scripts = await bridge.projects.markSetupStarted(project.id, command, project.harness)
          patchProjectScripts(project.id, scripts)
        }
        const run: ActiveProjectScriptRun = { requestId: crypto.randomUUID(), projectId: project.id, harness: project.harness, kind, command, ownsDrawer: false }
        const existing = terminalSessions.find((terminal) => terminal.workspaceKey === terminalSessionKey || Boolean(activeTerminalSessionPath && terminal.sessionPath === activeTerminalSessionPath))
        if (existing) {
          const pending = { ...run, drawerId: existing.id, ownsDrawer: false }
          activeProjectScriptRunRef.current = pending
          setActiveProjectScriptRun(pending)
        } else {
          const drawerId = crypto.randomUUID()
          const tabId = crypto.randomUUID()
          const started = { ...run, drawerId, tabId, ownsDrawer: true }
          activeProjectScriptRunRef.current = started
          setActiveProjectScriptRun(started)
          setTerminalSessions((current) => [
            ...current,
            {
              id: drawerId,
              workspaceKey: terminalSessionKey,
              cwd: activeCwd,
              sessionPath: activeTerminalSessionPath,
              initialCommand: {
                id: tabId,
                command,
                label: kind === 'setup' ? 'Setup' : 'Run',
                onExit: (exitCode) => finishProjectScriptRun(started, exitCode === undefined ? { cancelled: true } : { exitCode }),
              },
            },
          ])
        }
      } finally {
        projectScriptStartingRef.current = false
      }
    },
    [activeCwd, activeProject, activeTerminalSessionPath, bridge, finishProjectScriptRun, grantProject, patchProjectScripts, terminalSessionKey, terminalSessions],
  )
  const saveProjectScripts = useCallback(
    async (scripts: { setup: string; run: string }) => {
      if (!bridge || !activeProject) throw new Error('Select a project first.')
      const project = activeProject.inferred ? await grantProject(activeProject) : activeProject
      const updated = await bridge.projects.updateScripts(project.id, scripts, project.harness)
      patchProjectScripts(project.id, updated)
    },
    [activeProject, bridge, grantProject, patchProjectScripts],
  )
  const stopProjectScript = useCallback(() => {
    const run = activeProjectScriptRunRef.current
    if (!run) return
    finishProjectScriptRun(run, { cancelled: true })
    if (!run.drawerId || !run.tabId) return
    const drawer = terminalDrawerRefs.current.get(run.drawerId)
    if (drawer) drawer.stopCommand(run.tabId)
    else setTerminalSessions((current) => current.filter((terminal) => terminal.id !== run.drawerId))
  }, [finishProjectScriptRun])
  useEffect(() => {
    if (view === 'session') return
    const run = activeProjectScriptRunRef.current
    if (!run) return
    finishProjectScriptRun(run, { cancelled: true })
    if (!run.drawerId) return
    const drawer = terminalDrawerRefs.current.get(run.drawerId)
    if (!run.ownsDrawer && drawer && run.tabId) drawer.stopCommand(run.tabId)
    if (run.ownsDrawer) setTerminalSessions((current) => current.filter((terminal) => terminal.id !== run.drawerId))
  }, [finishProjectScriptRun, view])
  useEffect(() => {
    const run = activeProjectScriptRun
    if (!run || run.tabId || !run.drawerId) return
    const drawer = terminalDrawerRefs.current.get(run.drawerId)
    if (!drawer) return
    try {
      const tabId = drawer.runCommand(run.command, run.kind === 'setup' ? 'Setup' : 'Run', (exitCode) => finishProjectScriptRun(run, exitCode === undefined ? { cancelled: true } : { exitCode }))
      const started = { ...run, tabId }
      activeProjectScriptRunRef.current = started
      setActiveProjectScriptRun(started)
    } catch (error) {
      finishProjectScriptRun(run, { cancelled: true })
      reportError(error)
    }
  }, [activeProjectScriptRun, finishProjectScriptRun, reportError, terminalDrawerRevision])
  useEffect(() => {
    const scripts = activeProject?.scripts
    if (!activeProject || !scripts || !setupNeedsRun(scripts) || activeProjectScriptRunRef.current) return
    void startProjectScript('setup').catch((error: unknown) => {
      if (!(error instanceof ProjectScriptBusyError)) reportError(error)
    })
  }, [activeProject?.id, activeProject?.scripts, activeProjectScriptRun, reportError, startProjectScript])
  const sidebarActions = useSidebarActions({
    onSelectSession: selectSession,
    onNavigate: navigate,
    onNewSession: newSession,
    onAddProject: () => {
      void addProject()
    },
    onRemoveProject: (project) => {
      void removeProject(project)
    },
    onSetProjectSortMode: setProjectSortMode,
    onTogglePinProject: (project) => {
      void togglePinProject(project)
    },
    onClose: toggleSidebar,
    onOpenPalette: () => setPaletteOpen(true),
    onRenameSession: renameSession,
    onArchiveSession: deleteSession,
    onPopupMenu: (items) => bridge?.menu?.popup(items) ?? Promise.resolve(null),
    onBranchSession: (session) => {
      void branchSession(session)
    },
    onTogglePinSession: (session) => {
      void togglePinSession(session)
    },
  })

  const onAppKeyDown = useStableCallback(
    createAppKeydownHandler(
      {
        'open-palette': () => setPaletteOpen(true),
        'new-session': () => newSession(),
        'open-browser': () => openBrowser(),
        'toggle-sidebar': () => toggleSidebar(),
        'toggle-terminal': () => {
          void toggleTerminal()
        },
        'open-settings': () => navigate('settings'),
        'close-palette': () => setPaletteOpen(false),
        'close-settings': () => navigate('session'),
      },
      document,
      view === 'settings',
    ),
  )

  useEffect(() => {
    window.addEventListener('keydown', onAppKeyDown)
    return () => window.removeEventListener('keydown', onAppKeyDown)
  }, [onAppKeyDown])

  const harnessSessionActions = workspace.runtime?.sessionActions
  // Delivery detection: omp's queue snapshot keeps a message listed after it
  // was injected into the running turn (v18.13 sends no removal event, and
  // its queue_update frames still name taken steers), so a preview whose
  // text already exists as a user message at the transcript tail has been
  // delivered and must not keep rendering as queued. Only tail user messages
  // participate: matching the whole transcript would hide a re-queued copy of
  // an older prompt before omp actually delivers it.
  const harnessPreviewCount = (harnessSessionActions?.steering.length ?? 0) + (harnessSessionActions?.followUps.length ?? 0)
  const deliveredQueueTexts = useMemo(() => {
    const texts: string[] = []
    for (let index = workspace.messages.length - 1; index >= 0 && texts.length < harnessPreviewCount + 1; index -= 1) {
      const message = workspace.messages[index]
      if (message.role !== 'user') continue
      // `user-queued-*` ids are the composer's optimistic rows (see
      // createQueuedMessageEvent): that text exists locally before delivery,
      // so matching it would hide every queued row the moment it is typed.
      if (message.id.startsWith('user-queued-')) continue
      const text = message.parts
        .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('')
      if (text) texts.push(text)
    }
    // The engine keeps a delivered steer in its queue list until the turn
    // ends, and no live event carries the mid-turn user row — but the session
    // file already holds it, so the catalog's tail user texts clear the
    // preview the moment the model receives the message.
    for (const text of activeSession?.lastUserTexts ?? []) if (text && !texts.includes(text)) texts.push(text)
    return texts
  }, [workspace.messages, harnessPreviewCount, activeSession])
  const queuePreviewDelivered = useStableCallback((preview: string) => deliveredQueueTexts.some((text) => text === preview || text.startsWith(preview) || preview.startsWith(text)))
  const harnessQueuedPreviews = useMemo<HarnessQueuedPreview[]>(
    () =>
      [
        ...(harnessSessionActions?.steering ?? []).map((message) => ({ message, queue: 'steering' as const })),
        ...(harnessSessionActions?.followUps ?? []).map((message) => ({ message, queue: 'followUp' as const })),
      ].filter((preview) => !queuePreviewDelivered(preview.message)),
    [harnessSessionActions, queuePreviewDelivered],
  )
  const deliveredQueuePreviews = harnessPreviewCount - harnessQueuedPreviews.length
  const harnessQueuedMessageCount = Math.max(0, (harnessSessionActions?.queuedCount ?? 0) - deliveredQueuePreviews)
  const busy = Boolean(workspace.runtime?.isStreaming || workspace.runtime?.isCompacting || harnessQueuedMessageCount > 0 || workspace.messages.some((message) => message.streaming))
  // The user stopped the current turn and the transcript tail is that
  // cancelled assistant row: the composer's send slot becomes a retry button
  // until a new draft arrives (mirroring how the stop button owns the slot
  // while the model streams).
  const stoppedTurnRetryAvailable =
    !busy &&
    (() => {
      const lastAssistant = [...workspace.messages].reverse().find((message) => message.role === 'assistant')
      return lastAssistant?.outcome === 'cancelled'
    })()
  const execution = conversationExecution({
    runtime: workspace.runtime,
    messages: workspace.messages,
    submitting: submitting && submissionGenerationRef.current === workspace.workspaceGeneration,
    waiting: Boolean(extension.extensionUi && extension.extensionUi.runtimeId === workspace.runtime?.runtimeId),
    sessionStatus: activeSession?.status,
  })
  /* Compare owned status snapshots. A turn already running when a workspace
     opens has no trustworthy baseline, so it cannot produce a changes card. */
  useEffect(() => {
    const owner = JSON.stringify([activeCwd, workspace.activeSessionId, workspace.workspaceGeneration])
    if (turnOwnerRef.current !== owner) {
      turnOwnerRef.current = owner
      turnBaselineRef.current = null
      turnInFlightRef.current = busy
      turnResultPendingRef.current = false
      setTurnChanges(null)
      return
    }
    if (busy) {
      if (!turnInFlightRef.current) {
        turnInFlightRef.current = true
        turnBaselineRef.current = git.files
      }
      setTurnChanges(null)
      return
    }
    if (turnInFlightRef.current) {
      turnInFlightRef.current = false
      turnResultPendingRef.current = true
      void refreshGit()
    }
    if (!turnResultPendingRef.current || !turnBaselineRef.current) return
    setTurnChanges(turnFileDeltas(git.files, turnBaselineRef.current))
  }, [busy, git.files, refreshGit, activeCwd, workspace.activeSessionId, workspace.workspaceGeneration])

  const turnGit = useMemo(() => ({ ...git, files: turnChanges ?? [] }), [git, turnChanges])
  const externalSessionRunning = Boolean(activeSession?.status === 'running' && workspace.runtime?.sessionFile !== activeSession.filePath)
  const queuedMessages = useMemo<QueuedPrompt[]>(() => workspace.pendingQueuedPrompts.filter((pending) => pending.intent === 'queue'), [workspace.pendingQueuedPrompts])
  useEffect(() => {
    if (!bridge || busy || externalSessionRunning || submitting || queuedFlushRef.current || queuedMessages.length === 0) return
    const next = queuedMessages[0]
    if (next.flushAttemptFailed || next.recovered || next.deliveryPending) return
    queuedFlushRef.current = true
    void sendPrompt(next.text, [], 'queue', next.id)
      .catch(() => undefined)
      .finally(() => {
        queuedFlushRef.current = false
      })
  }, [bridge, busy, externalSessionRunning, queuedMessages, sendPrompt, submitting])

  const viewLabels = {
    session: t('app.view.session'),
    projects: t('app.view.projects'),
    activity: t('app.view.activity'),
    scheduled: t('app.view.scheduled'),
    plugins: t('app.view.plugins'),
    settings: t('app.view.settings'),
  } as const satisfies Record<WorkspaceView, string>
  const page =
    view === 'projects' ? (
      <ProjectsPage
        projects={projects}
        sortMode={settingsState.settings.projectSortMode}
        onAdd={() => void addProject()}
        onOpen={selectProject}
        onRelocate={(project) => void relocateProject(project)}
        onRemove={(project) => void removeProject(project)}
        onTogglePin={(project) => void togglePinProject(project)}
      />
    ) : view === 'activity' ? (
      <ActivityPage sessions={sessions} projects={projects} clearedActivity={clearedActivity} onOpen={selectSession} onClear={clearActivity} />
    ) : view === 'scheduled' ? (
      <ScheduledPage
        harness={activeHarness}
        schedules={schedules}
        projects={projects}
        sessions={sessions}
        models={provider.catalog?.models ?? EMPTY_MODELS}
        lastSelectedModel={provider.model}
        error={scheduleError}
        initialProjectId={activeProject?.id}
        initialSessionId={activeSession?.id}
        selectedScheduleId={scheduleFocusId}
        onCreate={createSchedule}
        onUpdate={updateSchedule}
        onPause={(id: string) => mutateSchedule(() => bridge!.schedules.pause(id))}
        onResume={(id: string) => mutateSchedule(() => bridge!.schedules.resume(id))}
        onDelete={(id: string) => mutateSchedule(() => bridge!.schedules.delete(id))}
        onRunNow={(id: string) => mutateSchedule(() => bridge!.schedules.runNow(id))}
        onPreview={async (timing: ScheduleTiming) => (bridge ? bridge.schedules.preview(timing, 3) : { timing, occurrences: [] })}
        onOpenSession={openScheduledSession}
      />
    ) : view === 'plugins' ? (
      <PluginsPage
        harness={activeHarness}
        skills={pluginSkills.skills}
        warnings={pluginSkills.warnings}
        loading={pluginSkills.loading}
        activeProjectPath={activeProject?.primaryFolder}
        askUserEnabled={settingsState.settings.askUserEnabled}
        onSetAskUserEnabled={(enabled) => settingsState.updateSettings({ askUserEnabled: enabled })}
        browserEnabled={settingsState.settings.browserEnabled}
        onSetBrowserEnabled={(enabled) => settingsState.updateSettings({ browserEnabled: enabled })}
        computerUseEnabled={settingsState.settings.computerUseEnabled}
        onSetComputerUseEnabled={(enabled) => settingsState.updateSettings({ computerUseEnabled: enabled })}
        onOpenExternal={openExternal}
        onRefresh={pluginSkills.refresh}
        onInstall={installSkill}
        onInstallExtension={installExtension}
        onConnectMcp={connectMcp}
        onSetMcpEnabled={setMcpEnabled}
        onMutateCapability={mutateCapability}
        onReloadCapabilities={reloadCapabilities}
        providerAccounts={{
          usable: Boolean(bridge && workspace.runtime),
          providers: providerAccounts.providers,
          status: providerAccounts.status,
          error: providerAccounts.error,
          loginInFlight: providerAccounts.loginInFlight,
          noticeKey: providerAccounts.noticeKey,
          noticeValues: providerAccounts.noticeValues,
          accountsByProvider: providerAccounts.accountsByProvider,
          accountsLoadingProvider: providerAccounts.accountsLoadingProvider,
          onRefresh: () => void providerAccounts.refresh(),
          onLogin: (providerId) => void providerAccounts.beginLogin(providerId),
          onCancelLogin: providerAccounts.cancelLogin,
          onLoadAccounts: (providerId) => void providerAccounts.loadAccounts(providerId),
          onLogout: (providerId, credentialId) => void providerAccounts.logout(providerId, credentialId),
        }}
      />
    ) : view === 'settings' ? (
      <SettingsPage
        initialSection={settingsSectionRequest.section}
        initialSectionRequestId={settingsSectionRequest.id}
        settings={settingsState.settings}
        meta={meta}
        providerCatalog={provider.catalog}
        sessionSettings={sessionSettingsCtl}
        voice={bridge?.voice ?? null}
        updateState={appUpdates.state}
        onUpdateAction={appUpdates.act}
        onCheckLatestRelease={appUpdates.checkLatestRelease}
        onOpenExternal={bridge ? (url: string) => bridge.app.openExternal(url) : undefined}
        onClose={() => navigate('session')}
        onUpdate={settingsState.updateSettings}
        onRefreshHarnesses={refreshDetectedHarnesses}
        onResetBrowser={async () => {
          if (!bridge) throw new Error(t('app.toast.browserDataDesktopOnly'))
          if (!(await bridge.settings.resetBrowserData())) {
            const error = new Error(t('app.toast.browserDataNotCleared'))
            reportError(error)
            throw error
          }
          setBrowserGeneration((value) => value + 1)
        }}
        onOpenDocs={() => openExternal(HARNESS_PROVIDER_DOCS[activeHarness])}
      />
    ) : null

  return (
    <I18nProvider preference={settingsState.settings.locale}>
      <ReasoningExpandedContext.Provider value={settingsState.settings.reasoningExpandedByDefault}>
        <div
          className="app-shell"
          data-density={settingsState.settings.conversationDensity}
          aria-busy={!initialized}
          data-platform={platform}
          data-ready={initialized ? 'true' : 'false'}
          style={{ '--sidebar-width': `${layout.sidebarWidth}px` } as CSSProperties}
        >
          {sidebarVisible && initialized ? (
            <Sidebar
              projects={projects}
              sessions={sessions}
              clearedAttention={clearedAttention}
              recentSessionOpens={recentSessionOpens}
              activeProjectId={activeProject?.id}
              activeSessionId={workspace.activeSessionId}
              activeView={view}
              activeHarness={activeHarness}
              updateState={appUpdates.state}
              onUpdateAction={appUpdates.act}
              harnessUpdateState={harnessUpdates.state}
              onHarnessUpdateAction={openHarnessUpdatePrompt}
              projectSortMode={settingsState.settings.projectSortMode}
              {...sidebarActions}
              onSelectDraftSession={openDraftSession}
              onDiscardDraftSession={discardDraftSession}
              overlay={layout.compactLayout}
              platform={platform}
            />
          ) : null}
          {sidebarVisible && initialized && !layout.compactLayout ? (
            <ResizeHandle
              orientation="vertical"
              startEdge
              styleTarget=".app-shell"
              label={t('app.resizeSidebar')}
              value={layout.sidebarWidth}
              min={SIDEBAR_MIN}
              max={SIDEBAR_MAX}
              defaultValue={SIDEBAR_DEFAULT}
              onChange={layout.setSidebarWidth}
            />
          ) : null}
          {sidebarVisible && initialized ? <button type="button" className="panel-scrim panel-scrim--sidebar" aria-label={t('app.closeSidebar')} onClick={toggleSidebar} /> : null}
          <div className="workbench" inert={layout.compactLayout && sidebarVisible ? true : undefined}>
            <TitleToolbar
              project={view === 'session' ? activeProject : undefined}
              sessionTitle={view === 'session' ? activeSession?.title : undefined}
              gitBranch={git.branch}
              view={view}
              productName={HARNESS_PRODUCT_NAMES[activeHarness]}
              sidebarOpen={sidebarVisible}
              terminalOpen={terminalOpen}
              activeProjectScriptKind={activeProjectScriptKind(activeProjectScriptRun, activeProject?.id)}
              onRunProjectScript={startProjectScript}
              onStopProjectScript={stopProjectScript}
              onSaveProjectScripts={saveProjectScripts}
              onToggleSidebar={toggleSidebar}
              inspectorOpen={inspectorVisible && !sideChatVisible}
              onToggleInspector={toggleInspectorPanel}
              onToggleTerminal={toggleTerminal}
              onOpenBrowser={openBrowser}
              onOpenSessionTree={view === 'session' ? () => setSessionTreeOpen(true) : undefined}
              platform={platform}
            />
            <div className="workbench__content">
              {view === 'session' ? (
                <div
                  ref={layout.workspaceRowRef}
                  className="session-workspace"
                  style={{ '--inspector-width': `${layout.inspectorWidth}px`, '--side-chat-width': `${layout.sideChatWidth}px`, '--terminal-height': `${layout.terminalHeight}px` } as CSSProperties}
                >
                  <div ref={layout.sessionWorkspaceRef} className="conversation-column">
                    <SubagentsPanel
                      key={workspace.workspaceGeneration}
                      state={subagents}
                      connected={Boolean(workspace.runtime)}
                      showReasoning={settingsState.settings.showReasoningSummaries}
                      showTools={settingsState.settings.showToolCalls}
                      execution={execution}
                      pinned={settingsState.settings.subagentsPanelPinned}
                      onPinnedChange={(subagentsPanelPinned) => {
                        void settingsState.updateSettings({ subagentsPanelPinned })
                      }}
                    >
                      <main className="conversation-pane">
                        <Suspense fallback={<LoadingPanel label={t('app.panel.conversation')} />}>
                          <Transcript
                            key={workspace.activeSessionId ?? 'new-session'}
                            followKey={workspace.activeSessionId ?? 'new-session'}
                            transcript={workspace.transcriptStore}
                            git={turnGit}
                            harness={activeHarness}
                            loading={workspace.loadingSession}
                            active={busy || activeSession?.status === 'running'}
                            visible={!subagents.selectedId}
                            onRetry={async () => {
                              await sendPrompt('/retry')
                            }}
                            onRestorePrompt={(text) => setRestorePrompt({ owner: workspace.workspaceGeneration, id: Date.now(), text })}
                            showReasoning={settingsState.settings.showReasoningSummaries}
                            showTools={settingsState.settings.showToolCalls}
                            onOpenChanges={openChanges}
                            onSuggestion={(prompt) => {
                              void sendPrompt(prompt).catch(() => undefined)
                            }}
                            suggestionsDisabled={!activeProject || workspace.loadingSession || submitting}
                            showChangesCard={Boolean(turnChanges?.length && settingsState.settings.showFileChangesPopup && !changesCardDismissed)}
                            onDismissChanges={() => setChangesCardDismissed(true)}
                            queuedMessageCount={queuedMessages.length + harnessQueuedMessageCount}
                            onOpenSessionReference={(sessionId, harness) => {
                              const session = sessions.find((candidate) => candidate.id === sessionId && candidate.harness === harness && !candidate.archived && candidate.depth === 0)
                              if (session) void selectSession(session)
                              else setToast('That referenced session is archived or no longer available.')
                            }}
                          />
                        </Suspense>
                        {btwHint ? (
                          <div className="conversation-hint" role="status">
                            {t('sidechat.needsRuntime')}
                          </div>
                        ) : null}
                        <ConversationDock>
                          <CommandOutputPanel
                            text={commandOutput.text}
                            command={commandOutput.command}
                            status={commandOutput.status}
                            onAbort={commandOutput.onAbort}
                            onClose={commandOutput.dismiss}
                            history={commandOutput.history}
                            selectedId={commandOutput.selectedId}
                            onSelect={commandOutput.select}
                            onClear={commandOutput.clear}
                          />
                          <ExtensionUiPresentation
                            status={extension.extensionStatus}
                            widgets={extension.extensionWidgets}
                            editorText={extension.editorTextUpdate}
                            openUrl={extension.openUrlRequest}
                            capabilityNotices={extension.extensionCapabilityNotices}
                            composerDraft={
                              readComposerDraft(workspace.activeSessionId ? `${activeProject?.id ?? 'no-project'}:${workspace.activeSessionId}` : `${activeProject?.id ?? 'no-project'}:new`)?.text ??
                              ''
                            }
                            activeRuntimeId={workspace.runtime?.runtimeId}
                            onApplyEditorText={(text) => {
                              // Stale guard: only the update currently pending for
                              // the active runtime may reach the composer draft.
                              const update = extension.editorTextUpdate
                              if (!update || update.runtimeId !== workspace.runtime?.runtimeId || update.text !== text) return
                              extension.consumeEditorTextUpdate()
                              setRestorePrompt({ owner: workspace.workspaceGeneration, id: Date.now(), text })
                            }}
                            onDismissEditorText={() => extension.dismissEditorTextUpdate()}
                            onOpenUrl={(url) => {
                              if (bridge)
                                void openExternalUrl(bridge.app, url).then((failure) => {
                                  if (failure) setToast(failure)
                                })
                            }}
                            onDismissOpenUrl={() => extension.dismissOpenUrlRequest()}
                            onDismissCapabilityNotice={extension.dismissCapabilityNotice}
                          >
                            <Composer
                              availableCommands={visibleSlashCommands}
                              key={
                                workspace.activeSessionId
                                  ? `${activeProject?.id ?? 'no-project'}:${workspace.activeSessionId}`
                                  : `${activeProject?.id ?? 'no-project'}:new:${workspace.workspaceGeneration}`
                              }
                              draftKey={workspace.activeSessionId ? `${activeProject?.id ?? 'no-project'}:${workspace.activeSessionId}` : `${activeProject?.id ?? 'no-project'}:new`}
                              busy={busy}
                              submitting={submitting}
                              loading={workspace.loadingSession}
                              disabled={!activeProject}
                              messageEnterAction={settingsState.settings.messageEnterAction}
                              voice={bridge?.voice}
                              transcriptionProvider={settingsState.settings.voiceTranscriptionProvider}
                              model={provider.model}
                              effort={provider.effort}
                              modelsByProvider={provider.modelsByProvider}
                              resolvedAutoEffort={provider.resolvedAutoEffort}
                              providers={provider.catalog?.providers ?? EMPTY_PROVIDERS}
                              presets={provider.catalog?.presets}
                              onSwitchPreset={(preset) => {
                                void sendPrompt(`/modelpreset switch ${preset.name}`).catch(reportError)
                              }}
                              onSavePreset={(name) => void sendPrompt(`/modelpreset save ${name}`)}
                              reasoningLevels={provider.reasoningLevels}
                              fast={provider.fast}
                              fastSupported={provider.selectedModel?.fastModeSupported ?? false}
                              fastAvailable={workspace.runtime?.fastModeAvailable !== false}
                              usageLimit={provider.usageLimit}
                              approvalMode={settingsState.settings.ompApprovalMode}
                              onApprovalModeChange={(mode) => {
                                void settingsState.updateSettings({ ompApprovalMode: mode })
                              }}
                              checkoutCatalog={checkoutCatalog}
                              checkoutLabel={git.branch ?? activeProject?.gitBranch ?? activeProject?.name}
                              checkoutsLoading={checkoutsLoading}
                              onExecuteCheckout={bridge && activeProject && !activeProject.inferred && checkoutCatalog ? executeCheckout : undefined}
                              projects={projects}
                              activeProjectId={activeProject?.id}
                              onSelectProject={(project) => {
                                if (project.id === activeProject?.id) return
                                // An empty workspace keeps its fresh-session state in the
                                // picked folder; an active session navigates like the sidebar.
                                if (workspace.activeSessionId) void selectProject(project)
                                else newSession(project)
                              }}
                              onAddProjectFolder={() => {
                                void addProject()
                              }}
                              agentName={HARNESS_AGENT_NAMES[activeHarness]}
                              shortName={HARNESS_SHORT_NAMES[activeHarness]}
                              imageInputSupported={Boolean(provider.selectedModel?.input.includes('image') || provider.catalog?.visionDelegation)}
                              contextUsage={workspace.runtime?.contextUsage}
                              sessionUsage={workspace.runtime?.sessionUsage}
                              runtimeId={workspace.runtime?.runtimeId}
                              executingModel={workspace.runtime?.executingModel}
                              skills={pluginSkills.skills}
                              sessions={mentionableSessions}
                              annotations={browserAnnotations.annotations}
                              terminalSelection={terminalSelection}
                              getTerminalContext={getTerminalContext}
                              queuedMessages={queuedMessages}
                              harnessQueuedMessageCount={harnessQueuedMessageCount}
                              harnessQueuedPreviews={harnessQueuedPreviews}
                              queueRuntimeId={workspace.runtime?.runtimeId}
                              onRemoveHarnessQueuedMessage={removeHarnessQueuedMessage}
                              onPromoteHarnessQueuedMessage={promoteHarnessQueuedMessage}
                              onReclaimHarnessQueuedMessage={reclaimHarnessQueuedMessage}
                              onDeleteQueuedMessage={removeQueuedMessage}
                              onSendQueuedMessage={sendQueuedMessage}
                              onEditQueuedMessage={(message) => workspace.editQueuedPrompt(message.id, message.text)}
                              sendSignal={browserAnnotations.sendSignal}
                              restoreRequest={restorePrompt?.owner === workspace.workspaceGeneration ? restorePrompt : undefined}
                              onRestoreHandled={() => setRestorePrompt(undefined)}
                              onModelChange={provider.changeModel}
                              onEffortChange={provider.changeEffort}
                              onFastChange={provider.changeFast}
                              onSend={sendVisiblePrompt}
                              onStop={stopRuntime}
                              retryStoppedTurn={stoppedTurnRetryAvailable}
                              onRetryStoppedTurn={() => {
                                void sendPrompt('/retry')
                              }}
                              onRemoveAnnotation={browserAnnotations.remove}
                              onClearAnnotations={browserAnnotations.clear}
                              onClearTerminalSelection={clearTerminalSelection}
                            />
                          </ExtensionUiPresentation>
                        </ConversationDock>
                      </main>
                    </SubagentsPanel>
                    {terminalSessions.map((terminal) => (
                      <Suspense key={terminal.id} fallback={terminal.id === activeTerminalSession?.id ? <TerminalLoadingPanel /> : null}>
                        <TerminalDrawer
                          ref={(handle) => {
                            if (handle) terminalDrawerRefs.current.set(terminal.id, handle)
                            else terminalDrawerRefs.current.delete(terminal.id)
                          }}
                          visible={terminal.id === activeTerminalSession?.id}
                          cwd={terminal.cwd}
                          sessionPath={terminal.sessionPath}
                          shell={settingsState.settings.terminalShell}
                          initialCommand={terminal.initialCommand}
                          height={layout.terminalHeight}
                          minHeight={TERMINAL_MIN}
                          maxHeight={layout.terminalMax}
                          defaultHeight={TERMINAL_DEFAULT}
                          onHeightChange={layout.setTerminalHeight}
                          onClose={() => closeTerminal(terminal.id)}
                          onError={reportError}
                          onInitialCommandConsumed={() => setTerminalSessions((current) => current.map((item) => (item.id === terminal.id ? { ...item, initialCommand: undefined } : item)))}
                          onOpenLink={openTerminalLink}
                          onReady={() => setTerminalDrawerRevision((revision) => revision + 1)}
                          onSelectionChange={(selection) => {
                            if (terminal.id === activeTerminalSession?.id) setTerminalSelection(selection)
                          }}
                        />
                      </Suspense>
                    ))}
                  </div>
                  {sideChatVisible ? (
                    <ResizeHandle
                      orientation="vertical"
                      label={t('sidechat.resize')}
                      value={layout.sideChatWidth}
                      min={INSPECTOR_MIN}
                      max={layout.inspectorMax}
                      defaultValue={INSPECTOR_DEFAULT}
                      onChange={layout.setSideChatWidth}
                      cssVariable="--side-chat-width"
                    />
                  ) : inspectorVisible ? (
                    <ResizeHandle
                      orientation="vertical"
                      label={t('app.resizeInspector')}
                      value={layout.inspectorWidth}
                      min={INSPECTOR_MIN}
                      max={layout.inspectorMax}
                      defaultValue={INSPECTOR_DEFAULT}
                      onChange={layout.setInspectorWidth}
                    />
                  ) : null}
                  {sideChatVisible && activeSideChat && sideChatSessionId ? (
                    <Suspense fallback={<LoadingPanel label={t('sidechat.aria')} />}>
                      <SideChatPanel
                        key={`side-chat-${sideChatSessionId}`}
                        state={activeSideChat}
                        hasSession={Boolean(workspace.runtime)}
                        onAsk={askSideQuestion}
                        onCancel={cancelSideQuestion}
                        onSelectTopic={selectSideQuestionTopic}
                        onClose={closeSideChat}
                      />
                    </Suspense>
                  ) : inspectorVisible ? (
                    <Suspense fallback={<LoadingPanel label={t('app.panel.inspector')} />}>
                      <Inspector
                        key={`inspector-${browserGeneration}`}
                        activeTab={settingsState.inspectorTab}
                        onTabChange={settingsState.selectInspectorTab}
                        onClose={toggleInspectorPanel}
                        agentName={HARNESS_AGENT_NAMES[activeHarness]}
                        shortName={HARNESS_SHORT_NAMES[activeHarness]}
                        project={activeProject}
                        cwd={activeCwd}
                        runtime={workspace.runtime}
                        transcript={workspace.transcriptStore}
                        git={git}
                        automations={inspectorAutomations}
                        onOpenAutomation={openAutomation}
                        browserHome={settingsState.settings.browserHome}
                        browserNavigationRequest={browserNavigationRequest}
                        onBrowserNavigationRequestHandled={handleBrowserNavigationRequest}
                        browserAnnotations={browserAnnotations}
                        agentBrowserTabs={activeAgentTabs}
                        activeAgentTabId={activeAgentTabId}
                        agentPreviewSelected={agentPreviewSelected}
                        onSelectAgentTab={selectAgentTab}
                        onCloseAgentTab={agentBrowser.close}
                        onShowBrowserPreview={showBrowserPreview}
                        onAgentSlotRect={setAgentSlotRect}
                        agentSessionKey={activeRuntimeSessionFile ?? activeSessionFilePath}
                        onPreviewContext={previewContext}
                        previewPointerEvent={agentBrowser.pointerEvent?.tabId === 'preview' ? agentBrowser.pointerEvent : null}
                        onNavigateAgentTab={navigateAgentTab}
                        onRefreshGit={refreshGit}
                        onOpenExternal={openExternal}
                        onRevealPath={revealInFileManager}
                        onGrantProject={grantActiveProject}
                        overlay={layout.compactLayout}
                        platform={platform}
                      />
                    </Suspense>
                  ) : null}
                  {sideChatVisible ? <button type="button" className="panel-scrim panel-scrim--inspector" aria-label={t('sidechat.close')} onClick={closeSideChat} /> : null}
                  {!sideChatVisible && inspectorVisible ? (
                    <button type="button" className="panel-scrim panel-scrim--inspector" aria-label={t('app.closeInspector')} onClick={toggleInspectorPanel} />
                  ) : null}
                </div>
              ) : (
                <Suspense fallback={<LoadingPanel label={viewLabels[view]} />}>{page}</Suspense>
              )}
            </div>
          </div>
          {paletteOpen ? (
            <Suspense fallback={null}>
              <CommandPalette
                open
                onClose={() => setPaletteOpen(false)}
                onNavigate={navigate}
                onNewSession={newSession}
                onToggleSidebar={toggleSidebar}
                onToggleTerminal={toggleTerminal}
                onOpenBrowser={openBrowser}
                platform={platform}
              />
            </Suspense>
          ) : null}
          {extension.extensionUi ? (
            <Suspense fallback={<LoadingPanel label={t('app.panel.request')} />}>
              <ExtensionUiModal request={extension.extensionUi.request} onRespond={(response) => void extension.respondToExtensionUi(response)} platform={platform} />
            </Suspense>
          ) : null}
          {sessionTreeOpen ? (
            <SessionTreeDialog
              runtimeId={workspace.runtime?.runtimeId}
              onClose={() => setSessionTreeOpen(false)}
              onToast={(text) => setToast(text)}
              onPrefillPrompt={(text) => setRestorePrompt({ owner: workspace.workspaceGeneration, id: Date.now(), text })}
            />
          ) : null}
          {harnessUpdatePromptOpen && harnessUpdates.state.phase === 'available' ? (
            <Modal
              title={t('sidebar.harnessUpdate.confirmTitle')}
              onClose={() => setHarnessUpdatePromptOpen(false)}
              footer={
                <>
                  <button type="button" className="button" onClick={() => setHarnessUpdatePromptOpen(false)}>
                    {t('sidebar.harnessUpdate.later')}
                  </button>
                  <button type="button" className="button button--primary" onClick={runHarnessUpdate}>
                    {t('sidebar.harnessUpdate.updateNow')}
                  </button>
                </>
              }
            >
              <p>{t('sidebar.harnessUpdate.confirmBody', { version: harnessUpdates.state.availableVersion ?? '' })}</p>
            </Modal>
          ) : null}
          {meta && !detectedHarnesses.length && !noHarnessPromptDismissed ? (
            <NoHarnessPrompt
              onClose={() => setNoHarnessPromptDismissed(true)}
              onOpenHarnessSettings={() => {
                setNoHarnessPromptDismissed(true)
                setSettingsSectionRequest((current) => ({ section: 'agent', id: current.id + 1 }))
                setView('settings')
              }}
            />
          ) : null}
          {toast ? (
            <div className={`toast toast--${toastTone}`} data-tone={toastTone} role="status" onMouseEnter={() => setToastHovered(true)} onMouseLeave={() => setToastHovered(false)}>
              {toast}
              <button type="button" aria-label={t('app.dismiss')} onClick={() => setToast(null)}>
                ×
              </button>
            </div>
          ) : null}
          {bridge ? (
            <AgentBrowserLayer
              tabs={agentBrowser.tabs}
              visibleTabId={agentTabVisible ? activeAgentTabId : null}
              rect={agentTabVisible ? agentSlotRect : null}
              pointerEvent={agentBrowser.pointerEvent}
              onAttach={agentBrowser.attach}
            />
          ) : null}
        </div>
      </ReasoningExpandedContext.Provider>
    </I18nProvider>
  )
}
