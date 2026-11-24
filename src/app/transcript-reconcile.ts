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
  return changed ? merged : current
}
