import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import type { DesktopApi, ProjectRecord, QueuedPrompt, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'
import { createSingleFlightAdmission } from '../../src/lib/workspace'
const project: ProjectRecord = {
  id: 'durable-project',
  harness: 'omp',
  name: 'Durable project',
  path: '/durable-project',
  folders: ['/durable-project'],
  primaryFolder: '/durable-project',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 1,
}

const otherProject: ProjectRecord = {
  ...project,
  id: 'other-project',
  name: 'Other project',
  path: '/other-project',
  folders: ['/other-project'],
  primaryFolder: '/other-project',
}

const existingSession: SessionRecord = {
  id: 'existing-session',
  harness: 'omp',
  filePath: '/durable-project/existing-session.jsonl',
  projectPath: '/durable-project',
  title: 'Existing session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
}

const durableSession: SessionRecord = {
  id: 'durable-session',
  harness: 'omp',
  filePath: '/durable-project/durable-session.jsonl',
  projectPath: '/durable-project',
  title: 'Untitled session',
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  status: 'idle',
  depth: 0,
}

const otherSession: SessionRecord = {
  ...existingSession,
  id: 'other-session',
  filePath: '/durable-project/other-session.jsonl',
  title: 'Other session',
}

const filelessRuntime = (runtimeId = 'durable-runtime'): RuntimeInfo => ({
  runtimeId,
  harness: 'omp',
  cwd: project.primaryFolder,
  isStreaming: false,
})

const ownedRuntime = (runtimeId: string): RuntimeInfo => ({
  runtimeId,
  harness: 'omp',
  cwd: project.primaryFolder,
  sessionFile: existingSession.filePath,
  isStreaming: false,
})

interface FixtureOptions {
  /** A runtime the renderer currently believes in, with ownership refs attached. */
  currentRuntime?: RuntimeInfo | null
  /** The runtimes agent.list() reports. */
  listedRuntimes?: RuntimeInfo[]
  bridge?: DesktopApi | null
}

function fixture({ currentRuntime = null, listedRuntimes = [], bridge: bridgeOverride }: FixtureOptions = {}) {
  let runtimeState: RuntimeInfo | null = currentRuntime
  let generation = 1
  let messages: TranscriptMessage[] = []
  const workspaceRef = {
    current: {
      generation: 1,
      project,
      session: currentRuntime ? existingSession : undefined,
      cwd: project.primaryFolder,
      sessionFile: currentRuntime ? existingSession.filePath : undefined,
    } as { generation: number; project?: ProjectRecord; session?: SessionRecord; cwd?: string; sessionFile?: string },
  }
  const start = vi.fn(async () => filelessRuntime())
  const command = vi.fn(async (_runtimeId: string, _command: { type: string }): Promise<Record<string, unknown>> => ({}))
  const sessionsList = vi.fn(async () => [durableSession, existingSession, otherSession])
  const stop = vi.fn(async () => false)
  const setSessions = vi.fn()
  const reportError = vi.fn()
  const adoptSessionId = vi.fn((session: SessionRecord) => {
    workspaceRef.current = { ...workspaceRef.current, session, sessionFile: session.filePath }
  })
  const attachCalls: Array<RuntimeInfo | undefined> = []
  const runtimeIdRef = { current: currentRuntime?.runtimeId ?? null as string | null }
  const runtimeOwnerRef = { current: currentRuntime ? { runtimeId: currentRuntime.runtimeId, generation: 1 } : null as { runtimeId: string; generation: number } | null }
  const workspace = {
    get runtime() { return runtimeState },
    workspaceRef,
    runtimeIdRef,
    runtimeOwnerRef,
    pendingQueuedPrompts: [] as QueuedPrompt[],
    prepareForPrompt: () => true,
    adoptSessionId,
    activateWorkspace(nextProject?: ProjectRecord, session?: SessionRecord) {
      generation += 1
      const target = nextProject ?? workspaceRef.current.project
      workspaceRef.current = { generation, project: target, session, cwd: target?.primaryFolder, sessionFile: session?.filePath }
      runtimeState = null
      runtimeIdRef.current = null
      runtimeOwnerRef.current = null
      return generation
    },
    attachRuntime(next: RuntimeInfo | undefined, attachGeneration?: number) {
      // Fidelity with the real hook: attach only into the generation that
      // requested it.
      if (attachGeneration !== undefined && workspaceRef.current.generation !== attachGeneration) return
      attachCalls.push(next)
      runtimeState = next ?? null
      runtimeIdRef.current = next?.runtimeId ?? null
      runtimeOwnerRef.current = next && attachGeneration !== undefined ? { runtimeId: next.runtimeId, generation: attachGeneration } : null
    },
    setRuntime(next: RuntimeInfo | ((current: RuntimeInfo | null) => RuntimeInfo | null)) {
      runtimeState = typeof next === 'function' ? next(runtimeState) : next
    },
    setMessages(next: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) {
      messages = typeof next === 'function' ? next(messages) : next
    },
    queuePrompt: vi.fn(),
    removeQueuedPrompt: vi.fn(),
    markQueuedPromptFlushFailed: vi.fn(),
    retractQueuedPrompt: vi.fn(),
    acceptSteer: vi.fn(),
    acknowledgeSteer: vi.fn(),
    restoreWithdrawnQueue: vi.fn(),
    reconcileQueuedPrompts: vi.fn(),
  }
  const bridge = bridgeOverride === null ? null : bridgeOverride ?? ({
    agent: { list: vi.fn(async () => listedRuntimes), command, start, stop },
    sessions: { list: sessionsList },
  } as unknown as DesktopApi)
  const actions = createWorkspaceActions(() => ({
    bridge,
    projects: [project],
    sessions: [existingSession, otherSession],
    activeProject: project,
    workspace,
    settingsState: { settings: { activeHarness: 'omp', locale: 'en' } },
    provider: { model: 'auto', effort: 'medium', fast: false },
    submissionAdmissionRef: { current: createSingleFlightAdmission() },
    initialized: true,
    layout: {},
    pluginSkills: {},
    gitRequestRef: { current: 0 },
    demoTimerRef: { current: [] },
    setProjects: vi.fn(),
    setSessions,
    setGitSnapshot: vi.fn(),
    setView: vi.fn(),
    setPaletteOpen: vi.fn(),
    setToast: vi.fn(),
    setSubmitting: vi.fn(),
    refreshSchedules: vi.fn(),
    resetBrowserView: vi.fn(),
    closeTerminalForSession: vi.fn(),
    clearSessionAttention: vi.fn(),
    reportError,
    onCommandStart: vi.fn(),
    onCommandFinish: vi.fn(),
  } as unknown as WorkspaceActionsDeps))

  return {
    actions,
    command,
    start,
    stop,
    sessionsList,
    setSessions,
    reportError,
    adoptSessionId,
    attachCalls,
    workspace,
    workspaceRef,
    runtimeState: () => runtimeState,
    messages: () => messages,
  }
}

const durableCommandResponses = vi.fn(async (_runtimeId: string, command: { type: string }): Promise<Record<string, unknown>> => {
  if (command.type === 'new_session') return { data: { cancelled: false } }
  if (command.type === 'get_state') {
    return { data: { sessionId: durableSession.id, sessionFile: durableSession.filePath, isStreaming: false } }
  }
  return {}
})

describe('durable new session boundary', () => {
  it('establishes an engine-owned empty session on a freshly started fileless runtime', async () => {
    const state = fixture()
    state.command.mockImplementation(durableCommandResponses)

    await state.actions.newSession(project)

    // A fileless runtime, no model and no prompt: the boundary is metadata only.
    expect(state.start).toHaveBeenCalledWith({ cwd: project.primaryFolder, harness: 'omp' })
    expect(state.command).toHaveBeenCalledWith('durable-runtime', { type: 'new_session' })
    expect(state.command).toHaveBeenCalledWith('durable-runtime', { type: 'get_state' })
    expect(state.command.mock.calls.every(([, command]) => command.type !== 'prompt')).toBe(true)
    expect(state.stop).not.toHaveBeenCalled()
    // The authoritative catalog row is indexed, adopted, and the runtime
    // re-attached under the authoritative session id and file.
    expect(state.sessionsList).toHaveBeenCalled()
    expect(state.setSessions).toHaveBeenCalled()
    expect(state.adoptSessionId).toHaveBeenCalledWith(expect.objectContaining({ filePath: durableSession.filePath }))
    expect(state.attachCalls.at(-1)).toMatchObject({ runtimeId: 'durable-runtime', sessionId: durableSession.id, sessionFile: durableSession.filePath })
  })

  it('keeps a draft workspace without the bridge', async () => {
    const state = fixture({ bridge: null })

    await state.actions.newSession(project)

    expect(state.workspaceRef.current.session).toBeUndefined()
    expect(state.start).not.toHaveBeenCalled()
    expect(state.messages()).toEqual([])
  })

  it('does not pretend a session exists when the engine cancels the boundary', async () => {
    const state = fixture()
    state.command.mockImplementation(async (_runtimeId: string, command: { type: string }): Promise<Record<string, unknown>> => {
      if (command.type === 'new_session') return { data: { cancelled: true } }
      return {}
    })

    // A UI click must never surface an unhandled rejection.
    await state.actions.newSession(project)

    expect(state.command.mock.calls.some(([, command]) => command.type === 'get_state')).toBe(false)
    expect(state.adoptSessionId).not.toHaveBeenCalled()
    expect(state.attachCalls).toEqual([])
    expect(state.workspaceRef.current.session).toBeUndefined()
    expect(state.reportError).toHaveBeenCalled()
    // The abandoned fileless runtime is cleaned up instead of leaking.
    expect(state.stop).toHaveBeenCalledWith('durable-runtime')
  })

  it('reports a failed boundary without rejecting or pretending a session exists', async () => {
    const state = fixture()
    const failure = new Error('new_session failed')
    state.command.mockRejectedValueOnce(failure)

    await state.actions.newSession(project)

    expect(state.reportError).toHaveBeenCalledWith(failure)
    expect(state.adoptSessionId).not.toHaveBeenCalled()
    expect(state.attachCalls).toEqual([])
    expect(state.stop).toHaveBeenCalledWith('durable-runtime')
  })

  it('never commands the current runtime for the boundary', async () => {
    const current = ownedRuntime('current-runtime')
    const state = fixture({ currentRuntime: current, listedRuntimes: [current] })
    state.command.mockImplementation(durableCommandResponses)

    await state.actions.newSession(project)

    expect(state.command.mock.calls.every(([runtimeId]) => runtimeId === 'durable-runtime')).toBe(true)
    expect(state.command).not.toHaveBeenCalledWith('current-runtime', expect.anything())
  })

  it('indexes the new session but cannot overwrite a view that switched away', async () => {
    const state = fixture()
    const startDeferred = Promise.withResolvers<RuntimeInfo>()
    state.start.mockReturnValue(startDeferred.promise)
    state.command.mockImplementation(durableCommandResponses)

    const creating = state.actions.newSession(project)
    // The user navigates to another session while the boundary is awaited.
    state.workspace.activateWorkspace(project, otherSession)
    startDeferred.resolve(filelessRuntime())
    await creating

    expect(state.setSessions).toHaveBeenCalled()
    expect(state.adoptSessionId).not.toHaveBeenCalled()
    expect(state.attachCalls).toEqual([])
    expect(state.workspaceRef.current.session).toMatchObject({ id: 'other-session' })
  })

  it('collapses a rapid double click into one boundary', async () => {
    const state = fixture()
    const startDeferred = Promise.withResolvers<RuntimeInfo>()
    state.start.mockReturnValue(startDeferred.promise)
    state.command.mockImplementation(durableCommandResponses)

    const first = state.actions.newSession(project)
    const second = state.actions.newSession(project)
    startDeferred.resolve(filelessRuntime())
    await Promise.all([first, second])

    expect(state.start).toHaveBeenCalledOnce()
    expect(state.command.mock.calls.filter(([, command]) => command.type === 'new_session')).toHaveLength(1)
  })

  it('runs an independent boundary for a different project requested mid-flight', async () => {
    const state = fixture()
    const startDeferred = Promise.withResolvers<RuntimeInfo>()
    state.start.mockReturnValueOnce(startDeferred.promise)
    state.command.mockImplementation(durableCommandResponses)

    const first = state.actions.newSession(project)
    // A different project requested while A's boundary is still in flight
    // must establish its own boundary, not silently join A's flight.
    const second = state.actions.newSession(otherProject)
    startDeferred.resolve(filelessRuntime('durable-runtime-a'))
    await Promise.all([first, second])

    expect(state.start).toHaveBeenCalledTimes(2)
    expect(state.start).toHaveBeenNthCalledWith(1, { cwd: project.primaryFolder, harness: 'omp' })
    expect(state.start).toHaveBeenNthCalledWith(2, { cwd: otherProject.primaryFolder, harness: 'omp' })
    expect(state.command.mock.calls.filter(([, command]) => command.type === 'new_session')).toHaveLength(2)
  })

  it('does not reclaim a draft the prompt admission already claimed', async () => {
    const state = fixture()
    const startDeferred = Promise.withResolvers<RuntimeInfo>()
    state.start.mockReturnValue(startDeferred.promise)
    state.command.mockImplementation(durableCommandResponses)

    const creating = state.actions.newSession(project)
    // A prompt submitted on the draft adopts its session without a
    // generation bump; the boundary must not drag that live turn off the
    // workspace when its own flight settles.
    state.workspace.adoptSessionId(existingSession)
    startDeferred.resolve(filelessRuntime())
    await creating

    // The boundary is still indexed for the sidebar, but the workspace keeps
    // the adopted session and its attached runtime.
    expect(state.setSessions).toHaveBeenCalled()
    expect(state.adoptSessionId).toHaveBeenCalledTimes(1)
    expect(state.attachCalls).toEqual([])
    expect(state.workspaceRef.current.session).toMatchObject({ id: 'existing-session' })
  })

  it('allows a fresh boundary after a settled flight and retries after a cancelled one', async () => {
    const state = fixture()
    state.command.mockImplementation(durableCommandResponses)
    await state.actions.newSession(project)
    await state.actions.newSession(project)
    expect(state.start).toHaveBeenCalledTimes(2)
    expect(state.command.mock.calls.filter(([, command]) => command.type === 'new_session')).toHaveLength(2)

    const retryState = fixture()
    retryState.command
      .mockImplementationOnce(async (_runtimeId: string, _command: { type: string }): Promise<Record<string, unknown>> => ({ data: { cancelled: true } }))
      .mockImplementation(durableCommandResponses)
    await retryState.actions.newSession(project)
    await retryState.actions.newSession(project)
    expect(retryState.command.mock.calls.filter(([, command]) => command.type === 'new_session')).toHaveLength(2)
    expect(retryState.adoptSessionId).toHaveBeenCalledWith(expect.objectContaining({ filePath: durableSession.filePath }))
  })

  it('shares one flight between explicit and implicit requests for the same project', async () => {
    const state = fixture()
    const startDeferred = Promise.withResolvers<RuntimeInfo>()
    state.start.mockReturnValue(startDeferred.promise)
    state.command.mockImplementation(durableCommandResponses)

    const first = state.actions.newSession(project)
    // No argument resolves to the workspace's project: the same boundary.
    const second = state.actions.newSession()
    startDeferred.resolve(filelessRuntime())
    await Promise.all([first, second])

    expect(state.start).toHaveBeenCalledOnce()
    expect(state.command.mock.calls.filter(([, command]) => command.type === 'new_session')).toHaveLength(1)
  })
})

describe('inferred project grant', () => {
  it('grants an inferred project before starting the boundary runtime', async () => {
    const grantInferred = vi.fn(async () => ({ ...project, inferred: false }))
    const start = vi.fn(async () => filelessRuntime())
    const state = fixture({ bridge: {
      agent: { list: vi.fn(async () => []), command: vi.fn(async () => ({})), start, stop: vi.fn(async () => false) },
      sessions: { list: vi.fn(async () => []) },
      projects: { grantInferred },
    } as unknown as DesktopApi })

    await state.actions.newSession({ ...project, inferred: true })

    expect(grantInferred).toHaveBeenCalledWith(project.primaryFolder, 'omp')
    expect(start).toHaveBeenCalledWith({ cwd: project.primaryFolder, harness: 'omp' })
  })
})
