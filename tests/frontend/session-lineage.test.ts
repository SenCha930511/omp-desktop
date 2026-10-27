import { describe, expect, it } from 'vitest'
import { indexSidebarSessions } from '../../src/components/Sidebar'
import { continuedSessionKeys } from '../../src/lib/session-lineage'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

const project: ProjectRecord = {
  id: 'proj', harness: 'omp', name: 'Proj', path: '/proj', folders: ['/proj'], primaryFolder: '/proj',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 0,
}

const session = (id: string, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id, harness: 'omp', projectPath: '/proj', filePath: `/sessions/${id}.jsonl`, title: `Session ${id}`,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0, ...overrides,
})

describe('session lineage collapse', () => {
  it('collects parent references by id and by absolute path', () => {
    const keys = continuedSessionKeys([
      session('root'),
      session('child-id', { parentSession: 'root' }),
      session('child-path', { parentSession: '/sessions/root.jsonl' }),
    ])
    expect([...keys].sort()).toEqual(['/sessions/root.jsonl', 'root'].sort())
  })

  it('folds a session continued by id (compact rollover) into its continuation', () => {
    const indexed = indexSidebarSessions([project], [
      session('root', { title: 'Same title' }),
      session('child', { title: 'Same title', parentSession: 'root', depth: 1 }),
    ])
    expect(indexed.activeSessions.map((row) => row.id)).toEqual(['child'])
    expect(indexed.sessionsByProject.get(project.id)?.map((row) => row.id)).toEqual(['child'])
  })

  it('folds a session continued by file path (external fork) the same way', () => {
    const indexed = indexSidebarSessions([project], [
      session('root'),
      session('fork', { parentSession: '/sessions/root.jsonl', depth: 1 }),
    ])
    expect(indexed.activeSessions.map((row) => row.id)).toEqual(['fork'])
  })

  it('shows only the newest member of a three-file chain', () => {
    const indexed = indexSidebarSessions([project], [
      session('root'),
      session('mid', { parentSession: 'root', depth: 1 }),
      session('tip', { parentSession: 'mid', depth: 1 }),
    ])
    expect(indexed.activeSessions.map((row) => row.id)).toEqual(['tip'])
  })

  it('keeps sessions whose continuation file is missing from the list', () => {
    const indexed = indexSidebarSessions([project], [
      session('orphan-child', { parentSession: 'not-in-list', depth: 1 }),
      session('plain'),
    ])
    expect(indexed.activeSessions.map((row) => row.id).sort()).toEqual(['orphan-child', 'plain'].sort())
  })

  it('still counts scanned sessions in stats while folding rows', () => {
    const stats = { projectPaths: 0, sessionScans: 0 }
    indexSidebarSessions([project], [session('root'), session('child', { parentSession: 'root', depth: 1 })], stats)
    expect(stats).toEqual({ projectPaths: 1, sessionScans: 2 })
  })
})
