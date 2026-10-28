import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import type { DesktopApi, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'
import { createSingleFlightAdmission } from '../../src/lib/workspace'

const project = {
  id: 'optimistic-project',
  harness: 'omp' as const,
  name: 'Optimistic project',
  path: '/optimistic-project',
  folders: ['/optimistic-project'],
  primaryFolder: '/optimistic-project',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 1,
}

const session = (status: SessionRecord['status'] = 'idle'): SessionRecord => ({
  id: 'optimistic-session',
  harness: 'omp',
  filePath: '/optimistic-project/session.jsonl',
  projectPath: '/optimistic-project',
  title: 'Optimistic session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status,
  depth: 0,
})

const runtime = (runtimeId = 'idle-runtime', isStreaming = false): RuntimeInfo => ({
  runtimeId,
  harness: 'omp',
  cwd: project.primaryFolder,
  sessionFile: session().filePath,
  isStreaming,
})

interface FixtureOptions {
  /** The runtime the renderer currently believes in (workspace view). */
  workspaceRuntime?: RuntimeInfo | null
  /** The runtimes agent.list() reports (main-process truth). */
  listedRuntimes?: RuntimeInfo[]
  sessionStatus?: SessionRecord['status']
}

function fixture({ workspaceRuntime = null, listedRuntimes = [], sessionStatus = 'idle' }: FixtureOptions = {}) {
  let currentRuntime = workspaceRuntime
  const submissionAdmission = createSingleFlightAdmission()
  let messages: TranscriptMessage[] = []
  const currentSession = session(sessionStatus)
  const workspaceRef = {
    current: {
      generation: 1,
      project,
      session: currentSession,
      cwd: project.primaryFolder,
      sessionFile: currentSession.filePath,
    },
  }
  const command = vi.fn(async () => ({}))
  const start = vi.fn(async () => runtime('started-runtime'))
  const queuePrompt = vi.fn(() => 'queued-prompt-id')
  const setSessions = vi.fn()
  const runtimeIdRef = { current: null as string | null }
  const runtimeOwnerRef = { current: null as { runtimeId: string; generation: number } | null }
  const workspace = {
    get runtime() { return currentRuntime },
    workspaceRef,
    runtimeIdRef,
    runtimeOwnerRef,
    prepareForPrompt: () => true,
    adoptSessionId: vi.fn(),
    attachRuntime: (next: RuntimeInfo | undefined) => {
      currentRuntime = next ?? null
      runtimeIdRef.current = next?.runtimeId ?? null
      runtimeOwnerRef.current = next ? { runtimeId: next.runtimeId, generation: 1 } : null
    },
    setRuntime: (next: RuntimeInfo | ((current: RuntimeInfo | null) => RuntimeInfo | null)) => {
      currentRuntime = typeof next === 'function' ? next(currentRuntime) : next
    },
    setMessages: (next: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) => {
      messages = typeof next === 'function' ? next(messages) : next
    },
    queuePrompt,
    removeQueuedPrompt: vi.fn(),
    markQueuedPromptFlushFailed: vi.fn(),
    acceptSteer: vi.fn(),
    acknowledgeSteer: vi.fn(),
  }
  const bridge = {
    agent: { list: vi.fn(async () => listedRuntimes), command, start, stop: vi.fn(async () => false) },
    sessions: { list: vi.fn(async () => [currentSession]) },
  } as unknown as DesktopApi
  const actions = createWorkspaceActions(() => ({
    bridge,
    projects: [project],
    sessions: [currentSession],
    activeProject: project,
    workspace,
    settingsState: { settings: { activeHarness: 'omp', locale: 'en' } },
    provider: { model: 'auto', effort: 'medium', fast: false },
    submissionAdmissionRef: { current: submissionAdmission },
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
    bumpRecentSessionOpen: vi.fn(),
    reportError: vi.fn(),
    onCommandStart: vi.fn(),
    onCommandFinish: vi.fn(),
  } as unknown as WorkspaceActionsDeps))

  return { actions, command, start, queuePrompt, setSessions, messages: () => messages }
}

describe('optimistic turn rows in existing sessions', () => {
  it('shows the user message and thinking placeholder while the runtime starts', async () => {
    const state = fixture()
    let finishStart!: (value: RuntimeInfo) => void
    state.start.mockImplementationOnce(() => new Promise<RuntimeInfo>((resolve) => { finishStart = resolve }))
    const sending = state.actions.sendPrompt('Run the tests')

    await vi.waitFor(() => expect(state.start).toHaveBeenCalled())
    // The turn is visible before the harness process even exists.
    expect(state.messages().map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(state.messages()[1]).toMatchObject({ streaming: true, parts: [] })

    finishStart(runtime('started-runtime'))
    await sending
    // The same rows serve the delivered turn: no duplicates, no queue row.
    expect(state.messages().map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(state.messages()[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Run the tests' }] })
    expect(state.command).toHaveBeenCalledWith('started-runtime', expect.objectContaining({ type: 'prompt', message: 'Run the tests' }))
    expect(state.queuePrompt).not.toHaveBeenCalled()
  })

  it('delivers a follow_up when the renderer already sees a streaming runtime', async () => {
    const busy = runtime('busy-runtime', true)
    const state = fixture({ workspaceRuntime: busy, listedRuntimes: [busy] })

    await state.actions.sendPrompt('Queue this')

    expect(state.messages()).toEqual([])
    expect(state.queuePrompt).not.toHaveBeenCalled()
    expect(state.command).toHaveBeenCalledWith('busy-runtime', expect.objectContaining({ type: 'follow_up', message: 'Queue this' }))
  })

  it('delivers a follow_up when agent.list reveals a busy runtime', async () => {
    const busy = runtime('busy-runtime', true)
    const state = fixture({ listedRuntimes: [busy] })

    await state.actions.sendPrompt('Queue this')

    expect(state.messages()).toEqual([])
    expect(state.queuePrompt).not.toHaveBeenCalled()
    expect(state.command).toHaveBeenCalledOnce()
    expect(state.command).toHaveBeenCalledWith('busy-runtime', expect.objectContaining({ type: 'follow_up', message: 'Queue this' }))
    expect(state.start).not.toHaveBeenCalled()
  })

  it('retracts the optimistic rows when a steer joins a running turn', async () => {
    const busy = runtime('busy-runtime', true)
    const state = fixture({ listedRuntimes: [busy] })

    await state.actions.sendPrompt('Steer this', [], 'steer')

    expect(state.messages()).toEqual([])
    expect(state.queuePrompt).toHaveBeenCalledWith('Steer this', 'steer', expect.any(Array), expect.any(Number))
    expect(state.command).toHaveBeenCalledWith('busy-runtime', expect.objectContaining({ type: 'steer', message: 'Steer this' }))
  })

  it('skips the optimistic rows for a session that runs outside OMP Desktop', async () => {
    const state = fixture({ sessionStatus: 'running' })

    await state.actions.sendPrompt('Queue this')

    expect(state.messages()).toEqual([])
    expect(state.queuePrompt).toHaveBeenCalledWith('Queue this', 'queue')
    expect(state.start).not.toHaveBeenCalled()
  })

  it('keeps the sidebar fresh through the optimistic send', async () => {
    const state = fixture()
    let finishStart!: (value: RuntimeInfo) => void
    state.start.mockImplementationOnce(() => new Promise<RuntimeInfo>((resolve) => { finishStart = resolve }))
    const sending = state.actions.sendPrompt('Run the tests')
    await vi.waitFor(() => expect(state.start).toHaveBeenCalled())

    expect(state.setSessions).toHaveBeenCalled()
    const updater = state.setSessions.mock.calls.at(-1)?.[0] as (items: SessionRecord[]) => SessionRecord[]
    expect(updater([session()])[0]).toMatchObject({ lastUserMessageAt: expect.any(String) })

    finishStart(runtime('started-runtime'))
    await sending
  })

  it('queues a follow-up while a previous admission is still starting the runtime', async () => {
    const state = fixture()
    let finishStart!: (value: RuntimeInfo) => void
    state.start.mockImplementationOnce(() => new Promise<RuntimeInfo>((resolve) => { finishStart = resolve }))
    const first = state.actions.sendPrompt('First message')
    await vi.waitFor(() => expect(state.start).toHaveBeenCalled())

    // The optimistic rows already mark the transcript busy; a second send
    // must queue behind the in-flight admission instead of failing it.
    await state.actions.sendPrompt('Second message')
    expect(state.queuePrompt).toHaveBeenCalledWith('Second message', 'queue')
    expect(state.messages().filter((message) => message.role === 'user')).toHaveLength(1)

    finishStart(runtime('started-runtime'))
    await first
    expect(state.messages().map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('waits for an in-flight admission before delivering a steer', async () => {
    const state = fixture()
    let finishStart!: (value: RuntimeInfo) => void
    state.start.mockImplementationOnce(() => new Promise<RuntimeInfo>((resolve) => { finishStart = resolve }))
    const first = state.actions.sendPrompt('First message')
    await vi.waitFor(() => expect(state.start).toHaveBeenCalled())

    const steer = state.actions.sendPrompt('Steer this', [], 'steer')
    await Promise.resolve()
    // Still waiting on the admission: nothing queued, nothing commanded.
    expect(state.queuePrompt).not.toHaveBeenCalled()
    expect(state.command).not.toHaveBeenCalled()

    finishStart(runtime('started-runtime'))
    await first
    await steer
    expect(state.command).toHaveBeenCalledWith('started-runtime', expect.objectContaining({ type: 'steer', message: 'Steer this' }))
    expect(state.queuePrompt).toHaveBeenCalledWith('Steer this', 'steer', expect.any(Array), expect.any(Number))
  })
})
