import { expect, it } from 'vitest'
import { activityState, conversationExecution } from '../../src/lib/execution-state'
import { prioritizeSubagents, subagentExecution } from '../../src/lib/subagent-activity'
import type { RuntimeInfo, TranscriptMessage } from '../../src/types/api'

const runtime: RuntimeInfo = { runtimeId: 'r', harness: 'omp', cwd: '/project', isStreaming: true }
const assistant: TranscriptMessage = { id: 'a', role: 'assistant', startedAt: 1000, streaming: true, parts: [{ type: 'thinking', text: 'Inspecting' }] }
const base = { runtime: null, messages: [], submitting: false, waiting: false }

it('derives startup, reasoning, tools and user input from structured signals', () => {
  expect(conversationExecution(base).phase).toBe('idle')
  expect(conversationExecution({ ...base, submitting: true, messages: [assistant] }).phase).toBe('starting')
  expect(conversationExecution({ ...base, runtime, messages: [assistant] }).phase).toBe('thinking')
  expect(conversationExecution({ ...base, runtime, messages: [assistant], waiting: true }).phase).toBe('waiting')
  expect(conversationExecution({ ...base, runtime: { ...runtime, isCompacting: true } }).phase).toBe('compacting')
  expect(activityState([{ type: 'toolCall', id: 'x', name: 'bash' }])).toEqual({ phase: 'running', detail: 'bash' })
  expect(activityState([{ type: 'toolCall', id: 'x', name: 'ask_user' }]).phase).toBe('waiting')
  expect(activityState([{ type: 'toolCall', id: 'x', name: 'ask_user' }, { type: 'toolResult', text: 'answered' }, { type: 'thinking', text: 'Continuing' }]).phase).toBe('thinking')
})

it('reads an in-flight compact as compacting, timed from the click', () => {
  expect(conversationExecution({ ...base, submitting: true, messages: [assistant] })).toMatchObject({ phase: 'starting' })
  expect(conversationExecution({ ...base, submitting: true, submittingKind: 'compact', submittingSince: 5000, messages: [assistant] }))
    .toMatchObject({ phase: 'starting', since: 5000 })
  expect(conversationExecution({ ...base, runtime: { ...runtime, isStreaming: false }, submitting: true, submittingKind: 'compact', submittingSince: 5000 }))
    .toMatchObject({ phase: 'compacting', since: 5000 })
  // The runtime's own compacting flag still wins once omp reports it.
  expect(conversationExecution({ ...base, runtime: { ...runtime, isCompacting: true }, submitting: true, submittingKind: 'compact' }).phase).toBe('compacting')
})

it('keeps failures and user cancellation distinct from normal completion', () => {
  const done: TranscriptMessage = { ...assistant, streaming: false, completedAt: 2000, parts: [{ type: 'text', text: 'Done' }] }
  expect(conversationExecution({ ...base, messages: [done] })).toMatchObject({ phase: 'completed', since: 1000, until: 2000 })
  expect(conversationExecution({ ...base, messages: [{ ...done, outcome: 'cancelled' }] }).phase).toBe('cancelled')
  expect(conversationExecution({ ...base, messages: [done], sessionStatus: 'failed' }).phase).toBe('failed')
  expect(conversationExecution({ ...base, messages: [done, { id: 'error-1', role: 'system', timestamp: 3000, parts: [{ type: 'text', text: 'Transport failed' }] }] }).phase).toBe('failed')
  expect(conversationExecution({ ...base, messages: [{ ...done, parts: [{ type: 'text', text: 'The words failed and waiting are ordinary output.' }] }] }).phase).toBe('completed')
})

it('prioritizes agents needing input and failures without reordering peers', () => {
  const make = (id: string, status: string, tool?: string) => ({ id, agent: id, status, progress: tool ? { currentTool: tool } : undefined, messages: [] })
  const agents = [make('done', 'completed', 'ask_user'), make('active-a', 'running', 'bash'), make('failed', 'failed', 'bash'), make('waiting', 'running', 'ask_user'), make('active-b', 'running')]
  expect(prioritizeSubagents(agents).map((agent) => agent.id)).toEqual(['waiting', 'failed', 'active-a', 'active-b', 'done'])
  expect(subagentExecution(agents[0]).phase).toBe('completed')
  expect(subagentExecution(make('other', 'unrecognized')).phase).toBe('unknown')
  expect(agents[0].id).toBe('done')
})
