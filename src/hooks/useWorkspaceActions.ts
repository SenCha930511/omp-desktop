import { useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { requestFailureMessage, type WorkspaceSnapshot } from '@/app/workspace'
import { clearComposerDraft } from '@/lib/composer-draft'
import { errorMessage } from '@/lib/errors'
import { HARNESS_AGENT_NAMES } from '@/lib/harness'
import { parseMcpAuthenticationCommand } from '@/lib/mcp-policy'
import { parseSessionActionSnapshot, streamingBehaviorForIntent } from '@/lib/session-actions'
import { deferredSlashCommand } from '@/lib/slash-commands'
import { resolveLocale, translate } from '@/lib/i18n'
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
  onCommandStart?(command: string): void
  onCommandFinish?(failure?: string, agentInvoked?: boolean): void
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

export function parseCompactCommand(prompt: string): { customInstructions?: string } | undefined {
  const trimmed = prompt.trim()
  if (trimmed === '/compact') return {}
  if (trimmed.startsWith('/compact ')) {
    const customInstructions = trimmed.slice(9).trim()
    return customInstructions ? { customInstructions } : {}
  }
  return undefined
}

export function parseMcpCommand(prompt: string): McpCommand | undefined {
  const value = prompt.trim()
  const authentication = parseMcpAuthenticationCommand(value)
  return authentication
    ? authentication.server ? { type: 'authenticate', server: authentication.server } : { type: 'authenticate' }
    : undefined
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
  const newSession = (requestedProject?: ProjectRecord) => {
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
        newSession()
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
      if (workspace.workspaceRef.current.session?.filePath === session.filePath) { resetBrowserView(); newSession() }
      setToast(translate(locale, 'sessions.deleted'))
    } catch (error) { reportError(error) }
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

  const sendPrompt = async (
    prompt: string,
    images: PromptImage[] = [],
    intent: PromptDeliveryIntent = 'queue',
    queuedFlushPromptId?: string,
  ) => {
    const { bridge, sessions, workspace, provider, settingsState, submissionAdmissionRef, demoTimerRef, setSessions, setSubmitting, setView, setToast, reportError } = getDeps()
    const commandHarness = workspace.workspaceRef?.current?.project?.harness ?? settingsState.settings.activeHarness
    const deferred = deferredSlashCommand(prompt)
    const locale = resolveLocale(settingsState.settings.locale ?? 'system')
    if (deferred) {
      const error = new Error(translate(locale, 'slash.error.deferred', { command: deferred }))
      getDeps().onCommandStart?.(prompt.trim())
      getDeps().onCommandFinish?.(error.message)
      throw error
    }
    const slashCommand = /^\/\S+/.test(prompt.trim())
    const compactCommand = /^\/compact\s+(?:soft|remote|snapcompact)(?:\s|$)/.test(prompt.trim()) ? undefined : parseCompactCommand(prompt)
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
    const currentWorkspace = workspace.workspaceRef.current
    const currentRuntime = workspace.runtime
    const currentOwner = workspace.runtimeOwnerRef.current
    const ownsStreamingRuntime = Boolean(
      bridge && currentRuntime && (currentRuntime.isStreaming || submissionAdmissionRef.current.active)
      && workspace.runtimeIdRef.current === currentRuntime.runtimeId
      && currentOwner?.runtimeId === currentRuntime.runtimeId
      && currentOwner.generation === currentWorkspace.generation,
    )
    const completeQueuedFlush = () => {
      if (queuedFlushPromptId) workspace.removeQueuedPrompt(queuedFlushPromptId)
    }
    if (ownsStreamingRuntime && currentRuntime && bridge) {
      if (compactCommand || slashCommand) {
        // Compacting mid-turn would abort the running turn, so it waits for the
        // idle flush like any queued prompt.
        if (!queuedFlushPromptId) workspace.queuePrompt(prompt, 'queue')
        if (intent === 'steer') setToast(translate(locale, compactCommand ? 'slash.compactQueued' : 'slash.queued'))
        return
      }
      if (intent === 'queue' && images.length === 0) {
        if (!queuedFlushPromptId) workspace.queuePrompt(prompt, intent)
        return
      }
      if (intent === 'steer') {
        const sentAt = Date.now()
        const pendingSteerId = workspace.queuePrompt(prompt, intent, [{ type: 'text', text: prompt }, ...images], sentAt)
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
        const opensNewTurn = !slashCommand && !compactCommand && !queuedFlushPromptId
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
        if ((intent === 'queue' || compactCommand) && images.length === 0 && (activeRuntime?.isStreaming || selectedSession?.status === 'running')) {
          // agent.list() disagreed with the optimistic append: the queue row
          // replaces the optimistic turn rows.
          retractPendingTurn()
          if (!queuedFlushPromptId) queuedPromptId = workspace.queuePrompt(prompt, compactCommand ? 'queue' : intent)
          if (compactCommand && intent === 'steer') setToast('Compaction will run when the current turn finishes.')
          return
        }
        let startedRuntime = false
        let startedSessionNeedsTitle = false
        if (slashCommand && !compactCommand) getDeps().onCommandStart?.(prompt.trim())
        if (!activeRuntime) {
          workspace.attachRuntime(undefined, generation)
          if (images.length > 0 && selected.sessionFile && selectedSession?.status === 'running') {
            throw new Error('Image attachments cannot be queued while this session is active outside OMP Desktop. Wait for it to finish, then try again.')
          }
          if (!provider.model) throw new Error(`No model is available for ${HARNESS_AGENT_NAMES[activeHarness]}. Enable or connect a provider, then try again.`)
          activeRuntime = await bridge.agent.start({ cwd: selected.cwd, sessionPath: selected.sessionFile, model: provider.model, thinking: provider.effort, fast: provider.fast, harness: activeHarness })
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
        if (compactCommand) {
          await bridge.agent.command(activeRuntime.runtimeId, {
            type: 'compact',
            ...(compactCommand.customInstructions ? { customInstructions: compactCommand.customInstructions } : {}),
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
          if (!slashCommand || compactCommand) {
            // setRuntime replaces the pill state, so unlike the guarded
            // message appends it must not fire for a navigated-away workspace.
            if (workspace.workspaceRef.current.generation === generation) workspace.setRuntime({ ...activeRuntime, isStreaming: true })
            appendPendingAssistant()
          }
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
          if (slashCommand && !compactCommand && workspace.workspaceRef.current.generation === generation) getDeps().onCommandFinish?.(undefined, data?.agentInvoked !== false)
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
        if (slashCommand && !compactCommand) {
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
    if (!bridge) { workspace.setMessages((items) => items.map((item) => item.streaming ? { ...item, streaming: false } : item)); workspace.setRuntime(null); return }
    const stoppedRuntimeId = stoppedRuntime.runtimeId
    const stoppedGeneration = workspace.workspaceRef.current.generation
    const stoppedOwner = workspace.runtimeOwnerRef.current
    const stoppedOwnerRuntimeId = stoppedOwner?.runtimeId
    const stoppedOwnerGeneration = stoppedOwner?.generation
    try {
      await bridge.agent.command(stoppedRuntimeId, { type: 'abort' })
      const currentOwner = workspace.runtimeOwnerRef.current
      if (
        workspace.workspaceRef.current.generation !== stoppedGeneration
        || workspace.runtimeIdRef.current !== stoppedRuntimeId
        || stoppedOwnerRuntimeId !== stoppedRuntimeId
        || stoppedOwnerGeneration !== stoppedGeneration
        || currentOwner?.runtimeId !== stoppedOwnerRuntimeId
        || currentOwner?.generation !== stoppedOwnerGeneration
      ) return
      workspace.setRuntime((current) => current?.runtimeId === stoppedRuntimeId ? { ...current, isStreaming: false } : current)
      workspace.setMessages((items) => {
        const lastAssistant = [...items].reverse().find((item) => item.role === 'assistant')
        return items.map((item) => item.id === lastAssistant?.id ? { ...item, streaming: false, completedAt: Date.now(), outcome: 'cancelled' } : item.streaming ? { ...item, streaming: false } : item)
      })
    } catch (error) { reportError(error) }
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

  return {
    grantProject, persistPanel, toggleSidebar, toggleInspector, toggleTerminal,
    selectProject, selectSession, newSession, openDraftSession, discardDraftSession, navigate, renameSession, setSessionArchived, deleteSession,
    addProject, relocateProject, removeProject, togglePinProject, setProjectSortMode, sendPrompt, stopRuntime, installSkill, installExtension, connectMcp, setMcpEnabled, mutateCapability,
    createSchedule, updateSchedule, mutateSchedule, openScheduledSession,
    openBrowser, openChanges,
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
