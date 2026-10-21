export const EVENT_REPLAY_MAX_BYTES = 16 * 1024 * 1024
export const EVENT_REPLAY_MAX_EVENTS = 50_000

/** Conservative retained-payload estimate, bounded without serializing large tool/image records again. */
export function eventPayloadBytes(event: unknown, limit = EVENT_REPLAY_MAX_BYTES): number {
  const pending = [event]
  const seen = new Set<object>()
  let bytes = 0
  while (pending.length && bytes <= limit) {
    const value = pending.pop()
    if (typeof value === 'string') bytes += value.length * 2
    else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value)
      bytes += 32
      for (const [key, entry] of Object.entries(value)) { bytes += key.length * 2 + 8; pending.push(entry) }
    } else bytes += 8
  }
  return bytes
}
