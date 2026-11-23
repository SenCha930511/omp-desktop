import { describe, expect, it } from 'vitest'
import {
  applyPageResultToPagination,
  INITIAL_HISTORY_PAGINATION,
  mergeNewestTranscriptTail,
  prependOlderPage,
} from '../../src/lib/session-pagination'
import type { TranscriptMessage } from '../../src/types/api'

function msg(id: string, text = id): TranscriptMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

describe('session pagination state helpers', () => {
  it('prepends older pages before the anchor and deduplicates existing ids', () => {
    const current = [msg('m3'), msg('m4'), msg('local-tail')]
    const older = [msg('m1'), msg('m2'), msg('m3')]
    const next = prependOlderPage(current, older, 'm3')
    expect(next.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'local-tail'])
  })

  it('returns the exact array identity when older page has no new messages', () => {
    const current = [msg('m1'), msg('m2')]
    expect(prependOlderPage(current, [], null)).toBe(current)
    expect(prependOlderPage(current, [msg('m1')], null)).toBe(current)
  })

  it('tracks ok, stale, and unavailable page states cleanly', () => {
    const ready = applyPageResultToPagination(INITIAL_HISTORY_PAGINATION, {
      status: 'ok',
      snapshotId: 'snap-1',
      messages: [msg('m3')],
      endExclusiveMessageId: null,
      remaining: { textChars: 100, toolChars: 100, argsChars: 100, imageChars: 100, parts: 10 },
      older: { state: 'ready', cursor: 'cur-1' },
    }, false)
    expect(ready).toMatchObject({ snapshotId: 'snap-1', older: { state: 'ready', cursor: 'cur-1' }, hasLoadedOlder: false })

    const olderLoaded = applyPageResultToPagination(ready, {
      status: 'ok',
      snapshotId: 'snap-1',
      messages: [msg('m1'), msg('m2')],
      endExclusiveMessageId: 'm3',
      remaining: { textChars: 50, toolChars: 50, argsChars: 50, imageChars: 50, parts: 5 },
      older: { state: 'unavailable', reason: 'display-budget' },
    }, true)
    expect(olderLoaded.hasLoadedOlder).toBe(true)
    expect(olderLoaded.older).toEqual({ state: 'unavailable', reason: 'display-budget' })

    const stale = applyPageResultToPagination(olderLoaded, { status: 'stale', reason: 'file-changed' }, true)
    expect(stale.staleReason).toBe('file-changed')
    expect(stale.snapshotId).toBeNull()
  })

  it('preserves loaded older prefix when reconciling the newest transcript tail', () => {
    const current = [msg('m1'), msg('m2'), msg('m3'), msg('m4', 'old')]
    const incoming = [msg('m3'), msg('m4', 'updated'), msg('m5')]
    const merged = mergeNewestTranscriptTail(current, incoming, true, (_curTail, nextTail) => nextTail)
    expect(merged.map((m) => `${m.id}:${m.parts[0].type === 'text' ? m.parts[0].text : ''}`)).toEqual([
      'm1:m1',
      'm2:m2',
      'm3:m3',
      'm4:updated',
      'm5:m5',
    ])
  })
})
