import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTurnMetrics, observeTurnEvent, resetTurnMetrics, subscribeTurnMetrics } from '../../src/lib/events/turn-metrics'

let now = 0

beforeEach(() => {
  now = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetTurnMetrics()
})

function advance(to: number): void {
  now = to
}

function sessionUsage(output: number): Record<string, unknown> {
  return { type: 'session_usage', sessionUsage: { cost: 0, tokens: { input: 10, output, cacheRead: 0, cacheWrite: 0, total: output + 10 } } }
}

function messageUpdate(deltaType: string, text: string): Record<string, unknown> {
  return { type: 'message_update', assistantMessageEvent: { type: deltaType, delta: text } }
}

describe('turn-metrics TTFT', () => {
  it('measures agent_start to the first content delta', () => {
    observeTurnEvent('rt-a', { type: 'agent_start' })
    expect(getTurnMetrics('rt-a').ttftMs).toBeNull()
    advance(1_800)
    observeTurnEvent('rt-a', messageUpdate('text_delta', 'h'))
    expect(getTurnMetrics('rt-a').ttftMs).toBe(800)
  })

  it('accepts thinking deltas and the raw.delta event shape', () => {
    observeTurnEvent('rt-b', { type: 'turn_start' })
    advance(2_500)
    observeTurnEvent('rt-b', { type: 'message_update', delta: { type: 'thinking_delta', delta: '嗯' } })
    expect(getTurnMetrics('rt-b').ttftMs).toBe(1_500)
  })

  it('ignores deltas without content and non-message events', () => {
    observeTurnEvent('rt-c', { type: 'agent_start' })
    advance(1_400)
    observeTurnEvent('rt-c', messageUpdate('text_delta', ''))
    observeTurnEvent('rt-c', messageUpdate('toolcall_end', 'x'))
    observeTurnEvent('rt-c', { type: 'context_usage' })
    expect(getTurnMetrics('rt-c').ttftMs).toBeNull()
  })
})

describe('turn-metrics TPS', () => {
  it('derives tokens per second from the session_usage delta over the streaming span', () => {
    observeTurnEvent('rt-d', sessionUsage(100))
    observeTurnEvent('rt-d', { type: 'agent_start' })
    advance(1_500)
    observeTurnEvent('rt-d', messageUpdate('text_delta', 'a'))
    advance(2_500)
    observeTurnEvent('rt-d', messageUpdate('text_delta', 'b'))
    observeTurnEvent('rt-d', sessionUsage(142))
    advance(2_600)
    observeTurnEvent('rt-d', { type: 'agent_end' })
    const metrics = getTurnMetrics('rt-d')
    expect(metrics.ttftMs).toBe(500)
    // The generation window runs from the first token to agent_end (1.1s).
    expect(metrics.tokensPerSecond).toBeCloseTo(42 / 1.1, 5)
  })

  it('still derives TPS when every delta lands in the same tick', () => {
    // Renderer batching: deltas can arrive together, so first === last. The
    // measurement window must come from agent_end, not the streaming span.
    observeTurnEvent('rt-batch', sessionUsage(0))
    observeTurnEvent('rt-batch', { type: 'agent_start' })
    advance(1_500)
    observeTurnEvent('rt-batch', messageUpdate('text_delta', 'a'))
    observeTurnEvent('rt-batch', messageUpdate('text_delta', 'b'))
    observeTurnEvent('rt-batch', sessionUsage(60))
    advance(3_500)
    observeTurnEvent('rt-batch', { type: 'agent_end' })
    const metrics = getTurnMetrics('rt-batch')
    expect(metrics.ttftMs).toBe(500)
    expect(metrics.tokensPerSecond).toBeCloseTo(30, 5)
  })

  it('finalizes when the closing session_usage arrives after agent_end', () => {
    observeTurnEvent('rt-e', sessionUsage(7))
    observeTurnEvent('rt-e', { type: 'agent_start' })
    advance(1_200)
    observeTurnEvent('rt-e', messageUpdate('text_delta', 'a'))
    advance(2_200)
    observeTurnEvent('rt-e', messageUpdate('text_delta', 'b'))
    observeTurnEvent('rt-e', { type: 'agent_end' })
    expect(getTurnMetrics('rt-e').tokensPerSecond).toBeNull()
    observeTurnEvent('rt-e', sessionUsage(27))
    expect(getTurnMetrics('rt-e').tokensPerSecond).toBeCloseTo(20, 5)
  })

  it('treats a pre-delta in-turn usage read as the baseline', () => {
    observeTurnEvent('rt-f', { type: 'agent_start' })
    observeTurnEvent('rt-f', sessionUsage(50))
    advance(1_000)
    observeTurnEvent('rt-f', messageUpdate('text_delta', 'a'))
    advance(2_000)
    observeTurnEvent('rt-f', messageUpdate('text_delta', 'b'))
    observeTurnEvent('rt-f', sessionUsage(60))
    observeTurnEvent('rt-f', { type: 'agent_end' })
    expect(getTurnMetrics('rt-f').tokensPerSecond).toBeCloseTo(10, 5)
  })

  it('keeps TPS absent when no baseline is knowable', () => {
    observeTurnEvent('rt-g', { type: 'agent_start' })
    advance(1_000)
    observeTurnEvent('rt-g', messageUpdate('text_delta', 'a'))
    advance(2_000)
    observeTurnEvent('rt-g', sessionUsage(99))
    observeTurnEvent('rt-g', { type: 'agent_end' })
    expect(getTurnMetrics('rt-g').tokensPerSecond).toBeNull()
  })
})

describe('turn-metrics auto-retry continuity', () => {
  it('continues the same turn across auto_retry_start without resetting TTFT', () => {
    observeTurnEvent('rt-h', sessionUsage(0))
    observeTurnEvent('rt-h', { type: 'agent_start' })
    advance(1_500)
    observeTurnEvent('rt-h', messageUpdate('text_delta', 'a'))
    advance(2_000)
    observeTurnEvent('rt-h', { type: 'agent_end' })
    observeTurnEvent('rt-h', { type: 'auto_retry_start' })
    observeTurnEvent('rt-h', { type: 'agent_start' })
    expect(getTurnMetrics('rt-h').ttftMs).toBe(500)
    advance(4_000)
    observeTurnEvent('rt-h', messageUpdate('text_delta', 'b'))
    advance(6_000)
    observeTurnEvent('rt-h', messageUpdate('text_delta', 'c'))
    observeTurnEvent('rt-h', sessionUsage(33))
    observeTurnEvent('rt-h', { type: 'agent_end' })
    const metrics = getTurnMetrics('rt-h')
    expect(metrics.ttftMs).toBe(500)
    expect(metrics.tokensPerSecond).toBeCloseTo(33 / 4.5, 5)
  })

  it('finalizes on a failed auto_retry_end', () => {
    observeTurnEvent('rt-i', sessionUsage(10))
    observeTurnEvent('rt-i', { type: 'agent_start' })
    advance(1_100)
    observeTurnEvent('rt-i', messageUpdate('text_delta', 'a'))
    advance(2_100)
    observeTurnEvent('rt-i', messageUpdate('text_delta', 'b'))
    observeTurnEvent('rt-i', { type: 'agent_end' })
    observeTurnEvent('rt-i', { type: 'auto_retry_start' })
    observeTurnEvent('rt-i', sessionUsage(20))
    observeTurnEvent('rt-i', { type: 'auto_retry_end', success: false })
    expect(getTurnMetrics('rt-i').tokensPerSecond).toBeCloseTo(10, 5)
  })

  it('opens a fresh turn once the retried turn has ended', () => {
    observeTurnEvent('rt-j', sessionUsage(0))
    observeTurnEvent('rt-j', { type: 'agent_start' })
    advance(1_200)
    observeTurnEvent('rt-j', messageUpdate('text_delta', 'a'))
    observeTurnEvent('rt-j', { type: 'agent_end' })
    observeTurnEvent('rt-j', { type: 'auto_retry_start' })
    observeTurnEvent('rt-j', { type: 'agent_end' })
    advance(5_000)
    observeTurnEvent('rt-j', { type: 'agent_start' })
    expect(getTurnMetrics('rt-j')).toEqual({ ttftMs: null, tokensPerSecond: null })
  })
})

describe('turn-metrics runtime scoping and reset', () => {
  it('scopes snapshots per runtime', () => {
    observeTurnEvent('rt-k', { type: 'agent_start' })
    advance(1_300)
    observeTurnEvent('rt-k', messageUpdate('text_delta', 'a'))
    expect(getTurnMetrics('rt-k').ttftMs).toBe(300)
    expect(getTurnMetrics('rt-other')).toEqual({ ttftMs: null, tokensPerSecond: null })
    expect(getTurnMetrics()).toEqual({ ttftMs: null, tokensPerSecond: null })
  })

  it('clears a runtime on resetTurnMetrics', () => {
    observeTurnEvent('rt-l', sessionUsage(5))
    observeTurnEvent('rt-l', { type: 'agent_start' })
    advance(1_400)
    observeTurnEvent('rt-l', messageUpdate('text_delta', 'a'))
    expect(getTurnMetrics('rt-l').ttftMs).toBe(400)
    resetTurnMetrics('rt-l')
    expect(getTurnMetrics('rt-l')).toEqual({ ttftMs: null, tokensPerSecond: null })
    // 基線一併清除:同 runtime 的下一個回合從新的累計讀數重新起算。
    observeTurnEvent('rt-l', sessionUsage(0))
    observeTurnEvent('rt-l', { type: 'agent_start' })
    advance(2_400)
    observeTurnEvent('rt-l', messageUpdate('text_delta', 'a'))
    advance(3_400)
    observeTurnEvent('rt-l', messageUpdate('text_delta', 'b'))
    advance(3_400)
    observeTurnEvent('rt-l', sessionUsage(12))
    observeTurnEvent('rt-l', { type: 'agent_end' })
    expect(getTurnMetrics('rt-l').tokensPerSecond).toBeCloseTo(12, 5)
  })
})

describe('turn-metrics snapshot stability', () => {
  it('keeps the same snapshot object until a value changes', () => {
    let notifications = 0
    const unsubscribe = subscribeTurnMetrics(() => { notifications += 1 })
    observeTurnEvent('rt-m', sessionUsage(0))
    observeTurnEvent('rt-m', { type: 'agent_start' })
    expect(notifications).toBe(0)
    advance(1_250)
    observeTurnEvent('rt-m', messageUpdate('text_delta', 'a'))
    expect(notifications).toBe(1)
    const afterFirst = getTurnMetrics('rt-m')
    advance(1_500)
    observeTurnEvent('rt-m', messageUpdate('text_delta', 'b'))
    observeTurnEvent('rt-m', messageUpdate('thinking_delta', 'c'))
    expect(getTurnMetrics('rt-m')).toBe(afterFirst)
    expect(notifications).toBe(1)
    advance(2_500)
    observeTurnEvent('rt-m', sessionUsage(25))
    observeTurnEvent('rt-m', { type: 'agent_end' })
    expect(getTurnMetrics('rt-m')).not.toBe(afterFirst)
    expect(notifications).toBe(2)
    unsubscribe()
  })

  it('does not notify when a new turn starts with nothing to clear', () => {
    let notifications = 0
    const unsubscribe = subscribeTurnMetrics(() => { notifications += 1 })
    observeTurnEvent('rt-n', { type: 'agent_start' })
    observeTurnEvent('rt-n', { type: 'agent_end' })
    observeTurnEvent('rt-n', { type: 'agent_start' })
    expect(notifications).toBe(0)
    expect(getTurnMetrics('rt-n')).toBe(getTurnMetrics('rt-zzz'))
    unsubscribe()
  })

  it('clears the previous turn values when a new turn opens', () => {
    observeTurnEvent('rt-o', sessionUsage(0))
    observeTurnEvent('rt-o', { type: 'agent_start' })
    advance(1_100)
    observeTurnEvent('rt-o', messageUpdate('text_delta', 'a'))
    advance(2_100)
    observeTurnEvent('rt-o', messageUpdate('text_delta', 'b'))
    observeTurnEvent('rt-o', sessionUsage(20))
    observeTurnEvent('rt-o', { type: 'agent_end' })
    expect(getTurnMetrics('rt-o').tokensPerSecond).not.toBeNull()
    observeTurnEvent('rt-o', { type: 'agent_start' })
    expect(getTurnMetrics('rt-o')).toEqual({ ttftMs: null, tokensPerSecond: null })
  })
})
