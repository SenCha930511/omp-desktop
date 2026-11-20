import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { reads } = vi.hoisted(() => ({ reads: [] as string[] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      reads.push(String(args[0]))
      return actual.createReadStream(...args)
    },
  }
})

const { gitWorktreeContentHash } = await import('../../electron/main/git-content-hash')

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => { reads.length = 0 })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-git-hash-'))
  dirs.push(dir)
  return dir
}

const DIGEST = /^\d+:[0-9a-f]{64}$/
const canMakeUnreadable = process.platform !== 'win32' && process.getuid?.() !== 0

describe('gitWorktreeContentHash cache', () => {
  it('reuses the digest while the file identity is unchanged', async () => {
    const file = join(tempDir(), 'file.txt')
    writeFileSync(file, 'alpha\n')

    const first = await gitWorktreeContentHash(file)
    const second = await gitWorktreeContentHash(file)

    expect(first).toMatch(DIGEST)
    expect(second).toBe(first)
    expect(reads).toHaveLength(1)
  })

  it('re-reads after an in-place rewrite that changes the identity', async () => {
    const file = join(tempDir(), 'file.txt')
    writeFileSync(file, 'alpha\n')
    const first = await gitWorktreeContentHash(file)

    // Same byte length: only the identity stamps can distinguish the contents.
    writeFileSync(file, 'omega\n')
    const second = await gitWorktreeContentHash(file)

    writeFileSync(file, 'omega\nsecond line\n')
    const third = await gitWorktreeContentHash(file)

    expect(second).not.toBe(first)
    expect(third).not.toBe(second)
    expect(reads).toHaveLength(3)
  })

  it('does not cache the missing-file answer', async () => {
    const file = join(tempDir(), 'file.txt')
    expect(await gitWorktreeContentHash(file)).toBe('deleted')

    writeFileSync(file, 'alpha\n')
    expect(await gitWorktreeContentHash(file)).toMatch(DIGEST)
    expect(reads).toHaveLength(1)
  })

  it.runIf(canMakeUnreadable)('never caches a failed read', async () => {
    const file = join(tempDir(), 'file.txt')
    writeFileSync(file, 'alpha\n')
    chmodSync(file, 0o000)
    try {
      await expect(gitWorktreeContentHash(file)).rejects.toThrow()
    } finally {
      chmodSync(file, 0o644)
    }

    expect(await gitWorktreeContentHash(file)).toMatch(DIGEST)
    expect(reads).toHaveLength(2)
  })
})
