import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentEventForwarder } from '../../electron/main/agent-rpc'

// Complements tests/backend/security.test.ts, which already covers the
// envelope byte bound, aggregate window byte bound for normal events, and
// agent_end surviving count saturation. These tests pin the runtime_exit
// exemption, exactly-once limit reporting, and the reserve interplay.

interface Forwarded { runtimeId: string; event: Record<string, unknown> }

function forwarder(limits: Partial<{ maxEvents: number; maxEnvelopeBytes: number; maxWindowBytes: number; windowMs: number }>): { events: Forwarded['event'][]; emit: (event: Record<string, unknown>, eventBytesHint?: number) => void } {
  const events: Forwarded['event'][] = []
  const instance = new AgentEventForwarder('runtime-test', (envelope: Forwarded) => events.push(envelope.event), limits)
  return { events, emit: (event, eventBytesHint) => instance.emit(event, eventBytesHint) }
}

const bytesOf = (event: Record<string, unknown>) => Buffer.byteLength(JSON.stringify({ runtimeId: 'runtime-test', event }), 'utf8')

afterEach(() => { vi.useRealTimers() })

describe('AgentEventForwarder runtime_exit exemption', () => {
  it('delivers runtime_exit exactly once per runtime while the normal-event limiter is saturated', () => {
    const { events, emit } = forwarder({ maxEvents: 3, windowMs: 60_000 })
    for (let index = 0; index < 20; index += 1) emit({ type: 'message_update', index })
    emit({ type: 'runtime_exit', code: 1, expected: false })
    emit({ type: 'runtime_exit', code: 1, expected: false })

    expect(events.filter((event) => event.type === 'message_update')).toHaveLength(3)
    // runtime_exit bypasses the limiter but is deduplicated per runtime lifetime.
    expect(events.filter((event) => event.type === 'runtime_exit')).toHaveLength(1)
    // Saturation is reported exactly once per window, not once per drop.
    expect(events.filter((event) => event.type === 'transport_limit')).toHaveLength(1)
  })

  it('lets critical events spend the byte reserve that normal events cannot touch', () => {
    const { events, emit } = forwarder({ maxEvents: 100, maxEnvelopeBytes: 10_000, maxWindowBytes: 1_000, windowMs: 60_000 })
    // reserve = min(64 KiB, 1000/4) = 250, so normal events stop at 750 bytes.
    const filler = { type: 'message_update', value: 'x'.repeat(700 - bytesOf({ type: 'message_update', value: '' })) }
    expect(bytesOf(filler)).toBe(700)
    emit(filler)
    expect(events).toHaveLength(1)

    const blocked = { type: 'message_update', value: 'y'.repeat(60) }
    emit(blocked)
    expect(events.filter((event) => event.type === 'message_update')).toHaveLength(1)
    const byteReports = events.filter((event) => event.type === 'transport_limit')
    expect(byteReports).toHaveLength(1)
    expect(String(byteReports[0].error)).toContain('byte rate')

    // A runtime_exit of comparable size still fits inside the reserved
    // headroom between 750 and the full 1000-byte window.
    emit({ type: 'runtime_exit', code: 3, expected: false })
    expect(events.filter((event) => event.type === 'runtime_exit')).toHaveLength(1)

    // The full window cap still applies to critical events; the drop is
    // silent because the bytes limit was already reported this window.
    emit({ type: 'runtime_exit', code: 3, expected: false, padding: 'z'.repeat(400) })
    expect(events.filter((event) => event.type === 'runtime_exit')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'transport_limit')).toHaveLength(1)
  })

  it('caps repeated lifecycle events while runtime_exit stays deduplicated', () => {
    const { events, emit } = forwarder({ maxEvents: 5, windowMs: 60_000 })
    for (let index = 0; index < 40; index += 1) emit({ type: 'runtime_exit', code: 0, expected: true })
    // runtime_exit is terminal: repeated emits collapse to the single delivery.
    expect(events.filter((event) => event.type === 'runtime_exit')).toHaveLength(1)
    for (let index = 0; index < 40; index += 1) emit({ type: 'agent_start', index })
    const started = events.filter((event) => event.type === 'agent_start').length
    expect(started).toBeGreaterThan(5)
    expect(started).toBeLessThanOrEqual(32)
  })

  it('resets saturation and reporting when the window rolls over', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { events, emit } = forwarder({ maxEvents: 1, windowMs: 1_000 })
    emit({ type: 'message_update', index: 0 })
    emit({ type: 'message_update', index: 1 })
    expect(events.map((event) => event.type)).toEqual(['message_update', 'transport_limit'])

    vi.setSystemTime(1_001_500)
    emit({ type: 'message_update', index: 2 })
    emit({ type: 'message_update', index: 3 })
    expect(events.filter((event) => event.type === 'message_update')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'transport_limit')).toHaveLength(2)
  })
})

describe('AgentEventForwarder frame byte hints', () => {
  it('measures a hinted event by its hint instead of reserializing it', () => {
    const { events, emit } = forwarder({ maxEnvelopeBytes: 1_000, maxWindowBytes: 10_000, windowMs: 60_000 })
    const large = { type: 'message_update', text: 'x'.repeat(5_000) }
    // Without the hint this envelope would exceed the limit; the hint is what
    // the runtime measured from the raw frame, so it is authoritative.
    expect(bytesOf(large)).toBeGreaterThan(1_000)
    emit(large, 512)
    expect(events).toEqual([large])
  })

  it('drops a hinted event whose bound exceeds the envelope limit', () => {
    const { events, emit } = forwarder({ maxEnvelopeBytes: 1_000, maxWindowBytes: 10_000, windowMs: 60_000 })
    emit({ type: 'message_update' }, 1_000)
    expect(events.map((event) => event.type)).toEqual(['transport_limit'])
    expect(String(events[0].error)).toContain('envelope')
  })

  it('charges the window by hinted bytes', () => {
    const { events, emit } = forwarder({ maxEnvelopeBytes: 100_000, maxWindowBytes: 1_000, windowMs: 60_000 })
    // reserve = min(64 KiB, 1000/4) = 250, so normal events stop at 750 bytes;
    // each hinted event costs 500 + 37 envelope bytes.
    emit({ type: 'message_update', index: 0 }, 500)
    emit({ type: 'message_update', index: 1 }, 500)
    expect(events.filter((event) => event.type === 'message_update')).toHaveLength(1)
    const byteReports = events.filter((event) => event.type === 'transport_limit')
    expect(byteReports).toHaveLength(1)
    expect(String(byteReports[0].error)).toContain('byte rate')
  })
})
