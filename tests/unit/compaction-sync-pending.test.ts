import { describe, expect, it } from 'vitest'
import { applyCompactionEvent, isCompactionEvent } from '../../src/lib/events/compaction'
import type { TranscriptMessage } from '../../src/types/api'

describe('compaction synchronization pending', () => {
  it('makes a lost completion visible without declaring a result, and accepts the late authoritative completion', () => {
    const started = applyCompactionEvent([], { type: 'compaction_start', reason: 'threshold' })!
    expect(isCompactionEvent({ type: 'compaction_sync_pending' })).toBe(true)
    const pending = applyCompactionEvent(started, { type: 'compaction_sync_pending' })!
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ streaming: false, parts: [{ type: 'compaction', status: 'sync_pending', reason: 'threshold' }] })
    expect(pending[0].completedAt).toBeUndefined()
    expect(pending[0].parts[0]).not.toHaveProperty('outcome')
    const finished = applyCompactionEvent(pending, {
      type: 'compaction_end', reason: 'threshold', aborted: false,
      result: { summary: 'Authoritative summary', tokensBefore: 40_000, tokensAfter: 8_000, firstKeptEntryId: 'kept' },
    })!
    expect(finished).toHaveLength(1)
    expect(finished[0].id).toBe(started[0].id)
    expect(finished[0]).toMatchObject({ streaming: false, completedAt: expect.any(Number), parts: [{ type: 'compaction', status: 'done', summary: 'Authoritative summary' }] })
  })

  it('does not downgrade an already authoritative completed result on a stale pending signal', () => {
    const completed = applyCompactionEvent([], { type: 'compaction_end', result: { summary: 'Known result', tokensBefore: 40_000 } })!
    const pending = applyCompactionEvent(completed, { type: 'compaction_sync_pending' })
    expect(pending).toBe(completed)
  })

  it('does not create a result for an unrelated pending signal without a running compaction', () => {
    const messages: TranscriptMessage[] = []
    expect(applyCompactionEvent(messages, { type: 'compaction_sync_pending' })).toBe(messages)
  })
})
