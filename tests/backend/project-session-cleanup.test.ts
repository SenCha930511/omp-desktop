import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteProjectSessions, resolveProjectRoots, type ProjectSessionCandidate, type ProjectSessionCleanupDeps } from '../../electron/main/project-sessions'

function recordingDeps(sessions: readonly ProjectSessionCandidate[]) {
  const calls: Array<{ kind: string; filePath: string }> = []
  const deps: ProjectSessionCleanupDeps = {
    listSessions: async () => sessions,
    deleteSession: async (filePath) => { calls.push({ kind: 'delete', filePath }) },
    closeBrowserView: (filePath) => { calls.push({ kind: 'closeBrowserView', filePath }) },
    killTerminal: async (filePath) => { calls.push({ kind: 'killTerminal', filePath }) },
  }
  return { deps, calls }
}

describe('deleteProjectSessions', () => {
  it('deletes only sessions stored under the given project roots, including subdirectories', async () => {
    const { deps, calls } = recordingDeps([
      { filePath: '/sessions/a.jsonl', projectPath: '/work/project' },
      { filePath: '/sessions/b.jsonl', projectPath: '/work/project/packages/ui' },
      { filePath: '/sessions/c.jsonl', projectPath: '/work/other' },
      { filePath: '/sessions/d.jsonl' },
    ])

    const deleted = await deleteProjectSessions(deps, ['/work/project'])

    expect(deleted).toEqual(['/sessions/a.jsonl', '/sessions/b.jsonl'])
    // Per-session cleanup mirrors the single-session delete handler: the file
    // deletion runs first, then the browser view closes, then the terminal.
    expect(calls).toEqual([
      { kind: 'delete', filePath: '/sessions/a.jsonl' },
      { kind: 'closeBrowserView', filePath: '/sessions/a.jsonl' },
      { kind: 'killTerminal', filePath: '/sessions/a.jsonl' },
      { kind: 'delete', filePath: '/sessions/b.jsonl' },
      { kind: 'closeBrowserView', filePath: '/sessions/b.jsonl' },
      { kind: 'killTerminal', filePath: '/sessions/b.jsonl' },
    ])
  })

  it('matches sessions across multiple roots and tolerates relative segments', async () => {
    const { deps, calls } = recordingDeps([
      { filePath: '/sessions/a.jsonl', projectPath: '/work/one' },
      { filePath: '/sessions/b.jsonl', projectPath: '/work/two/nested' },
      { filePath: '/sessions/c.jsonl', projectPath: '/work/three' },
    ])

    const deleted = await deleteProjectSessions(deps, ['/work/one', '/work/./two'])

    expect(deleted).toEqual(['/sessions/a.jsonl', '/sessions/b.jsonl'])
    expect(calls).toHaveLength(6)
  })

  it('touches nothing without roots or matches', async () => {
    const { deps, calls } = recordingDeps([{ filePath: '/sessions/a.jsonl', projectPath: '/work/project' }])

    expect(await deleteProjectSessions(deps, [])).toEqual([])
    expect(await deleteProjectSessions(deps, ['/work/elsewhere'])).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('resolveProjectRoots', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

  it('canonicalizes existing folders and keeps stale folders lexical', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omp-desktop-project-roots-')); dirs.push(root)
    const existing = join(root, 'existing')
    mkdirSync(existing)
    writeFileSync(join(existing, 'marker.txt'), 'present')
    const stale = join(root, 'stale')

    const [canonical, lexical] = await resolveProjectRoots([existing, stale])

    expect(canonical).toBe(realpathSync(existing))
    expect(lexical).toBe(stale)
  })
})
