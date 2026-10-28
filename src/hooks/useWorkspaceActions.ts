import { useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { requestFailureMessage, type WorkspaceSnapshot } from '@/app/workspace'
import { clearComposerDraft } from '@/lib/composer-draft'
import { errorMessage } from '@/lib/errors'
import type { WithdrawnQueue, WithdrawnQueuedMessage } from '@/lib/queued-prompt-storage'
import { HARNESS_AGENT_NAMES } from '@/lib/harness'
import { capabilityReloadPrompt, parseMcpAuthenticationCommand } from '@/lib/mcp-policy'
import { parseSessionActionSnapshot, streamingBehaviorForIntent } from '@/lib/session-actions'
import { alwaysLocalSlashCommand, busySlashDisposition, deferredSlashCommand, parseCompactCommand as parseCompactCommandCore, parseSlashInvocation, slashCommandAcceptsImages, type ParsedCompactCommand } from '@/lib/slash-commands'
import { localSlashResponse } from '@/lib/slash-command-ui'
import { agentControlOutcomeText } from '@/lib/goal-rpc'
import { parseBashShorthandInput, parsePythonShorthandInput } from '@/lib/input-shorthands'
import { bashResultFailed, bashResultStatusText, buildBashResultMessage, readBashResult } from '@/lib/bash-result'
import { resolveLocale, translate, type MessageKey } from '@/lib/i18n'
import type { DEFAULT_SETTINGS } from '@/lib/data'
import { type createSingleFlightAdmission, findProjectForSession, findRuntimeForWorkspace, newSessionProject, projectContainsPath, workspaceCwd } from '@/lib/workspace'
import type { CapabilityMutationInput, ExtensionInstallInput, McpConnectionInput, McpStateInput, DesktopApi, ProjectRecord, ProjectSortMode, PromptDeliveryIntent, PromptImage, ScheduleInput, SchedulePatch, SessionRecord, TranscriptMessage, WorkspaceView } from '@/types/api'
import type { useAppSettings } from '@/hooks/useAppSettings'
import type { usePanelLayout } from '@/hooks/usePanelLayout'
import type { usePluginSkills } from '@/hooks/usePluginSkills'
import type { ProviderCatalog } from '@/hooks/useProviderCatalog'
import type { useWorkspaceRuntime } from '@/hooks/useWorkspaceRuntime'
import { mergeSessionCatalog } from '@/hooks/useBootstrap'

export interface WorkspaceActionsDeps {
  bridge: DesktopApi | null
  initialized: boolean
  projects: ProjectRecord[]
  sessions: SessionRecord[]
  activeProject: ProjectRecord | undefined
  workspace: ReturnType<typeof useWorkspaceRuntime>
  settingsState: ReturnType<typeof useAppSettings>
  layout: ReturnType<typeof usePanelLayout>
  provider: ProviderCatalog
  pluginSkills: ReturnType<typeof usePluginSkills>
  submissionAdmissionRef: MutableRefObject<ReturnType<typeof createSingleFlightAdmission>>
  refreshGit(selected?: Pick<WorkspaceSnapshot, 'generation' | 'cwd'>): Promise<void>
  demoTimerRef: MutableRefObject<number[]>
  setProjects: Dispatch<SetStateAction<ProjectRecord[]>>
  setSessions: Dispatch<SetStateAction<SessionRecord[]>>
  setView: Dispatch<SetStateAction<WorkspaceView>>
  setPaletteOpen: Dispatch<SetStateAction<boolean>>
  setToast: Dispatch<SetStateAction<string | null>>
  setSubmitting: Dispatch<SetStateAction<boolean>>
  refreshSchedules(): Promise<void>
  resetBrowserView(): void
  closeTerminalForSession(sessionPath: string): void
  clearSessionAttention(session: SessionRecord): void
  reportError(error: unknown): void
  /** `onAbort` 只在可中止的指令(使用者 `!` bash)提供,面板據此顯示停止鈕。 */
  onCommandStart?(command: string, onAbort?: () => void): void
  onCommandFinish?(failure?: string, agentInvoked?: boolean): void
  /** 開啟 session tree dialog(App 持有其顯示狀態;/tree、/branch、/rewind 的 GUI 入口)。 */
  openSessionTree?(): void
}

export type McpCommand = { type: 'open' } | { type: 'authenticate'; server?: string }

interface StartedSessionIndexInput {
  bridge: DesktopApi
  harness: ProjectRecord['harness']
  sessionFile: string | undefined
  setSessions: Dispatch<SetStateAction<SessionRecord[]>>
  fallbackTitle?: string
  isCurrent?(): boolean
}

export async function indexStartedSession({ bridge, harness, sessionFile, setSessions, fallbackTitle, isCurrent }: StartedSessionIndexInput): Promise<SessionRecord | undefined> {
  if (!sessionFile) return
  // Runtime creation and filesystem watch delivery are separate async paths.
  // Make the created file part of the renderer catalog before prompt admission
  // continues, so navigating away cannot expose a watch-timing visibility gap.
  const catalog = await bridge.sessions.list(undefined, true, harness, true)
  const indexedSession = catalog.find((session) => session.filePath === sessionFile)
  if (isCurrent && !isCurrent()) return indexedSession
  setSessions((current) => mergeSessionCatalog(current, catalog, sessionFile, new Map(), 0).map((session) => (
    fallbackTitle && session.filePath === sessionFile && session.title === 'Untitled session'
      ? { ...session, title: fallbackTitle }
      : session
  )))
  return indexedSession
}

export function sessionTitleFromPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length > 100 ? `${oneLine.slice(0, 99)}…` : oneLine
}

interface StartedSessionTitleInput extends StartedSessionIndexInput {
  runtimeId: string
  prompt: string
}

export async function titleStartedSession({ bridge, harness, runtimeId, sessionFile, prompt, setSessions, isCurrent }: StartedSessionTitleInput): Promise<void> {
  if (!sessionFile) return
  const title = sessionTitleFromPrompt(prompt)
  if (!title) return

  // Prompt admission is the first point where this is a real user task. Show
  // its prompt-derived title immediately, then persist it through the harness.
  // Both persistence and the forced read are best-effort because a delivered
  // prompt must never be reported as failed solely due to title bookkeeping.
  if (!isCurrent || isCurrent()) {
    setSessions((current) => current.map((session) => session.filePath === sessionFile && session.title === 'Untitled session'
      ? { ...session, title }
      : session))
  }
  await bridge.agent.command(runtimeId, { type: 'set_session_name', name: title }).catch(() => undefined)
  await indexStartedSession({ bridge, harness, sessionFile, setSessions, fallbackTitle: title, isCurrent }).catch(() => undefined)
}

export function parseCompactCommand(prompt: string): ParsedCompactCommand | undefined {
  return parseCompactCommandCore(prompt)
}

export function parseMcpCommand(prompt: string): McpCommand | undefined {
  const value = prompt.trim()
  const authentication = parseMcpAuthenticationCommand(value)
  return authentication
    ? authentication.server ? { type: 'authenticate', server: authentication.server } : { type: 'authenticate' }
    : undefined
}

function parseWithdrawnImages(value: unknown): PromptImage[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const images: PromptImage[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const candidate = raw as Record<string, unknown>
    if (candidate.type !== 'image' || typeof candidate.data !== 'string' || typeof candidate.mimeType !== 'string') return undefined
    images.push({ type: 'image', data: candidate.data, mimeType: candidate.mimeType })
  }
  return images
}

/** Parses the `abort_and_restore_queue` result (`AbortAndRestoreQueueResult`)
 * defensively: omp's contract is `{ steering, followUp, imagesDropped?,
 * truncated? }` of `{ text, images? }`, but a malformed entry is skipped
 * rather than restored — an image-carrying command must never come back as
 * plain text. Returns null when the reply is not the result shape at all. */
export function parseWithdrawnQueue(value: unknown): WithdrawnQueue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.steering) || !Array.isArray(raw.followUp)) return null
  const parseList = (list: unknown[]): { messages: WithdrawnQueuedMessage[]; skipped: number } => {
    const messages: WithdrawnQueuedMessage[] = []
    let skipped = 0
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { skipped += 1; continue }
      const candidate = entry as Record<string, unknown>
      if (typeof candidate.text !== 'string' || candidate.text.length === 0) { skipped += 1; continue }
      const images = parseWithdrawnImages(candidate.images)
      if (images === undefined && candidate.images !== undefined) { skipped += 1; continue }
      messages.push(images ? { text: candidate.text, images } : { text: candidate.text })
    }
    return { messages, skipped }
  }
  const steering = parseList(raw.steering)
  const followUp = parseList(raw.followUp)
  return {
    steering: steering.messages,
    followUp: followUp.messages,
    skipped: steering.skipped + followUp.skipped,
    ...(raw.imagesDropped === true ? { imagesDropped: true } : {}),
    ...(raw.truncated === true ? { truncated: true } : {}),
  }
}

/**
 * The workspace mutation handlers, extracted from App. Every callback has a
 * stable identity (created once) and dispatches against the latest render's
 * dependencies, mirroring useStableCallback/useSidebarActions semantics.
 */
export function createWorkspaceActions(getDeps: () => WorkspaceActionsDeps) {
  const grantProject = async (project: ProjectRecord): Promise<ProjectRecord> => {
    const { bridge, workspace, setProjects, refreshGit } = getDeps()
    if (!bridge || !project.inferred) return project
    const granted = await bridge.projects.grantInferred(project.primaryFolder, project.harness)
    setProjects((items) => items.map((item) => item.id === project.id ? granted : item))
    const selected = workspace.workspaceRef.current
    if (selected.project?.id !== project.id) return granted
    workspace.workspaceRef.current = { ...selected, project: granted, cwd: workspaceCwd(granted, selected.session) }
    const cwd = workspaceCwd(granted, selected.session)
    if (!cwd) return granted
    await refreshGit({ generation: selected.generation, cwd })
    return granted
  }
  const persistPanel = (patch: Partial<typeof DEFAULT_SETTINGS>) => { void getDeps().settingsState.updateSettings(patch) }
  const toggleSidebar = () => {
    const { settingsState, layout } = getDeps()
    const next = !(settingsState.sidebarOpen && !layout.sidebarSuppressed)
    layout.setSmallestSidebarAllowed(next)
    layout.compactRestoreRef.current = null
    if (layout.compactLayout && next && settingsState.inspectorOpen) {
      layout.setSmallestInspectorAllowed(false)
      settingsState.setInspectorOpen(false)
    }
    persistPanel({ sidebarOpen: next })
  }
  const toggleInspector = () => {
    const { settingsState, layout } = getDeps()
    const next = !(settingsState.inspectorOpen && !layout.inspectorSuppressed)
    layout.setSmallestInspectorAllowed(next)
    layout.compactRestoreRef.current = null
    if (layout.compactLayout && next && settingsState.sidebarOpen) {
      layout.setSmallestSidebarAllowed(false)
      settingsState.setSidebarOpen(false)
    }
    persistPanel({ inspectorOpen: next })
  }
  const toggleTerminal = async () => {
    const { settingsState, activeProject, reportError } = getDeps()
    if (!settingsState.terminalOpen && activeProject?.inferred) {
      try { await grantProject(activeProject) } catch (error) { reportError(error); return }
    }
    persistPanel({ terminalOpen: !settingsState.terminalOpen })
  }
  const selectProject = async (project: ProjectRecord) => {
    const { bridge, layout, settingsState, sessions, workspace, setSessions, setView, clearSessionAttention, reportError } = getDeps()
    if (layout.compactLayout) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
    if (workspace.workspaceRef.current.project?.id === project.id) {
      setView('session')
      return
    }
    const session = sessions.find((candidate) => !candidate.archived && projectContainsPath(project, candidate.projectPath))
    if (session) {
      clearSessionAttention(session)
      setSessions((items) => items.map((item) => item.id === session.id ? { ...item, unread: false } : item))
    }
    const generation = workspace.activateWorkspace(project, session)
    setView('session')
    try {
      // Inferred projects come from the harness's global session history and
      // remain display-only until the user performs an action that needs a
      // filesystem grant (starting work or opening a terminal).
      if (bridge && !project.inferred) await bridge.projects.touch(project.id, project.harness)
      await workspace.reconcileRuntime(generation)
    } catch (error) { if (workspace.workspaceRef.current.generation === generation) reportError(error) }
  }
  const selectSession = async (session: SessionRecord) => {
    const { layout, settingsState, projects, workspace, setSessions, setView, clearSessionAttention, reportError } = getDeps()
    if (layout.compactLayout) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
    clearSessionAttention(session)
    setSessions((items) => items.map((item) => item.id === session.id ? { ...item, unread: false } : item))
    const project = findProjectForSession(projects, session)
    if (!project) { reportError('This session is not contained by an available project.'); return }
    const generation = workspace.activateWorkspace(project, session)
    setView('session')
    try { await workspace.reconcileRuntime(generation) }
    catch (error) { if (workspace.workspaceRef.current.generation === generation) reportError(error) }
  }
  // The local draft reset archive/delete fall back to: a renderer placeholder
  // only, with no engine boundary. Deliberately private — the public New
  // action is durable, and this shape must not leak back into the API.
  const openProjectDraft = (requestedProject?: ProjectRecord) => {
    const { bridge, initialized, layout, settingsState, activeProject, workspace, setView, setPaletteOpen } = getDeps()
    if (!initialized) return
    const project = newSessionProject(requestedProject, workspace.workspaceRef.current.project, activeProject)
    if (!project) return
    if (layout.compactLayout) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
    clearComposerDraft(`${project.id}:new`)
    workspace.activateWorkspace(project)
    if (!bridge) workspace.setMessages([])
    setView('session'); setPaletteOpen(false)
  }
  /** One durable New boundary per project at a time: a rapid double click on
   * the same project must not create two engine sessions, while a different
   * project requested mid-flight still establishes its own independent
   * boundary. Callers that ignore the promise share their project's flight. */
  const durableNewSessionFlights = new Map<string, Promise<void>>()
  /** runtimeId → when Stop last sent its graceful abort for the current
   * turn. A second press while the same turn still streams escalates to the
   * hard stop; any new prompt clears the entry so a fresh turn always gets
   * a graceful stop first. */
  const gracefulAbortAttempts = new Map<string, number>()
  // Public New: establishes an omp-owned empty session boundary on the engine
  // (TUI parity) instead of leaving only a renderer draft the next prompt
  // would auto-resume. The boundary rides a freshly started fileless runtime —
  // the current runtime and session are never commanded or stopped for it —
  // and its identity comes from the authoritative get_state plus catalog read.
  // Errors are caught and reported: UI clicks may ignore the promise, so the
  // action itself never rejects.
  const newSession = (requestedProject?: ProjectRecord): Promise<void> => {
    const { initialized, activeProject, workspace } = getDeps()
    if (!initialized) return Promise.resolve()
    const project = newSessionProject(requestedProject, workspace.workspaceRef.current.project, activeProject)
    if (!project) return Promise.resolve()
    const inFlight = durableNewSessionFlights.get(project.id)
    if (inFlight) return inFlight
    const run = async () => {
      const { bridge, layout, settingsState, setView, setPaletteOpen, reportError } = getDeps()
      if (layout.compactLayout) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
      clearComposerDraft(`${project.id}:new`)
      const generation = workspace.activateWorkspace(project)
      setView('session'); setPaletteOpen(false)
      if (!bridge) { workspace.setMessages([]); return }
      try {
        // An inferred project (from the harness's global session history) has
        // no filesystem grant yet: promoting it here keeps New session from
        // failing the cwd authorization gate the engine enforces.
        if (project.inferred) { try { await grantProject(project) } catch { /* the start below reports the authorization failure */ } }
        const cwd = workspace.workspaceRef.current.cwd ?? project.primaryFolder
        const runtime = await bridge.agent.start({ cwd, harness: project.harness })
        try {
          const boundary = await bridge.agent.command(runtime.runtimeId, { type: 'new_session' })
          const boundaryData = boundary.data
          if (boundaryData && typeof boundaryData === 'object' && !Array.isArray(boundaryData) && (boundaryData as Record<string, unknown>).cancelled === true) {
            throw new Error('The new session was cancelled before it was created.')
          }
          // new_session replies only with its cancellation flag; the boundary
          // is metadata-only, so the authoritative id and file come from
          // get_state and the catalog read that follows.
          const state = await bridge.agent.command(runtime.runtimeId, { type: 'get_state' })
          const stateData = state.data && typeof state.data === 'object' && !Array.isArray(state.data) ? state.data as Record<string, unknown> : {}
          const sessionId = typeof stateData.sessionId === 'string' ? stateData.sessionId : undefined
          const sessionFile = typeof stateData.sessionFile === 'string' ? stateData.sessionFile : undefined
          if (!sessionFile) throw new Error('The new session did not report its session file.')
          // The catalog row belongs in the sidebar even when the user already
          // navigated away; only the view adoption stays generation-guarded.
          const indexed = await indexStartedSession({ bridge, harness: project.harness, sessionFile, setSessions: getDeps().setSessions })
          if (workspace.workspaceRef.current.generation !== generation) return
          // A prompt submitted on the draft adopts its session without a
          // generation bump (adoptSessionId is identity-only); the boundary
          // must not drag that live turn off the workspace.
          if (workspace.workspaceRef.current.session) return
          if (indexed) workspace.adoptSessionId(indexed)
          workspace.attachRuntime({ ...runtime, ...(sessionId ? { sessionId } : {}), sessionFile }, generation)
        } catch (error) {
          // The boundary did not establish: clean up this flight's own
          // fileless runtime (never another project's) so a failed attempt
          // leaks no process, and never pretend success.
          await bridge.agent.stop(runtime.runtimeId).catch(() => false)
          throw error
        }
      } catch (error) {
        reportError(error)
      }
    }
    const flight = run().finally(() => { durableNewSessionFlights.delete(project.id) })
    durableNewSessionFlights.set(project.id, flight)
    return flight
  }
  // The draft placeholder row's own activation: unlike newSession it never
  // clears the composer draft, and re-activating the same draft is a no-op so
  // the composer is not remounted under the click.
  const openDraftSession = (project: ProjectRecord) => {
    const { layout, settingsState, workspace, setView } = getDeps()
    if (layout.compactLayout) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
    const current = workspace.workspaceRef.current
    if (current.project?.id !== project.id || current.session) workspace.activateWorkspace(project)
    setView('session')
  }
  // Trashing the draft placeholder discards it without a confirmation or any
  // backend call: fall back to the project's newest unarchived session, or
  // stay on a fresh draft when the project has none.
  const discardDraftSession = async (project: ProjectRecord) => {
    const { sessions, workspace, setSessions, setView, clearSessionAttention, reportError } = getDeps()
    const session = sessions.find((candidate) => !candidate.archived && projectContainsPath(project, candidate.projectPath))
    if (session) {
      clearSessionAttention(session)
      setSessions((items) => items.map((item) => item.id === session.id ? { ...item, unread: false } : item))
    }
    const generation = workspace.activateWorkspace(project, session)
    setView('session')
    try { await workspace.reconcileRuntime(generation) }
    catch (error) { if (workspace.workspaceRef.current.generation === generation) reportError(error) }
  }
  const navigate = (nextView: WorkspaceView) => {
    const { layout, settingsState, setView, setPaletteOpen } = getDeps()
    if (layout.compactLayout) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
    setView(nextView); setPaletteOpen(false)
  }
  const renameSession = async (session: SessionRecord, title: string) => {
    const { bridge, settingsState, setSessions, setToast, reportError } = getDeps()
    if (!bridge) return
    try {
      if (!await bridge.sessions.rename(session.filePath, title)) throw new Error(`${HARNESS_AGENT_NAMES[settingsState.settings.activeHarness]} could not rename this session.`)
      setSessions((items) => items.map((item) => item.id === session.id ? { ...item, title } : item)); setToast('Session renamed.')
    } catch (error) { reportError(error) }
  }
  const setSessionArchived = async (session: SessionRecord, archived: boolean) => {
    const { bridge, workspace, setSessions, setToast, resetBrowserView, closeTerminalForSession, clearSessionAttention, reportError } = getDeps()
    if (!bridge) return
    try {
      await bridge.sessions.archive(session.filePath, archived)
      if (archived) {
        clearSessionAttention(session)
        closeTerminalForSession(session.filePath)
      }
      setSessions((items) => items.map((item) => item.id === session.id ? { ...item, archived, unread: archived ? false : item.unread } : item))
      if (archived && workspace.workspaceRef.current.session?.id === session.id) {
        resetBrowserView()
        openProjectDraft()
      }
      setToast(archived ? 'Session archived.' : 'Session restored.')
    } catch (error) { reportError(error) }
  }
  const deleteSession = async (session: SessionRecord) => {
    const { bridge, workspace, settingsState, setSessions, setToast, resetBrowserView, closeTerminalForSession, clearSessionAttention, reportError } = getDeps()
    if (!bridge) return
    const locale = resolveLocale(settingsState.settings.locale ?? 'system')
    try {
      if (!await bridge.sessions.delete(session.filePath)) throw new Error(translate(locale, 'sessions.deleteFailed'))
      clearSessionAttention(session)
      closeTerminalForSession(session.filePath)
      clearComposerDraft(`${workspace.workspaceRef.current.project?.id ?? 'no-project'}:${session.id}`)
      setSessions((items) => items.filter((item) => item.filePath !== session.filePath))
      if (workspace.workspaceRef.current.session?.filePath === session.filePath) { resetBrowserView(); openProjectDraft() }
      setToast(translate(locale, 'sessions.deleted'))
    } catch (error) { reportError(error) }
  }
  const branchSession = async (session: SessionRecord) => {
    const { bridge, setSessions, setToast, settingsState, reportError } = getDeps()
    if (!bridge) return
    const locale = resolveLocale(settingsState.settings.locale ?? 'system')
    try {
      const branch = await bridge.sessions.branch(session.filePath)
      setSessions((items) => (items.some((item) => item.filePath === branch.filePath) ? items : [...items, branch]))
      selectSession(branch)
      setToast(translate(locale, 'sessions.branched'))
    } catch (error) {
      reportError(error instanceof Error ? error : new Error(translate(locale, 'sessions.branchFailed')))
    }
  }
  const togglePinSession = async (session: SessionRecord) => {
    const { bridge, setSessions, reportError } = getDeps()
    if (!bridge) return
    const pinned = !session.pinned
    try {
      await bridge.sessions.setPinned(session.filePath, pinned)
      setSessions((items) => items.map((item) => (item.filePath === session.filePath ? { ...item, pinned } : item)))
    } catch (error) {
      reportError(error)
    }
  }
  const addProject = async () => {
    const { bridge, workspace, setProjects, setView, setToast, settingsState, reportError } = getDeps()
    if (!bridge) { setToast('Project picker is available in the desktop app.'); return }
    try {
      const project = await bridge.projects.add(settingsState.settings.activeHarness)
      if (project) { setProjects((items) => [project, ...items.filter((item) => item.id !== project.id)]); workspace.activateWorkspace(project); setView('session') }
    } catch (error) { reportError(error) }
  }
  const relocateProject = async (project: ProjectRecord) => {
    const { bridge, workspace, setProjects, setView, setToast, reportError } = getDeps()
    if (!bridge) { setToast('Project relocation is available in the desktop app.'); return }
    try {
      const updated = await bridge.projects.relocate(project.id, project.harness)
      if (!updated) return
      setProjects((items) => items.map((item) => item.id === updated.id ? updated : item))
      if (workspace.workspaceRef.current.project?.id === project.id) { workspace.activateWorkspace(updated); setView('session') }
      setToast('Project folder updated.')
    } catch (error) { reportError(error) }
  }
  const removeProject = async (project: ProjectRecord) => {
    const { bridge, projects, sessions, workspace, setProjects, setSessions, setToast, closeTerminalForSession, clearSessionAttention, reportError } = getDeps()
    try {
      if (bridge && !await bridge.projects.remove(project.id, project.harness)) throw new Error('This project could not be removed.')
      // The main process deleted the project's saved sessions with it; mirror
      // the per-session cleanup the single-session delete path performs.
      const doomed = sessions.filter((item) => projectContainsPath(project, item.projectPath))
      for (const item of doomed) {
        clearSessionAttention(item)
        closeTerminalForSession(item.filePath)
        clearComposerDraft(`${project.id}:${item.id}`)
      }
      setProjects((items) => items.filter((item) => item.id !== project.id))
      setSessions((items) => items.filter((item) => !projectContainsPath(project, item.projectPath)))
      if (workspace.workspaceRef.current.project?.id === project.id) {
        const fallback = projects.find((item) => item.id !== project.id)
        const session = fallback ? sessions.find((candidate) => !candidate.archived && projectContainsPath(fallback, candidate.projectPath)) : undefined
        workspace.activateWorkspace(fallback, session)
      }
      setToast('Project removed. Its saved sessions were deleted.')
    } catch (error) { reportError(error) }
  }
  const togglePinProject = async (project: ProjectRecord) => {
    const { bridge, setProjects, setToast, reportError } = getDeps()
    if (project.inferred) { setToast('Add this project before pinning it.'); return }
    if (!bridge) { setToast('Project pinning is available in the desktop app.'); return }
    try {
      if (!await bridge.projects.setPinned(project.id, !project.pinned, project.harness)) throw new Error('This project could not be pinned.')
      setProjects((items) => items.map((item) => item.id === project.id ? { ...item, pinned: !project.pinned } : item))
    } catch (error) { reportError(error) }
  }
  const setProjectSortMode = (mode: ProjectSortMode) => {
    void getDeps().settingsState.updateSettings({ projectSortMode: mode })
  }

  // 使用者 `!` bash 的在途追蹤:OMP 每個 session 同一時間只跑一個使用者
  // bash(TUI isBashRunning 守衛),renderer 先擋並發;中止走 abort_bash RPC。
  let bashInFlight: { runtimeId: string; generation: number } | null = null

  /**
   * `!` shell 速寫:把指令送給擁有中的 runtime 的 `bash` RPC(游離/無
   * runtime 時不啟動新 runtime——TUI 的 bash 永遠掛在既有 session 上,這裡
   * 沒有 session 就明確拒絕,不偽造本地執行也不降級成模型 prompt)。
   * 結果列直接由 BashResult 組成 live transcript 列;磁碟上的 bashExecution
   * 重讀列出現時由 reconcile 以 role 取代(id 前綴在 LOCAL_MESSAGE_ID 內)。
   * 錯誤沿用 deferred 命令模式:面板標記失敗 + throw,Composer 還原草稿。
   */
  const runBashShorthand = async (rawText: string, command: string): Promise<void> => {
    const { bridge, workspace, settingsState, reportError, onCommandStart, onCommandFinish } = getDeps()
    const locale = resolveLocale(settingsState.settings.locale ?? 'system')
    const t = (key: MessageKey, values?: Record<string, string | number>) => translate(locale, key, values)
    const reject = (key: MessageKey): never => {
      const error = new Error(t(key))
      onCommandStart?.(rawText.trim())
      onCommandFinish?.(error.message)
      throw error
    }
    const snapshot = workspace.workspaceRef.current
    const runtime = workspace.runtime
    const owned = runtime !== null
      && workspace.runtimeOwnerRef.current?.runtimeId === runtime.runtimeId
      && workspace.runtimeOwnerRef.current.generation === snapshot.generation
    if (!bridge || !runtime || !owned) return reject('bash.error.noSession')
    if (bashInFlight) return reject('bash.error.busy')
    const generation = snapshot.generation
    bashInFlight = { runtimeId: runtime.runtimeId, generation }
    onCommandStart?.(`!${command}`, () => {
      if (bashInFlight?.runtimeId !== runtime.runtimeId) return
      // 中止只發 abort_bash;取消後的 BashResult(cancelled: true)走正常結果路徑。
      void bridge.agent.command(runtime.runtimeId, { type: 'abort_bash' }).catch(() => undefined)
    })
    try {
      const response = await bridge.agent.command(runtime.runtimeId, { type: 'bash', command })
      const result = readBashResult(response.data)
      if (workspace.workspaceRef.current.generation === generation) {
        const id = `bash-${Date.now()}`
        workspace.setMessages((items) => [...items, buildBashResultMessage(id, command, result, t)])
      }
      onCommandFinish?.(bashResultFailed(result) ? bashResultStatusText(result, t) : undefined)
    } catch (error) {
      onCommandFinish?.(requestFailureMessage(error))
      reportError(error)
      throw error
    } finally {
      if (bashInFlight?.runtimeId === runtime.runtimeId) bashInFlight = null
    }
  }

  const sendPrompt = async (
    prompt: string,
    images: PromptImage[] = [],
    intent: PromptDeliveryIntent = 'queue',
    queuedFlushPromptId?: string,
  ) => {
    const { bridge, sessions, workspace, provider, settingsState, submissionAdmissionRef, demoTimerRef, setSessions, setSubmitting, setView, setToast, reportError } = getDeps()
    const commandHarness = workspace.workspaceRef?.current?.project?.harness ?? settingsState.settings.activeHarness
    const slashCatalog = workspace.runtime?.availableCommands
    const deferred = deferredSlashCommand(prompt, slashCatalog)
    const locale = resolveLocale(settingsState.settings.locale ?? 'system')
    if (deferred) {
      const error = new Error(translate(locale, 'slash.error.deferred', { command: deferred }))
      getDeps().onCommandStart?.(prompt.trim())
      getDeps().onCommandFinish?.(error.message)
      throw error
    }
    const slashCommand = /^\/\S+/.test(prompt.trim())
    const compactCommand = parseCompactCommand(prompt)
    const t = (key: MessageKey, values?: Record<string, string | number>) => translate(locale, key, values)
    // 上游 rejectsFocus:snapcompact 只做點陣圖歸檔,不帶 focus 指示——與
    // goal-usage-error 同模式原地拒絕,不起 runtime 只為回一句錯誤。
    if (compactCommand?.kind === 'error') {
      reportError(t('compact.error.snapcompactFocus'))
      return
    }
    // 模式命令(/compact soft|remote|snapcompact,大小寫不敏感):上游 RPC
    // compact 只接 customInstructions、不承載模式,原樣交給上游 slash
    // dispatcher(prompt 路徑);無模式形式才走本地 compact RPC。
    const compactRpc = compactCommand?.kind === 'rpc' ? compactCommand : undefined
    const mcpCommand = parseMcpCommand(prompt)
    if (mcpCommand?.type === 'open' && images.length === 0 && prompt.trim() === '/mcp') {
      setView('plugins')
      setToast('Manage MCP integrations in Capabilities.')
      return
    }
    if (mcpCommand?.type === 'authenticate') {
      const target = mcpCommand.server ? ` to sign in to ${mcpCommand.server}` : ' to authenticate network MCP servers'
      setToast(`Network MCP authentication is managed outside OMP Desktop. Use ${HARNESS_AGENT_NAMES[commandHarness]} directly${target}.`)
      return
    }
    if (compactCommand && images.length > 0) {
      reportError('/compact does not accept attachments. Remove the attachment and try again.')
      return
    }
    // skill / 模板展開型命令依上游能力承載圖片;其餘 slash 上游本地
    // 消化會靜默丟棄——Composer 層已阻擋,此處是 queue flush / 直接調用的
    // 防禦:不接受的命令原地拒絕,不靜默丟棄。
    const slashCarriesImages = Boolean(slashCommand && images.length > 0 && slashCommandAcceptsImages(prompt, slashCatalog))
    // 忙碌時的 slash 分類:唯讀查詢本地呈現、agent 控制直送 RPC、其餘排隊。
    // /status 這類上游沒有文字處理器的命令,空閒時也走同一本地路徑。
    const slashDisposition = slashCommand && !compactRpc ? busySlashDisposition(prompt, slashCatalog) : undefined
    // /goal 用法錯誤(/goal set 無目標、/goal budget 等):不送模型、不排隊,
    // 依照 deferred 命令同一模式原地拒絕。
    if (slashDisposition?.kind === 'goal-usage-error') {
      const error = new Error(t(slashDisposition.messageKey as MessageKey))
      getDeps().onCommandStart?.(prompt.trim())
      getDeps().onCommandFinish?.(error.message)
      throw error
    }
    // goal RPC 不承載附件,忙碌直送與空閒直送都會被靜默丟棄,提前拒絕。
    if (slashDisposition?.kind === 'agent-control' && images.length > 0) {
      reportError('/goal commands do not accept attachments. Remove the attachment and try again.')
      return
    }
    // 無 bridge 時沒有可命令的 runtime,不降級成把 /goal 文字送給 demo 助理。
    if (!bridge && slashDisposition?.kind === 'agent-control') {
      reportError(t('goal.error.noSession'))
      return
    }
    // 不承載附件的 slash(builtin/extension;compact 與 goal 另有專屬訊息)
    // 直接送達會被上游靜默丟棄,原地拒絕。
    if (slashCommand && images.length > 0 && !compactCommand && slashDisposition?.kind !== 'agent-control' && !slashCarriesImages) {
      reportError(t('slash.error.images'))
      return
    }
    // /goal drop 會永久結束目標(無法還原),送出前必須明確確認;排隊等候
    // 期間若使用者已切換工作區,generation 不符,不再代送破壞性操作。
    const confirmGoalDrop = (generation: number): boolean => {
      if (slashDisposition?.kind !== 'agent-control' || slashDisposition.command.type !== 'goal' || slashDisposition.command.op !== 'drop') return true
      if (workspace.workspaceRef.current.generation !== generation) return false
      return window.confirm(t('goal.confirmDrop'))
    }
    // `!`/`$` 速寫路由(TUI parity):sent 入口在此分流,排隊回放
    // (queuedFlushPromptId)的文字不再重判——排隊內容是 prompt,不是捷徑。
    if (!queuedFlushPromptId) {
      const bashShorthand = parseBashShorthandInput(prompt)
      if (bashShorthand) {
        // `!!` 要求結果排除出 context;RPC wire 的 bash 只有 command 參數,
        // 語意無法表達,明確拒絕而不是靜默降級成 `!`(會污染模型 context)。
        if (bashShorthand.excludeFromContext) {
          const error = new Error(t('bash.error.excludeUnsupported'))
          getDeps().onCommandStart?.(prompt.trim())
          getDeps().onCommandFinish?.(error.message)
          throw error
        }
        // bash RPC 不承載附件;比照 /goal 的提前拒絕,避免靜默丟棄。
        if (images.length > 0) {
          reportError(t('bash.error.noAttachments'))
          return
        }
        await runBashShorthand(prompt, bashShorthand.command)
        return
      }
      // `$ code`/`$$ code` 是 TUI 的 Python 捷徑;上游 RPC 沒有 python/eval
      // 命令(缺口,不偽造),送出前先攔截告知,避免汙染模型 context 或
      // 誤以為已執行。貼上的 shell transcript(`$ ` 開頭每行)不在此列。
      const pythonShorthand = parsePythonShorthandInput(prompt)
      if (pythonShorthand) {
        const error = new Error(t('bash.error.pythonUnsupported'))
        getDeps().onCommandStart?.(prompt.trim())
        getDeps().onCommandFinish?.(error.message)
        throw error
      }
    }
    const respondLocally = (runtime: Parameters<typeof localSlashResponse>[1]) => {
      const snapshot = workspace.workspaceRef.current
      const text = localSlashResponse(prompt, runtime, (key, values) => translate(locale, key, values), { cwd: snapshot.cwd, sessionFile: snapshot.sessionFile })
      workspace.setMessages((items) => [...items, { id: `slash-local-${Date.now()}-${items.length}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text }] }])
    }
    if (slashDisposition?.kind === 'respond-local' && alwaysLocalSlashCommand(parseSlashInvocation(prompt)?.name.toLowerCase() ?? '', slashCatalog)) {
      respondLocally(workspace.runtime ?? undefined)
      return
    }
    const currentWorkspace = workspace.workspaceRef.current
    // A flushed queue entry carries its own attachments (restored input):
    // callers hand only the text back, so the entry's image parts ride along
    // instead of silently sending an image-carrying command as plain text.
    if (queuedFlushPromptId && images.length === 0) {
      const queued = (workspace.pendingQueuedPrompts ?? []).find((candidate) => candidate.id === queuedFlushPromptId)
      const queuedImages = queued?.parts?.filter((part): part is PromptImage => part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') ?? []
      if (queuedImages.length) images = queuedImages
    }
    let currentRuntime = workspace.runtime
    let currentOwner = workspace.runtimeOwnerRef.current
    // An admission still in flight owns the turn slot even while
    // workspace.runtime is briefly null during runtime startup — the
    // optimistic rows already mark the transcript busy. Queue behind it
    // instead of losing the race with the single-flight gate.
    if (bridge && intent === 'queue' && images.length === 0 && submissionAdmissionRef.current.active) {
      if (!queuedFlushPromptId) workspace.queuePrompt(prompt, intent)
      return
    }
    // A steer aimed at a turn whose admission is still delivering must wait
    // for that admission: workspace.runtime is briefly null during runtime
    // startup, so the streaming-runtime shortcut below cannot route it yet.
    if (bridge && intent === 'steer' && submissionAdmissionRef.current.active) {
      await submissionAdmissionRef.current.waitForIdle()
      if (workspace.workspaceRef.current.generation !== currentWorkspace.generation) return
      currentRuntime = getDeps().workspace.runtime
      currentOwner = workspace.runtimeOwnerRef.current
    }
    const ownsStreamingRuntime = Boolean(
      bridge && currentRuntime && (currentRuntime.isStreaming || submissionAdmissionRef.current.active)
      && workspace.runtimeIdRef.current === currentRuntime.runtimeId
      && currentOwner?.runtimeId === currentRuntime.runtimeId
      && currentOwner.generation === currentWorkspace.generation,
    )
    const completeQueuedFlush = () => {
      if (queuedFlushPromptId) workspace.removeQueuedPrompt(queuedFlushPromptId)
    }
    // GUI 自有入口的 slash(tree/branch/rewind/fork/resume、new/clear、login/logout):絕不送模型。
    if (slashDisposition?.kind === 'gui-action') {
      // tree/branch/rewind 一律開啟 SessionTreeDialog;上游 get_tree/branch
      // RPC 由 dialog 自處理,branch 忙碌時可用,因此不等 idle。
      if (slashDisposition.action === 'session-tree') {
        completeQueuedFlush()
        getDeps().openSessionTree?.()
        return
      }
      // /login /logout 開啟 Capabilities 頁的 provider 帳號面板;上游查詢
      // 與認證 RPC 皆非 session-mutation(busy-safe),忙碌時同樣立即分派。
      if (slashDisposition.action === 'provider-accounts') {
        completeQueuedFlush()
        navigate('plugins')
        return
      }
      // /new 的 durable 邊界建立在全新 runtime 上,不打斷進行中的回合,忙碌時同樣成立。
      if (slashDisposition.action === 'new-session') {
        if (!newSessionProject(undefined, workspace.workspaceRef.current.project, getDeps().activeProject)) {
          reportError('Add a project before starting a session.')
        } else {
          void newSession()
        }
        completeQueuedFlush()
        return
      }
      // /resume 語意是切換到既有工作階段:bare 開啟 sidebar 讓使用者選取,
      // 帶 target 時以 id/title/路徑比對既有 catalog 後走 selectSession
      // + --resume 流程。切換不打斷進行中的 runtime,忙碌時同樣直接分派。
      if (slashDisposition.action === 'resume-session') {
        completeQueuedFlush()
        const target = slashDisposition.target
        // @claude/@codex 是其他 harness 的 session,桌面版不支援。
        if (target?.startsWith('@')) {
          reportError(t('slash.resume.foreignHarness'))
          return
        }
        if (target) {
          const lowerTarget = target.toLowerCase()
          const match = sessions.find((item) => item.id.toLowerCase().startsWith(lowerTarget))
            ?? sessions.find((item) => item.title.toLowerCase() === lowerTarget)
            ?? sessions.find((item) => item.filePath.toLowerCase() === lowerTarget || item.filePath.toLowerCase().endsWith(`/${lowerTarget}`))
          if (!match) { reportError(t('slash.resume.notFound', { query: target })); return }
          void selectSession(match)
          return
        }
        // bare /resume 對應上游 session 選擇器;GUI 的選擇器就是 sidebar。
        navigate('session')
        settingsState.setSidebarOpen(true)
        setToast(t('slash.resume.pick'))
        return
      }
      // /fork:上游對進行中的 session 拒絕 fork(session_busy),維持 idle-only;
      // 忙碌(自家 runtime 串流中或送達 admission 未完)時排隊等 idle 後再分派。
      if (ownsStreamingRuntime || submissionAdmissionRef.current.active) {
        if (!queuedFlushPromptId) workspace.queuePrompt(prompt, 'queue')
        if (intent === 'steer') setToast(translate(locale, 'slash.queued'))
        return
      }
      if (!bridge) { reportError('Fork is available in the desktop app.'); completeQueuedFlush(); return }
      // native full fork:沿用 sidebar Branch 的分支流程,對象為目前 session。
      const forkTarget = workspace.workspaceRef.current.session
        ?? sessions.find((item) => item.filePath === workspace.workspaceRef.current.sessionFile)
      if (!forkTarget) { reportError(t('slash.error.forkNeedsSession')); completeQueuedFlush(); return }
      await branchSession(forkTarget)
      completeQueuedFlush()
      return
    }
    if (ownsStreamingRuntime && currentRuntime && bridge) {
      if (compactRpc || slashCommand) {
        if (slashDisposition?.kind === 'respond-local') {
          // 唯讀查詢:忙碌的 runtime 會持續以事件更新快照,直接以快照回應。
          // 無 streamingBehavior 的 prompt 忙碌時會被上游拒絕,因此絕不轉送。
          respondLocally(currentRuntime)
          completeQueuedFlush()
          return
        }
        if (slashDisposition?.kind === 'agent-control') {
          // agent 控制(/pause、/goal 各 op)走專用 busy-safe RPC,不等 idle。
          if (!confirmGoalDrop(currentWorkspace.generation)) { completeQueuedFlush(); return }
          try {
            const response = await bridge.agent.command(currentRuntime.runtimeId, slashDisposition.command)
            workspace.setMessages((items) => [...items, { id: `slash-control-${Date.now()}-${items.length}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: agentControlOutcomeText(slashDisposition.command, response, t) }] }])
            completeQueuedFlush()
          } catch (error) {
            if (queuedFlushPromptId) workspace.markQueuedPromptFlushFailed(queuedFlushPromptId)
            reportError(error)
            throw error
          }
          return
        }
        // Compacting mid-turn would abort the running turn, so it waits for the
        // idle flush like any queued prompt. 其餘 slash 上游 busy 語意未查證,
        // 一律保守排隊。承載圖片的 skill / 模板命令把圖片隨條目保存,
        // flush 時原樣恢復,不靜默成純文字。
        if (!queuedFlushPromptId) {
          if (slashCarriesImages) workspace.queuePrompt(prompt, 'queue', [{ type: 'text', text: prompt }, ...images])
          else workspace.queuePrompt(prompt, 'queue')
        }
        if (intent === 'steer') setToast(translate(locale, compactRpc ? 'slash.compactQueued' : 'slash.queued'))
        return
      }
      if (intent === 'queue') {
        // Busy follow-up: omp owns the queue, and text and images share one
        // semantic — both ride the follow_up command instead of a second
        // renderer-side queue that could drift from the engine's own.
        const sentAt = Date.now()
        if (currentWorkspace.sessionFile) {
          setSessions((items) => items.map((session) => session.filePath === currentWorkspace.sessionFile ? { ...session, lastUserMessageAt: new Date(sentAt).toISOString() } : session))
        }
        try {
          const response = await bridge.agent.command(currentRuntime.runtimeId, { type: 'follow_up', message: prompt, ...(images.length ? { images } : {}) })
          const actions = parseSessionActionSnapshot(response.sessionActions)
          if (actions) {
            workspace.setRuntime((current) => current?.runtimeId === currentRuntime.runtimeId
              ? { ...current, sessionActions: actions }
              : current)
          }
          completeQueuedFlush()
          return
        } catch (error) {
          if (queuedFlushPromptId) {
            // A failed flush keeps the local entry for an explicit retry;
            // the boundary event clears the failure mark.
            workspace.markQueuedPromptFlushFailed(queuedFlushPromptId)
          } else if (workspace.workspaceRef.current.generation === currentWorkspace.generation) {
            // Keep a durable failure row: a toast alone is easy to miss, and
            // a silently vanishing follow-up reads as "sent but ignored".
            // No auto replay: the composer draft is the user's retry path.
            workspace.setMessages((items) => [
              ...items,
              { id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: `Follow-up was not delivered: ${requestFailureMessage(error)} Your draft was restored.` }] },
            ])
          }
          reportError(error)
          throw error
        }
      }
      if (intent === 'steer') {
        const sentAt = Date.now()
        // A queue-flushed steer keeps its original prompt id: the optimistic
        // row rendered at submit time is the row this steer reconciles into.
        const pendingSteerId = queuedFlushPromptId ?? workspace.queuePrompt(prompt, intent, [{ type: 'text', text: prompt }, ...images], sentAt)
        if (currentWorkspace.sessionFile) {
          const sentAtIso = new Date(sentAt).toISOString()
          setSessions((items) => items.map((session) => session.filePath === currentWorkspace.sessionFile ? { ...session, lastUserMessageAt: sentAtIso } : session))
        }
        try {
          const response = await bridge.agent.command(currentRuntime.runtimeId, { type: 'steer', message: prompt, ...(images.length ? { images } : {}) })
          workspace.acceptSteer(pendingSteerId)
          const actions = parseSessionActionSnapshot(response.sessionActions)
          if (actions) workspace.acknowledgeSteer(pendingSteerId, actions)
          return
        } catch (error) {
          workspace.removeQueuedPrompt(pendingSteerId)
          workspace.retractQueuedPrompt(pendingSteerId)
          if (workspace.workspaceRef.current.generation === currentWorkspace.generation) {
            // Keep a durable failure row: a toast alone is easy to miss, and a
            // silently vanishing steer reads as "sent but ignored".
            workspace.setMessages((items) => [
              ...items,
              { id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: `Steer was not delivered: ${requestFailureMessage(error)} Your draft was restored.` }] },
            ])
          }
          reportError(error)
          throw error
        }
      }
    }
    const admittedSubmission = await submissionAdmissionRef.current.run(async () => {
      setSubmitting(true)
      // The queued prompt's optimistic row hands off to the real turn: the
      // harness events render the durable row as the prompt is delivered.
      if (queuedFlushPromptId) workspace.retractQueuedPrompt(queuedFlushPromptId)
      const admitted = workspace.workspaceRef.current
      const generation = admitted.generation
      let startedPrompt = false
      let queuedPromptId: string | undefined
      const sentAt = Date.now()
      const sentAtIso = new Date(sentAt).toISOString()
      const userMessage: TranscriptMessage = { id: `user-${sentAt}`, role: 'user', timestamp: sentAt, parts: [{ type: 'text', text: prompt }, ...images] }
      let userMessageAppended = false
      const pendingAssistantId = `assistant-${sentAt}`
      let pendingAssistantAppended = false
      try {
        if (!admitted.project || !admitted.cwd) { reportError('Add a project before starting a session.'); return }
        // The harness comes from the workspace's own project, never global
        // settings: a prompt landing between a harness switch and the
        // bootstrap effect's workspace reset would otherwise start the new
        // harness against the old workspace's cwd and session.
        const activeHarness = admitted.project.harness
        if (images.length > 0 && !provider.selectedModel?.input.includes('image') && !provider.catalog?.visionDelegation) {
          reportError('This model does not accept images. Remove the attachment or choose a vision model.')
          return
        }
        if (!workspace.prepareForPrompt(generation)) return
        const appendUserMessage = () => {
          if (userMessageAppended) return
          // The workspace may have switched while a command was in flight;
          // an optimistic append would land in the wrong transcript.
          if (workspace.workspaceRef.current.generation !== generation) return
          userMessageAppended = true
          workspace.setMessages((items) => [...items, userMessage])
          if (admitted.sessionFile) setSessions((items) => items.map((session) => session.filePath === admitted.sessionFile ? { ...session, lastUserMessageAt: sentAtIso } : session))
        }
        const appendPendingAssistant = () => {
          if (pendingAssistantAppended || workspace.workspaceRef.current.generation !== generation) return
          pendingAssistantAppended = true
          workspace.setMessages((items) => [...items, { id: pendingAssistantId, role: 'assistant', timestamp: sentAt, startedAt: sentAt, streaming: true, parts: [] }])
        }
        const retractPendingTurn = () => {
          // The queue/steer branches represent this prompt with their own rows;
          // drop the optimistic ones. An assistant row that already carries
          // parts holds streamed content from the running turn and survives.
          workspace.setMessages((items) => items.filter((item) => item.id !== userMessage.id && (item.id !== pendingAssistantId || item.parts.length > 0)))
        }
        if (!bridge) {
          appendUserMessage()
          const assistantId = `assistant-${Date.now()}`
          workspace.setMessages((items) => [...items, { id: assistantId, role: 'assistant', timestamp: Date.now(), startedAt: Date.now(), streaming: true, parts: [{ type: 'thinking', text: 'Reviewing the request and current workspace context.' }] }])
          demoTimerRef.current.push(window.setTimeout(() => workspace.setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, parts: [...item.parts, { type: 'toolCall', id: 'demo-tool', name: 'Inspect project', args: { cwd: admitted.cwd } }] } : item)), 450))
          demoTimerRef.current.push(window.setTimeout(() => workspace.setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, streaming: false, completedAt: Date.now(), parts: [...item.parts, { type: 'toolResult', name: 'Inspect project', text: 'Project context loaded' }, { type: 'text', text: 'I’ve reviewed the project context and prepared the workspace. Connect the desktop bridge to run this request with OMP.' }] } : item)), 1_250))
          return
        }
        // A fresh conversation has no history or delivery queue to reconcile.
        // Show the admitted turn before permission checks and runtime startup;
        // the same placeholder receives real events after the harness starts.
        // An existing session earns the same optimistic rows when every
        // renderer signal says this prompt opens a new turn — otherwise the
        // transcript stays blank through runtime startup and session indexing.
        // When agent.list() disagrees (the session was busy after all), the
        // queue and follow-up branches retract the rows.
        const sessionCatalogRow = admitted.sessionFile ? sessions.find((session) => session.filePath === admitted.sessionFile) : undefined
        const opensNewTurn = !slashCommand && !compactRpc && !queuedFlushPromptId
          && !getDeps().workspace.runtime?.isStreaming
          && (!admitted.sessionFile || sessionCatalogRow?.status !== 'running')
        if (opensNewTurn) {
          appendUserMessage()
          appendPendingAssistant()
        }
        await grantProject(admitted.project)
        if (workspace.workspaceRef.current.generation !== generation) return
        const selected = workspace.workspaceRef.current
        if (!selected.cwd) throw new Error('The selected workspace has no working directory.')
        const liveRuntimes = (await bridge.agent.list()).filter((candidate) => candidate.harness === activeHarness)
        if (workspace.workspaceRef.current.generation !== generation) return
        const owner = workspace.runtimeOwnerRef.current
        const tracked = workspace.runtimeIdRef.current ? liveRuntimes.find((item) => item.runtimeId === workspace.runtimeIdRef.current) : undefined
        const belongsHere = Boolean(tracked && owner?.runtimeId === tracked.runtimeId && owner.generation === generation && tracked.cwd === selected.cwd && (!selected.sessionFile || tracked.sessionFile === selected.sessionFile))
        let activeRuntime = belongsHere ? tracked : findRuntimeForWorkspace(liveRuntimes, selected.cwd, selected.sessionFile)
        const selectedSession = selected.sessionFile ? sessions.find((session) => session.filePath === selected.sessionFile) : undefined
        if (compactCommand && !activeRuntime) {
          if (!selected.sessionFile) { setToast('Nothing to compact yet.'); return }
          if (selectedSession?.status === 'running') {
            setToast('Compaction is unavailable while this session is running outside OMP Desktop.')
            return
          }
        }
        const streamingRuntime = activeRuntime?.isStreaming ? activeRuntime : undefined
        if (intent === 'queue' && !compactRpc && !slashCommand && streamingRuntime) {
          // agent.list() disagreed with the optimistic append: omp owns the
          // busy queue, so the follow-up is delivered to the streaming
          // runtime — text and images share one semantic. The const snapshot
          // keeps the narrowing inside the setRuntime closure below.
          retractPendingTurn()
          workspace.attachRuntime(streamingRuntime, generation)
          if (admitted.sessionFile) setSessions((items) => items.map((session) => session.filePath === admitted.sessionFile ? { ...session, lastUserMessageAt: sentAtIso } : session))
          const response = await bridge.agent.command(streamingRuntime.runtimeId, { type: 'follow_up', message: prompt, ...(images.length ? { images } : {}) })
          const actions = parseSessionActionSnapshot(response.sessionActions)
          if (actions) {
            workspace.setRuntime((current) => current?.runtimeId === streamingRuntime.runtimeId
              ? { ...current, sessionActions: actions }
              : current)
          }
          completeQueuedFlush()
          return
        }
        if ((intent === 'queue' || compactRpc) && (images.length === 0 || slashCarriesImages) && (activeRuntime?.isStreaming || selectedSession?.status === 'running')) {
          // agent.list() 發現 renderer 以為空閒的 runtime 其實在跑:唯讀查詢與
          // agent 控制比照 ownsStreamingRuntime 分支即時處理;session 在 OMP
          // Desktop 外執行時沒有可命令的 runtime,輸入維持本地排隊。
          if (activeRuntime?.isStreaming && slashDisposition?.kind === 'respond-local') {
            retractPendingTurn()
            respondLocally(activeRuntime)
            completeQueuedFlush()
            return
          }
          if (activeRuntime?.isStreaming && slashDisposition?.kind === 'agent-control') {
            retractPendingTurn()
            if (!confirmGoalDrop(generation)) { completeQueuedFlush(); return }
            const response = await bridge.agent.command(activeRuntime.runtimeId, slashDisposition.command)
            workspace.setMessages((items) => [...items, { id: `slash-control-${Date.now()}-${items.length}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: agentControlOutcomeText(slashDisposition.command, response, t) }] }])
            completeQueuedFlush()
            return
          }
          // Deferred local-only work: compacts and slash commands wait for
          // the idle flush, and a session running outside OMP Desktop has no
          // runtime to command — its input stays local until then.
          retractPendingTurn()
          queuedPromptId = slashCarriesImages
            ? workspace.queuePrompt(prompt, compactRpc ? 'queue' : intent, [{ type: 'text', text: prompt }, ...images])
            : workspace.queuePrompt(prompt, compactRpc ? 'queue' : intent)
          if (compactRpc && intent === 'steer') setToast('Compaction will run when the current turn finishes.')
          return
        }
        if (slashDisposition?.kind === 'agent-control') {
          // 上游 /goal、/pause 沒有 text-mode handler,空閒時同樣必須走 goal RPC,
          // 不能當成一般 prompt 送給模型;沒有可命令的 runtime 代表工作階段
          // 尚未啟動(或在本桌面外的 OMP 執行),無法操作目標。
          if (!activeRuntime) { reportError(t('goal.error.noSession')); return }
          if (!confirmGoalDrop(generation)) { completeQueuedFlush(); return }
          try {
            const response = await bridge.agent.command(activeRuntime.runtimeId, slashDisposition.command)
            workspace.setMessages((items) => [...items, { id: `slash-control-${Date.now()}-${items.length}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: agentControlOutcomeText(slashDisposition.command, response, t) }] }])
            completeQueuedFlush()
          } catch (error) {
            if (queuedFlushPromptId) workspace.markQueuedPromptFlushFailed(queuedFlushPromptId)
            reportError(error)
            throw error
          }
          return
        }
        let startedRuntime = false
        let startedSessionNeedsTitle = false
        if (slashCommand && !compactRpc) getDeps().onCommandStart?.(prompt.trim())
        if (!activeRuntime) {
          workspace.attachRuntime(undefined, generation)
          if (images.length > 0 && selected.sessionFile && selectedSession?.status === 'running') {
            throw new Error('Image attachments cannot be queued while this session is active outside OMP Desktop. Wait for it to finish, then try again.')
          }
          // Same grant as New session: an inferred project must be promoted
          // before the engine's cwd authorization gate rejects the launch.
          if (selected.project?.inferred) { try { await grantProject(selected.project) } catch { /* the start below reports the authorization failure */ } }
          const latestProvider = getDeps().provider
          const selection = latestProvider.resolveSelection ? await latestProvider.resolveSelection() : latestProvider
          if (workspace.workspaceRef.current.generation !== generation) return
          if (!selection.model) throw new Error(`No model is available for ${HARNESS_AGENT_NAMES[activeHarness]}. Enable or connect a provider, then try again.`)
          activeRuntime = await bridge.agent.start({ cwd: selected.cwd, sessionPath: selected.sessionFile, model: selection.model, thinking: selection.effort, fast: selection.fast, harness: activeHarness })
          startedRuntime = true
          // The prompt is hereby submitted work: launching survives workspace
          // switches. Earlier builds stopped the just-started runtime when the
          // user navigated mid-launch, silently deleting the "starting" draft —
          // the launch now continues in the background and only the adoption
          // and view mutations below stay generation-guarded.
          const indexedSession = await indexStartedSession({
            bridge,
            harness: activeHarness,
            sessionFile: activeRuntime.sessionFile,
            setSessions,
          })
          // A prompt that started from the draft placeholder adopts the
          // session it just created, replacing the placeholder with the real
          // row without touching the in-flight turn. Adopt only when the
          // workspace is still this one; after a switch the merged catalog row
          // stands on its own.
          if (workspace.workspaceRef.current.generation === generation && !admitted.sessionFile && indexedSession) workspace.adoptSessionId(indexedSession)
          startedSessionNeedsTitle = !indexedSession || indexedSession.title === 'Untitled session'
        }
        if (activeRuntime.cwd !== selected.cwd || (selected.sessionFile && activeRuntime.sessionFile !== selected.sessionFile)) {
          if (startedRuntime) await bridge.agent.stop(activeRuntime.runtimeId).catch(() => false)
          throw new Error(`${HARNESS_AGENT_NAMES[activeHarness]} returned a runtime for a different workspace or session.`)
        }
        workspace.attachRuntime(activeRuntime, generation)
        if (compactRpc) {
          await bridge.agent.command(activeRuntime.runtimeId, {
            type: 'compact',
            ...(compactRpc.customInstructions ? { customInstructions: compactRpc.customInstructions } : {}),
          })
          completeQueuedFlush()
        } else if (activeRuntime.isStreaming) {
          // Follow-ups are daemon-owned. Steers get a renderer-only pending
          // row so pickup can move them into history without redelivery.
          // The running turn owns the transcript: hand our optimistic rows back.
          retractPendingTurn()
          if (intent === 'steer') queuedPromptId = workspace.queuePrompt(prompt, intent, userMessage.parts, sentAt)
          const response = await bridge.agent.command(activeRuntime.runtimeId, { type: intent === 'steer' ? 'steer' : 'follow_up', message: prompt, ...(images.length ? { images } : {}) })
          const actions = parseSessionActionSnapshot(response.sessionActions)
          if (actions) {
            workspace.setRuntime((current) => current?.runtimeId === activeRuntime.runtimeId
              ? { ...current, sessionActions: actions }
              : current)
          }
          if (intent === 'steer' && queuedPromptId) {
            workspace.acceptSteer(queuedPromptId)
            if (actions) workspace.acknowledgeSteer(queuedPromptId, actions)
          }
          completeQueuedFlush()
        } else {
          startedPrompt = true
          appendUserMessage()
          // Pure slash commands resolve without the model; agentic ones mark
          // streaming themselves via agent_start — optimistically flashing a
          // working state here would linger until the next real turn.
          if (!slashCommand || compactRpc) {
            // setRuntime replaces the pill state, so unlike the guarded
            // message appends it must not fire for a navigated-away workspace.
            if (workspace.workspaceRef.current.generation === generation) workspace.setRuntime({ ...activeRuntime, isStreaming: true })
            appendPendingAssistant()
          }
          // A fresh turn deserves a fresh graceful Stop: forget any abort
          // attempt recorded for the previous turn on this runtime.
          gracefulAbortAttempts.delete(activeRuntime.runtimeId)
          const response = await bridge.agent.command(activeRuntime.runtimeId, {
            type: 'prompt',
            message: prompt,
            streamingBehavior: streamingBehaviorForIntent(intent),
            ...(images.length ? { images } : {}),
          })
          const data = response.data as { agentInvoked?: boolean } | undefined
          if (data?.agentInvoked === false && workspace.workspaceRef.current.generation === generation) {
            workspace.setRuntime((current) => current?.runtimeId === activeRuntime.runtimeId ? { ...current, isStreaming: false } : current)
            workspace.setMessages((items) => items.filter((item) => (item.id !== userMessage.id || !slashCommand) && (item.id !== pendingAssistantId || item.parts.length > 0)).map((item) => item.id === pendingAssistantId ? { ...item, streaming: false } : item))
          }
          if (slashCommand && !compactRpc && workspace.workspaceRef.current.generation === generation) getDeps().onCommandFinish?.(undefined, data?.agentInvoked !== false)
          completeQueuedFlush()
          if (startedRuntime && startedSessionNeedsTitle && data?.agentInvoked !== false) {
            // Title bookkeeping touches only the global sessions list, so it
            // runs even when the user navigated away mid-launch — the renamed
            // row belongs in the sidebar regardless of the active workspace.
            void titleStartedSession({
              bridge,
              harness: activeHarness,
              runtimeId: activeRuntime.runtimeId,
              sessionFile: activeRuntime.sessionFile,
              prompt,
              setSessions,
            })
          }
        }
      } catch (error) {
        if (queuedFlushPromptId) {
          workspace.markQueuedPromptFlushFailed(queuedFlushPromptId)
          if (userMessageAppended) {
            workspace.setMessages((items) => items.filter((item) => item.id !== userMessage.id))
          }
        }
        if (queuedPromptId) workspace.removeQueuedPrompt(queuedPromptId)
        if (workspace.workspaceRef.current.generation !== generation) return
        const failure = requestFailureMessage(error)
        if (startedPrompt) workspace.setRuntime((current) => current ? { ...current, isStreaming: false } : current)
        if (slashCommand && !compactRpc) {
          getDeps().onCommandFinish?.(failure)
          workspace.setMessages((items) => items.filter((item) => item.id !== pendingAssistantId || item.parts.length > 0).map((item) => item.id === pendingAssistantId ? { ...item, streaming: false } : item))
          throw error
        }
        workspace.setMessages((items) => {
          if (pendingAssistantAppended) items = items.filter((item) => item.id !== pendingAssistantId || item.parts.length > 0)
          const finalized = startedPrompt
            ? items.flatMap((item) => item.streaming && item.role === 'assistant' && item.parts.length === 0 ? [] : [{ ...item, streaming: false }])
            : items
          return finalized.at(-1)?.role === 'system' ? finalized : [...finalized, { id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: failure }] }]
        })
        throw error
      } finally { setSubmitting(false) }
    })
    if (!admittedSubmission) {
      const error = new Error('Another message is still being admitted. Try steering again.')
      reportError(error)
      throw error
    }
  }
  const stopRuntime = async () => {
    const { bridge, workspace, reportError } = getDeps()
    const stoppedRuntime = workspace.runtime
    if (!stoppedRuntime) return
    workspace.pauseQueuedPrompts?.()
    if (!bridge) { workspace.setMessages((items) => items.map((item) => item.streaming ? { ...item, streaming: false } : item)); workspace.setRuntime(null); return }
    const stoppedRuntimeId = stoppedRuntime.runtimeId
    const stoppedGeneration = workspace.workspaceRef.current.generation
    const stoppedOwner = workspace.runtimeOwnerRef.current
    const stoppedOwnerRuntimeId = stoppedOwner?.runtimeId
    const stoppedOwnerGeneration = stoppedOwner?.generation
    const ownershipMoved = () => {
      const currentOwner = workspace.runtimeOwnerRef.current
      return workspace.workspaceRef.current.generation !== stoppedGeneration
        || workspace.runtimeIdRef.current !== stoppedRuntimeId
        || stoppedOwnerRuntimeId !== stoppedRuntimeId
        || stoppedOwnerGeneration !== stoppedGeneration
        || currentOwner?.runtimeId !== stoppedOwnerRuntimeId
        || currentOwner?.generation !== stoppedOwnerGeneration
    }
    // The settle below only ever runs on an authoritative answer: either the
    // abort reply (omp awaits session.abort() before responding) or a
    // get_state probe that confirms the run ended. An optimistic flip on a
    // lost reply would hide a still-running turn.
    const settleStoppedTurn = () => {
      workspace.setRuntime((current) => current?.runtimeId === stoppedRuntimeId ? { ...current, isStreaming: false } : current)
      workspace.setMessages((items) => {
        const lastAssistant = [...items].reverse().find((item) => item.role === 'assistant')
        return items.map((item) => item.id === lastAssistant?.id ? { ...item, streaming: false, completedAt: Date.now(), outcome: 'cancelled' } : item.streaming ? { ...item, streaming: false } : item)
      })
    }
    const stillWorking = stoppedRuntime.isStreaming || stoppedRuntime.isCompacting
    const previousAbortAttempt = gracefulAbortAttempts.get(stoppedRuntimeId)
    if (stillWorking && previousAbortAttempt !== undefined && performance.now() - previousAbortAttempt < 45_000) {
      // The graceful abort did not stop this turn — a long tool call can
      // outlive the abort round-trip, or the reply was lost with events
      // still flowing. A second press means Stop: kill the runtime (the
      // session itself is file-backed and resumable).
      gracefulAbortAttempts.delete(stoppedRuntimeId)
      try { await bridge.agent.stop(stoppedRuntimeId) } catch { /* already gone */ }
      if (ownershipMoved()) return
      settleStoppedTurn()
      return
    }
    if (stillWorking) gracefulAbortAttempts.set(stoppedRuntimeId, performance.now())
    try {
      // omp withdraws every queued steering/follow-up before aborting and the
      // reply lists the withdrawn input, so Stop restores what actually came
      // back instead of guessing what survived (TUI Esc semantics).
      const response = await bridge.agent.command(stoppedRuntimeId, { type: 'abort_and_restore_queue' })
      if (ownershipMoved()) return
      const withdrawn = parseWithdrawnQueue(response.data)
      if (withdrawn) {
        workspace.restoreWithdrawnQueue(withdrawn, {
          harness: stoppedRuntime.harness,
          sessionFile: stoppedRuntime.sessionFile,
          runtimeId: stoppedRuntimeId,
        })
        if (withdrawn.skipped > 0 || withdrawn.imagesDropped || withdrawn.truncated) {
          // A lossy restore must be visible, not silent: entries or
          // attachments beyond the transport limit are gone for good.
          workspace.setMessages((items) => [
            ...items,
            { id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: 'Stopped, but some queued input exceeded the transport limit and could not be restored.' }] },
          ])
        }
      }
      settleStoppedTurn()
    } catch (error) {
      // Uncertain acceptance: the withdrawal and abort may or may not have
      // run. Never re-send and never restore blindly — ask omp for its
      // actual state and let the events stay the authority.
      try {
        const state = await bridge.agent.command(stoppedRuntimeId, { type: 'get_state' })
        if (!ownershipMoved()) {
          const data = state.data
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            const raw = data as Record<string, unknown>
            const held = raw.queuedMessages && typeof raw.queuedMessages === 'object' && !Array.isArray(raw.queuedMessages) ? raw.queuedMessages as Record<string, unknown> : {}
            const steering = Array.isArray(held.steering) ? held.steering.filter((preview): preview is string => typeof preview === 'string') : []
            const followUps = Array.isArray(held.followUp) ? held.followUp.filter((preview): preview is string => typeof preview === 'string') : []
            const queuedCount = Number.isSafeInteger(raw.queuedMessageCount) && Number(raw.queuedMessageCount) >= 0
              ? Number(raw.queuedMessageCount)
              : steering.length + followUps.length
            const snapshot = { queuedCount, steering, followUps }
            workspace.reconcileQueuedPrompts?.(snapshot)
            workspace.setRuntime((current) => current?.runtimeId === stoppedRuntimeId ? { ...current, sessionActions: snapshot } : current)
            if (raw.isStreaming === false) settleStoppedTurn()
          }
        }
      } catch { /* state unreachable: leave every signal to the event stream */ }
      reportError(error)
    }
  }

  const installSkill = async (source: string) => {
    const { bridge, reportError, settingsState } = getDeps()
    if (!bridge) return { ok: false as const, reason: 'blocked' as const, output: 'Package installation is available in the desktop app.' }
    try { return await bridge.plugins.install(source, settingsState.settings.activeHarness) } catch (error) { reportError(error); return { ok: false, output: errorMessage(error) } }
  }
  const installExtension = async (input: ExtensionInstallInput) => {
    const { activeProject, bridge, pluginSkills, reportError, settingsState } = getDeps()
    if (!bridge) return { ok: false as const, reason: 'blocked' as const, output: 'Extension installation is available in the desktop app.' }
    try {
      let installation = input
      if (input.scope === 'project') {
        if (!activeProject) return { ok: false as const, reason: 'blocked' as const, output: 'Open a project before adding a project extension.' }
        const project = await grantProject(activeProject)
        installation = { ...input, projectPath: project.primaryFolder }
      }
      const response = await bridge.plugins.installExtension(installation, settingsState.settings.activeHarness)
      if (response.ok) await pluginSkills.refresh()
      return response
    } catch (error) { reportError(error); return { ok: false, output: errorMessage(error) } }
  }
  const connectMcp = async (input: McpConnectionInput) => {
    const { bridge, activeProject, pluginSkills, reportError, settingsState } = getDeps()
    if (!bridge) return { ok: false as const, reason: 'blocked' as const, output: 'MCP connections are available in the desktop app.' }
    try {
      let connection = input
      if (input.scope === 'project') {
        if (!activeProject) return { ok: false as const, reason: 'blocked' as const, output: 'Open a project before adding a project MCP server.' }
        const project = await grantProject(activeProject); connection = { ...input, projectPath: project.primaryFolder }
      }
      const response = await bridge.plugins.connectMcp(connection, settingsState.settings.activeHarness)
      if (response.ok) await pluginSkills.refresh()
      return response
    } catch (error) { reportError(error); return { ok: false, output: errorMessage(error) } }
  }
  const setMcpEnabled = async (input: McpStateInput) => {
    const { bridge, activeProject, pluginSkills, reportError, settingsState } = getDeps()
    if (!bridge) return { ok: false as const, reason: 'blocked' as const, output: 'MCP connections are available in the desktop app.' }
    try {
      let update = input
      if (input.scope === 'project') {
        if (!activeProject) return { ok: false as const, reason: 'blocked' as const, output: 'Open a project before changing a project MCP server.' }
        const project = await grantProject(activeProject); update = { ...input, projectPath: project.primaryFolder }
      }
      const response = await bridge.plugins.setMcpEnabled(update, settingsState.settings.activeHarness)
      if (response.ok) await pluginSkills.refresh()
      return response
    } catch (error) { reportError(error); return { ok: false, output: errorMessage(error) } }
  }
  const mutateCapability = async (input: CapabilityMutationInput) => {
    const { bridge, activeProject, pluginSkills, reportError, settingsState } = getDeps()
    if (!bridge) return { ok: false as const, reason: 'blocked' as const, output: 'Capabilities can only be changed in the desktop app.' }
    try {
      let update = input
      if (input.scope === 'project') {
        if (!activeProject) return { ok: false as const, reason: 'blocked' as const, output: 'Open a project before changing a project capability.' }
        const project = await grantProject(activeProject); update = { ...input, projectPath: project.primaryFolder }
      }
      const response = await bridge.plugins.mutateCapability(update, settingsState.settings.activeHarness)
      if (response.ok) await pluginSkills.refresh()
      return response
    } catch (error) { reportError(error); return { ok: false, output: errorMessage(error) } }
  }
  const createSchedule = async (input: ScheduleInput) => {
    const { bridge, refreshSchedules, reportError, settingsState } = getDeps()
    if (!bridge) throw new Error('Scheduled tasks are available in the desktop app.')
    try { await bridge.schedules.create(input, settingsState.settings.activeHarness); await refreshSchedules() } catch (error) { reportError(error); throw error }
  }
  const updateSchedule = async (id: string, patch: SchedulePatch) => {
    const { bridge, refreshSchedules, reportError } = getDeps()
    if (!bridge) throw new Error('Scheduled tasks are available in the desktop app.')
    try { await bridge.schedules.update(id, patch); await refreshSchedules() } catch (error) { reportError(error); throw error }
  }
  const mutateSchedule = async (operation: () => Promise<unknown>) => {
    const { bridge, refreshSchedules, reportError } = getDeps()
    if (!bridge) throw new Error('Scheduled tasks are available in the desktop app.')
    try { await operation(); await refreshSchedules() } catch (error) { reportError(error); throw error }
  }
  const openScheduledSession = (sessionFile: string) => {
    const { bridge, sessions, settingsState, setSessions, reportError } = getDeps()
    const known = sessions.find((session) => session.filePath === sessionFile)
    if (known) { void selectSession(known); return }
    if (!bridge) return
    void bridge.sessions.list(undefined, true, settingsState.settings.activeHarness).then((catalog) => {
      setSessions(catalog)
      const found = catalog.find((session) => session.filePath === sessionFile)
      if (found) void selectSession(found)
    }).catch(reportError)
  }
  const openBrowser = () => {
    const { layout, settingsState, setView } = getDeps()
    if (layout.compactLayout && settingsState.sidebarOpen) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
    setView('session')
    settingsState.selectInspectorTab('browser')
    if (!settingsState.inspectorOpen) persistPanel({ inspectorOpen: true })
  }
  const openChanges = () => {
    const { layout, settingsState } = getDeps()
    if (layout.compactLayout && settingsState.sidebarOpen) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
    settingsState.selectInspectorTab('changes')
    if (!settingsState.inspectorOpen) persistPanel({ inspectorOpen: true })
  }

  // /mcp reload、/reload-plugins 上游無專用 RPC:以文字 prompt 轉送上游
  // dispatcher。既有 sendPrompt 管線處理 idle admission(/mcp reload 歸類
  // queue-until-idle,busy 時排隊等 idle);認證指令(/mcp reauth)仍由
  // parseMcpCommand 攔截,不經 GUI。
  const reloadCapabilities = (kind: 'mcp' | 'plugins'): void => {
    void sendPrompt(capabilityReloadPrompt(kind))
  }

  return {
    grantProject, persistPanel, toggleSidebar, toggleInspector, toggleTerminal,
    selectProject, selectSession, newSession, openDraftSession, discardDraftSession, navigate, renameSession, setSessionArchived, deleteSession, branchSession, togglePinSession,
    addProject, relocateProject, removeProject, togglePinProject, setProjectSortMode, sendPrompt, stopRuntime, installSkill, installExtension, connectMcp, setMcpEnabled, mutateCapability,
    createSchedule, updateSchedule, mutateSchedule, openScheduledSession,
    openBrowser, openChanges, reloadCapabilities,
  }
}

export type WorkspaceActions = ReturnType<typeof createWorkspaceActions>

/** Memoized workspace mutation handlers: one stable object for the app's lifetime. */
export function useWorkspaceActions(deps: WorkspaceActionsDeps): WorkspaceActions {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const [actions] = useState(() => createWorkspaceActions(() => depsRef.current))
  return actions
}
