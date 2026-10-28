// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, parseWithdrawnQueue, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import { useWorkspaceRuntime } from '../../src/hooks/useWorkspaceRuntime'
import { ensureLocalStorage } from './storage-fixture'
import type { DesktopApi, ProjectRecord, QueuedPrompt, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'

const image = { type: 'image' as const, mimeType: 'image/png', data: 'aW1hZ2UtYnl0ZXM=' }

describe('parseWithdrawnQueue', () => {
  it('parses withdrawn steering and follow-ups with their attachments', () => {
    const result = parseWithdrawnQueue({
      steering: [{ text: 'steer text', images: [{ type: 'image', data: 'abc', mimeType: 'image/png', detail: 'low' }] }],
      followUp: [{ text: 'follow-up text' }],
    })
    expect(result).toEqual({
      steering: [{ text: 'steer text', images: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] }],
      followUp: [{ text: 'follow-up text' }],
      skipped: 0,
    })
  })

  it('returns null for shapes omp never sends', () => {
    expect(parseWithdrawnQueue(undefined)).toBeNull()
    expect(parseWithdrawnQueue('nope')).toBeNull()
    expect(parseWithdrawnQueue([])).toBeNull()
    expect(parseWithdrawnQueue({})).toBeNull()
    expect(parseWithdrawnQueue({ steering: 'x', followUp: [] })).toBeNull()
  })

  it('skips malformed entries instead of restoring them as plain text', () => {
    const result = parseWithdrawnQueue({
      steering: [{ text: 'ok' }, { text: 7 }, { nope: true }, { text: 'bad images', images: [{ type: 'image', data: 3 }] }],
      followUp: [],
    })
    expect(result?.steering).toEqual([{ text: 'ok' }])
    expect(result?.skipped).toBe(3)
  })

  it('carries the transport-loss flags omp reports', () => {
    const result = parseWithdrawnQueue({ steering: [], followUp: [], imagesDropped: true, truncated: true })
    expect(result).toMatchObject({ imagesDropped: true, truncated: true })
  })
})

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

function stopFixture() {
  let currentRuntime: RuntimeInfo | null = runtime('runtime-a')
  let currentMessages = [transcript('message-a')]
  const workspaceRef = { current: { generation: 1 } }
  const runtimeIdRef = { current: 'runtime-a' as string | null }
  const runtimeOwnerRef = { current: { runtimeId: 'runtime-a', generation: 1 } as { runtimeId: string; generation: number } | null }
  const reportError = vi.fn()
  const agentCommand = vi.fn(async (_runtimeId: string, _command: Record<string, unknown>): Promise<Record<string, unknown>> => ({}))
  const agentStop = vi.fn(async () => true)
  const restoreWithdrawnQueue = vi.fn()
  const reconcileQueuedPrompts = vi.fn()
  const pauseQueuedPrompts = vi.fn()
  const workspace = {
    get runtime() { return currentRuntime },
    workspaceRef,
    runtimeIdRef,
    runtimeOwnerRef,
    pendingQueuedPrompts: [] as QueuedPrompt[],
    pauseQueuedPrompts,
    restoreWithdrawnQueue,
    reconcileQueuedPrompts,
    setRuntime(update: RuntimeInfo | null | ((current: RuntimeInfo | null) => RuntimeInfo | null)) {
      currentRuntime = typeof update === 'function' ? update(currentRuntime) : update
    },
    setMessages(update: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) {
      currentMessages = typeof update === 'function' ? update(currentMessages) : update
    },
  }
  const actions = createWorkspaceActions(() => ({
    bridge: { agent: { command: agentCommand, stop: agentStop } } as unknown as DesktopApi,
    workspace,
    reportError,
  } as unknown as WorkspaceActionsDeps))

  return {
    actions,
    agentCommand,
    agentStop,
    reportError,
    restoreWithdrawnQueue,
    reconcileQueuedPrompts,
    pauseQueuedPrompts,
    runtime: () => currentRuntime,
    messages: () => currentMessages,
    replaceWorkspace(nextRuntime: RuntimeInfo, messages: TranscriptMessage[], generation: number) {
      currentRuntime = nextRuntime
      currentMessages = messages
      workspaceRef.current = { generation }
      runtimeIdRef.current = nextRuntime.runtimeId
      runtimeOwnerRef.current = { runtimeId: nextRuntime.runtimeId, generation }
    },
  }
}

describe('stop restores omp’s withdrawn queue', () => {
  it('stops through abort_and_restore_queue and restores the returned input', async () => {
    const fixture = stopFixture()
    fixture.agentCommand.mockResolvedValueOnce({
      data: {
        steering: [{ text: 'withdrawn steer', images: [image] }],
        followUp: [{ text: 'withdrawn follow-up' }],
      },
    })

    await fixture.actions.stopRuntime()

    expect(fixture.agentCommand).toHaveBeenCalledWith('runtime-a', { type: 'abort_and_restore_queue' })
    expect(fixture.pauseQueuedPrompts).toHaveBeenCalledOnce()
    expect(fixture.restoreWithdrawnQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        steering: [{ text: 'withdrawn steer', images: [image] }],
        followUp: [{ text: 'withdrawn follow-up' }],
      }),
      { harness: 'omp', sessionFile: '/sessions/runtime-a.jsonl', runtimeId: 'runtime-a' },
    )
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-a', isStreaming: false })
    expect(fixture.messages()).toMatchObject([{ id: 'message-a', streaming: false, outcome: 'cancelled' }])
  })

  it('settles without restoring when the reply carries no withdrawable data', async () => {
    const fixture = stopFixture()
    fixture.agentCommand.mockResolvedValueOnce({})

    await fixture.actions.stopRuntime()

    expect(fixture.restoreWithdrawnQueue).not.toHaveBeenCalled()
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-a', isStreaming: false })
  })

  it('does not restore or settle a workspace that moved on while stopping', async () => {
    const fixture = stopFixture()
    const stopReply = Promise.withResolvers<Record<string, unknown>>()
    fixture.agentCommand.mockImplementationOnce(() => stopReply.promise)
    const stopping = fixture.actions.stopRuntime()

    fixture.replaceWorkspace(runtime('runtime-b'), [transcript('message-b')], 2)
    stopReply.resolve({ data: { steering: [{ text: 'withdrawn steer' }], followUp: [] } })
    await stopping

    expect(fixture.restoreWithdrawnQueue).not.toHaveBeenCalled()
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-b', isStreaming: true })
    expect(fixture.messages()).toMatchObject([{ id: 'message-b', streaming: true }])
  })

  it('probes omp state when the stop reply is lost and settles from the probe', async () => {
    const fixture = stopFixture()
    const failure = new Error('stop reply lost')
    fixture.agentCommand
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        data: { isStreaming: false, queuedMessageCount: 1, queuedMessages: { steering: ['held steer'], followUp: [] } },
      })

    await fixture.actions.stopRuntime()

    expect(fixture.agentCommand).toHaveBeenNthCalledWith(2, 'runtime-a', { type: 'get_state' })
    expect(fixture.reconcileQueuedPrompts).toHaveBeenCalledWith({ queuedCount: 1, steering: ['held steer'], followUps: [] })
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-a', isStreaming: false })
    expect(fixture.restoreWithdrawnQueue).not.toHaveBeenCalled()
    expect(fixture.reportError).toHaveBeenCalledOnce()
    expect(fixture.reportError).toHaveBeenCalledWith(failure)
  })

  it('keeps streaming state when the probe shows the run still active', async () => {
    const fixture = stopFixture()
    fixture.agentCommand
      .mockRejectedValueOnce(new Error('stop reply lost'))
      .mockResolvedValueOnce({ data: { isStreaming: true, queuedMessageCount: 0, queuedMessages: { steering: [], followUp: [] } } })

    await fixture.actions.stopRuntime()

    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-a', isStreaming: true })
    expect(fixture.messages()).toMatchObject([{ id: 'message-a', streaming: true }])
    expect(fixture.reportError).toHaveBeenCalledOnce()
  })

  it('reports the original failure when the state probe is unreachable too', async () => {
    const fixture = stopFixture()
    const failure = new Error('stop reply lost')
    fixture.agentCommand
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(new Error('probe failed'))

    await fixture.actions.stopRuntime()

    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-a', isStreaming: true })
    expect(fixture.messages()).toMatchObject([{ id: 'message-a', streaming: true }])
    expect(fixture.reportError).toHaveBeenCalledOnce()
    expect(fixture.reportError).toHaveBeenCalledWith(failure)
  })

  it('surfaces a restore that lost entries or attachments to the transport limit', async () => {
    const fixture = stopFixture()
    fixture.agentCommand.mockResolvedValueOnce({ data: { steering: [], followUp: [], imagesDropped: true } })

    await fixture.actions.stopRuntime()

    expect(fixture.restoreWithdrawnQueue).toHaveBeenCalledOnce()
    const notices = fixture.messages().filter((message) => message.role === 'system')
    expect(notices).toHaveLength(1)
    expect(notices[0].parts[0]).toMatchObject({ type: 'text' })
  })
})

const project: ProjectRecord = {
  id: 'project', harness: 'omp', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const session: SessionRecord = {
  id: 'session', harness: 'omp', filePath: '/sessions/session.jsonl', projectPath: '/project', title: 'Session',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}
const otherSession: SessionRecord = {
  ...session, id: 'other-session', filePath: '/sessions/other-session.jsonl', title: 'Other session',
}

type Workspace = ReturnType<typeof useWorkspaceRuntime>
let latest: Workspace

const stableReportError = () => undefined

function Probe() {
  latest = useWorkspaceRuntime({ bridge: null, initialProject: project, initialSession: session, sessions: [session, otherSession], initialMessages: [], reportError: stableReportError })
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ensureLocalStorage()
  window.localStorage.clear()
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

describe('restoreWithdrawnQueue in the workspace runtime', () => {
  it('re-queues withdrawn input as recovered entries and retracts the withdrawn steer row', () => {
    act(() => root.render(createElement(Probe)))
    act(() => { latest.queuePrompt('withdraw me', 'steer', [{ type: 'text', text: 'withdraw me' }]) })
    act(() => { latest.reconcileQueuedPrompts({ queuedCount: 1, steering: ['withdraw me'], followUps: [] }) })
    expect(latest.messages).toHaveLength(1)
    expect(latest.messages[0]).toMatchObject({ role: 'user' })

    act(() => {
      latest.restoreWithdrawnQueue(
        { steering: [{ text: 'withdraw me', images: [image] }], followUp: [{ text: 'after the stop' }], skipped: 0 },
        { harness: 'omp', sessionFile: session.filePath, runtimeId: 'runtime-a' },
      )
    })

    // The withdrawn steer’s optimistic row goes with its queue entry; the
    // restored chips carry the input without new transcript rows.
    expect(latest.messages).toEqual([])
    expect(latest.pendingQueuedPrompts).toHaveLength(2)
    expect(latest.pendingQueuedPrompts[0]).toMatchObject({
      text: 'withdraw me',
      intent: 'queue',
      recovered: true,
      flushAttemptFailed: true,
      parts: [{ type: 'text', text: 'withdraw me' }, image],
    })
    expect(latest.pendingQueuedPrompts[1]).toMatchObject({ text: 'after the stop', intent: 'queue', recovered: true })
  })

  it('withdraws only as many duplicate-text steers as the reply lists', () => {
    act(() => root.render(createElement(Probe)))
    act(() => { latest.queuePrompt('same text', 'steer', [{ type: 'text', text: 'same text' }]) })
    act(() => { latest.queuePrompt('same text', 'steer', [{ type: 'text', text: 'same text' }]) })

    act(() => {
      latest.restoreWithdrawnQueue(
        { steering: [{ text: 'same text' }], followUp: [], skipped: 0 },
        { harness: 'omp', sessionFile: session.filePath, runtimeId: 'runtime-a' },
      )
    })

    expect(latest.pendingQueuedPrompts).toHaveLength(2)
    expect(latest.pendingQueuedPrompts.filter((prompt) => prompt.intent === 'steer')).toHaveLength(1)
    expect(latest.pendingQueuedPrompts.filter((prompt) => prompt.intent === 'queue' && prompt.recovered)).toHaveLength(1)
  })

  it('restores under the owning session when the workspace moved on', () => {
    act(() => root.render(createElement(Probe)))
    act(() => { latest.activateWorkspace(project, otherSession) })

    act(() => {
      latest.restoreWithdrawnQueue(
        { steering: [{ text: 'belongs to the stopped session' }], followUp: [], skipped: 0 },
        { harness: 'omp', sessionFile: session.filePath, runtimeId: 'runtime-a' },
      )
    })
    expect(latest.pendingQueuedPrompts).toEqual([])

    act(() => { latest.activateWorkspace(project, session) })
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['belongs to the stopped session'])
  })

  it('keeps restored attachments across a remount instead of dropping them to text', () => {
    act(() => root.render(createElement(Probe)))
    act(() => {
      latest.restoreWithdrawnQueue(
        { steering: [{ text: 'with an image', images: [image] }], followUp: [], skipped: 0 },
        { harness: 'omp', sessionFile: session.filePath, runtimeId: 'runtime-a' },
      )
    })
    act(() => root.unmount())
    root = createRoot(container)
    act(() => root.render(createElement(Probe)))

    expect(latest.pendingQueuedPrompts).toHaveLength(1)
    expect(latest.pendingQueuedPrompts[0]).toMatchObject({
      text: 'with an image',
      recovered: true,
      parts: [{ type: 'text', text: 'with an image' }, image],
    })
  })
})

describe('stop escalation', () => {
  it('escalates to the hard stop when the graceful abort leaves the turn streaming', async () => {
    const fixture = stopFixture()
    fixture.agentCommand.mockResolvedValue({})

    await fixture.actions.stopRuntime()
    expect(fixture.agentCommand).toHaveBeenCalledWith('runtime-a', { type: 'abort_and_restore_queue' })
    expect(fixture.agentStop).not.toHaveBeenCalled()

    // The abort did not take: events re-opened the same turn on the same runtime.
    fixture.replaceWorkspace(runtime('runtime-a'), [transcript('message-a')], 1)

    await fixture.actions.stopRuntime()
    expect(fixture.agentStop).toHaveBeenCalledWith('runtime-a')
    expect(fixture.agentCommand).toHaveBeenCalledTimes(1)
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-a', isStreaming: false })
    expect(fixture.messages()).toMatchObject([{ id: 'message-a', streaming: false, outcome: 'cancelled' }])
  })
})
