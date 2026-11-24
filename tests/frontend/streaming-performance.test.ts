import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingAgentEvent } from '../../src/app/agent-events'
import { createScopedRequestGuard } from '../../src/app/scoped-request'
import { areSidebarPropsEqual, boundedSidebarSessions, indexSidebarSessions, type SidebarProps } from '../../src/components/Sidebar'
import {
  ACTIVITY_BATCH,
  growActivityBatch,
  updateActivityCriteria,
  type ActivityViewState,
} from '../../src/pages/ActivityPage'
import { applyPrimeEvent, createPrimeEventBuffer, createSteerAcceptedEvent, createSteerPickupEvent, replayPrimeEvents, resetTranscriptIdsForTests, type PrimeEventReplayStats } from '../../src/lib/events'
import { reconcileTranscripts } from '../../src/app/transcript-reconcile'
import { createSidebarActionProxy } from '../../src/hooks/useSidebarActions'
import { mergeSessionCatalog } from '../../src/hooks/useBootstrap'
import { lastAssistantMessage, shouldRefreshGitOnSessionTransition } from '../../src/lib/workspace'
import type { ProjectRecord, SessionRecord, TranscriptMessage } from '../../src/types/api'
import { createAssistantTurnCoalescer } from '../../src/lib/assistant-turns'

Object.defineProperty(globalThis, 'self', { value: globalThis })
afterEach(() => vi.restoreAllMocks())
const { admitAgentEvent, eventsForWorkspace } = await import('../../src/app/agent-events')

it('preserves historical assistant groups when only a later turn streams', () => {
  const coalesce = createAssistantTurnCoalescer()
  const messages: TranscriptMessage[] = [
    { id: 'a', role: 'assistant', timestamp: 1, parts: [{ type: 'text', text: 'First' }] },
    { id: 'b', role: 'assistant', timestamp: 2, completedAt: 3, parts: [{ type: 'text', text: 'Second' }] },
    { id: 'u', role: 'user', timestamp: 4, parts: [] },
    { id: 'live', role: 'assistant', timestamp: 5, streaming: true, parts: [] },
  ]
  const first = coalesce(messages)
  const next = coalesce([...messages.slice(0, -1), { ...messages[3], parts: [{ type: 'text', text: 'Next token' }] }])
  expect(next[0]).toBe(first[0])
  expect(next[0].completedAt).toBe(3)
  expect(next[0].parts).toHaveLength(2)
  expect(next[1]).toBe(messages[2])
  expect(next[2]).not.toBe(first[2])
})

const transcript = (): TranscriptMessage[] => [{
  id: 'assistant-1',
  role: 'assistant',
  timestamp: 1,
  streaming: true,
  parts: [{ type: 'text', text: 'loaded:' }],
}]

const delta = (text: string): Record<string, unknown> => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: text },
})

const transcriptText = (messages: TranscriptMessage[]) => {
  const part = messages[0]?.parts[0]
  return part?.type === 'text' ? part.text : undefined
}

function runTranscriptRace(frameBeforeRead: boolean): TranscriptMessage[] {
  const eventBuffer = createPrimeEventBuffer()
  const pendingLoad = { generation: 4, eventBuffer }
  const frameQueue: PendingAgentEvent[] = []
  const events = [delta('one'), delta('-two')]

  expect(events.map((event) => admitAgentEvent(4, event, pendingLoad, frameQueue))).toEqual(['transcript', 'transcript'])

  let messages: TranscriptMessage[] = []
  const flushFrame = () => {
    messages = eventsForWorkspace(frameQueue.splice(0), 4)
      .reduce((current, event) => applyPrimeEvent(current, event), messages)
  }
  const finishRead = () => { messages = eventBuffer.replay(transcript()) }

  if (frameBeforeRead) {
    flushFrame()
    finishRead()
  } else {
    finishRead()
    flushFrame()
  }
  return messages
}

describe('streamed transcript event ownership', () => {
  it('routes transcript-read payload overflow through authoritative reconciliation', () => {
    const eventBuffer = createPrimeEventBuffer({ maxBytes: 256 })
    const owner = { generation: 4, eventBuffer }
    const frames: PendingAgentEvent[] = []
    expect(admitAgentEvent(4, delta('x'.repeat(1_000)), owner, frames)).toBe('overflow')
    expect(eventBuffer.size).toBe(0)
    expect(eventBuffer.payloadBytes).toBe(0)
    expect(frames).toHaveLength(0)
  })
  it('applies buffered deltas exactly once when the transcript read resolves before RAF', () => {
    expect(transcriptText(runTranscriptRace(false))).toBe('loaded:one-two')
  })

  it('applies buffered deltas exactly once and in order when RAF runs before the transcript read', () => {
    expect(transcriptText(runTranscriptRace(true))).toBe('loaded:one-two')
  })

  it('preserves frame order and rejects events from an old workspace generation', () => {
    const queue: PendingAgentEvent[] = [
      { generation: 2, event: delta('old') },
      { generation: 3, event: delta('new-1') },
      { generation: 3, event: delta('-new-2') },
    ]
    const messages = eventsForWorkspace(queue, 3).reduce(
      (current, event) => applyPrimeEvent(current, event),
      transcript(),
    )

    expect(transcriptText(messages)).toBe('loaded:new-1-new-2')
  })
})

const sidebarProps = (onNewSession: () => void): SidebarProps => ({
  projects: [],
  sessions: [],
  activeView: 'projects',
  onSelectSession: () => undefined,
  onNavigate: () => undefined,
  onNewSession,
  onAddProject: () => undefined,
  onRemoveProject: () => undefined,
  onClose: () => undefined,
  onOpenPalette: () => undefined,
  onRenameSession: async () => undefined,
  onArchiveSession: async () => undefined,
})

describe('Sidebar memoization and scale bounds', () => {
  it('rejects a streaming parent rerender when navigation data and stable handlers are unchanged', () => {
    const callbacks = sidebarProps(() => undefined)
    const before = { ...callbacks }
    const streamedMessages = applyPrimeEvent(transcript(), delta('next frame'))
    const after = { ...callbacks }

    expect(streamedMessages).not.toBe(transcript())
    expect(areSidebarPropsEqual(before, after)).toBe(true)
  })

  it('keeps callback identities stable while dispatching to the latest App render', () => {
    let oldCalls = 0
    let newCalls = 0
    const previous = sidebarProps(() => { oldCalls += 1 })
    const proxy = createSidebarActionProxy(previous)
    const stable = proxy.callbacks
    proxy.update(sidebarProps(() => { newCalls += 1 }))

    expect(proxy.callbacks).toBe(stable)
    stable.onNewSession()
    expect(oldCalls).toBe(0)
    expect(newCalls).toBe(1)
    expect(areSidebarPropsEqual({ ...previous, ...stable }, { ...previous, ...proxy.callbacks })).toBe(true)
  })

  it('indexes 5,000 sessions once and bounds rendered rows per project', () => {
    const project: ProjectRecord = {
      id: 'large', harness: 'omp', name: 'Large', path: '/large', folders: ['/large'], primaryFolder: '/large',
      pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 5_000,
    }
    const sessions: SessionRecord[] = Array.from({ length: 5_000 }, (_, index) => ({
      id: `session-${index}`, harness: 'omp' as const, projectPath: '/large', filePath: `/sessions/${index}.jsonl`, title: `Session ${index}`,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
    }))
    const stats = { projectPaths: 0, sessionScans: 0 }
    const indexed = indexSidebarSessions([project], sessions, stats)
    const rows = boundedSidebarSessions(indexed.sessionsByProject.get(project.id) ?? [])

    expect(stats).toEqual({ projectPaths: 1, sessionScans: 5_000 })
    expect(indexed.activeSessions).toHaveLength(5_000)
    expect(rows).toHaveLength(7)
  })
})

describe('Activity batching', () => {
  const initial = (): ActivityViewState => ({ filter: 'all', query: '', visibleLimit: ACTIVITY_BATCH })

  it('grows by one bounded batch', () => {
    expect(growActivityBatch(initial(), 1_000).visibleLimit).toBe(500)
    expect(growActivityBatch({ ...initial(), visibleLimit: 750 }, 800).visibleLimit).toBe(800)
  })

  it('resets the limit atomically with query and filter changes', () => {
    const expanded = { ...initial(), visibleLimit: 750 }
    expect(updateActivityCriteria(expanded, { query: 'running' })).toEqual({
      filter: 'all', query: 'running', visibleLimit: ACTIVITY_BATCH,
    })
    expect(updateActivityCriteria(expanded, { filter: 'running' })).toEqual({
      filter: 'running', query: '', visibleLimit: ACTIVITY_BATCH,
    })
  })
})


afterEach(() => { vi.useRealTimers() })

describe('batched Prime event reduction', () => {
  it('anchors an accepted steer immediately, then marks the exact pickup boundary', () => {
    const steer = { id: 'queued-1', text: 'change direction', intent: 'steer' as const, timestamp: 2, parts: [{ type: 'text' as const, text: 'change direction' }] }
    const result = replayPrimeEvents(transcript(), [
      delta('before acceptance'),
      createSteerAcceptedEvent(steer),
      delta('still finishing the current work'),
      createSteerPickupEvent([steer]),
      { type: 'turn_start' },
      delta('after pickup'),
    ])

    expect(result.map((message) => [message.role, message.kind])).toEqual([
      ['assistant', undefined],
      ['user', undefined],
      ['assistant', undefined],
      ['system', 'steer-read-marker'],
      ['assistant', undefined],
    ])
    expect(result[1]).toMatchObject({ id: 'user-queued-1', steerState: 'read' })
    expect(result[2]?.parts).toEqual([{ type: 'text', text: 'still finishing the current work', partId: expect.any(String) }])
    expect(result[3]?.parts).toEqual([{ type: 'text', text: 'Steer read here' }])
    expect(result[4]?.parts).toEqual([{ type: 'text', text: 'after pickup', partId: expect.any(String) }])
  })

  it('places repeated picked-up steers between the tool segments that consumed them', () => {
    const result = replayPrimeEvents(transcript(), [
      { type: 'tool_execution_start', toolCallId: 'read', toolName: 'Read', args: { path: 'before.ts' } },
      createSteerPickupEvent([{ id: 'queued-1', text: 'change direction', intent: 'steer', timestamp: 2, parts: [{ type: 'text', text: 'change direction' }] }]),
      { type: 'turn_start' },
      { type: 'tool_execution_start', toolCallId: 'write', toolName: 'Write', args: { path: 'after.ts' } },
      createSteerPickupEvent([{ id: 'queued-2', text: 'also compare the physics', intent: 'steer', timestamp: 3, parts: [{ type: 'text', text: 'also compare the physics' }] }]),
      { type: 'turn_start' },
      delta('continued after both pickups'),
    ])

    expect(result.map((message) => message.role)).toEqual(['assistant', 'user', 'system', 'assistant', 'user', 'system', 'assistant'])
    expect(result[0]?.streaming).toBe(false)
    expect(result[0]?.parts.some((part) => part.type === 'toolCall' && part.name === 'Read')).toBe(true)
    expect(result[1]).toMatchObject({ id: 'user-queued-1', timestamp: 2, parts: [{ type: 'text', text: 'change direction' }] })
    expect(result[2]).toMatchObject({ kind: 'steer-read-marker' })
    expect(result[3]).toMatchObject({ role: 'assistant', streaming: false })
    expect(result[3]?.parts.some((part) => part.type === 'toolCall' && part.name === 'Write')).toBe(true)
    expect(result[4]).toMatchObject({ id: 'user-queued-2', timestamp: 3, parts: [{ type: 'text', text: 'also compare the physics' }] })
    expect(result[5]).toMatchObject({ kind: 'steer-read-marker' })
    expect(result[6]?.streaming).toBe(true)
    expect(result[6]?.parts).toEqual([{ type: 'text', text: 'continued after both pickups', partId: expect.any(String) }])
  })

  it('is equivalent to ordered single-event reduction across text, thinking, and tool merges', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))
    const events: Record<string, unknown>[] = [
      delta('hello'),
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' } },
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'Read', args: { path: 'a' } },
      { type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'Read', args: { path: 'a' }, partialResult: 'partial' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '-after-tool' } },
      { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'Read', result: { output: 'done' } },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 'tool-2', name: 'Write', arguments: { path: 'b' } } } },
      { type: 'tool_execution_end', toolCallId: 'tool-2', toolName: 'Write', result: 'written', isError: false },
      { type: 'agent_end' },
    ]
    resetTranscriptIdsForTests()
    const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), transcript())
    resetTranscriptIdsForTests()
    const batched = replayPrimeEvents(transcript(), events)

    expect(batched).toEqual(sequential)
    expect(batched[0]?.parts.map((part) => part.type)).toEqual([
      'text', 'thinking', 'toolCall', 'toolResult', 'text', 'toolCall', 'toolResult',
    ])
  })

  it('walks a large transcript a bounded number of times for a large delta frame', () => {
    const source = Array.from({ length: 2_000 }, (_, index): TranscriptMessage => ({
      id: `message-${index}`,
      role: index === 1_999 ? 'assistant' : 'user',
      timestamp: index,
      streaming: index === 1_999,
      parts: index === 1_999 ? [{ type: 'text', text: '' }] : [{ type: 'text', text: 'old' }],
    }))
    let indexedReads = 0
    const measured = new Proxy(source, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) indexedReads += 1
        return Reflect.get(target, key, receiver)
      },
    })
    const result = replayPrimeEvents(measured, Array.from({ length: 1_000 }, () => delta('x')))

    expect(transcriptText([result.at(-1)!])).toBe('x'.repeat(1_000))
    expect(indexedReads).toBeLessThan(6_100)
  })
})

describe('Sidebar root-render isolation', () => {
  it('retains every callback identity across transcript-only renders while dispatching current actions', () => {
    let selected = 'old'
    const old = sidebarProps(() => { selected = 'old-called' })
    const proxy = createSidebarActionProxy(old)
    const first = { ...old, ...proxy.callbacks }
    const latest = { ...first, onNewSession: () => { selected = 'latest-called' } }
    proxy.update(latest)
    const afterTranscriptRender = { ...first, ...proxy.callbacks }

    expect(areSidebarPropsEqual(first, afterTranscriptRender)).toBe(true)
    expect(Object.keys(proxy.callbacks).every((key) => (
      first[key as keyof SidebarProps] === afterTranscriptRender[key as keyof SidebarProps]
    ))).toBe(true)
    afterTranscriptRender.onNewSession()
    expect(selected).toBe('latest-called')
  })
})


describe('linear event batches', () => {
  it('is equivalent to sequential replay across text, tools, errors, and turn boundaries', () => {
    vi.spyOn(Date, 'now').mockReturnValue(42)
    const events: Record<string, unknown>[] = [
      { type: 'turn_start' },
      delta('hello'),
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' } },
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'Read', args: { path: 'a' } },
      { type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'Read', args: { path: 'a' }, partialResult: 'partial' },
      { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'Read', result: 'done' },
      delta(' world'),
      { type: 'agent_end' },
      { type: 'turn_start' },
      { type: 'message_update', delta: { type: 'toolcall_end', toolCall: { id: 'tool-2', name: 'Write', arguments: { path: 'b' } } } },
      { type: 'tool_execution_end', toolCallId: 'tool-2', toolName: 'Write', result: { output: 'saved' } },
      { type: 'runtime_exit', expected: true },
    ]
    resetTranscriptIdsForTests()
    const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), transcript())
    resetTranscriptIdsForTests()
    expect(replayPrimeEvents(transcript(), events)).toEqual(sequential)
  })

  it('pairs id-less tool executions onto one tool row instead of adding a phantom row', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))
    const events: Record<string, unknown>[] = [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolName: 'Anonymous', args: { path: 'a' } },
      { type: 'tool_execution_end', toolName: 'Anonymous', result: 'done' },
      { type: 'agent_end' },
    ]
    resetTranscriptIdsForTests()
    const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), transcript())
    resetTranscriptIdsForTests()
    const batched = replayPrimeEvents(transcript(), events)

    expect(batched).toEqual(sequential)
    const parts = batched[0]?.parts ?? []
    expect(parts.filter((part) => part.type === 'toolCall')).toHaveLength(1)
    expect(parts.filter((part) => part.type === 'toolResult')).toHaveLength(1)
    const call = parts.find((part) => part.type === 'toolCall')
    expect(call && 'id' in call ? call.id : undefined).toBeTruthy()
  })

  it('keeps the args captured at tool start when an execution update omits them', () => {
    vi.spyOn(Date, 'now').mockReturnValue(7)
    resetTranscriptIdsForTests()
    const events: Record<string, unknown>[] = [
      { type: 'turn_start' },
      { type: 'tool_execution_start', toolCallId: 'one', toolName: 'One', args: { command: 'ls -la' } },
      { type: 'tool_execution_update', toolCallId: 'one', toolName: 'One', partialResult: 'partial' },
    ]
    const messages = replayPrimeEvents(transcript(), events)
    const call = messages.flatMap((message) => message.parts).find((part) => part.type === 'toolCall')
    expect(call && 'args' in call ? call.args : undefined).toEqual({ command: 'ls -la' })
  })

  it('matches single-event semantics for deterministic mixed-event permutations', () => {
    vi.spyOn(Date, 'now').mockReturnValue(7)
    const pool: Record<string, unknown>[] = [
      { type: 'turn_start' }, delta('a'),
      { type: 'message_update', delta: { type: 'thinking_delta', delta: 'b' } },
      { type: 'tool_execution_start', toolCallId: 'one', toolName: 'One', args: 1 },
      { type: 'tool_execution_update', toolCallId: 'one', toolName: 'One', partialResult: 'partial' },
      { type: 'tool_execution_end', toolCallId: 'one', toolName: 'One', result: 'done' },
      { type: 'tool_execution_start', toolName: 'Anonymous' },
      { type: 'tool_execution_update', toolName: 'Anonymous', partialResult: 'partial' },
      { type: 'tool_execution_end', toolName: 'Anonymous', result: 'done' },
      { type: 'agent_end' }, { type: 'error', message: 'failed' },
      { type: 'runtime_exit', expected: true },
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'compaction_end', reason: 'threshold', aborted: false, result: { summary: 'Trimmed earlier work.', tokensBefore: 4_096, firstKeptEntryId: 'kept-1' } },
      { type: 'compaction_end', reason: 'manual', aborted: true },
    ]
    let seed = 0x5eed
    const random = () => { seed = (seed * 1_664_525 + 1_013_904_223) >>> 0; return seed }
    for (let run = 0; run < 100; run += 1) {
      const events = Array.from({ length: 80 }, () => pool[random() % pool.length])
      resetTranscriptIdsForTests()
      const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), transcript())
      resetTranscriptIdsForTests()
      expect(replayPrimeEvents(transcript(), events)).toEqual(sequential)
    }
  })

  it('opens a fresh assistant turn after a compaction row carried over from a prior batch', () => {
    vi.spyOn(Date, 'now').mockReturnValue(7)
    const batchA: Record<string, unknown>[] = [{ type: 'compaction_start', reason: 'threshold' }]
    const batchB: Record<string, unknown>[] = [
      { type: 'agent_start' },
      delta('after compaction'),
      { type: 'agent_end' },
    ]
    resetTranscriptIdsForTests()
    const sequential = [...batchA, ...batchB].reduce((current, event) => applyPrimeEvent(current, event), transcript())
    resetTranscriptIdsForTests()
    const batched = replayPrimeEvents(replayPrimeEvents(transcript(), batchA), batchB)

    expect(batched).toEqual(sequential)
    expect(batched.filter((message) => message.role === 'assistant')).toHaveLength(2)
    expect(batched.at(-1)?.parts).toMatchObject([{ type: 'text', text: 'after compaction' }])
  })

  it('uses one bounded state commit for each sustained frame batch', () => {
    const original: TranscriptMessage[] = Array.from({ length: 500 }, (_, index) => ({
      id: `message-${index}`, role: index === 499 ? 'assistant' : 'user', timestamp: index,
      streaming: index === 499, parts: [{ type: 'text', text: index === 499 ? '' : 'stable' }],
    }))
    let state = original
    let commits = 0
    for (let batch = 0; batch < 50; batch += 1) {
      const events = Array.from({ length: 200 }, () => delta('x'))
      const stats: PrimeEventReplayStats = { messageScans: 0, eventScans: 0, partScans: 0, transcriptCopies: 0 }
      const next = replayPrimeEvents(state, events, stats)
      commits += 1
      // The tail-delta fast path reads only the streaming message it appends
      // to and never rebuilds a part list or its tool index.
      expect(stats.messageScans).toBe(1)
      expect(stats.eventScans).toBe(200)
      expect(stats.partScans).toBe(0)
      expect(stats.transcriptCopies).toBe(1)
      expect(next[0]).toBe(state[0])
      state = next
    }
    expect(commits).toBe(50)
    expect(transcriptText([state[499]])).toHaveLength(10_000)
  })
})

describe('tail delta fast path', () => {
  const streamingAssistant = (parts: TranscriptMessage['parts']): TranscriptMessage[] => [
    { id: 'user-1', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'go' }] },
    { id: 'assistant-1', role: 'assistant', timestamp: 2, streaming: true, parts },
  ]
  const thinking = (text: string): Record<string, unknown> => ({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: text },
  })
  const stats = (): PrimeEventReplayStats => ({ messageScans: 0, eventScans: 0, partScans: 0, transcriptCopies: 0 })

  it('matches the full reducer for text and thinking batches, including the parts it has to open', () => {
    const cases: { name: string; messages: TranscriptMessage[]; events: Record<string, unknown>[]; scans: number }[] = [
      { name: 'merges into the streaming tail', messages: streamingAssistant([{ type: 'text', text: 'loaded:' }]), events: [delta(' one'), delta(' two')], scans: 1 },
      { name: 'opens a thinking part, then a text part', messages: streamingAssistant([{ type: 'text', text: 'loaded:' }]), events: [thinking('plan'), thinking(' more'), delta('answer')], scans: 1 },
      { name: 'opens the first part of an empty turn', messages: streamingAssistant([]), events: [thinking('plan'), delta('answer')], scans: 1 },
      {
        name: 'targets the streaming assistant above a later row',
        messages: [...streamingAssistant([{ type: 'text', text: 'loaded:' }]), { id: 'system-1', role: 'system', timestamp: 3, parts: [{ type: 'text', text: 'notice' }] }],
        events: [delta(' more')],
        scans: 2,
      },
    ]
    for (const { name, messages, events, scans } of cases) {
      const before = structuredClone(messages)
      const counts = stats()
      resetTranscriptIdsForTests()
      const fast = replayPrimeEvents(messages, events, counts)
      resetTranscriptIdsForTests()
      const slow = replayPrimeEvents(messages, events, undefined, { tailFastPath: false })
      resetTranscriptIdsForTests()
      const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), messages)

      expect(fast, name).toEqual(slow)
      expect(fast, name).toEqual(sequential)
      // The fast path ran: it probes the tail message and never scans the part list.
      expect(counts.messageScans, name).toBe(scans)
      expect(counts.partScans, name).toBe(0)
      // The fast path reads the input without writing to it.
      expect(messages, name).toEqual(before)
    }
  })

  it('keeps untouched parts and earlier messages by identity', () => {
    const base = streamingAssistant([
      { type: 'text', text: 'earlier', partId: 'part-a' },
      { type: 'toolCall', id: 'tool-1', name: 'Read', partId: 'part-b' },
      { type: 'text', text: 'tail' },
    ])
    const next = replayPrimeEvents(base, [delta('+more')])

    expect(next).not.toBe(base)
    expect(next[0]).toBe(base[0])
    expect(next[1]).not.toBe(base[1])
    expect(next[1]?.streaming).toBe(true)
    expect(next[1]?.parts).not.toBe(base[1]?.parts)
    expect(next[1]?.parts[0]).toBe(base[1]?.parts[0])
    expect(next[1]?.parts[1]).toBe(base[1]?.parts[1])
    expect(next[1]?.parts[2]).toMatchObject({ type: 'text', text: 'tail+more' })
    expect(base[1]?.parts[2]).toMatchObject({ type: 'text', text: 'tail' })
  })

  it('leaves tool, message-end, and structural batches on the full reducer', () => {
    const messages = streamingAssistant([{ type: 'text', text: 'loaded:' }])
    const batches: Record<string, unknown>[][] = [
      [delta('x'), { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'Read' }],
      [delta('x'), { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 'tool-1', name: 'Read' } } }],
      [delta('x'), { type: 'agent_end' }],
      [{ type: 'turn_start' }, delta('x')],
    ]
    for (const events of batches) {
      const counts = stats()
      resetTranscriptIdsForTests()
      const batched = replayPrimeEvents(messages, events, counts)
      resetTranscriptIdsForTests()
      const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), messages)

      expect(batched).toEqual(sequential)
      // The full reducer scans the whole transcript; the tail probe reads one message.
      expect(counts.messageScans).toBe(messages.length)
    }
  })
})

describe('external sync reconciliation', () => {
  const syncTranscript = (): TranscriptMessage[] => [
    { id: 'user-1', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'question' }] },
    { id: 'assistant-1', role: 'assistant', timestamp: 2, parts: [{ type: 'text', text: 'answer' }, { type: 'toolCall', id: 'tool-1', name: 'Read', args: { path: 'a' } }] },
    { id: 'assistant-2', role: 'assistant', timestamp: 3, streaming: true, parts: [{ type: 'text', text: 'stream' }] },
  ]

  it('keeps object identity for unchanged messages across a sync tick so memoized rows skip re-rendering', () => {
    const current = syncTranscript()
    const fromDisk = structuredClone(current)
    const streamedPart = fromDisk[2]!.parts[0]
    if (streamedPart?.type === 'text') streamedPart.text = 'stream-extended'

    const merged = reconcileTranscripts(current, fromDisk)

    expect(merged[0]).toBe(current[0])
    expect(merged[1]).toBe(current[1])
    expect(merged[2]).not.toBe(current[2])
    expect(merged[2]).toBe(fromDisk[2])
  })

  it('returns the current array identity when a re-read changes nothing', () => {
    const current = syncTranscript()
    expect(reconcileTranscripts(current, structuredClone(current))).toBe(current)
  })

  it('treats absent optional fields and undefined values as equal, but not content changes', () => {
    const current = syncTranscript()
    const fromDisk = structuredClone(current)
    fromDisk[0]!.agentName = undefined
    expect(reconcileTranscripts(current, fromDisk)[0]).toBe(current[0])

    const changedArgs = structuredClone(current)
    const tool = changedArgs[1]!.parts[1]
    if (tool?.type === 'toolCall') tool.args = { path: 'b' }
    expect(reconcileTranscripts(current, changedArgs)[1]).toBe(changedArgs[1])
  })

  it('adopts reordered and new messages from the authoritative read', () => {
    const current = syncTranscript()
    const fromDisk = [...structuredClone(current), { id: 'assistant-3', role: 'assistant' as const, timestamp: 4, parts: [] }]
    const merged = reconcileTranscripts(current, fromDisk)
    expect(merged).toHaveLength(4)
    expect(merged[0]).toBe(current[0])
    expect(merged[3]).toBe(fromDisk[3])
  })

  it('compares nested records by their defined own keys on both sides', () => {
    const withUndefined = [{ id: 'a', role: 'user' as const, timestamp: 1, parts: [], meta: { kept: 1, dropped: undefined } }] as unknown as TranscriptMessage[]
    const withoutUndefined = [{ id: 'a', role: 'user' as const, timestamp: 1, parts: [], meta: { kept: 1 } }] as unknown as TranscriptMessage[]
    expect(reconcileTranscripts(withUndefined, withoutUndefined)).toBe(withUndefined)

    const extraKey = [{ id: 'a', role: 'user' as const, timestamp: 1, parts: [], meta: { kept: 1, added: 2 } }] as unknown as TranscriptMessage[]
    expect(reconcileTranscripts(withUndefined, extraKey)[0]).toBe(extraKey[0])
  })

  it('keeps a local steer row the read cannot know about and drops it once the same text is persisted', () => {
    const disk = syncTranscript()
    const local: TranscriptMessage = { id: 'user-queued-1', role: 'user', timestamp: 2, parts: [{ type: 'text', text: 'change direction' }] }
    const kept = reconcileTranscripts([...disk, local], disk)
    expect(kept.map((message) => message.id)).toContain('user-queued-1')
    expect(kept.filter((message) => message.role === 'user').map((message) => message.parts[0]?.type === 'text' ? message.parts[0].text : '')).toEqual(['question', 'change direction'])

    const persisted = [...disk, { id: 'entry-9', role: 'user' as const, timestamp: 2, parts: [{ type: 'text' as const, text: 'change direction' }] }]
    const deduped = reconcileTranscripts([...disk, local], persisted)
    expect(deduped.map((message) => message.id)).toEqual(persisted.map((message) => message.id))
  })

  it('does not let earlier history with the same text swallow a new pending prompt', () => {
    const history: TranscriptMessage = { id: 'entry-1', role: 'user', timestamp: 1_000, parts: [{ type: 'text', text: 'continue' }] }
    const pending: TranscriptMessage = { id: 'user-queued-2', role: 'user', timestamp: 50_000, parts: [{ type: 'text', text: 'continue' }] }
    const read = [history]
    const kept = reconcileTranscripts([history, pending], read)
    expect(kept.map((message) => message.id)).toEqual(['entry-1', 'user-queued-2'])

    const persisted = [history, { id: 'entry-2', role: 'user' as const, timestamp: 50_200, parts: [{ type: 'text' as const, text: 'continue' }] }]
    expect(reconcileTranscripts([history, pending], persisted).map((message) => message.id)).toEqual(['entry-1', 'entry-2'])
  })
})

describe('catalog tick session identity', () => {
  const record = (filePath: string, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
    id: filePath, harness: 'omp', projectPath: '/project', filePath, title: 'Session',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'idle', depth: 0, ...overrides,
  })

  it('bumps syncRevision only for sessions whose file changed and keeps identity for the rest', () => {
    const current = [record('/a.jsonl', { syncRevision: 3 }), record('/b.jsonl', { syncRevision: 5 })]
    const merged = mergeSessionCatalog(
      current,
      [record('/a.jsonl'), record('/b.jsonl')],
      undefined,
      new Map([['/a.jsonl', 7]]),
      0,
    )
    expect(merged[0]?.syncRevision).toBe(7)
    expect(merged[0]).not.toBe(current[0])
    expect(merged[1]).toBe(current[1])
    expect(merged[1]?.syncRevision).toBe(5)
  })

  it('does not spread a catalog-only revision onto untouched sessions', () => {
    const current = [record('/a.jsonl', { syncRevision: 3 }), record('/b.jsonl', { syncRevision: 5 })]
    const merged = mergeSessionCatalog(
      current,
      [record('/a.jsonl', { updatedAt: '2026-01-02T00:00:00.000Z' }), record('/b.jsonl')],
      undefined,
      new Map(),
      9,
    )
    expect(merged[0]?.syncRevision).toBe(9)
    expect(merged[1]).toBe(current[1])
    expect(merged[1]?.syncRevision).toBe(5)
  })
})

describe('streaming markdown parse throttling', () => {
  it('parses at most once per interval while holding the previous committed snapshot', async () => {
    const { advanceStreamingParse, STREAMING_PARSE_INTERVAL_MS } = await import('../../src/components/MarkdownText')
    const first = advanceStreamingParse({ boundary: 0, lastParseAt: 0 }, 10, 1_000)
    expect(first.state).toEqual({ boundary: 10, lastParseAt: 1_000 })
    expect(first.delayMs).toBeUndefined()

    // More deltas inside the interval: keep the coherent old snapshot and retry later.
    const throttled = advanceStreamingParse(first.state, 25, 1_040)
    expect(throttled.state).toBe(first.state)
    expect(throttled.delayMs).toBe(STREAMING_PARSE_INTERVAL_MS - 40)

    // Once the interval elapses the boundary advances.
    const elapsed = advanceStreamingParse(first.state, 25, 1_000 + STREAMING_PARSE_INTERVAL_MS)
    expect(elapsed.state.boundary).toBe(25)

    // Unchanged text is a no-op; shrunk text re-parses from the new end.
    expect(advanceStreamingParse(elapsed.state, 25, 2_000).state).toBe(elapsed.state)
    expect(advanceStreamingParse(elapsed.state, 5, 2_000).state).toEqual({ boundary: 5, lastParseAt: 2_000 })
  })

  it('holds a newline-heavy delta stream to the same 100ms parse cadence', async () => {
    const { advanceStreamingParse, STREAMING_PARSE_INTERVAL_MS } = await import('../../src/components/MarkdownText')
    // Start as if the last parse happened at t=1000, then feed 100 deltas one
    // per 10ms. Code fences and bullet lists make most of the unparsed tail
    // contain a newline, which must not buy an extra parse.
    let state = { boundary: 0, lastParseAt: 1_000 }
    let parses = 0
    for (let step = 1; step <= 100; step += 1) {
      const result = advanceStreamingParse(state, step, 1_000 + step * 10)
      if (result.state !== state) {
        parses += 1
        state = result.state
      }
      if (step === 5) expect(state.boundary).toBe(0)
    }
    expect(parses).toBe(Math.floor(1_000 / STREAMING_PARSE_INTERVAL_MS))
    expect(state.boundary).toBe(100)
  })

  it('summarizes the transcript in the store with one reverse walk', async () => {
    const { createTranscriptStore } = await import('../../src/app/transcript-store')
    const messages: TranscriptMessage[] = [
      { id: 'user-1', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'ask' }] },
      { id: 'assistant-1', role: 'assistant', timestamp: 2, parts: [{ type: 'toolCall', id: 'a', name: 'Read' }, { type: 'text', text: 'first answer' }] },
      { id: 'assistant-2', role: 'assistant', timestamp: 3, parts: [{ type: 'text', text: 'final answer' }, { type: 'toolCall', id: 'b', name: 'Write' }] },
      { id: 'tool-1', role: 'tool', timestamp: 4, parts: [{ type: 'toolResult', name: 'Write', text: 'done' }] },
    ]
    expect(createTranscriptStore(messages).getSummary()).toMatchObject({ count: 4, toolCount: 2, lastText: 'final answer' })
    expect(createTranscriptStore([]).getSummary()).toMatchObject({ count: 0, toolCount: 0, lastText: undefined })
    // The newest assistant text wins, but a newer assistant turn without text falls back to the previous reply.
    const fallback = createTranscriptStore([messages[1]!, { ...messages[2]!, parts: [{ type: 'toolCall', id: 'b', name: 'Write' }] }])
    expect(fallback.getSummary().lastText).toBe('first answer')
  })

  it('publishes streamed reply text to summary subscribers without waking execution subscribers', async () => {
    const { createTranscriptStore } = await import('../../src/app/transcript-store')
    const store = createTranscriptStore([{ id: 'live', role: 'assistant', timestamp: 1, streaming: true, parts: [{ type: 'text', text: 'Answer:' }] }])
    const summaryNotifies = vi.fn()
    const executionNotifies = vi.fn()
    const messageNotifies = vi.fn()
    const offSummary = store.subscribeSummary(summaryNotifies)
    const offExecution = store.subscribeExecutionSummary(executionNotifies)
    const offMessages = store.subscribe(messageNotifies)
    try {
      store.update((current) => [{ ...current[0]!, parts: [{ type: 'text', text: 'Answer: x' }] }])
      expect(summaryNotifies).toHaveBeenCalledOnce()
      expect(messageNotifies).toHaveBeenCalledOnce()
      // The workspace owner renders the transcript itself, so only execution semantics may wake it.
      expect(executionNotifies).not.toHaveBeenCalled()
      expect(store.getExecutionSummary()).not.toHaveProperty('lastText')
    } finally { offSummary(); offExecution(); offMessages() }
  })

  it('bounds lastText to 220 chars so post-preview streaming tokens stop waking summary subscribers', async () => {
    const { createTranscriptStore } = await import('../../src/app/transcript-store')
    const baseText = 'a'.repeat(221)
    const olderParts = [{ type: 'toolCall' as const, id: 'old-1', name: 'Read' }]
    const olderMessage: TranscriptMessage = { id: 'older', role: 'assistant', timestamp: 1, parts: olderParts }
    const store = createTranscriptStore([
      olderMessage,
      { id: 'live', role: 'assistant', timestamp: 2, streaming: true, parts: [{ type: 'text', text: baseText }] },
    ])
    expect(store.getSummary().lastText).toBe(`${'a'.repeat(220)}…`)
    expect(store.getSummary().toolCount).toBe(1)

    const summaryNotifies = vi.fn()
    const offSummary = store.subscribeSummary(summaryNotifies)
    try {
      store.update((current) => [current[0]!, { ...current[1]!, parts: [{ type: 'text', text: `${baseText} more tokens` }] }])
      expect(summaryNotifies).not.toHaveBeenCalled()
      expect(store.getSummary().lastText).toBe(`${'a'.repeat(220)}…`)

      // Adding a tool call or changing message count still recomputes accurate toolCount and notifies summary subscribers.
      store.update((current) => [
        current[0]!,
        { ...current[1]!, parts: [{ type: 'text', text: `${baseText} more tokens` }, { type: 'toolCall', id: 'new-1', name: 'Write' }] },
      ])
      expect(summaryNotifies).toHaveBeenCalledTimes(1)
      expect(store.getSummary().toolCount).toBe(2)

      store.update((current) => [
        ...current,
        { id: 'tail-2', role: 'assistant', timestamp: 3, streaming: true, parts: [{ type: 'text', text: 'Next turn' }] },
      ])
      expect(summaryNotifies).toHaveBeenCalledTimes(2)
      expect(store.getSummary()).toMatchObject({ toolCount: 2, lastText: 'Next turn' })
    } finally { offSummary() }
  })
})

describe('git refresh scheduling', () => {
  it('fires once when an externally running session stops, never per catalog tick', () => {
    expect(shouldRefreshGitOnSessionTransition('running', 'running', false)).toBe(false)
    expect(shouldRefreshGitOnSessionTransition('running', 'complete', false)).toBe(true)
    expect(shouldRefreshGitOnSessionTransition('complete', 'complete', false)).toBe(false)
    expect(shouldRefreshGitOnSessionTransition('idle', 'complete', false)).toBe(false)
    expect(shouldRefreshGitOnSessionTransition(undefined, 'complete', false)).toBe(false)
    expect(shouldRefreshGitOnSessionTransition('running', undefined, false)).toBe(false)
    expect(shouldRefreshGitOnSessionTransition('running', 'complete', true)).toBe(false)
  })
})

describe('scoped async ownership', () => {
  it('rejects stale request generations and paths', () => {
    const guard = createScopedRequestGuard()
    const global = guard.begin(3)
    const project = guard.begin(4, '/project')
    expect(guard.isCurrent(global, 3)).toBe(false)
    expect(guard.isCurrent(project, 4, '/other')).toBe(false)
    expect(guard.isCurrent(project, 3, '/project')).toBe(false)
    expect(guard.isCurrent(project, 4, '/project')).toBe(true)
    guard.invalidate()
    expect(guard.isCurrent(project, 4, '/project')).toBe(false)
  })

})

describe('transcript tail reads', () => {
  const assistant = (id: string, outcome?: TranscriptMessage['outcome']): TranscriptMessage => ({ id, role: 'assistant', parts: [], ...(outcome ? { outcome } : {}) })
  const user = (id: string): TranscriptMessage => ({ id, role: 'user', parts: [] })

  it('finds the newest assistant row from the tail without copying the transcript', () => {
    const messages = [assistant('first'), user('u1'), assistant('second', 'cancelled'), user('tail')]
    expect(lastAssistantMessage(messages)?.id).toBe('second')
    expect(lastAssistantMessage(messages)?.outcome).toBe('cancelled')
    expect(lastAssistantMessage([assistant('only')])?.id).toBe('only')
    expect(lastAssistantMessage([user('u1'), user('u2')])).toBeUndefined()
    expect(lastAssistantMessage([])).toBeUndefined()
  })
})
