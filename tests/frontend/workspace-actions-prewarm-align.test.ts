// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import { createSingleFlightAdmission, type ComposerSelection } from '../../src/lib/workspace'
import type { DesktopApi, RuntimeInfo, SessionRecord } from '../../src/types/api'

const project = {
  id: 'prewarm-project',
  harness: 'omp' as const,
  name: 'Prewarm project',
  path: '/prewarm-project',
  folders: ['/prewarm-project'],
  primaryFolder: '/prewarm-project',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 1,
}

const session = (id = 'prewarm-session'): SessionRecord => ({
  id,
  harness: 'omp',
  filePath: `/prewarm-project/${id}.jsonl`,
  projectPath: '/prewarm-project',
  title: 'Prewarm session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
})

const runtime = (overrides: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  runtimeId: 'runtime-1',
  harness: 'omp',
  cwd: project.primaryFolder,
  sessionFile: session().filePath,
  isStreaming: false,
  model: { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' },
  thinkingLevel: 'low',
  ...overrides,
})

const selection = (overrides: Partial<ComposerSelection> = {}): ComposerSelection => ({
  model: 'openai-codex/gpt-5.6',
  effort: 'medium',
  fast: false,
  ...overrides,
})

interface PromptFixtureInput {
  listed?: RuntimeInfo[]
  started?: RuntimeInfo
  peekSelection?: () => ComposerSelection | null
  alignRuntime?: (value: RuntimeInfo) => Promise<RuntimeInfo>
}

function promptFixture({ listed = [], started = runtime(), peekSelection, alignRuntime }: PromptFixtureInput) {
  const order: string[] = []
  const workspaceRef = {
    current: {
      generation: 1,
      project,
      session: session(),
      cwd: project.primaryFolder,
      sessionFile: session().filePath,
    },
  }
  const attachRuntime = vi.fn()
  const agentMocks = {
    list: vi.fn(async () => listed),
    start: vi.fn(async () => { order.push('start'); return started }),
    command: vi.fn(async (_runtimeId: string, request: Record<string, unknown>) => { order.push(String(request.type)); return {} }),
    stop: vi.fn(async () => false),
  }
  const bridge = {
    agent: agentMocks,
    sessions: { list: vi.fn(async () => [session()]) },
  } as unknown as DesktopApi
  const provider = {
    model: selection().model,
    effort: selection().effort,
    fast: selection().fast,
    resolveSelection: vi.fn(async () => ({ model: selection().model, effort: selection().effort, fast: selection().fast })),
    ...(peekSelection ? { peekSelection } : {}),
    ...(alignRuntime ? { alignRuntime: vi.fn(async (value: RuntimeInfo) => { order.push('align'); return alignRuntime(value) }) } : {}),
  }
  const actions = createWorkspaceActions(
    () =>
      ({
        bridge,
        projects: [project],
        sessions: [session()],
        activeProject: project,
        workspace: {
          runtime: null,
          workspaceRef,
          runtimeIdRef: { current: null },
          runtimeOwnerRef: { current: null },
          prepareForPrompt: () => true,
          attachRuntime,
          setRuntime: vi.fn(),
          setMessages: vi.fn(),
          queuePrompt: vi.fn(),
          removeQueuedPrompt: vi.fn(),
          markQueuedPromptFlushFailed: vi.fn(),
          adoptSessionId: vi.fn(),
        },
        settingsState: { settings: { activeHarness: 'omp', locale: 'en' } },
        provider,
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
        clearSessionAttention: vi.fn(),
        bumpRecentSessionOpen: vi.fn(),
        reportError: vi.fn(),
      }) as unknown as WorkspaceActionsDeps,
  )
  return { actions, bridge, agentMocks, attachRuntime, provider, order, workspaceRef }
}

describe('first prompt alignment against a prewarmed runtime', () => {
  it('aligns the adopted runtime before the prompt and attaches the refreshed snapshot', async () => {
    const listed = runtime()
    const refreshed = runtime({
      model: { provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6' },
      thinkingLevel: 'medium',
    })
    const { actions, agentMocks, attachRuntime, provider, order } = promptFixture({
      listed: [listed],
      peekSelection: () => null,
      alignRuntime: async () => refreshed,
    })

    await actions.sendPrompt('first prompt')

    expect(provider.alignRuntime).toHaveBeenCalledExactlyOnceWith(listed)
    expect(agentMocks.command).toHaveBeenCalledExactlyOnceWith('runtime-1', expect.objectContaining({ type: 'prompt', message: 'first prompt' }))
    expect(order).toEqual(['align', 'prompt'])
    expect(attachRuntime).toHaveBeenCalledWith(refreshed, 1)
    expect(agentMocks.start).not.toHaveBeenCalled()
  })

  it('does not adopt an idle runtime that disagrees with the current selection', async () => {
    const listed = runtime()
    const started = runtime({
      runtimeId: 'runtime-2',
      model: { provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6' },
      thinkingLevel: 'medium',
    })
    const { actions, agentMocks, provider, attachRuntime } = promptFixture({
      listed: [listed],
      started,
      peekSelection: () => selection(),
    })

    await actions.sendPrompt('first prompt')

    expect(agentMocks.start).toHaveBeenCalledTimes(1)
    expect(agentMocks.start).toHaveBeenCalledWith(expect.objectContaining({ model: selection().model, thinking: selection().effort }))
    expect(provider.alignRuntime).toBeUndefined()
    expect(attachRuntime).toHaveBeenLastCalledWith(started, 1)
  })

  it('still adopts a streaming runtime that disagrees and never aligns it', async () => {
    const streaming = runtime({ isStreaming: true })
    const { actions, agentMocks, attachRuntime } = promptFixture({
      listed: [streaming],
      peekSelection: () => selection(),
      alignRuntime: async () => streaming,
    })

    await actions.sendPrompt('follow up')

    expect(agentMocks.start).not.toHaveBeenCalled()
    expect(agentMocks.command).toHaveBeenCalledExactlyOnceWith('runtime-1', expect.objectContaining({ type: 'follow_up', message: 'follow up' }))
    expect(attachRuntime).toHaveBeenCalledWith(streaming, 1)
  })

  it('stops before attaching and sending when the workspace switches during alignment', async () => {
    const listed = runtime()
    const { actions, agentMocks, attachRuntime, workspaceRef } = promptFixture({
      listed: [listed],
      peekSelection: () => null,
      alignRuntime: async () => {
        workspaceRef.current = { ...workspaceRef.current, generation: 2 }
        return runtime()
      },
    })

    await actions.sendPrompt('first prompt')

    expect(agentMocks.command).not.toHaveBeenCalled()
    expect(attachRuntime).not.toHaveBeenCalled()
  })

  it('aligns a runtime started on demand before sending the prompt', async () => {
    const started = runtime({ runtimeId: 'runtime-3' })
    const refreshed = runtime({
      runtimeId: 'runtime-3',
      model: { provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6' },
      thinkingLevel: 'medium',
    })
    const { actions, agentMocks, attachRuntime, order } = promptFixture({
      listed: [],
      started,
      peekSelection: () => null,
      alignRuntime: async () => refreshed,
    })

    await actions.sendPrompt('first prompt')

    expect(order).toEqual(['start', 'align', 'prompt'])
    expect(attachRuntime).toHaveBeenLastCalledWith(refreshed, 1)
    expect(agentMocks.command).toHaveBeenCalledExactlyOnceWith('runtime-3', expect.objectContaining({ type: 'prompt' }))
  })

  it('surfaces an alignment rejection instead of sending with the wrong model', async () => {
    const listed = runtime()
    const { actions, agentMocks, attachRuntime } = promptFixture({
      listed: [listed],
      peekSelection: () => null,
      alignRuntime: async () => { throw new Error('model rejected') },
    })

    await expect(actions.sendPrompt('first prompt')).rejects.toThrow('model rejected')

    expect(agentMocks.command).not.toHaveBeenCalled()
    expect(attachRuntime).not.toHaveBeenCalled()
  })
})
