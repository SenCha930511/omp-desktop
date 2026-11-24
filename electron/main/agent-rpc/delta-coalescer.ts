import type { PrimeEventEnvelope } from '../../../src/types/api'

/** Largest single coalesced payload. A larger stream flushes early so one
 * IPC message never grows without bound. */
const MAX_BATCH_BYTES = 256 * 1024

/** The only outer keys a coalescable `message_update` may carry. `message` is
 * the growing full-message snapshot and is dropped; every consumer of the
 * delta path reads only the nested `{ type, delta }`. */
const MESSAGE_UPDATE_KEYS = new Set(['type', 'assistantMessageEvent', 'delta', 'message'])
/** The only inner keys a coalescable delta may carry. `partial` is another
 * growing snapshot, and `contentIndex` is not read by any delta consumer. */
const DELTA_KEYS = new Set(['type', 'delta', 'contentIndex', 'partial'])

type DeltaField = 'assistantMessageEvent' | 'delta'
type ContentDeltaType = 'text_delta' | 'thinking_delta'

interface ContentDelta {
  field: DeltaField
  type: ContentDeltaType
  text: string
}

interface PendingBatch {
  runtimeId: string
  field: DeltaField
  type: ContentDeltaType
  /** Trailing text not yet sent; the leading delta leaves immediately. */
  text: string
  bytes: number
}

export interface StreamingDeltaCoalescer {
  /** Feed one forwarded envelope; non-matching envelopes flush first, then pass through untouched. */
  push(envelope: PrimeEventEnvelope): void
  /** Send any buffered trailing text now, preserving event order. */
  flush(): void
  /** Drop the buffer and timer without emitting (used while quitting). */
  dispose(): void
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Matches only a pure streaming content delta: `message_update` whose outer and
 * inner key sets are exactly the known shape, exactly one delta location, and a
 * non-empty `text_delta`/`thinking_delta` string. Anything else — a tool call
 * boundary, an unknown field from a newer harness, a non-string delta — returns
 * undefined so the caller forwards the original event unchanged.
 */
function matchContentDelta(event: Record<string, unknown>): ContentDelta | undefined {
  if (event.type !== 'message_update') return undefined
  for (const key in event) if (!MESSAGE_UPDATE_KEYS.has(key)) return undefined
  const hasAssistantEvent = Object.hasOwn(event, 'assistantMessageEvent')
  const hasDelta = Object.hasOwn(event, 'delta')
  // Both locations present would be ambiguous; the renderer prefers
  // `assistantMessageEvent`, so only a single unambiguous location coalesces.
  if (hasAssistantEvent === hasDelta) return undefined
  const field: DeltaField = hasAssistantEvent ? 'assistantMessageEvent' : 'delta'
  const inner = event[field]
  if (!isPlainRecord(inner)) return undefined
  for (const key in inner) if (!DELTA_KEYS.has(key)) return undefined
  const type = inner.type
  if (type !== 'text_delta' && type !== 'thinking_delta') return undefined
  const text = inner.delta
  if (typeof text !== 'string' || text.length === 0) return undefined
  return { field, type, text }
}

function deltaEnvelope(runtimeId: string, field: DeltaField, type: ContentDeltaType, text: string): PrimeEventEnvelope {
  return { runtimeId, event: { type: 'message_update', [field]: { type, delta: text } } }
}

/**
 * Collapses per-token streaming deltas into at most one IPC envelope per
 * `windowMs`. OMP's `message_update` frames carry a full growing `message` and
 * `partial` snapshot beside every delta, so forwarding them verbatim makes a
 * turn's total IPC traffic quadratic in its length. The first delta of a window
 * is stripped and forwarded synchronously (TTFT never waits), the rest are
 * concatenated and flushed on the timer, on a size cap, or immediately before
 * any other event so ordering is never interleaved.
 */
export function createStreamingDeltaCoalescer(
  sink: (envelope: PrimeEventEnvelope) => void,
  windowMs = 12,
): StreamingDeltaCoalescer {
  let pending: PendingBatch | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const flush = (): void => {
    clearTimer()
    const batch = pending
    pending = undefined
    if (batch && batch.text.length > 0) sink(deltaEnvelope(batch.runtimeId, batch.field, batch.type, batch.text))
  }

  const schedule = (): void => {
    timer = setTimeout(() => {
      timer = undefined
      flush()
    }, windowMs)
    // A buffered delta must never keep the process alive between turns.
    timer.unref?.()
  }

  const push = (envelope: PrimeEventEnvelope): void => {
    if (disposed) return
    const match = matchContentDelta(envelope.event)
    if (!match) {
      flush()
      sink(envelope)
      return
    }
    const batch = pending
    if (batch && batch.runtimeId === envelope.runtimeId && batch.field === match.field && batch.type === match.type) {
      const bytes = Buffer.byteLength(match.text, 'utf8')
      if (batch.bytes + bytes <= MAX_BATCH_BYTES) {
        batch.text += match.text
        batch.bytes += bytes
        return
      }
      flush()
    } else if (batch) {
      flush()
    }
    pending = { runtimeId: envelope.runtimeId, field: match.field, type: match.type, text: '', bytes: 0 }
    sink(deltaEnvelope(envelope.runtimeId, match.field, match.type, match.text))
    schedule()
  }

  return {
    push,
    flush,
    dispose(): void {
      disposed = true
      clearTimer()
      pending = undefined
    },
  }
}
