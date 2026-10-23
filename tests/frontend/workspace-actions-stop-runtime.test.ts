import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import type { DesktopApi, RuntimeInfo, TranscriptMessage } from '../../src/types/api'
import { createSingleFlightAdmission } from '../../src/lib/workspace'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const runtime = (runtimeId: string, isStreaming = true): RuntimeInfo => ({
  runtimeId,
  harness: 'omp',
  cwd: '/project',
  sessionFile: `/sessions/${runtimeId}.jsonl`,
  isStreaming,
})

const transcript = (id: string, streaming = true): TranscriptMessage => ({
  id,
  role: 'assistant',
  timestamp: 1,
  streaming,
  parts: [{ type: 'text', text: id }],
})

function stopRuntimeFixture(command: ReturnType<typeof deferred<unknown>>) {
  let currentRuntime: RuntimeInfo | null = runtime('runtime-a')
  let currentMessages = [transcript('message-a')]
  const workspaceRef = { current: { generation: 1 } }
  const runtimeIdRef = { current: 'runtime-a' as string | null }
  const runtimeOwnerRef = { current: { runtimeId: 'runtime-a', generation: 1 } as { runtimeId: string; generation: number } | null }
  const reportError = vi.fn()
  const agentCommand = vi.fn(() => command.promise)
  const workspace = {
    get runtime() { return currentRuntime },
    workspaceRef,
    runtimeIdRef,
    runtimeOwnerRef,
    setRuntime(update: RuntimeInfo | null | ((current: RuntimeInfo | null) => RuntimeInfo | null)) {
      currentRuntime = typeof update === 'function' ? update(currentRuntime) : update
    },
    setMessages(update: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) {
      currentMessages = typeof update === 'function' ? update(currentMessages) : update
    },
  }
  const actions = createWorkspaceActions(() => ({
    bridge: { agent: { command: agentCommand } } as unknown as DesktopApi,
    workspace,
    reportError,
  } as unknown as WorkspaceActionsDeps))

  return {
    actions,
    agentCommand,
    reportError,
    runtime: () => currentRuntime,
    messages: () => currentMessages,
    setOwner(owner: { runtimeId: string; generation: number } | null) {
      runtimeOwnerRef.current = owner
    },
    replaceWorkspace(nextRuntime: RuntimeInfo, messages: TranscriptMessage[], generation: number) {
      currentRuntime = nextRuntime
      currentMessages = messages
      workspaceRef.current = { generation }
      runtimeIdRef.current = nextRuntime.runtimeId
      runtimeOwnerRef.current = { runtimeId: nextRuntime.runtimeId, generation }
    },
  }
}

describe('workspace runtime abort ownership', () => {
  it('leaves a navigated workspace runtime and transcript unchanged when the previous abort resolves', async () => {
    const command = deferred<unknown>()
    const fixture = stopRuntimeFixture(command)
    const stopping = fixture.actions.stopRuntime()
    expect(fixture.agentCommand).toHaveBeenCalledWith('runtime-a', { type: 'abort' })

    const runtimeB = runtime('runtime-b')
    const messagesB = [transcript('message-b')]
    fixture.replaceWorkspace(runtimeB, messagesB, 2)
    command.resolve({})
    await stopping

    expect(fixture.runtime()).toBe(runtimeB)
    expect(fixture.messages()).toBe(messagesB)
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-b', isStreaming: true })
    expect(fixture.messages()).toMatchObject([{ id: 'message-b', streaming: true }])
  })

  it('leaves a same-generation replacement runtime and transcript unchanged', async () => {
    const command = deferred<unknown>()
    const fixture = stopRuntimeFixture(command)
    const stopping = fixture.actions.stopRuntime()

    const replacement = runtime('runtime-replacement')
    const replacementMessages = [transcript('replacement-message')]
    fixture.replaceWorkspace(replacement, replacementMessages, 1)
    command.resolve({})
    await stopping

    expect(fixture.runtime()).toBe(replacement)
    expect(fixture.messages()).toBe(replacementMessages)
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-replacement', isStreaming: true })
    expect(fixture.messages()).toMatchObject([{ id: 'replacement-message', streaming: true }])
  })

  it('rejects an earlier-generation completion when the runtime ID is reused', async () => {
    const command = deferred<unknown>()
    const fixture = stopRuntimeFixture(command)
    const stopping = fixture.actions.stopRuntime()

    const reattachedRuntime = runtime('runtime-a')
    const reattachedMessages = [transcript('reattached-message')]
    fixture.replaceWorkspace(reattachedRuntime, reattachedMessages, 2)
    command.resolve({})
    await stopping

    expect(fixture.runtime()).toBe(reattachedRuntime)
    expect(fixture.messages()).toBe(reattachedMessages)
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-a', isStreaming: true })
    expect(fixture.messages()).toMatchObject([{ id: 'reattached-message', streaming: true }])
  })

  it.each([
    { label: 'cleared', owner: null },
    { label: 'mismatched', owner: { runtimeId: 'runtime-other', generation: 1 } },
  ])('leaves current state unchanged when its runtime owner is $label', async ({ owner }) => {
    const command = deferred<unknown>()
    const fixture = stopRuntimeFixture(command)
    const stopping = fixture.actions.stopRuntime()
    const ownedRuntime = fixture.runtime()
    const ownedMessages = fixture.messages()

    fixture.setOwner(owner)
    command.resolve({})
    await stopping

    expect(fixture.runtime()).toBe(ownedRuntime)
    expect(fixture.messages()).toBe(ownedMessages)
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-a', isStreaming: true })
    expect(fixture.messages()).toMatchObject([{ id: 'message-a', streaming: true }])
  })

  it('settles the captured runtime and its transcript when ownership remains current', async () => {
    const command = deferred<unknown>()
    const fixture = stopRuntimeFixture(command)
    const stopping = fixture.actions.stopRuntime()

    command.resolve({})
    await stopping

    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-a', isStreaming: false })
    expect(fixture.messages()).toMatchObject([{ id: 'message-a', streaming: false }])
    expect(fixture.reportError).not.toHaveBeenCalled()
  })

  it('reports an abort rejection without mutating an unrelated replacement', async () => {
    const command = deferred<unknown>()
    const fixture = stopRuntimeFixture(command)
    const stopping = fixture.actions.stopRuntime()

    const replacement = runtime('runtime-b')
    const replacementMessages = [transcript('message-b')]
    fixture.replaceWorkspace(replacement, replacementMessages, 2)
    const failure = new Error('abort failed')
    command.reject(failure)
    await stopping

    expect(fixture.reportError).toHaveBeenCalledOnce()
    expect(fixture.reportError).toHaveBeenCalledWith(failure)
    expect(fixture.runtime()).toBe(replacement)
    expect(fixture.messages()).toBe(replacementMessages)
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-b', isStreaming: true })
    expect(fixture.messages()).toMatchObject([{ id: 'message-b', streaming: true }])
  })
})

describe('workspace MCP command policy', () => {
  it('does not forward omp remote-auth commands to the harness', async () => {
    const agentStart = vi.fn()
    const agentCommand = vi.fn()
    const setToast = vi.fn()
    const actions = createWorkspaceActions(() => ({
      bridge: { agent: { start: agentStart, command: agentCommand } },
      sessions: [],
      workspace: { workspaceRef: { current: { project: { harness: 'omp' as const } } } },
      provider: {},
      settingsState: { settings: { activeHarness: 'omp' as const } },
      setToast,
    } as unknown as WorkspaceActionsDeps))

    await actions.sendPrompt('/mcp reauth docs')
    await actions.sendPrompt('/mcp reauth docs', [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }])

    expect(agentStart).not.toHaveBeenCalled()
    expect(agentCommand).not.toHaveBeenCalled()
    expect(setToast).toHaveBeenCalledWith('Network MCP authentication is managed outside OMP Desktop. Use OMP directly to sign in to docs.')
  })
})

describe('idle prompt streaming behavior', () => {
  const project = {
    id: 'idle-project',
    harness: 'omp' as const,
    name: 'Idle project',
    path: '/idle-project',
    folders: ['/idle-project'],
    primaryFolder: '/idle-project',
    pinned: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
    sessionCount: 1,
  }
  const session = {
    id: 'idle-session',
    harness: 'omp' as const,
    filePath: '/idle-project/session.jsonl',
    projectPath: '/idle-project',
    title: 'Idle session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'idle' as const,
    depth: 0,
  }

  it.each([
    ['queue', 'followUp'],
    ['steer', 'steer'],
  ] as const)('maps %s on an idle snapshot to %s', async (intent, streamingBehavior) => {
    const command = vi.fn(async () => ({}))
    let messages: TranscriptMessage[] = []
    let currentRuntime: RuntimeInfo | null = null
    const runtime = {
      runtimeId: 'idle-runtime',
      harness: 'omp' as const,
      cwd: project.primaryFolder,
      sessionFile: session.filePath,
      isStreaming: false,
    }
    const workspaceRef = { current: { generation: 1, project, session, cwd: project.primaryFolder, sessionFile: session.filePath } }
    const workspace = {
      workspaceRef,
      runtime: currentRuntime,
      runtimeIdRef: { current: null },
      runtimeOwnerRef: { current: null },
      prepareForPrompt: () => true,
      attachRuntime: (next: RuntimeInfo | undefined) => { currentRuntime = next ?? null },
      setRuntime: (next: RuntimeInfo | ((current: RuntimeInfo | null) => RuntimeInfo | null)) => {
        currentRuntime = typeof next === 'function' ? next(currentRuntime) : next
      },
      setMessages: (next: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) => {
        messages = typeof next === 'function' ? next(messages) : next
      },
      queuePrompt: vi.fn(),
      removeQueuedPrompt: vi.fn(),
      retractQueuedPrompt: vi.fn(),
      markQueuedPromptFlushFailed: vi.fn(),
    }
    const actions = createWorkspaceActions(() => ({
      bridge: {
        agent: {
          list: vi.fn(async () => [runtime]),
          command,
          start: vi.fn(),
        },
      },
      projects: [project],
      sessions: [session],
      activeProject: project,
      workspace,
      settingsState: { settings: { activeHarness: 'omp' } },
      provider: { model: 'auto', effort: 'medium', fast: false },
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
      setToast: vi.fn(),
      setSubmitting: vi.fn(),
      refreshSchedules: vi.fn(),
      resetBrowserView: vi.fn(),
      closeTerminalForSession: vi.fn(),
      clearSessionAttention: vi.fn(),
      reportError: vi.fn(),
    } as unknown as WorkspaceActionsDeps))

    await actions.sendPrompt(`idle ${intent}`, [], intent)

    expect(command).toHaveBeenCalledOnce()
    expect(command).toHaveBeenCalledWith('idle-runtime', {
      type: 'prompt',
      message: `idle ${intent}`,
      streamingBehavior,
    })
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
  })

  it('rolls back the optimistic row on a failed flush and does not duplicate it on retry', async () => {
    let messages: TranscriptMessage[] = []
    let currentRuntime: RuntimeInfo | null = null
    let flushFailed = false
    const startedRuntime = { ...runtime('flush-runtime', false), cwd: project.primaryFolder, sessionFile: session.filePath }
    const command = vi.fn()
      .mockRejectedValueOnce(new Error('admission failed'))
      .mockResolvedValueOnce({})
    const workspace = {
      workspaceRef: { current: { generation: 1, project, session, cwd: project.primaryFolder, sessionFile: session.filePath } },
      runtime: currentRuntime,
      runtimeIdRef: { current: null as string | null },
      runtimeOwnerRef: { current: null as { runtimeId: string; generation: number } | null },
      prepareForPrompt: () => true,
      attachRuntime: (next: RuntimeInfo | undefined) => { currentRuntime = next ?? null },
      setRuntime: (next: RuntimeInfo | ((current: RuntimeInfo | null) => RuntimeInfo | null)) => {
        currentRuntime = typeof next === 'function' ? next(currentRuntime) : next
      },
      setMessages: (next: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) => {
        messages = typeof next === 'function' ? next(messages) : next
      },
      queuePrompt: vi.fn(),
      removeQueuedPrompt: vi.fn(),
      retractQueuedPrompt: vi.fn(),
      markQueuedPromptFlushFailed: vi.fn(() => { flushFailed = true }),
    }
    const actions = createWorkspaceActions(() => ({
      bridge: {
        agent: {
          list: vi.fn(async () => [startedRuntime]),
          start: vi.fn(async () => startedRuntime),
          command,
          stop: vi.fn(async () => false),
        },
        sessions: { list: vi.fn(async () => [session]) },
      },
      projects: [project],
      sessions: [session],
      activeProject: project,
      workspace,
      settingsState: { settings: { activeHarness: 'omp' } },
      provider: { model: 'auto', effort: 'medium', fast: false },
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
      setToast: vi.fn(),
      setSubmitting: vi.fn(),
      refreshSchedules: vi.fn(),
      resetBrowserView: vi.fn(),
      closeTerminalForSession: vi.fn(),
      clearSessionAttention: vi.fn(),
      reportError: vi.fn(),
    } as unknown as WorkspaceActionsDeps))

    await expect(actions.sendPrompt('flush this', [], 'queue', 'queued-flush')).rejects.toThrow('admission failed')
    expect(flushFailed).toBe(true)
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(0)
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1)

    await actions.sendPrompt('flush this', [], 'queue', 'queued-flush')
    expect(command).toHaveBeenCalledTimes(2)
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
  })
})
