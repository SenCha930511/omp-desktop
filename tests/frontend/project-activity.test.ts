import { describe, expect, it } from 'vitest'
import { indexSidebarSessions } from '../../src/components/Sidebar'
import { projectActivityAt, projectsWithActivity } from '../../src/lib/project-activity'
import { sortProjects } from '../../src/lib/project-order'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

function project(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    harness: 'omp',
    name: id,
    path: `/${id}`,
    folders: [`/${id}`],
    primaryFolder: `/${id}`,
    pinned: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
    sessionCount: 0,
    ...overrides,
  }
}

function session(id: string, projectPath: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    harness: 'omp',
    filePath: `/sessions/${id}.jsonl`,
    projectPath,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'idle',
    depth: 0,
    ...overrides,
  }
}

const recentIds = (projects: ProjectRecord[]) => sortProjects(projects, 'recent').map(({ id }) => id)

describe('project user activity', () => {
  it('advances on user turns but ignores clicks, background updates, and pinned ordering', () => {
    const records = [
      project('clicked', { lastOpenedAt: '2027-01-01T00:00:00.000Z', lastUserActivityAt: '2026-02-01T00:00:00.000Z' }),
      project('used', { lastOpenedAt: '2025-01-01T00:00:00.000Z', lastUserActivityAt: '2026-03-01T00:00:00.000Z' }),
      project('pinned', { pinned: true, lastUserActivityAt: '2025-01-01T00:00:00.000Z' }),
    ]

    expect(recentIds(records)).toEqual(['pinned', 'used', 'clicked'])
    const projected = projectsWithActivity(records, [
      session('background', '/used', { createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2027-02-01T00:00:00.000Z' }),
    ])
    expect(recentIds(projected)).toEqual(['pinned', 'used', 'clicked'])
  })

  it('counts archived and lineage-folded history without restoring invisible rows', () => {
    const records = [project('work')]
    const sessions = [
      session('archived', '/work', { archived: true, lastUserMessageAt: '2026-02-01T00:00:00.000Z' }),
      session('parent', '/work', { lastUserMessageAt: '2026-04-01T00:00:00.000Z' }),
      session('child', '/work', { parentSession: 'parent', lastUserMessageAt: '2026-03-01T00:00:00.000Z' }),
    ]

    const projected = projectsWithActivity(records, sessions)
    expect(projectActivityAt(projected[0]!)).toBe('2026-04-01T00:00:00.000Z')
    expect(indexSidebarSessions(records, sessions).activeSessions.map(({ id }) => id)).toEqual(['child'])
  })

  it('uses each session creation fallback and the project creation fallback without invalid-date poisoning', () => {
    const records = [
      project('valid', { lastUserActivityAt: 'invalid' }),
      project('new', { createdAt: '2026-03-01T00:00:00.000Z' }),
      project('invalid', { createdAt: 'invalid', lastUserActivityAt: 'invalid' }),
      project('also-invalid', { createdAt: 'invalid' }),
    ]
    const projected = projectsWithActivity(records, [
      session('created', '/valid', { createdAt: '2026-02-01T00:00:00.000Z', lastUserMessageAt: 'invalid' }),
      session('unknown', '/invalid', { createdAt: 'invalid', lastUserMessageAt: 'invalid' }),
    ])

    expect(projectActivityAt(projected[0]!)).toBe('2026-02-01T00:00:00.000Z')
    expect(projectActivityAt(projected[1]!)).toBe('2026-03-01T00:00:00.000Z')
    expect(projectActivityAt(projected[2]!)).toBeUndefined()
    expect(recentIds(projected)).toEqual(['new', 'valid', 'also-invalid', 'invalid'])
  })

  it('assigns nested sessions only to the most specific actual project folders', () => {
    const records = [
      project('broad', { path: '/repo', folders: ['/repo'], primaryFolder: '/repo' }),
      project('nested', { path: '/repo/packages/app', folders: ['/repo/packages/app'], primaryFolder: '/repo/packages/app' }),
    ]
    const projected = projectsWithActivity(records, [
      session('broad-turn', '/repo', { lastUserMessageAt: '2026-04-01T00:00:00.000Z' }),
      session('nested-turn', '/repo/packages/app', { lastUserMessageAt: '2026-02-01T00:00:00.000Z' }),
      session('prefix-only', '/repository', { lastUserMessageAt: '2027-01-01T00:00:00.000Z' }),
    ])

    expect(projectActivityAt(projected[0]!)).toBe('2026-04-01T00:00:00.000Z')
    expect(projectActivityAt(projected[1]!)).toBe('2026-02-01T00:00:00.000Z')
    expect(projected[2]).toBeUndefined()
  })

  it('merges newer session data while retaining a known newer bootstrap projection', () => {
    const records = [
      project('old', { lastUserActivityAt: '2026-02-01T00:00:00.000Z' }),
      project('new', { lastUserActivityAt: '2026-03-01T00:00:00.000Z' }),
    ]
    const oldSessions = [
      session('old', '/old', { lastUserMessageAt: '2026-02-01T00:00:00.000Z' }),
      session('new', '/new', { lastUserMessageAt: '2026-03-01T00:00:00.000Z' }),
    ]
    expect(recentIds(projectsWithActivity(records, oldSessions))).toEqual(['new', 'old'])

    const newTurn = oldSessions.map((item) => item.id === 'old' ? { ...item, lastUserMessageAt: '2026-04-01T00:00:00.000Z' } : item)
    const advanced = projectsWithActivity(records, newTurn)
    expect(recentIds(advanced)).toEqual(['old', 'new'])

    const staleSnapshot = projectsWithActivity(advanced, [
      { ...newTurn[0]!, lastUserMessageAt: undefined },
      { ...newTurn[1]!, lastUserMessageAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(recentIds(staleSnapshot)).toEqual(['old', 'new'])
    expect(projectActivityAt(staleSnapshot[0]!)).toBe('2026-04-01T00:00:00.000Z')
    expect(projectActivityAt(staleSnapshot[1]!)).toBe('2026-03-01T00:00:00.000Z')
  })
})
