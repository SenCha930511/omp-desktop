// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceRuntime } from '../../src/hooks/useWorkspaceRuntime'
import type { HarnessId, DesktopApi, ProjectRecord, SessionRecord, TranscriptMessage } from '../../src/types/api'

const project: ProjectRecord = {
  id: 'project', harness: 'omp', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const session: SessionRecord = {
  id: 'session', harness: 'omp', filePath: '/sessions/session.jsonl', projectPath: '/project', title: 'Session',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}

type Workspace = ReturnType<typeof useWorkspaceRuntime>
let latest: Workspace

// A module-level identity keeps startTranscriptRead's useCallback stable across
// renders; an inline arrow would re-fire the transcript effect every render.
const stableReportError = () => undefined

function Probe({
  bridge,
  harness = 'omp',
  initialProject = project,
  initialSession = session,
  sessions = [session],
}: {
  bridge: DesktopApi | null
  harness?: HarnessId
  initialProject?: ProjectRecord
  initialSession?: SessionRecord
  sessions?: SessionRecord[]
}) {
  latest = useWorkspaceRuntime({
    bridge,
    harness,
    initialProject,
    initialSession,
    sessions,
    initialMessages: [],
    reportError: stableReportError,
  })
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const flush = async () => { await act(async () => { await Promise.resolve() }) }

describe('prompt admission versus background transcript reads', () => {
  it('marks failed queued flushes across the active owner and clears them at a boundary', () => {
    act(() => { root.render(createElement(Probe, { bridge: null })) })
    act(() => { latest.queuePrompt('retry this prompt', 'queue') })
    const queuedId = latest.pendingQueuedPrompts[0].id
    act(() => { latest.markQueuedPromptFlushFailed(queuedId) })
    expect(latest.pendingQueuedPrompts).toMatchObject([{ id: queuedId, flushAttemptFailed: true }])
    act(() => { latest.clearQueuedPromptFlushFailures() })
    expect(latest.pendingQueuedPrompts).toMatchObject([{ id: queuedId }])
    expect(latest.pendingQueuedPrompts[0].flushAttemptFailed).toBeUndefined()
  })

  it('keeps queued prompts with their thread when navigating away and back', () => {
    const ompProject: ProjectRecord = {
      ...project,
      id: 'omp-project',
      harness: 'omp',
      path: '/omp-project',
      folders: ['/omp-project'],
      primaryFolder: '/omp-project',
    }
    const ompSession: SessionRecord = {
      ...session,
      id: 'omp-session',
      harness: 'omp',
      filePath: '/omp-sessions/session.jsonl',
      projectPath: '/omp-project',
    }
    const otherSession: SessionRecord = {
      ...ompSession,
      id: 'other-session',
      filePath: '/omp-sessions/other-session.jsonl',
      title: 'Other session',
    }
    act(() => { root.render(createElement(Probe, { bridge: null, initialProject: ompProject, initialSession: ompSession, sessions: [ompSession, otherSession] })) })

    act(() => { latest.queuePrompt('keep this OMP follow-up', 'queue') })
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['keep this OMP follow-up'])

    act(() => { latest.activateWorkspace(ompProject, otherSession) })
    expect(latest.pendingQueuedPrompts).toEqual([])
    act(() => { latest.queuePrompt('other thread follow-up', 'queue') })

    act(() => { latest.activateWorkspace(ompProject, ompSession) })
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['keep this OMP follow-up'])

    act(() => { latest.activateWorkspace(ompProject, otherSession) })
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['other thread follow-up'])
  })

  it('promotes an acknowledged omp steer into history while leaving true queued prompts pending', () => {
    let flushFrame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { flushFrame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    act(() => { root.render(createElement(Probe, { bridge: null })) })
    act(() => {
      latest.setMessages([{
        id: 'assistant-live', role: 'assistant', timestamp: 1, streaming: true,
        parts: [{ type: 'text', text: 'Working before the steer.' }],
      }])
      latest.queuePrompt('change direction', 'steer', [{ type: 'text', text: 'change direction' }], 2)
      latest.queuePrompt('do this next turn', 'queue')
    })

    act(() => { latest.reconcileQueuedPrompts({ queuedCount: 1, steering: ['change direction'], followUps: [] }) })
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.intent)).toEqual(['steer', 'queue'])

    act(() => {
      latest.reconcileQueuedPrompts({
        queuedCount: 0,
        steering: [],
        followUps: [],
        active: { kind: 'turn', phase: 'preparing', label: 'change direction' },
      })
      flushFrame?.(3)
    })

    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['do this next turn'])
    expect(latest.messages).toMatchObject([
      { id: 'assistant-live', role: 'assistant', streaming: false },
      { role: 'user', steerState: 'read', timestamp: 2, parts: [{ type: 'text', text: 'change direction' }] },
      { role: 'system', kind: 'steer-read-marker', parts: [{ type: 'text', text: 'Steer read here' }] },
    ])
  })

  it('removes a cancelled steer without promoting it into transcript history', () => {
    act(() => { root.render(createElement(Probe, { bridge: null })) })
    act(() => { latest.queuePrompt('cancel this steer', 'steer') })
    act(() => { latest.reconcileQueuedPrompts({ queuedCount: 1, steering: ['cancel this steer'], followUps: [] }) })
    act(() => { latest.reconcileQueuedPrompts({ queuedCount: 0, steering: [], followUps: [] }) })

    expect(latest.pendingQueuedPrompts).toEqual([])
    expect(latest.messages).toEqual([])
  })

  it('settles a steer picked up before its scheduler update reaches the renderer', () => {
    let flushFrame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { flushFrame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    act(() => { root.render(createElement(Probe, { bridge: null })) })
    act(() => {
      latest.setMessages([{ id: 'assistant-live', role: 'assistant', timestamp: 1, streaming: true, parts: [] }])
      const id = latest.queuePrompt('fast steer', 'steer', [{ type: 'text', text: 'fast steer' }], 2)
      latest.acknowledgeSteer(id, {
        queuedCount: 0,
        steering: [],
        followUps: [],
        active: { kind: 'turn', phase: 'running', label: 'fast steer' },
      })
      flushFrame?.(3)
    })

    expect(latest.pendingQueuedPrompts).toEqual([])
    expect(latest.messages).toMatchObject([
      { id: 'assistant-live', role: 'assistant', streaming: false },
      { role: 'user', steerState: 'read', timestamp: 2, parts: [{ type: 'text', text: 'fast steer' }] },
      { role: 'system', kind: 'steer-read-marker', parts: [{ type: 'text', text: 'Steer read here' }] },
    ])
  })

  it('keeps the optimistic user message when a pending background read resolves after the prompt', async () => {
    let resolveRead!: (value: TranscriptMessage[]) => void
    const read = vi.fn(() => new Promise<TranscriptMessage[]>((resolve) => { resolveRead = resolve }))
    const bridge = {
      sessions: { read },
      agent: { list: vi.fn(async () => []) },
    } as unknown as DesktopApi

    await act(async () => { root.render(createElement(Probe, { bridge })) })
    await flush()
    expect(read).toHaveBeenCalledTimes(1)

    const generation = latest.workspaceRef.current.generation
    const userMessage: TranscriptMessage = {
      id: 'user-1754500000000', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'run the tests' }],
    }
    await act(async () => {
      expect(latest.prepareForPrompt(generation)).toBe(true)
      latest.setMessages((items) => [...items, userMessage])
    })

    await act(async () => {
      resolveRead([{ id: 'record-1', role: 'assistant', timestamp: 0, parts: [{ type: 'text', text: 'old answer' }] }])
    })
    await flush()

    expect(latest.messages.some((message) => message.id === 'user-1754500000000')).toBe(true)
  })

  it('applies a background read normally when no prompt raced it', async () => {
    let resolveRead!: (value: TranscriptMessage[]) => void
    const read = vi.fn(() => new Promise<TranscriptMessage[]>((resolve) => { resolveRead = resolve }))
    const bridge = {
      sessions: { read },
      agent: { list: vi.fn(async () => []) },
    } as unknown as DesktopApi

    await act(async () => { root.render(createElement(Probe, { bridge })) })
    await flush()

    await act(async () => {
      resolveRead([{ id: 'record-1', role: 'assistant', timestamp: 0, parts: [{ type: 'text', text: 'persisted answer' }] }])
    })
    await flush()

    expect(latest.messages.map((message) => message.id)).toEqual(['record-1'])
    expect(latest.loadingSession).toBe(false)
  })
})

describe('draft session adoption', () => {
  it('adopts the started session without bumping the generation or touching the transcript', () => {
    act(() => { root.render(createElement(Probe, { bridge: null })) })
    act(() => { latest.activateWorkspace(project, undefined) })
    expect(latest.activeSessionId).toBeUndefined()
    const generation = latest.workspaceGeneration
    act(() => { latest.setMessages([{ id: 'user-draft', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'first draft prompt' }] }]) })

    act(() => { latest.adoptSessionId(session) })

    expect(latest.activeSessionId).toBe('session')
    expect(latest.workspaceRef.current.session?.id).toBe('session')
    expect(latest.workspaceRef.current.sessionFile).toBe(session.filePath)
    expect(latest.workspaceRef.current.cwd).toBe('/project')
    expect(latest.workspaceGeneration).toBe(generation)
    expect(latest.messages.map((message) => message.id)).toEqual(['user-draft'])
  })

  it('skips the cold transcript read when the in-flight turn owns the adopted session', async () => {
    // Never-resolve so a rogue read cannot settle and churn the effect loop.
    const read = vi.fn(() => new Promise<TranscriptMessage[]>(() => undefined))
    const bridge = {
      sessions: { read },
      agent: { list: vi.fn(async () => []) },
    } as unknown as DesktopApi

    await act(async () => { root.render(createElement(Probe, { bridge })) })
    await flush()
    // Enter the draft state through the public action (drafts have no session).
    await act(async () => { latest.activateWorkspace(project, undefined) })
    await flush()

    await act(async () => {
      latest.setMessages([{ id: 'user-draft', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'first draft prompt' }] }])
    })

    // sendPrompt adopts and attaches in the same batch; the transcript effect
    // must see a locally-owned session and stay off the disk.
    read.mockClear()
    const generation = latest.workspaceGeneration
    await act(async () => {
      latest.adoptSessionId(session)
      latest.attachRuntime({ runtimeId: 'runtime-1', harness: 'omp', sessionId: session.id, sessionFile: session.filePath, cwd: '/project', isStreaming: true }, generation)
    })
    await flush()

    expect(read).not.toHaveBeenCalled()
    expect(latest.messages.map((message) => message.id)).toEqual(['user-draft'])
  })

  it('keeps the in-flight transcript when the adopted row flaps in the catalog', async () => {
    const read = vi.fn(() => new Promise<TranscriptMessage[]>(() => undefined))
    const bridge = {
      sessions: { read },
      agent: { list: vi.fn(async () => []) },
    } as unknown as DesktopApi

    await act(async () => { root.render(createElement(Probe, { bridge, sessions: [] })) })
    await flush()
    await act(async () => { latest.activateWorkspace(project, undefined) })
    await flush()

    await act(async () => {
      latest.setMessages([{ id: 'user-draft', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'first draft prompt' }] }])
    })

    const generation = latest.workspaceGeneration
    await act(async () => {
      latest.adoptSessionId(session)
      latest.attachRuntime({ runtimeId: 'runtime-1', harness: 'omp', sessionId: session.id, sessionFile: session.filePath, cwd: '/project', isStreaming: true }, generation)
    })
    await flush()

    // The catalog catches up …
    await act(async () => { root.render(createElement(Probe, { bridge, sessions: [session] })) })
    await flush()
    // … then momentarily drops the row on a stale refresh: no blanking.
    await act(async () => { root.render(createElement(Probe, { bridge, sessions: [] })) })
    await flush()

    expect(read).not.toHaveBeenCalled()
    expect(latest.messages.map((message) => message.id)).toEqual(['user-draft'])
  })
})
