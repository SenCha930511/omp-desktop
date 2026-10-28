import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import type { DesktopApi, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'
import { createSingleFlightAdmission } from '../../src/lib/workspace'
import { waitUntil } from '../helpers/wait'

// 4.5 GUI/TUI parity:tree/branch/rewind → SessionTreeDialog;fork → native
// full fork(idle-only);resume → 選取 session 切換;new/clear → durable
// newSession 邊界;help → 本地命令清單。全部絕不送模型。
const project = {
  id: 'gui-project',
  harness: 'omp' as const,
  name: 'Gui project',
  path: '/gui-project',
  folders: ['/gui-project'],
  primaryFolder: '/gui-project',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 2,
}

const currentSession: SessionRecord = {
  id: 'session-current',
  harness: 'omp',
  filePath: '/gui-project/current.jsonl',
  projectPath: '/gui-project',
  title: 'Current session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
}

const olderSession: SessionRecord = { ...currentSession, id: '0de4-session-0000', filePath: '/gui-project/older.jsonl', title: 'Older session' }

const branchedSession: SessionRecord = { ...currentSession, id: 'branched-session', filePath: '/gui-project/branched.jsonl', title: 'Current session (branch)' }

interface FixtureOptions {
  /** 目前持有的事件流 runtime(忙碌時設定)。 */
  attachedRuntime?: RuntimeInfo | null
  /** 覆寫 bridge(例如 /new 的 durable 邊界回應)。 */
  bridgeOverride?: DesktopApi
}

function fixture({ attachedRuntime = null, bridgeOverride }: FixtureOptions = {}) {
  let currentRuntime = attachedRuntime
  const submissionAdmission = createSingleFlightAdmission()
  let messages: TranscriptMessage[] = []
  const workspaceRef = {
    current: {
      generation: 1,
      project,
      session: currentSession as SessionRecord | undefined,
      cwd: project.primaryFolder,
      sessionFile: currentSession.filePath,
    },
  }
  const command = vi.fn(async (_runtimeId: string, commandBody: { type: string }): Promise<Record<string, unknown>> => {
    if (commandBody.type === 'new_session') return { data: {} }
    if (commandBody.type === 'get_state') return { data: { sessionId: 'durable-session-id', sessionFile: '/gui-project/durable.jsonl' } }
    return {}
  })
  const start = vi.fn(async () => ({ runtimeId: 'durable-runtime', harness: 'omp' as const, cwd: project.primaryFolder, isStreaming: false }))
  const sessionsBranch = vi.fn(async () => branchedSession)
  const sessionsList = vi.fn(async () => [currentSession, olderSession])
  const bridge =
    bridgeOverride ??
    ({
      agent: { list: vi.fn(async () => []), command, start, stop: vi.fn(async () => false) },
      sessions: { list: sessionsList, branch: sessionsBranch },
      projects: { touch: vi.fn(async () => true) },
    } as unknown as DesktopApi)
  const queuePrompt = vi.fn(() => 'queued-prompt-id')
  const reportError = vi.fn()
  const setToast = vi.fn()
  const setView = vi.fn()
  const setSidebarOpen = vi.fn()
  const openSessionTree = vi.fn()
  const activateWorkspace = vi.fn((_p?: unknown, session?: SessionRecord) => {
    workspaceRef.current.session = session
    workspaceRef.current.sessionFile = session?.filePath ?? (null as unknown as string)
    return 1
  })
  const reconcileRuntime = vi.fn(async () => undefined)
  const runtimeIdRef = { current: attachedRuntime?.runtimeId ?? (null as string | null) }
  const runtimeOwnerRef = { current: attachedRuntime ? { runtimeId: attachedRuntime.runtimeId, generation: 1 } : (null as { runtimeId: string; generation: number } | null) }
  const workspace = {
    get runtime() {
      return currentRuntime
    },
    workspaceRef,
    runtimeIdRef,
    runtimeOwnerRef,
    pendingQueuedPrompts: [],
    prepareForPrompt: () => true,
    adoptSessionId: vi.fn(),
    activateWorkspace,
    reconcileRuntime,
    attachRuntime: (next: RuntimeInfo | undefined) => {
      currentRuntime = next ?? null
      runtimeIdRef.current = next?.runtimeId ?? null
      runtimeOwnerRef.current = next ? { runtimeId: next.runtimeId, generation: 1 } : null
    },
    setRuntime: vi.fn(),
    setMessages: (next: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) => {
      messages = typeof next === 'function' ? next(messages) : next
    },
    setComposerToastSuppressed: vi.fn(),
    queuePrompt,
    removeQueuedPrompt: vi.fn(),
    markQueuedPromptFlushFailed: vi.fn(),
    retractQueuedPrompt: vi.fn(),
    acceptSteer: vi.fn(),
    acknowledgeSteer: vi.fn(),
    restoreWithdrawnQueue: vi.fn(),
    reconcileQueuedPrompts: vi.fn(),
  }
  const actions = createWorkspaceActions(
    () =>
      ({
        bridge,
        projects: [project],
        sessions: [currentSession, olderSession],
        activeProject: project,
        workspace,
        settingsState: { settings: { activeHarness: 'omp', locale: 'en' }, setSidebarOpen },
        provider: { model: 'auto', effort: 'medium', fast: false },
        submissionAdmissionRef: { current: submissionAdmission },
        initialized: true,
        layout: {},
        pluginSkills: {},
        demoTimerRef: { current: [] },
        setProjects: vi.fn(),
        setSessions: vi.fn(),
        setView,
        setPaletteOpen: vi.fn(),
        setToast,
        setSubmitting: vi.fn(),
        bumpRecentSessionOpen: vi.fn(),
        refreshSchedules: vi.fn(),
        resetBrowserView: vi.fn(),
        closeTerminalForSession: vi.fn(),
        clearSessionAttention: vi.fn(),
        reportError,
        onCommandStart: vi.fn(),
        onCommandFinish: vi.fn(),
        openSessionTree,
      }) as unknown as WorkspaceActionsDeps,
  )

  return {
    actions,
    command,
    start,
    queuePrompt,
    reportError,
    setToast,
    setView,
    setSidebarOpen,
    openSessionTree,
    sessionsBranch,
    activateWorkspace,
    reconcileRuntime,
    workspace,
    messages: () => messages,
    runtimeState: () => currentRuntime,
  }
}

describe('slash GUI entries', () => {
  it('/tree, /branch and /rewind open the session tree dialog without touching the model', async () => {
    const state = fixture()
    for (const prompt of ['/tree', '/branch', '/rewind']) {
      await state.actions.sendPrompt(prompt)
    }
    expect(state.openSessionTree).toHaveBeenCalledTimes(3)
    expect(state.command).not.toHaveBeenCalled()
    expect(state.queuePrompt).not.toHaveBeenCalled()
  })

  it('opens the session tree dialog even while the runtime is busy', async () => {
    const busy: RuntimeInfo = { runtimeId: 'busy-runtime', harness: 'omp', cwd: project.primaryFolder, sessionFile: currentSession.filePath, isStreaming: true }
    const state = fixture({ attachedRuntime: busy })
    await state.actions.sendPrompt('/tree')
    expect(state.openSessionTree).toHaveBeenCalledOnce()
    expect(state.queuePrompt).not.toHaveBeenCalled()
  })

  it('/new and /clear establish the durable new-session boundary', async () => {
    const state = fixture()
    await state.actions.sendPrompt('/new')
    // 等第一個 durable 邊界完整結束(attachRuntime 是 flight 的最後一步),
    // 再送 /clear,避免撞進同專案的 flight dedup 視窗。
    await waitUntil(() => state.runtimeState()?.sessionFile === '/gui-project/durable.jsonl')
    expect(state.start).toHaveBeenCalledOnce()
    expect(state.command).toHaveBeenCalledWith('durable-runtime', { type: 'new_session' })
    await state.actions.sendPrompt('/clear')
    await waitUntil(() => state.start.mock.calls.length === 2)
    expect(state.command.mock.calls.filter((call) => call[1]?.type === 'new_session')).toHaveLength(2)
    expect(state.queuePrompt).not.toHaveBeenCalled()
  })

  it('/fork uses the native fork flow for the current session when idle', async () => {
    const state = fixture()
    await state.actions.sendPrompt('/fork')
    await waitUntil(() => state.sessionsBranch.mock.calls.length > 0)
    expect(state.sessionsBranch).toHaveBeenCalledWith(currentSession.filePath)
    expect(state.command).not.toHaveBeenCalled()
  })

  it('/fork queues when the runtime is busy, matching the upstream session_busy rejection', async () => {
    const busy: RuntimeInfo = { runtimeId: 'busy-runtime', harness: 'omp', cwd: project.primaryFolder, sessionFile: currentSession.filePath, isStreaming: true }
    const state = fixture({ attachedRuntime: busy })
    await state.actions.sendPrompt('/fork')
    expect(state.sessionsBranch).not.toHaveBeenCalled()
    expect(state.queuePrompt).toHaveBeenCalledWith('/fork', 'queue')
  })

  it('/fork without a session reports the missing-session error in place', async () => {
    const state = fixture()
    state.workspace.workspaceRef.current.session = undefined
    state.workspace.workspaceRef.current.sessionFile = undefined as unknown as string
    await state.actions.sendPrompt('/fork')
    expect(state.sessionsBranch).not.toHaveBeenCalled()
    expect(state.reportError).toHaveBeenCalledOnce()
    expect(String(state.reportError.mock.calls[0]?.[0])).toContain('send a message to start one first')
  })

  it('/fork pane stays deferred as terminal multiplexer chrome', async () => {
    const state = fixture()
    await expect(state.actions.sendPrompt('/fork pane')).rejects.toThrow('/fork pane uses a terminal selector')
    expect(state.sessionsBranch).not.toHaveBeenCalled()
    expect(state.command).not.toHaveBeenCalled()
  })

  it('bare /resume points the user at the sidebar session list', async () => {
    const state = fixture()
    await state.actions.sendPrompt('/resume')
    expect(state.setSidebarOpen).toHaveBeenCalledWith(true)
    expect(state.setView).toHaveBeenCalledWith('session')
    expect(state.setToast).toHaveBeenCalledOnce()
    expect(String(state.setToast.mock.calls[0]?.[0])).toContain('sidebar')
    expect(state.command).not.toHaveBeenCalled()
  })

  it('/resume <id> switches to the matching session through selectSession', async () => {
    const state = fixture()
    await state.actions.sendPrompt('/resume 0de4')
    await waitUntil(() => state.reconcileRuntime.mock.calls.length > 0)
    expect(state.activateWorkspace).toHaveBeenCalledWith(project, expect.objectContaining({ id: olderSession.id }))
    expect(state.command).not.toHaveBeenCalled()
  })

  it('/resume with an unknown identifier reports the miss in place', async () => {
    const state = fixture()
    await state.actions.sendPrompt('/resume nope-unknown')
    expect(state.reportError).toHaveBeenCalledOnce()
    expect(String(state.reportError.mock.calls[0]?.[0])).toContain('nope-unknown')
    expect(state.activateWorkspace).not.toHaveBeenCalled()
  })

  it('/resume @claude is rejected as a foreign-harness target', async () => {
    const state = fixture()
    await state.actions.sendPrompt('/resume @claude')
    expect(state.reportError).toHaveBeenCalledOnce()
    expect(String(state.reportError.mock.calls[0]?.[0])).toContain('another harness')
    expect(state.activateWorkspace).not.toHaveBeenCalled()
  })

  it('/resume dispatches immediately even while busy because it is a workspace switch', async () => {
    const busy: RuntimeInfo = { runtimeId: 'busy-runtime', harness: 'omp', cwd: project.primaryFolder, sessionFile: currentSession.filePath, isStreaming: true }
    const state = fixture({ attachedRuntime: busy })
    await state.actions.sendPrompt('/resume 0de4')
    await waitUntil(() => state.reconcileRuntime.mock.calls.length > 0)
    expect(state.activateWorkspace).toHaveBeenCalledWith(project, expect.objectContaining({ id: olderSession.id }))
    expect(state.queuePrompt).not.toHaveBeenCalled()
  })

  it('/help lists commands locally without an RPC, idle and busy alike', async () => {
    const idle = fixture()
    await idle.actions.sendPrompt('/help')
    expect(idle.command).not.toHaveBeenCalled()
    const idlePart = idle.messages()[0]?.parts[0]
    expect(String(idlePart?.type === 'text' ? idlePart.text : '')).toContain('Commands available here:')

    const busy: RuntimeInfo = { runtimeId: 'busy-runtime', harness: 'omp', cwd: project.primaryFolder, sessionFile: currentSession.filePath, isStreaming: true }
    const busyState = fixture({ attachedRuntime: busy })
    await busyState.actions.sendPrompt('/help')
    expect(busyState.command).not.toHaveBeenCalled()
    expect(busyState.queuePrompt).not.toHaveBeenCalled()
    const busyPart = busyState.messages()[0]?.parts[0]
    expect(String(busyPart?.type === 'text' ? busyPart.text : '')).toContain('Commands available here:')
  })
})
