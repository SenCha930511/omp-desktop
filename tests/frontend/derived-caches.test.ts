import { describe, expect, it } from 'vitest'
import { deriveOmpBackgroundTasks } from '../../src/lib/omp-background-tasks'
import { dedupeSubagentMessages } from '../../src/hooks/useSubagents'
import { tokenizeSyntax, tokenizeSyntaxCached } from '../../src/components/transcript/syntax'
import type { MessagePart, TranscriptMessage } from '../../src/types/api'

type RawMessage = Record<string, unknown>

/** The Map + sort definition the streaming fast path must reproduce exactly. */
function referenceDedupe(current: RawMessage[], incoming: unknown[]): RawMessage[] {
  if (!incoming.length) return current
  const messages = new Map(current.map((message) => [`${message.role}:${message.timestamp}`, message]))
  for (const raw of incoming) {
    const message = raw as RawMessage
    if (message && typeof message.role === 'string' && typeof message.timestamp === 'number') messages.set(`${message.role}:${message.timestamp}`, message)
  }
  return [...messages.values()].sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
}

const message = (role: string, timestamp: number, text: string): RawMessage => ({ role, timestamp, text })

describe('dedupeSubagentMessages streaming fast path', () => {
  it('appends newer messages in one pass without changing the result', () => {
    const current = [message('user', 1, 'a'), message('assistant', 2, 'b')]
    const incoming = [message('assistant', 3, 'c'), message('tool', 4, 'd')]
    expect(dedupeSubagentMessages(current, incoming)).toEqual(referenceDedupe(current, incoming))
    expect(dedupeSubagentMessages(current, incoming).at(-1)).toBe(incoming[1])
  })

  it('replaces the tail in place when role and timestamp repeat', () => {
    const current = [message('user', 1, 'a'), message('assistant', 2, 'draft')]
    const incoming = [message('assistant', 2, 'final')]
    const merged = dedupeSubagentMessages(current, incoming)
    expect(merged).toHaveLength(2)
    expect(merged.at(-1)).toBe(incoming[0])
    expect(merged).toEqual(referenceDedupe(current, incoming))
  })

  it('keeps only the last duplicate inside one incoming batch', () => {
    const current = [message('user', 1, 'a')]
    const incoming = [message('assistant', 2, 'first'), message('assistant', 2, 'second')]
    const merged = dedupeSubagentMessages(current, incoming)
    expect(merged).toHaveLength(2)
    expect((merged.at(-1) as RawMessage).text).toBe('second')
    expect(merged).toEqual(referenceDedupe(current, incoming))
  })

  it('falls back to the Map path for out-of-order timestamps', () => {
    const current = [message('user', 1, 'a'), message('assistant', 5, 'b')]
    const incoming = [message('user', 3, 'late')]
    const merged = dedupeSubagentMessages(current, incoming)
    expect(merged.map((entry) => entry.timestamp)).toEqual([1, 3, 5])
    expect(merged).toEqual(referenceDedupe(current, incoming))
  })

  it('falls back for an unsorted current transcript', () => {
    const current = [message('assistant', 5, 'b'), message('user', 1, 'a')]
    const incoming = [message('assistant', 9, 'c')]
    expect(dedupeSubagentMessages(current, incoming)).toEqual(referenceDedupe(current, incoming))
  })

  it('falls back for a non-numeric timestamp without throwing', () => {
    const current = [message('user', 1, 'a')]
    const incoming = [{ role: 'assistant', timestamp: 'soon', text: 'x' }]
    expect(() => dedupeSubagentMessages(current, incoming)).not.toThrow()
    expect(dedupeSubagentMessages(current, incoming)).toHaveLength(1)
  })

  it('returns the current array when the batch adds nothing', () => {
    const current = [message('user', 1, 'a')]
    expect(dedupeSubagentMessages(current, [])).toBe(current)
    expect(dedupeSubagentMessages(current, [{ role: 1 }])).toBe(current)
  })
})

describe('deriveOmpBackgroundTasks completed-message cache', () => {
  const toolCall: MessagePart = { type: 'toolCall', id: 'call-1', name: 'Bash', args: { command: 'npm run build:watch' } }
  const completed: TranscriptMessage = {
    id: 'assistant-1',
    role: 'assistant',
    timestamp: 1,
    parts: [
      toolCall,
      { type: 'toolResult', partId: 'call-1', name: 'Bash', text: 'Backgrounded as job job-7\n[job-7] bash (running) - watch' },
      { type: 'text', text: 'Cancelled background job job-8' },
    ],
  }
  const user: TranscriptMessage = { id: 'user-1', role: 'user', timestamp: 0, parts: [{ type: 'text', text: 'go' }] }

  it('produces the same tasks on repeated derivations', () => {
    const messages = [user, completed]
    const first = deriveOmpBackgroundTasks({ messages })
    const second = deriveOmpBackgroundTasks({ messages })
    expect(second).toEqual(first)
    expect(first.map((task) => [task.id, task.kind, task.status])).toEqual([['job-7', 'job', 'running']])
  })

  it('replays cached ops in message order so a later status update still wins', () => {
    const later: TranscriptMessage = { id: 'user-2', role: 'user', timestamp: 2, parts: [{ type: 'text', text: 'job-7 completed' }] }
    const messages = [user, completed, later]
    expect(deriveOmpBackgroundTasks({ messages })).toEqual(deriveOmpBackgroundTasks({ messages: [...messages] }))
  })

  it('rescans the streaming message so its open tool call appears and disappears', () => {
    const streaming: TranscriptMessage = { id: 'assistant-2', role: 'assistant', timestamp: 3, streaming: true, parts: [toolCall] }
    const live = deriveOmpBackgroundTasks({ messages: [user, streaming], isStreaming: true })
    expect(live.map((task) => [task.id, task.kind])).toContainEqual(['call-1', 'tool'])
    const finished = deriveOmpBackgroundTasks({ messages: [user, { ...streaming, streaming: false }], isStreaming: false })
    expect(finished).toEqual([])
  })
})

describe('tokenizeSyntaxCached', () => {
  it('returns the same tokens as the uncached tokenizer', () => {
    const text = 'const answer = 42 // comment'
    expect(tokenizeSyntaxCached(text)).toEqual(tokenizeSyntax(text))
  })

  it('serves a repeated text from the cache', () => {
    const text = 'function cached() { return 1 }'
    const first = tokenizeSyntaxCached(text)
    expect(tokenizeSyntaxCached(text)).toBe(first)
  })

  it('bypasses the cache for oversized text', () => {
    const text = 'x'.repeat(16_385)
    expect(tokenizeSyntaxCached(text)).toEqual(tokenizeSyntax(text))
    expect(tokenizeSyntaxCached(text)).not.toBe(tokenizeSyntaxCached(text))
  })
})
