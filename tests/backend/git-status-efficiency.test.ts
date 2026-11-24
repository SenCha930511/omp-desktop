import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  holdStatus: null as Promise<void> | null,
}))

vi.mock('../../electron/main/process-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/process-utils')>()
  return {
    ...actual,
    runProcess: async (file: string, args: readonly string[], options: Parameters<typeof actual.runProcess>[2]) => {
      state.calls.push({ command: file, args: [...args] })
      if (state.holdStatus && file === 'git' && args.includes('--porcelain=v1') && args.includes('--branch')) await state.holdStatus
      return actual.runProcess(file, args, options)
    },
  }
})

const { GitService } = await import('../../electron/main/git')

const dirs: string[] = []
afterEach(() => {
  state.holdStatus = null
  state.calls.length = 0
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

function repository(): string {
  const cwd = mkdtempSync(join(realpathSync.native(tmpdir()), 'omp-desktop-git-status-'))
  dirs.push(cwd)
  git(cwd, 'init', '-q')
  git(cwd, 'config', 'user.name', 'Prime Work Test')
  git(cwd, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(cwd, 'file.txt'), 'base\n')
  git(cwd, 'add', 'file.txt')
  git(cwd, 'commit', '-qm', 'base')
  return cwd
}

const gitCalls = () => state.calls.filter((call) => call.command === 'git')
const diffCalls = () => gitCalls().filter((call) => call.args.includes('diff'))
const statusCalls = () => gitCalls().filter((call) => call.args.includes('--porcelain=v1') && call.args.includes('--branch'))

async function warmed(service: InstanceType<typeof GitService>, cwd: string): Promise<void> {
  await service.status(cwd)
  state.calls.length = 0
}

describe('GitService.status subprocess budget', () => {
  it('spawns only status for a clean worktree', async () => {
    const cwd = repository()
    const service = new GitService(async () => cwd, async () => cwd)
    await warmed(service, cwd)
    const status = await service.status(cwd)
    expect(status.files).toEqual([])
    expect(gitCalls()).toHaveLength(1)
    expect(diffCalls()).toHaveLength(0)
  })

  it('skips every diff when only untracked files exist', async () => {
    const cwd = repository()
    const service = new GitService(async () => cwd, async () => cwd)
    writeFileSync(join(cwd, 'untracked.txt'), 'new\n')
    await warmed(service, cwd)
    const status = await service.status(cwd)
    expect(status.files.map((file) => [file.path, file.staged])).toEqual([['untracked.txt', false]])
    expect(diffCalls()).toHaveLength(0)
  })

  it('reads only the unstaged numstat for a worktree edit', async () => {
    const cwd = repository()
    const service = new GitService(async () => cwd, async () => cwd)
    writeFileSync(join(cwd, 'file.txt'), 'changed\n')
    await warmed(service, cwd)
    const status = await service.status(cwd)
    expect(status.files.find((file) => !file.staged)?.additions).toBe(1)
    const diffs = diffCalls()
    expect(diffs).toHaveLength(1)
    expect(diffs[0].args).toContain('--numstat')
    expect(diffs[0].args).not.toContain('--cached')
  })

  it('reads both cached diffs but no unstaged numstat for a staged edit', async () => {
    const cwd = repository()
    const service = new GitService(async () => cwd, async () => cwd)
    writeFileSync(join(cwd, 'file.txt'), 'changed\n')
    git(cwd, 'add', 'file.txt')
    await warmed(service, cwd)
    const status = await service.status(cwd)
    expect(status.files.find((file) => file.staged)?.contentHash).toBeTruthy()
    const diffs = diffCalls()
    expect(diffs).toHaveLength(2)
    for (const call of diffs) expect(call.args).toContain('--cached')
    expect(diffs.some((call) => call.args.includes('--raw'))).toBe(true)
  })

  it('reads all three diffs when worktree and index both changed', async () => {
    const cwd = repository()
    const service = new GitService(async () => cwd, async () => cwd)
    writeFileSync(join(cwd, 'file.txt'), 'staged\n')
    git(cwd, 'add', 'file.txt')
    writeFileSync(join(cwd, 'file.txt'), 'worktree\n')
    await warmed(service, cwd)
    const status = await service.status(cwd)
    expect(status.files).toHaveLength(2)
    expect(diffCalls()).toHaveLength(3)
  })
})

describe('GitService.status sharing', () => {
  it('shares one subprocess burst between concurrent reads and clones each result', async () => {
    const cwd = repository()
    const service = new GitService(async () => cwd, async () => cwd)
    await warmed(service, cwd)
    const [first, second] = await Promise.all([service.status(cwd), service.status(cwd)])
    expect(statusCalls()).toHaveLength(1)
    expect(first).not.toBe(second)
    first.files.push({ path: 'injected', status: 'M', staged: false, additions: 0, deletions: 0 })
    expect(second.files).toEqual([])
  })

  it('never spawns git for a cwd the authorizer rejects', async () => {
    const cwd = repository()
    const service = new GitService(async () => { throw new Error('unauthorized project') }, async () => { throw new Error('unauthorized project') })
    const status = await service.status(cwd)
    expect(status.error).toContain('unauthorized project')
    expect(gitCalls()).toHaveLength(0)
  })

  it('starts a fresh read for callers that arrive after a mutation', async () => {
    const cwd = repository()
    const service = new GitService(async () => cwd, async () => cwd)
    await warmed(service, cwd)
    writeFileSync(join(cwd, 'file.txt'), 'changed\n')
    let release: () => void = () => undefined
    state.holdStatus = new Promise<void>((resolve) => { release = resolve })
    const beforeMutation = service.status(cwd)
    await vi.waitFor(() => expect(statusCalls()).toHaveLength(1))
    await service.stage(cwd, ['file.txt'])
    const afterMutation = service.status(cwd)
    await vi.waitFor(() => expect(statusCalls()).toHaveLength(2))
    state.holdStatus = null
    release()
    await expect(beforeMutation).resolves.toMatchObject({ isRepo: true })
    const staged = await afterMutation
    expect(staged.files.some((file) => file.staged)).toBe(true)
  })
})
