import type { TranscriptMessage } from '@/types/api'

/** Allocation-free deep equality. Records are compared by own enumerable keys
 * whose value is not `undefined`, on both sides, so a transient `undefined`
 * never forces a re-render. */
function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!structurallyEqual(left[index], right[index])) return false
    }
    return true
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  let leftCount = 0
  for (const key in leftRecord) {
    if (!Object.hasOwn(leftRecord, key)) continue
    const value = leftRecord[key]
    if (value === undefined) continue
    leftCount += 1
    if (!structurallyEqual(value, rightRecord[key])) return false
  }
  let rightCount = 0
  for (const key in rightRecord) {
    if (!Object.hasOwn(rightRecord, key)) continue
    if (rightRecord[key] !== undefined) rightCount += 1
  }
  return leftCount === rightCount
}

/** Concatenated text parts, trimmed: the identity of a prompt for superseding
 * a renderer-local user row with the row the harness persisted. */
export function transcriptMessageText(message: TranscriptMessage): string {
  let text = ''
  for (const part of message.parts) {
    if (part.type === 'text' || part.type === 'agentMessage') text += part.text
  }
  return text.trim()
}

/**
 * Re-inserts renderer-local user rows the read cannot know about. A steer the
 * harness injected is often not persisted as a user record, so the row that
 * rendered at submit time is the reader's only copy; dropping it on every
 * authoritative read made steers vanish.
 *
 * A persisted row supersedes a local row only when it is that prompt's own
 * copy: same text, written at or after the submit time, matched one to one and
 * nearest first. Text membership alone is not enough — earlier history with the
 * same text ("continue" sent twice) must not swallow the new pending row.
 */
export function keepLocalUserRows(current: TranscriptMessage[], next: TranscriptMessage[]): TranscriptMessage[] {
  const nextIds = new Set(next.map((message) => message.id))
  const persistedUsers = next.filter((message) => message.role === 'user' && typeof message.timestamp === 'number')
  const superseded = new Set<TranscriptMessage>()
  const missing: TranscriptMessage[] = []
  for (const message of current) {
    if (message.role !== 'user' || !message.id.startsWith('user-') || nextIds.has(message.id)) continue
    const text = transcriptMessageText(message)
    const rowTime = typeof message.timestamp === 'number' ? message.timestamp : Number.NaN
    let best: TranscriptMessage | undefined
    for (const candidate of persistedUsers) {
      if (superseded.has(candidate) || transcriptMessageText(candidate) !== text) continue
      const candidateTime = candidate.timestamp as number
      // The harness writes the user record at or after submission; an older row
      // with the same text is earlier history, not this prompt's copy.
      if (Number.isFinite(rowTime) && candidateTime < rowTime - 2_000) continue
      if (!best || Math.abs((best.timestamp as number) - rowTime) > Math.abs(candidateTime - rowTime)) best = candidate
    }
    if (best) superseded.add(best)
    else missing.push(message)
  }
  if (!missing.length) return next
  const merged = [...next]
  for (const row of missing) {
    const rowTime = typeof row.timestamp === 'number' ? row.timestamp : Number.POSITIVE_INFINITY
    const index = merged.findIndex((message) => typeof message.timestamp === 'number' && message.timestamp > rowTime)
    if (index < 0) merged.push(row)
    else merged.splice(index, 0, row)
  }
  return merged
}

/**
 * Merges an authoritative transcript read into current renderer state by
 * message id: messages whose content is unchanged keep their current object
 * identity so memoized rows skip re-rendering, and a fully unchanged
 * transcript keeps the current array identity.
 */
export function reconcileTranscripts(current: TranscriptMessage[], next: TranscriptMessage[]): TranscriptMessage[] {
  if (current === next || current.length === 0) return next
  const currentById = new Map<string, TranscriptMessage>()
  for (const message of current) if (!currentById.has(message.id)) currentById.set(message.id, message)
  let changed = next.length !== current.length
  const merged = next.map((message, index) => {
    const previous = currentById.get(message.id)
    if (previous && structurallyEqual(previous, message)) {
      if (current[index] !== previous) changed = true
      return previous
    }
    changed = true
    return message
  })
  return changed ? keepLocalUserRows(current, merged) : current
}
