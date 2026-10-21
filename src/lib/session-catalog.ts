import type { SessionCatalogUpdate, SessionRecord } from '@/types/api'

export function applySessionCatalogDelta(current: SessionRecord[], update: Extract<SessionCatalogUpdate, { kind: 'delta' }>, upserts = update.upserts): SessionRecord[] {
  if (!upserts.length && !update.removals.length) return current
  const replaced = new Set([...update.removals, ...upserts.map((record) => record.filePath)])
  const records = current.filter((record) => !replaced.has(record.filePath))
  for (const record of upserts) {
    const time = Date.parse(record.lastUserMessageAt ?? record.createdAt)
    let low = 0
    let high = records.length
    while (low < high) {
      const middle = (low + high) >>> 1
      const candidate = records[middle]
      const difference = time - Date.parse(candidate.lastUserMessageAt ?? candidate.createdAt)
        || (candidate.filePath < record.filePath ? -1 : candidate.filePath > record.filePath ? 1 : 0)
      if (difference <= 0) low = middle + 1
      else high = middle
    }
    records.splice(low, 0, record)
  }
  return records
}
