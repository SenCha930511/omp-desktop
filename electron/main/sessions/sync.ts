import type { SessionCatalogUpdate, SessionRecord } from '../../../src/types/api'

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false
  }
  return true
}

function unchanged(previous: SessionRecord | undefined, next: SessionRecord): boolean {
  return previous !== undefined && Object.keys(previous).length === Object.keys(next).length
    && (Object.keys(next) as (keyof SessionRecord)[]).every((key) => sameValue(previous[key], next[key]))
}

/** Publishes a coherent catalog revision; lagging clients recover with a full snapshot. */
export class SessionCatalogSync {
  private records = new Map<string, SessionRecord>()
  private revision = 0
  private delta: Extract<SessionCatalogUpdate, { kind: 'delta' }> | undefined

  publish(records: SessionRecord[]): void {
    const next = new Map<string, SessionRecord>()
    const upserts: SessionRecord[] = []
    for (const record of records) {
      const previous = this.records.get(record.filePath)
      const retained = unchanged(previous, record) ? previous! : record
      next.set(record.filePath, retained)
      if (retained !== previous) upserts.push(retained)
    }
    const removals = [...this.records.keys()].filter((path) => !next.has(path))
    if (!upserts.length && !removals.length) return
    const baseRevision = this.revision++
    this.records = next
    this.delta = { kind: 'delta', baseRevision, revision: this.revision, upserts, removals }
  }

  read(revision?: number): SessionCatalogUpdate {
    if (revision === this.revision) return { kind: 'delta', baseRevision: revision, revision, upserts: [], removals: [] }
    if (this.delta && this.delta.baseRevision === revision) return this.delta
    return { kind: 'snapshot', revision: this.revision, records: [...this.records.values()] }
  }
}
