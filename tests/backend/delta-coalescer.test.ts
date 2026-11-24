import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStreamingDeltaCoalescer } from '../../electron/main/agent-rpc/delta-coalescer'
import type { PrimeEventEnvelope } from '../../src/types/api'

function deltaEvent(runtimeId: string, delta: string, type: 'text_delta' | 'thinking_delta' = 'text_delta'): PrimeEventEnvelope {
  return {
    runtimeId,
    event: {
      type: 'message_update',
      message: { role: 'assistant', content: 'full snapshot' },
      assistantMessageEvent: { type, delta, contentIndex: 0, partial: { growing: true } },
    },
  }
}

function setup() {
  const delivered: PrimeEventEnvelope[] = []
  const coalescer = createStreamingDeltaCoalescer((envelope) => delivered.push(envelope), 12)
  return { delivered, coalescer }
}

describe('streaming delta coalescer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sends the first delta immediately and strips the growing snapshots', () => {
    const { delivered, coalescer } = setup()
    coalescer.push(deltaEvent('runtime-1', 'hel'))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toEqual({ runtimeId: 'runtime-1', event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hel' } } })
    coalescer.dispose()
  })

  it('concatenates the deltas inside one window into a single event', () => {
    const { delivered, coalescer } = setup()
    coalescer.push(deltaEvent('runtime-1', 'a'))
    coalescer.push(deltaEvent('runtime-1', 'b'))
    coalescer.push(deltaEvent('runtime-1', 'c'))
    expect(delivered).toHaveLength(1)
    vi.advanceTimersByTime(12)
    expect(delivered).toHaveLength(2)
    expect(delivered[1].event).toEqual({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'bc' } })
    coalescer.dispose()
  })

  it('flushes a pending batch synchronously before any other event', () => {
    const { delivered, coalescer } = setup()
    coalescer.push(deltaEvent('runtime-1', 'a'))
    coalescer.push(deltaEvent('runtime-1', 'b'))
    coalescer.push({ runtimeId: 'runtime-1', event: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'Read' } })
    expect(delivered.map(({ event }) => event.type)).toEqual(['message_update', 'message_update', 'tool_execution_start'])
    expect(delivered[1].event).toEqual({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } })
    coalescer.dispose()
  })

  it('flushes before switching runtime or delta kind', () => {
    const { delivered, coalescer } = setup()
    coalescer.push(deltaEvent('runtime-1', 'a'))
    coalescer.push(deltaEvent('runtime-1', 'b'))
    coalescer.push(deltaEvent('runtime-2', 'c'))
    expect(delivered.map(({ runtimeId }) => runtimeId)).toEqual(['runtime-1', 'runtime-1', 'runtime-2'])
    coalescer.push(deltaEvent('runtime-2', 'd', 'thinking_delta'))
    expect(delivered.map(({ event }) => (event.assistantMessageEvent as { type: string }).type)).toEqual(['text_delta', 'text_delta', 'text_delta', 'thinking_delta'])
    coalescer.dispose()
  })

  it('passes unknown shapes through untouched', () => {
    const { delivered, coalescer } = setup()
    const unknownField = {
      runtimeId: 'runtime-1',
      event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' }, futureField: true },
    }
    coalescer.push(unknownField)
    expect(delivered[0]).toBe(unknownField)

    const toolDelta = { runtimeId: 'runtime-1', event: { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', delta: 'x' } } }
    coalescer.push(toolDelta)
    expect(delivered[1]).toBe(toolDelta)
    coalescer.dispose()
  })

  it('supports the alternate outer delta location', () => {
    const { delivered, coalescer } = setup()
    coalescer.push({ runtimeId: 'runtime-1', event: { type: 'message_update', delta: { type: 'thinking_delta', delta: 'think' } } })
    expect(delivered[0].event).toEqual({ type: 'message_update', delta: { type: 'thinking_delta', delta: 'think' } })
    coalescer.dispose()
  })

  it('flushes early at the batch byte cap instead of growing one message', () => {
    const { delivered, coalescer } = setup()
    const chunk = 'x'.repeat(200 * 1024)
    coalescer.push(deltaEvent('runtime-1', chunk))
    coalescer.push(deltaEvent('runtime-1', chunk))
    // The buffered message is still under the cap, so it stays pending.
    expect(delivered).toHaveLength(1)
    coalescer.push(deltaEvent('runtime-1', chunk))
    // 400 KiB would exceed the 256 KiB cap: the buffered batch flushes and the
    // incoming delta opens a new leading batch instead of growing one message.
    expect(delivered).toHaveLength(3)
    for (const envelope of delivered) {
      expect((envelope.event.assistantMessageEvent as { delta: string }).delta.length).toBeLessThanOrEqual(256 * 1024)
    }
    coalescer.dispose()
  })

  it('drops the buffer and timer on dispose', () => {
    const { delivered, coalescer } = setup()
    coalescer.push(deltaEvent('runtime-1', 'a'))
    coalescer.push(deltaEvent('runtime-1', 'b'))
    coalescer.dispose()
    vi.advanceTimersByTime(50)
    expect(delivered).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
