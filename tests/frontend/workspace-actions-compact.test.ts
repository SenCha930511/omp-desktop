import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import { createSingleFlightAdmission } from '../../src/lib/workspace'
import type { DesktopApi, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'

const project = {
  id: 'compact-project',
  harness: 'omp' as const,
  name: 'Compact project',
  path: '/compact-project',
  folders: ['/compact-project'],
  primaryFolder: '/compact-project',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 1,
}

const session = (status: SessionRecord['status'] = 'idle'): SessionRecord => ({
  id: 'compact-session',
  harness: 'omp',
  filePath: '/compact-project/session.jsonl',
  projectPath: '/compact-project',
  title: 'Compact session',
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
  runtime?: RuntimeInfo | null
  sessionStatus?: SessionRecord['status']
  ownsStreaming?: boolean
  withSession?: boolean
}

function fixture({ runtime: configuredRuntime = null, sessionStatus = 'idle', ownsStreaming = false, withSession = true }: FixtureOptions = {}) {
  let currentRuntime = configuredRuntime
  let messages: TranscriptMessage[] = []
  const currentSession = withSession ? session(sessionStatus) : undefined
  const workspaceRef = {
    current: {
      generation: 1,
      project,
      session: currentSession,
      cwd: project.primaryFolder,
      sessionFile: currentSession?.filePath,
    },
  }
  const runtimeIdRef = { current: ownsStreaming && configuredRuntime ? configuredRuntime.runtimeId : null as string | null }
  const runtimeOwnerRef = {
    current: ownsStreaming && configuredRuntime
      ? { runtimeId: configuredRuntime.runtimeId, generation: 1 }
      : null as { runtimeId: string; generation: number } | null,
  }
  const command = vi.fn(async () => ({}))
  const start = vi.fn(async () => runtime('started-runtime'))
  const followUp = vi.fn(async () => true)
  const queuePrompt = vi.fn()
  const setToast = vi.fn()
  const reportError = vi.fn()
  const onCommandStart = vi.fn()
  const onCommandFinish = vi.fn()
  const workspace = {
    runtime: currentRuntime,
    workspaceRef,
    runtimeIdRef,
    runtimeOwnerRef,
    prepareForPrompt: () => true,
    adoptSessionId: (next: SessionRecord) => {
      workspaceRef.current = { ...workspaceRef.current, session: next, sessionFile: next.filePath }
    },
    attachRuntime: (next: RuntimeInfo | undefined) => { currentRuntime = next ?? null },
    setRuntime: (next: RuntimeInfo | ((current: RuntimeInfo | null) => RuntimeInfo | null)) => {
      currentRuntime = typeof next === 'function' ? next(currentRuntime) : next
    },
    setMessages: (next: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) => {
      messages = typeof next === 'function' ? next(messages) : next
    },
    queuePrompt,
    removeQueuedPrompt: vi.fn(),
    markQueuedPromptFlushFailed: vi.fn(),
  }
  const agentList = vi.fn(async () => configuredRuntime ? [configuredRuntime] : [])
  const bridge = {
    agent: { list: agentList, command, start, stop: vi.fn(async () => false) },
    sessions: { followUp, list: vi.fn(async () => [session()]) },
  } as unknown as DesktopApi
  const workspaceSessions = currentSession ? [currentSession] : []
  const actions = createWorkspaceActions(() => ({
    bridge,
    projects: [project],
    sessions: workspaceSessions,
    activeProject: project,
    workspace,
    settingsState: { settings: { activeHarness: 'omp', locale: 'en' } },
    provider: { model: 'auto', effort: 'medium', fast: false, selectedModel: { input: ['text', 'image'] } },
    submissionAdmissionRef: { current: createSingleFlightAdmission() },
    initialized: true,
    layout: {},
    pluginSkills: {},
    gitRequestRef: { current: 0 },
    demoTimerRef: { current: [] },
    setProjects: vi.fn(),
    setSessions: vi.fn(),
    setGitSnapshot: vi.fn(),
    setView: vi.fn(),
    setPaletteOpen: vi.fn(),
    setToast,
    setSubmitting: vi.fn(),
    refreshSchedules: vi.fn(),
    resetBrowserView: vi.fn(),
    closeTerminalForSession: vi.fn(),
    clearSessionAttention: vi.fn(),
    reportError,
    onCommandStart,
    onCommandFinish,
  } as unknown as WorkspaceActionsDeps))

  return { actions, command, start, followUp, queuePrompt, setToast, reportError, onCommandStart, onCommandFinish, messages: () => messages, runtime: () => currentRuntime }
}

describe('/compact dispatch', () => {
  it('shows a fresh turn while runtime startup is pending and reuses its placeholder', async () => {
    const state = fixture({ withSession: false })
    let finishStart!: (value: RuntimeInfo) => void
    state.start.mockImplementationOnce(() => new Promise<RuntimeInfo>((resolve) => { finishStart = resolve }))
    const sending = state.actions.sendPrompt('Start a new conversation')
    await vi.waitFor(() => expect(state.start).toHaveBeenCalled())
    expect(state.messages().map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(state.messages()[1]).toMatchObject({ streaming: true, parts: [] })
    const placeholderId = state.messages()[1].id
    finishStart(runtime('started-runtime'))
    await sending
    expect(state.messages().filter((message) => message.role === 'assistant').map((message) => message.id)).toEqual([placeholderId])
  })

  it('clears the startup animation and shows an error if a new runtime fails', async () => {
    const state = fixture({ withSession: false })
    state.start.mockRejectedValueOnce(new Error('Runtime could not start'))
    await expect(state.actions.sendPrompt('Start a new conversation')).rejects.toThrow('Runtime could not start')
    expect(state.messages().some((message) => message.streaming)).toBe(false)
    expect(state.messages().map((message) => message.role)).toEqual(['user', 'system'])
  })

  it('finishes text-only slash commands without leaving a streaming placeholder', async () => {
    const state = fixture({ runtime: runtime() })
    state.command.mockResolvedValue({ data: { agentInvoked: false } })
    await state.actions.sendPrompt('/context')
    expect(state.command).toHaveBeenCalledWith('idle-runtime', expect.objectContaining({ type: 'prompt', message: '/context' }))
    expect(state.messages().some((message) => message.streaming)).toBe(false)
    expect(state.messages().filter((message) => message.role === 'assistant')).toEqual([])
    expect(state.messages()).toEqual([])
    expect(state.onCommandStart).toHaveBeenCalledWith('/context')
    expect(state.onCommandFinish).toHaveBeenCalledWith(undefined, false)
  })

  it('never flashes the working state for local-only slash commands even without an admission flag', async () => {
    const state = fixture({ runtime: runtime() })
    state.command.mockResolvedValue({ data: {} })
    await state.actions.sendPrompt('/context')
    expect(state.runtime()?.isStreaming).toBe(false)
    expect(state.messages().some((message) => message.streaming)).toBe(false)
    expect(state.messages().filter((message) => message.role === 'assistant')).toEqual([])
    expect(state.onCommandFinish).toHaveBeenCalledWith(undefined, true)
  })

  it('reports command errors in the output panel without adding an assistant error turn', async () => {
    const state = fixture({ runtime: runtime() })
    state.command.mockRejectedValueOnce(new Error('Command failed'))
    await expect(state.actions.sendPrompt('/context')).rejects.toThrow('Command failed')
    expect(state.onCommandFinish).toHaveBeenCalledWith('Request failed: Command failed')
    expect(state.messages().filter((message) => message.role === 'assistant' || message.role === 'system')).toEqual([])
  })

  it('queues slash commands instead of steering them into the model', async () => {
    const state = fixture({ runtime: runtime('busy', true), ownsStreaming: true })
    await state.actions.sendPrompt('/effort high', [], 'steer')
    expect(state.command).not.toHaveBeenCalled()
    expect(state.queuePrompt).toHaveBeenCalledWith('/effort high', 'queue')
  })

  it('rejects deferred displays without forwarding them', async () => {
    const state = fixture({ runtime: runtime() })
    await expect(state.actions.sendPrompt('/theme')).rejects.toThrow('terminal selector')
    expect(state.command).not.toHaveBeenCalled()
  })
  it('sends compact to an idle runtime without a prompt command or user message', async () => {
    const fixtureState = fixture({ runtime: runtime() })

    await fixtureState.actions.sendPrompt('/compact')

    expect(fixtureState.command).toHaveBeenCalledOnce()
    expect(fixtureState.command).toHaveBeenCalledWith('idle-runtime', { type: 'compact' })
    expect(fixtureState.command).not.toHaveBeenCalledWith('idle-runtime', expect.objectContaining({ type: 'prompt' }))
    expect(fixtureState.messages().filter((message) => message.role === 'user')).toHaveLength(0)
  })

  it('passes custom instructions to compact', async () => {
    const fixtureState = fixture({ runtime: runtime() })

    await fixtureState.actions.sendPrompt('/compact focus on auth')

    expect(fixtureState.command).toHaveBeenCalledWith('idle-runtime', { type: 'compact', customInstructions: 'focus on auth' })
  })

  it('queues compact for an owned streaming runtime', async () => {
    const fixtureState = fixture({ runtime: runtime('streaming-runtime', true), ownsStreaming: true })

    await fixtureState.actions.sendPrompt('/compact', [], 'steer')

    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.queuePrompt).toHaveBeenCalledWith('/compact', 'queue')
    expect(fixtureState.setToast).toHaveBeenCalledWith('Compaction will run when the current turn finishes.')
  })

  it('does not start a runtime when there is nothing to compact', async () => {
    const fixtureState = fixture({ withSession: false })

    await fixtureState.actions.sendPrompt('/compact')

    expect(fixtureState.start).not.toHaveBeenCalled()
    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.setToast).toHaveBeenCalledWith('Nothing to compact yet.')
  })

  it('does not follow up an externally running session', async () => {
    const fixtureState = fixture({ sessionStatus: 'running' })

    await fixtureState.actions.sendPrompt('/compact')

    expect(fixtureState.followUp).not.toHaveBeenCalled()
    expect(fixtureState.start).not.toHaveBeenCalled()
    expect(fixtureState.setToast).toHaveBeenCalledWith('Compaction is unavailable while this session is running outside OMP Desktop.')
  })

  it('rejects image attachments', async () => {
    const fixtureState = fixture({ runtime: runtime() })

    await fixtureState.actions.sendPrompt('/compact', [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }])

    expect(fixtureState.reportError).toHaveBeenCalledWith('/compact does not accept attachments. Remove the attachment and try again.')
    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.start).not.toHaveBeenCalled()
  })

  it('queues compact for a non-owned streaming runtime instead of steering it', async () => {
    const fixtureState = fixture({ runtime: runtime('external-streaming-runtime', true) })

    await fixtureState.actions.sendPrompt('/compact', [], 'steer')

    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.followUp).not.toHaveBeenCalled()
    expect(fixtureState.queuePrompt).toHaveBeenCalledWith('/compact', 'queue')
    expect(fixtureState.setToast).toHaveBeenCalledWith('Compaction will run when the current turn finishes.')
  })

  it('routes uppercase mode compacts to the upstream slash dispatcher instead of custom instructions', async () => {
    // 上游 compact 模式不分大小寫(Yke):/compact SOFT 须視為模式命令,
    // 原样交給 prompt 路径,不能当 custom instructions 走 compact RPC。
    for (const prompt of ['/compact soft', '/compact SOFT', '/compact Soft keep the auth bits', '/compact REMOTE']) {
      const fixtureState = fixture({ runtime: runtime() })

      await fixtureState.actions.sendPrompt(prompt)

      expect(fixtureState.command).toHaveBeenCalledWith('idle-runtime', expect.objectContaining({ type: 'prompt', message: prompt }))
      expect(fixtureState.command).not.toHaveBeenCalledWith('idle-runtime', expect.objectContaining({ type: 'compact' }))
    }
  })

  it('rejects snapcompact focus instructions in place instead of starting a runtime for the error', async () => {
    // 上游 rejectsFocus:snapcompact 只做點陣圖歸檔,不接受指示;错过会起一
    // 个 runtime 只为回一句错误,在地稿栏直接拒絕。
    const fixtureState = fixture({ runtime: runtime() })

    await fixtureState.actions.sendPrompt('/compact snapcompact focus on tests')

    expect(fixtureState.reportError).toHaveBeenCalledWith('/compact snapcompact archives history onto bitmaps without an LLM summary and does not take focus instructions. Remove the instructions and try again.')
    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.start).not.toHaveBeenCalled()
  })

  it('forwards a skill command with its images to the agent', async () => {
    // 上游 runRpcSkillCommand 把图片并入 skill prompt;依 catalog(source
    // 'skill')放行的命令攜圖直送 prompt RPC,labels: 與上游一起排隊。
    const skillRuntime: RuntimeInfo = { ...runtime(), availableCommands: [{ name: 'commit', source: 'skill' }] }
    const fixtureState = fixture({ runtime: skillRuntime })
    const images = [{ type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgo=' }]

    await fixtureState.actions.sendPrompt('/commit make it good', images)

    expect(fixtureState.reportError).not.toHaveBeenCalled()
    expect(fixtureState.command).toHaveBeenCalledWith('idle-runtime', expect.objectContaining({ type: 'prompt', message: '/commit make it good', images }))
    expect(fixtureState.followUp).not.toHaveBeenCalled()
  })

  it('queues a busy skill command with its images in the local entry', async () => {
    // 忙碌时本地排隊:图片隨條目保存,flush 时原样恢復,不静默成纯文字。
    const skillRuntime: RuntimeInfo = { ...runtime('busy', true), availableCommands: [{ name: 'commit', source: 'skill' }] }
    const fixtureState = fixture({ runtime: skillRuntime, ownsStreaming: true })
    const images = [{ type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgo=' }]

    await fixtureState.actions.sendPrompt('/commit', images)

    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.queuePrompt).toHaveBeenCalledWith('/commit', 'queue', [{ type: 'text', text: '/commit' }, ...images])
  })

  it('still rejects images for slash commands outside the image-capable sources', async () => {
    // builtin/extension 上游本地消化会静默丟棄圖片;GUI 原地拒絕(Composer 层
    // 同样挡住,这里是 sendPrompt 防禦)。
    const builtinRuntime: RuntimeInfo = { ...runtime(), availableCommands: [{ name: 'context', source: 'builtin' }] }
    const fixtureState = fixture({ runtime: builtinRuntime })

    await fixtureState.actions.sendPrompt('/context', [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }])

    expect(fixtureState.reportError).toHaveBeenCalledWith('This command does not accept image attachments. Remove the attachment and try again.')
    expect(fixtureState.command).not.toHaveBeenCalled()
  })
})
