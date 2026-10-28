import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import { createSingleFlightAdmission } from '../../src/lib/workspace'
import type { DesktopApi, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'

const project = {
  id: 'gui-project',
  harness: 'omp' as const,
  name: 'GUI project',
  path: '/gui-project',
  folders: ['/gui-project'],
  primaryFolder: '/gui-project',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 1,
}

const session = (filePath = '/gui-project/session.jsonl'): SessionRecord => ({
  id: `gui-${filePath}`,
  harness: 'omp',
  filePath,
  projectPath: '/gui-project',
  title: 'GUI session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
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
  ownsStreaming?: boolean
  withSession?: boolean
}

function fixture({ runtime: configuredRuntime = null, ownsStreaming = false, withSession = true }: FixtureOptions = {}) {
  let messages: TranscriptMessage[] = []
  let generation = 1
  const currentSession = withSession ? session() : undefined
  const workspaceRef = {
    current: {
      generation,
      project,
      session: currentSession,
      cwd: project.primaryFolder,
      sessionFile: currentSession?.filePath,
    },
  }
  const runtimeIdRef = { current: ownsStreaming && configuredRuntime ? configuredRuntime.runtimeId : null as string | null }
  const runtimeOwnerRef = {
    current: ownsStreaming && configuredRuntime
      ? { runtimeId: configuredRuntime.runtimeId, generation }
      : null as { runtimeId: string; generation: number } | null,
  }
  const command = vi.fn(async (runtimeId: string, request: Record<string, unknown>) => {
    if (request.type === 'new_session') return { data: {} }
    if (request.type === 'get_state') return { data: { sessionId: 'new-session-id', sessionFile: '/gui-project/new-session.jsonl' } }
    return {}
  })
  const start = vi.fn(async () => runtime('started-runtime'))
  const branch = vi.fn(async (source: string) => session(source.replace('.jsonl', '-fork.jsonl')))
  const queuePrompt = vi.fn()
  const removeQueuedPrompt = vi.fn()
  const setToast = vi.fn()
  const reportError = vi.fn()
  const openSessionTree = vi.fn()
  const workspace = {
    runtime: configuredRuntime,
    workspaceRef,
    runtimeIdRef,
    runtimeOwnerRef,
    pendingQueuedPrompts: [] as unknown[],
    prepareForPrompt: () => true,
    activateWorkspace: (nextProject: unknown, nextSession?: SessionRecord) => {
      generation += 1
      workspaceRef.current = {
        generation,
        project: nextProject as typeof project,
        session: nextSession,
        cwd: project.primaryFolder,
        sessionFile: nextSession?.filePath,
      }
      return generation
    },
    adoptSessionId: (next: SessionRecord) => {
      workspaceRef.current = { ...workspaceRef.current, session: next, sessionFile: next.filePath }
    },
    attachRuntime: vi.fn(),
    setRuntime: vi.fn(),
    reconcileRuntime: vi.fn(async () => undefined),
    setMessages: (next: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) => {
      messages = typeof next === 'function' ? next(messages) : next
    },
    queuePrompt,
    removeQueuedPrompt,
    markQueuedPromptFlushFailed: vi.fn(),
  }
  const bridge = {
    agent: { list: vi.fn(async () => configuredRuntime ? [configuredRuntime] : []), command, start, stop: vi.fn(async () => false) },
    sessions: { branch, list: vi.fn(async () => [session('/gui-project/new-session.jsonl')]), followUp: vi.fn(async () => true) },
  } as unknown as DesktopApi
  const setView = vi.fn()
  const actions = createWorkspaceActions(() => ({
    bridge,
    projects: [project],
    sessions: withSession ? [currentSession!] : [],
    activeProject: project,
    workspace,
    settingsState: { settings: { activeHarness: 'omp', locale: 'en' } },
    provider: { model: 'auto', effort: 'medium', fast: false },
    submissionAdmissionRef: { current: createSingleFlightAdmission() },
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
    refreshSchedules: vi.fn(),
    resetBrowserView: vi.fn(),
    closeTerminalForSession: vi.fn(),
    clearSessionAttention: vi.fn(),
    bumpRecentSessionOpen: vi.fn(),
    reportError,
    openSessionTree,
  } as unknown as WorkspaceActionsDeps))

  return { actions, setView, command, start, branch, queuePrompt, removeQueuedPrompt, setToast, reportError, openSessionTree, messages: () => messages }
}

describe('GUI-entry slash dispatch', () => {
  it('opens the session tree dialog for /tree, /branch and /rewind without an RPC', async () => {
    for (const prompt of ['/tree', '/branch', '/rewind']) {
      const state = fixture({ runtime: runtime() })
      await state.actions.sendPrompt(prompt)
      expect(state.openSessionTree).toHaveBeenCalledOnce()
      expect(state.command).not.toHaveBeenCalled()
      expect(state.queuePrompt).not.toHaveBeenCalled()
      expect(state.messages()).toEqual([])
    }
  })

  it('opens the session tree dialog immediately when the runtime is busy (branch is busy-safe upstream)', async () => {
    const state = fixture({ runtime: runtime('busy-runtime', true), ownsStreaming: true })
    await state.actions.sendPrompt('/tree')
    expect(state.openSessionTree).toHaveBeenCalledOnce()
    expect(state.queuePrompt).not.toHaveBeenCalled()
  })

  it('routes /login and /logout to the provider accounts panel without any RPC', async () => {
    for (const prompt of ['/login', '/logout', '/login anthropic']) {
      const state = fixture({ runtime: runtime() })
      await state.actions.sendPrompt(prompt)
      expect(state.setView).toHaveBeenCalledWith('plugins')
      // 絕不送模型,也不排隊:帳號 RPC 由面板的按鈕操作送出。
      expect(state.command).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'prompt' }))
      expect(state.queuePrompt).not.toHaveBeenCalled()
      expect(state.messages()).toEqual([])
    }
  })

  it('dispatches /login immediately when the runtime is busy (auth RPCs are busy-safe upstream)', async () => {
    const state = fixture({ runtime: runtime('busy-runtime', true), ownsStreaming: true })
    await state.actions.sendPrompt('/login')
    expect(state.setView).toHaveBeenCalledWith('plugins')
    expect(state.queuePrompt).not.toHaveBeenCalled()
  })

  it('dispatches /new to the durable new-session boundary instead of a prompt', async () => {
    const state = fixture({ runtime: runtime() })
    await state.actions.sendPrompt('/new')
    expect(state.command).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'prompt' }))
    await vi.waitFor(() => expect(state.command).toHaveBeenCalledWith('started-runtime', { type: 'new_session' }))
    expect(state.start).toHaveBeenCalled()
    expect(state.openSessionTree).not.toHaveBeenCalled()
  })

  it('does not interrupt the running turn for /new', async () => {
    const state = fixture({ runtime: runtime('busy-runtime', true), ownsStreaming: true })
    await state.actions.sendPrompt('/new')
    expect(state.queuePrompt).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(state.command).toHaveBeenCalledWith('started-runtime', { type: 'new_session' }))
  })

  it('branches the current session for an idle /fork via the existing sidebar fork path', async () => {
    const state = fixture({ runtime: runtime() })
    await state.actions.sendPrompt('/fork')
    expect(state.branch).toHaveBeenCalledWith('/gui-project/session.jsonl')
    expect(state.command).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'prompt' }))
  })

  it('queues /fork until idle while a turn is running (upstream rejects fork on a busy session)', async () => {
    const state = fixture({ runtime: runtime('busy-runtime', true), ownsStreaming: true })
    await state.actions.sendPrompt('/fork')
    expect(state.queuePrompt).toHaveBeenCalledWith('/fork', 'queue')
    expect(state.branch).not.toHaveBeenCalled()
    expect(state.command).not.toHaveBeenCalled()
  })

  it('runs a queued /fork at flush time and clears its queue entry', async () => {
    const state = fixture({ runtime: runtime() })
    await state.actions.sendPrompt('/fork', [], 'queue', 'queued-fork-1')
    expect(state.branch).toHaveBeenCalledWith('/gui-project/session.jsonl')
    expect(state.removeQueuedPrompt).toHaveBeenCalledWith('queued-fork-1')
  })

  it('reports /fork without a session instead of forwarding it to the model', async () => {
    const state = fixture({ runtime: runtime(), withSession: false })
    await state.actions.sendPrompt('/fork')
    expect(state.branch).not.toHaveBeenCalled()
    expect(state.command).not.toHaveBeenCalled()
    expect(state.reportError).toHaveBeenCalledWith('Fork needs a session to copy — send a message to start one first.')
  })
})
