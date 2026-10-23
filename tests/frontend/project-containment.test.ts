import { describe, expect, it } from 'vitest'
import { findProjectForSession, projectContainsPath, workspaceCwd } from '../../src/lib/workspace'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

const project = (id: string, path: string, folders: string[]): ProjectRecord => ({
  id,
  harness: 'omp',
  name: id,
  path,
  folders,
  primaryFolder: folders[0] ?? path,
  pinned: false,
  createdAt: '2025-01-01T00:00:00.000Z',
  lastOpenedAt: '2025-01-01T00:00:00.000Z',
  sessionCount: 1,
})

const session = (projectPath: string): SessionRecord => ({
  id: 'session',
  harness: 'omp',
  projectPath,
  filePath: '/sessions/session.jsonl',
  title: 'session',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
})

describe('project path containment', () => {
  it('still matches exact project path and folder entries', () => {
    const repo = project('repo', '/repo', ['/repo', '/docs'])
    expect(projectContainsPath(repo, '/repo')).toBe(true)
    expect(projectContainsPath(repo, '/docs')).toBe(true)
    expect(findProjectForSession([repo], session('/repo'))?.id).toBe('repo')
    expect(findProjectForSession([repo], session('/docs'))?.id).toBe('repo')
  })

  it('matches a session recorded in a project subdirectory', () => {
    const repo = project('repo', '/repo', ['/repo'])
    expect(projectContainsPath(repo, '/repo/packages/app')).toBe(true)
    expect(findProjectForSession([repo], session('/repo/packages/app'))?.id).toBe('repo')
    expect(workspaceCwd(repo, session('/repo/packages/app'))).toBe('/repo/packages/app')
  })

  it('does not match paths that merely share a prefix', () => {
    const repo = project('repo', '/repo', ['/repo'])
    expect(projectContainsPath(repo, '/repository')).toBe(false)
    expect(projectContainsPath(repo, '/repo-other')).toBe(false)
    expect(findProjectForSession([repo], session('/repository'))).toBeUndefined()
  })

  it('matches Windows-style separators', () => {
    const repo = project('repo', 'C:\\repo', ['C:\\repo'])
    expect(projectContainsPath(repo, 'C:\\repo\\packages\\app')).toBe(true)
    expect(projectContainsPath(repo, 'C:\\repository')).toBe(false)
    const posix = project('posix', 'C:/repo', ['C:/repo'])
    expect(projectContainsPath(posix, 'C:/repo/packages/app')).toBe(true)
    expect(projectContainsPath(posix, 'C:/repository')).toBe(false)
  })

  it('prefers the project with the longest matching folder', () => {
    const broad = project('broad', '/repo', ['/repo'])
    const nested = project('nested', '/repo/packages/app', ['/repo/packages/app'])
    const deeper = project('deeper', '/repo/packages/app/src', ['/repo/packages/app/src'])
    expect(findProjectForSession([broad, nested], session('/repo/packages/app/lib'))?.id).toBe('nested')
    expect(findProjectForSession([nested, broad], session('/repo/packages/app/lib'))?.id).toBe('nested')
    expect(findProjectForSession([broad, nested, deeper], session('/repo/packages/app/src/main.ts'))?.id).toBe('deeper')
    // A sibling of the nested folder falls back to the broad project.
    expect(findProjectForSession([broad, nested], session('/repo/packages/other'))?.id).toBe('broad')
  })

  it('matches containment through the project path itself, not only folders', () => {
    const repo = project('repo', '/repo', ['/unrelated'])
    expect(projectContainsPath(repo, '/repo/sub/dir')).toBe(true)
    expect(findProjectForSession([repo], session('/repo/sub/dir'))?.id).toBe('repo')
  })
})
