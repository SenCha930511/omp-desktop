import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ConformanceClient, type ConformanceSandbox, createConformanceSandbox, requireCapability } from './client'
import type { AdapterInfo } from './protocol'

let client: ConformanceClient
let info: AdapterInfo
let sandbox: ConformanceSandbox | null = null

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
}

beforeAll(async () => {
  client = await ConformanceClient.launch()
  info = await client.info()
})

afterEach(async () => {
  await client.call('state.close').catch(() => undefined)
  sandbox?.cleanup()
  sandbox = null
})

afterAll(async () => {
  await client.close()
})

describe('conformance: git & checkout strategy', () => {
  it('inspects status/diff, stages, unstages, restores, commits, and switches branches safely', async () => {
    if (!requireCapability(info, 'git') || !requireCapability(info, 'checkouts') || !requireCapability(info, 'projects')) return
    sandbox = createConformanceSandbox('omp-conf-git-')
    const repoDir = join(sandbox.rootDir, 'repo')
    const outsideRepoDir = join(sandbox.rootDir, 'outside-repo')
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(outsideRepoDir, { recursive: true })

    writeFileSync(join(repoDir, 'app.txt'), 'line1\n', 'utf8')
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.name', 'OMP Conformance'],
      ['config', 'user.email', 'conformance@example.com'],
      ['add', 'app.txt'],
      ['commit', '-qm', 'initial'],
      ['branch', 'feature/existing'],
    ]) {
      runGit(repoDir, args)
    }

    writeFileSync(join(outsideRepoDir, 'x.txt'), 'x\n', 'utf8')
    runGit(outsideRepoDir, ['init', '-q'])

    await client.call('workspace.reset', {
      rootDir: sandbox.rootDir,
      homeDir: sandbox.homeDir,
      userDataDir: sandbox.userDataDir,
      appDataDir: sandbox.appDataDir,
      ompExecutable: sandbox.ompExecutable,
    })

    // Unauthorized repository must report error instead of reading files.
    const unauthorized = await client.call<{ error?: string }>('git.status', { cwd: outsideRepoDir })
    expect(unauthorized.error).toBeTruthy()

    const project = await client.call<{ id: string }>('projects.grant', { path: repoDir })

    // Modify tracked file and verify status + diff + stage + unstage + restore.
    writeFileSync(join(repoDir, 'app.txt'), 'line1\nline2\n', 'utf8')
    const dirtyStatus = await client.call<{ isRepo: boolean; branch?: string; files: Array<{ path: string; staged: boolean }> }>('git.status', { cwd: repoDir })
    expect(dirtyStatus.isRepo).toBe(true)
    expect(dirtyStatus.branch).toBe('main')
    expect(dirtyStatus.files.some((f) => f.path === 'app.txt' && !f.staged)).toBe(true)

    const unstagedDiff = await client.call<{ text: string }>('git.diff', { cwd: repoDir, path: 'app.txt', staged: false })
    expect(unstagedDiff.text).toContain('+line2')

    expect(await client.call<boolean>('git.stage', { cwd: repoDir, paths: ['app.txt'] })).toBe(true)
    const stagedDiff = await client.call<{ text: string }>('git.diff', { cwd: repoDir, path: 'app.txt', staged: true })
    expect(stagedDiff.text).toContain('+line2')

    // Dirty tree must block branch switching cleanly.
    await client.call('state.updateSettings', { patch: { checkoutStrategy: 'branch' } })
    const refused = await client.call<{ kind: string; code?: string }>('checkouts.execute', {
      projectId: project.id,
      action: { strategy: 'branch', operation: 'switch', branch: 'feature/existing' },
    })
    expect(refused).toMatchObject({ kind: 'refused', code: 'dirty-worktree' })

    // Unstage & restore back to clean HEAD.
    expect(await client.call<boolean>('git.unstage', { cwd: repoDir, paths: ['app.txt'] })).toBe(true)
    expect(await client.call<boolean>('git.restore', { cwd: repoDir, paths: ['app.txt'] })).toBe(true)
    expect(readFileSync(join(repoDir, 'app.txt'), 'utf8')).toBe('line1\n')

    // Stage & commit a real change.
    writeFileSync(join(repoDir, 'app.txt'), 'line1\ncommitted\n', 'utf8')
    expect(await client.call<boolean>('git.stage', { cwd: repoDir, paths: ['app.txt'] })).toBe(true)
    const commitOutcome = await client.call<{ ok: boolean }>('git.commit', { cwd: repoDir, message: 'update app' })
    expect(commitOutcome.ok).toBe(true)

    // Switch branches in branch mode and list worktrees in worktree mode.
    const catalog = await client.call<{ strategy: string; activeName: string; checkouts: Array<{ name: string }> }>('checkouts.list', {
      projectId: project.id,
    })
    expect(catalog.strategy).toBe('branch')
    expect(catalog.activeName).toBe('main')

    const switched = await client.call<{ kind: string }>('checkouts.execute', {
      projectId: project.id,
      action: { strategy: 'branch', operation: 'create', branch: 'feature/conformance' },
    })
    expect(switched.kind).toBe('applied')

    await client.call('state.updateSettings', { patch: { checkoutStrategy: 'worktree' } })
    const worktrees = await client.call<{ strategy: string; checkouts: Array<{ branch?: string }> }>('checkouts.list', {
      projectId: project.id,
    })
    expect(worktrees.strategy).toBe('worktree')
    expect(worktrees.checkouts.some((w) => w.branch === 'feature/conformance')).toBe(true)
  })
})
