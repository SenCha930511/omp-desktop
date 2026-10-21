import { expect, it, vi } from 'vitest'
import { SessionService } from '../../electron/main/sessions'
import type { JsonStateStore } from '../../electron/main/store'
import { SessionCatalogSync } from '../../electron/main/sessions/sync'
import { applySessionCatalogDelta } from '../../src/lib/session-catalog'
import type { SessionRecord } from '../../src/types/api'

function session(index: number): SessionRecord {
  return {
    id: String(index), harness: 'omp', filePath: `/sessions/${String(index).padStart(4, '0')}.jsonl`, projectPath: '/project',
    title: `Session ${index}`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', status: 'idle', depth: 0,
  }
}

it('transmits only changed records and preserves untouched identities at 5,000 sessions', () => {
  const catalog = new SessionCatalogSync()
  const initial = Array.from({ length: 5_000 }, (_, index) => session(index))
  catalog.publish(initial)
  const snapshot = catalog.read()
  expect(snapshot.kind).toBe('snapshot')
  const changed = { ...initial[10], title: 'Updated', lastUserMessageAt: '2026-02-01T00:00:00Z' }
  catalog.publish([changed, ...initial.filter((record) => record.id !== '10' && record.id !== '20')])
  const update = catalog.read(snapshot.revision)
  expect(update.kind).toBe('delta')
  if (update.kind !== 'delta') throw new Error('Expected a delta')
  expect(update.upserts).toEqual([changed])
  expect(update.removals).toEqual([initial[20].filePath])
  expect(Buffer.byteLength(JSON.stringify(update))).toBeLessThan(Buffer.byteLength(JSON.stringify(snapshot)) / 100)
  const applied = applySessionCatalogDelta(initial, update)
  expect(applied[0]).toBe(changed)
  expect(applied[1]).toBe(initial[0])
  expect(applied.find((record) => record.id === '20')).toBeUndefined()
  expect(applied).toEqual(catalog.read().kind === 'snapshot' ? [changed, ...initial.filter((record) => record.id !== '10' && record.id !== '20')] : [])
  const unchanged = catalog.read(update.revision)
  if (unchanged.kind !== 'delta') throw new Error('Expected an unchanged delta')
  expect(applySessionCatalogDelta(applied, unchanged)).toBe(applied)
})

it('recovers missed revisions with a coherent full snapshot', () => {
  const catalog = new SessionCatalogSync()
  expect(catalog.read()).toEqual({ kind: 'snapshot', revision: 0, records: [] })
  catalog.publish([session(1)])
  const first = catalog.read()
  catalog.publish([session(1), session(2)])
  catalog.publish([session(3)])
  expect(catalog.read(first.revision)).toEqual({ kind: 'snapshot', revision: 3, records: [session(3)] })
})

it('reads again for a caller arriving after an earlier scan captured stale records', async () => {
  const service = new SessionService({} as JsonStateStore, null)
  let release!: (records: SessionRecord[]) => void
  const old = new Promise<SessionRecord[]>((resolve) => { release = resolve })
  const list = vi.spyOn(service, 'list').mockReturnValueOnce(old).mockResolvedValueOnce([{ ...session(1), title: 'New title' }])
  const first = service.sync()
  await Promise.resolve()
  const second = service.sync()
  release([session(1)])
  await first
  expect(await second).toMatchObject({ kind: 'snapshot', records: [{ title: 'New title' }] })
  expect(list).toHaveBeenCalledTimes(2)
})
