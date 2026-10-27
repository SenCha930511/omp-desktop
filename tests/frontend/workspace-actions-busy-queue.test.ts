import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import type { DesktopApi, PromptImage, QueuedPrompt, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'
import { createSingleFlightAdmission } from '../../src/lib/workspace'

const project = {
  id: 'busy-project',
  harness: 'omp' as const,
  name: 'Busy project',
  path: '/busy-project',
  folders: ['/busy-project'],
  primaryFolder: '/busy-project',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 1,
}

const session = (status: SessionRecord['status'] = 'idle'): SessionRecord => ({
  id: 'busy-session',
  harness: 'omp',
  filePath: '/busy-project/session.jsonl',
  projectPath: '/busy-project',
  title: 'Busy session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status,
  depth: 0,
})

const runtime = (runtimeId = 'busy-runtime', isStreaming = true): RuntimeInfo => ({
  runtimeId,
  harness: 'omp',
  cwd: project.primaryFolder,
  sessionFile: session().filePath,
  isStreaming,
})

const image: PromptImage = { type: 'image', mimeType: 'image/png', data: 'aW1hZ2UtYnl0ZXM=' }

interface FixtureOptions {
  /** The runtime the renderer currently believes in, with its ownership refs attached. */
  attachedRuntime?: RuntimeInfo | null
  /** The runtime the renderer believes in without ownership refs (admission path). */
  workspaceRuntime?: RuntimeInfo | null
  /** The runtimes agent.list() reports (main-process truth). */
  listedRuntimes?: RuntimeInfo[]
  sessionStatus?: SessionRecord['status']
}

function fixture({ attachedRuntime = null, workspaceRuntime = null, listedRuntimes = [], sessionStatus = 'idle' }: FixtureOptions = {}) {
  let currentRuntime = attachedRuntime ?? workspaceRuntime
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
  const start = vi.fn(async () => runtime('started-runtime', false))
  const queuePrompt = vi.fn(() => 'queued-prompt-id')
  const setSessions = vi.fn()
  const runtimeIdRef = { current: attachedRuntime?.runtimeId ?? null as string | null }
  const runtimeOwnerRef = { current: attachedRuntime ? { runtimeId: attachedRuntime.runtimeId, generation: 1 } : null as { runtimeId: string; generation: number } | null }
  const workspace = {
    get runtime() { return currentRuntime },
    workspaceRef,
    runtimeIdRef,
    runtimeOwnerRef,
    pendingQueuedPrompts: [] as QueuedPrompt[],
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
    retractQueuedPrompt: vi.fn(),
    acceptSteer: vi.fn(),
    acknowledgeSteer: vi.fn(),
    restoreWithdrawnQueue: vi.fn(),
    reconcileQueuedPrompts: vi.fn(),
  }
  const bridge = {
    agent: { list: vi.fn(async () => listedRuntimes), command, start, stop: vi.fn(async () => false) },
    sessions: { list: vi.fn(async () => [currentSession]) },
  } as unknown as DesktopApi
  const reportError = vi.fn()
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
    reportError,
    onCommandStart: vi.fn(),
    onCommandFinish: vi.fn(),
  } as unknown as WorkspaceActionsDeps))

  return { actions, command, start, queuePrompt, reportError, setSessions, workspace, messages: () => messages, runtimeState: () => currentRuntime }
}

describe('busy queue parity between text and images', () => {
  it('delivers busy text to omp as a follow_up instead of a renderer queue', async () => {
    const busy = runtime()
    const state = fixture({ attachedRuntime: busy, listedRuntimes: [busy] })

    await state.actions.sendPrompt('Queue this')

    expect(state.command).toHaveBeenCalledOnce()
    expect(state.command).toHaveBeenCalledWith('busy-runtime', { type: 'follow_up', message: 'Queue this' })
    expect(state.queuePrompt).not.toHaveBeenCalled()
    expect(state.messages()).toEqual([])
  })

  it('delivers busy images through the same follow_up command as text', async () => {
    const busy = runtime()
    const state = fixture({ attachedRuntime: busy, listedRuntimes: [busy] })

    await state.actions.sendPrompt('Queue this', [image])

    expect(state.command).toHaveBeenCalledOnce()
    expect(state.command).toHaveBeenCalledWith('busy-runtime', { type: 'follow_up', message: 'Queue this', images: [image] })
    expect(state.queuePrompt).not.toHaveBeenCalled()
    expect(state.messages()).toEqual([])
  })

  it('keeps steers on the steer command with their pending row', async () => {
    const busy = runtime()
    const state = fixture({ attachedRuntime: busy, listedRuntimes: [busy] })

    await state.actions.sendPrompt('Steer this', [], 'steer')

    expect(state.command).toHaveBeenCalledWith('busy-runtime', expect.objectContaining({ type: 'steer', message: 'Steer this' }))
    expect(state.command).not.toHaveBeenCalledWith('busy-runtime', expect.objectContaining({ type: 'follow_up' }))
    expect(state.queuePrompt).toHaveBeenCalledWith('Steer this', 'steer', expect.any(Array), expect.any(Number))
  })

  it('keeps compacts and slash commands deferred in the local queue while busy', async () => {
    const busy = runtime()
    const state = fixture({ attachedRuntime: busy, listedRuntimes: [busy] })

    await state.actions.sendPrompt('/compact')
    await state.actions.sendPrompt('/model auto')

    expect(state.command).not.toHaveBeenCalled()
    expect(state.queuePrompt).toHaveBeenCalledWith('/compact', 'queue')
    expect(state.queuePrompt).toHaveBeenCalledWith('/model auto', 'queue')
  })

  it('answers read-only slash queries from the runtime snapshot without queueing or an RPC', async () => {
    const busy: RuntimeInfo = {
      ...runtime(),
      model: { provider: 'anthropic', id: 'opus', name: 'Claude Opus' },
      thinkingLevel: 'high',
      contextUsage: { tokens: 151_000, contextWindow: 200_000, percent: 75 },
      sessionUsage: { cost: 0.42, tokens: { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1_500 } },
    }
    const state = fixture({ attachedRuntime: busy, listedRuntimes: [busy] })

    await state.actions.sendPrompt('/status')
    await state.actions.sendPrompt('/context')
    await state.actions.sendPrompt('/usage')

    // 不排隊、不打 RPC:系統訊息直接以 runtime 快照呈現
    expect(state.command).not.toHaveBeenCalled()
    expect(state.queuePrompt).not.toHaveBeenCalled()
    const texts = state.messages().filter((message) => message.role === 'system').map((message) => message.parts.map((part) => part.type === 'text' ? part.text : '').join(''))
    expect(texts).toHaveLength(3)
    expect(texts[0]).toContain('Model: Claude Opus')
    expect(texts[0]).toContain('State: busy')
    expect(texts[1]).toBe('Context: 151,000 / 200,000 tokens (75%)')
    expect(texts[2]).toBe('Usage this session: $0.42 · 1,000 in / 500 out / 0 cached')
  })

  it('answers read-only slash queries immediately for steer intent too', async () => {
    const busy = runtime()
    const state = fixture({ attachedRuntime: busy, listedRuntimes: [busy] })

    await state.actions.sendPrompt('/model', [], 'steer')

    expect(state.command).not.toHaveBeenCalled()
    expect(state.queuePrompt).not.toHaveBeenCalled()
    expect(state.messages().filter((message) => message.role === 'system')).toHaveLength(1)
  })

  it('still queues read-only queries whose data is not in the runtime snapshot', async () => {
    const busy = runtime()
    const state = fixture({ attachedRuntime: busy, listedRuntimes: [busy] })

    // /tools、/jobs、/todo 的資料不在 runtime 快照內,上游 busy 語意未查證 → 保守排隊
    await state.actions.sendPrompt('/tools')
    await state.actions.sendPrompt('/todo')

    expect(state.command).not.toHaveBeenCalled()
    expect(state.queuePrompt).toHaveBeenCalledWith('/tools', 'queue')
    expect(state.queuePrompt).toHaveBeenCalledWith('/todo', 'queue')
    expect(state.messages().filter((message) => message.role === 'system')).toHaveLength(0)
  })

  it('answers /status locally even while idle, since upstream has no text handler', async () => {
    const state = fixture({})

    await state.actions.sendPrompt('/status')

    expect(state.command).not.toHaveBeenCalled()
    expect(state.queuePrompt).not.toHaveBeenCalled()
    expect(state.start).not.toHaveBeenCalled()
    const texts = state.messages().filter((message) => message.role === 'system').map((message) => message.parts.map((part) => part.type === 'text' ? part.text : '').join(''))
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('Session: /busy-project/session.jsonl')
  })

  it('applies the session action snapshot returned with a follow_up', async () => {
    const busy = runtime()
    const state = fixture({ attachedRuntime: busy, listedRuntimes: [busy] })
    state.command.mockResolvedValueOnce({ sessionActions: { queuedCount: 1, steering: [], followUps: ['Queue this'] } })

    await state.actions.sendPrompt('Queue this')

    expect(state.runtimeState()).toMatchObject({
      runtimeId: 'busy-runtime',
      sessionActions: { queuedCount: 1, followUps: ['Queue this'] },
    })
  })

  it('surfaces a failed busy follow-up without settling streaming state or replaying it', async () => {
    const busy = runtime()
    const state = fixture({ attachedRuntime: busy, listedRuntimes: [busy] })
    state.command.mockRejectedValueOnce(new Error('follow-up rejected'))

    await expect(state.actions.sendPrompt('Queue this')).rejects.toThrow('follow-up rejected')

    expect(state.command).toHaveBeenCalledOnce()
    expect(state.queuePrompt).not.toHaveBeenCalled()
    expect(state.runtimeState()).toMatchObject({ runtimeId: 'busy-runtime', isStreaming: true })
    expect(state.messages().filter((message) => message.role === 'system')).toHaveLength(1)
    expect(state.reportError).toHaveBeenCalledOnce()
  })

  it('marks a failed queue flush for retry without duplicating the optimistic row', async () => {
    const busy = runtime()
    const state = fixture({ attachedRuntime: busy, listedRuntimes: [busy] })
    state.command.mockRejectedValueOnce(new Error('flush rejected'))

    await expect(state.actions.sendPrompt('Flush this', [], 'queue', 'queued-flush')).rejects.toThrow('flush rejected')

    expect(state.command).toHaveBeenCalledWith('busy-runtime', expect.objectContaining({ type: 'follow_up', message: 'Flush this' }))
    expect(state.workspace.markQueuedPromptFlushFailed).toHaveBeenCalledWith('queued-flush')
    expect(state.messages()).toEqual([])
  })

  it('flushes a restored queue entry together with its attachments', async () => {
    const busy = runtime()
    const state = fixture({ attachedRuntime: busy, listedRuntimes: [busy] })
    state.workspace.pendingQueuedPrompts = [{
      id: 'queued-restore',
      text: 'Restored with an image',
      intent: 'queue',
      timestamp: 1,
      recovered: true,
      parts: [{ type: 'text', text: 'Restored with an image' }, image],
    }]

    await state.actions.sendPrompt('Restored with an image', [], 'queue', 'queued-restore')

    expect(state.command).toHaveBeenCalledWith('busy-runtime', {
      type: 'follow_up',
      message: 'Restored with an image',
      images: [image],
    })
    expect(state.workspace.removeQueuedPrompt).toHaveBeenCalledWith('queued-restore')
  })

  it('delivers a follow_up when agent.list reveals a busy runtime after an optimistic append', async () => {
    const busy = runtime()
    const state = fixture({ listedRuntimes: [busy] })

    await state.actions.sendPrompt('Queue this')

    expect(state.command).toHaveBeenCalledOnce()
    expect(state.command).toHaveBeenCalledWith('busy-runtime', expect.objectContaining({ type: 'follow_up', message: 'Queue this' }))
    expect(state.queuePrompt).not.toHaveBeenCalled()
    expect(state.start).not.toHaveBeenCalled()
    expect(state.messages()).toEqual([])
  })

  it('keeps input in the local queue when the session runs outside OMP Desktop', async () => {
    const state = fixture({ sessionStatus: 'running' })

    await state.actions.sendPrompt('Queue this')

    expect(state.command).not.toHaveBeenCalled()
    expect(state.queuePrompt).toHaveBeenCalledWith('Queue this', 'queue')
  })
})
