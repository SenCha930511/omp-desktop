import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync, type BigIntStats, type PathLike } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { reads, lstatFixture, onStreamEnd } = vi.hoisted(() => ({
  reads: [] as string[],
  lstatFixture: { current: undefined } as {
    current: undefined | ((path: PathLike, stat: BigIntStats) => BigIntStats)
  },
  onStreamEnd: { current: undefined } as { current: undefined | (() => void) },
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      reads.push(String(args[0]))
      const stream = actual.createReadStream(...args)
      if (onStreamEnd.current) stream.once('end', onStreamEnd.current)
      return stream
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (path: PathLike) => {
      const stat = await actual.lstat(path, { bigint: true })
      return lstatFixture.current?.(path, stat) ?? stat
    },
  }
})

const { gitWorktreeContentHash } = await import('../../electron/main/git-content-hash')

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => {
  reads.length = 0
  lstatFixture.current = undefined
  onStreamEnd.current = undefined
})

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

  it('re-reads after in-place rewrites with deterministic identity changes', async () => {
    const file = join(tempDir(), 'file.txt')
    writeFileSync(file, 'alpha\n')
    const base = lstatSync(file, { bigint: true })
    let revision = 0n

    lstatFixture.current = (_path, stat) => Object.create(stat, {
      mtimeMs: { value: base.mtimeMs + revision },
      mtimeNs: { value: base.mtimeNs + revision * 1_000_000n },
      ctimeMs: { value: base.ctimeMs },
      ctimeNs: { value: base.ctimeNs },
    }) as BigIntStats

    try {
      const first = await gitWorktreeContentHash(file)

      // Same byte length: only the identity stamps can distinguish the contents.
      writeFileSync(file, 'omega\n')
      revision = 1n
      const second = await gitWorktreeContentHash(file)

      writeFileSync(file, 'omega\nsecond line\n')
      revision = 2n
      const third = await gitWorktreeContentHash(file)

      expect(second).not.toBe(first)
      expect(third).not.toBe(second)
      expect(reads).toHaveLength(3)
    } finally {
      lstatFixture.current = undefined
    }
  })

  it('distinguishes nanosecond identities within the same coarse millisecond', async () => {
    const file = join(tempDir(), 'file.txt')
    writeFileSync(file, 'alpha\n')
    const base = lstatSync(file, { bigint: true })
    const millisecondStartNs = base.mtimeMs * 1_000_000n
    let mtimeNs = millisecondStartNs + 1n

    lstatFixture.current = (path) => {
      if (String(path) !== file) return lstatSync(path, { bigint: true })
      return Object.create(base, {
        mtimeNs: { value: mtimeNs },
      }) as BigIntStats
    }

    try {
      const first = await gitWorktreeContentHash(file)
      expect(await gitWorktreeContentHash(file)).toBe(first)
      expect(reads).toHaveLength(1)

      // Identical path, inode, size, mtimeMs and ctimeMs; only mtimeNs changes.
      writeFileSync(file, 'omega\n')
      mtimeNs = millisecondStartNs + 2n
      const second = await gitWorktreeContentHash(file)

      expect(second).not.toBe(first)
      expect(reads).toHaveLength(2)
    } finally {
      lstatFixture.current = undefined
    }
  })

  it('does not cache bytes when a writer changes the identity during the read', async () => {
    const file = join(tempDir(), 'file.txt')
    writeFileSync(file, 'alpha\n')
    const base = lstatSync(file, { bigint: true })
    let version = 0n

    lstatFixture.current = () => Object.create(base, {
      mtimeMs: { value: base.mtimeMs + version },
      mtimeNs: { value: base.mtimeNs + version * 1_000_000n },
    }) as BigIntStats
    onStreamEnd.current = () => {
      writeFileSync(file, 'omega\n')
      version = 1n
    }

    try {
      const first = await gitWorktreeContentHash(file)
      onStreamEnd.current = undefined

      // Reusing the initial identity must not revive bytes cached before the write.
      version = 0n
      const second = await gitWorktreeContentHash(file)

      expect(second).not.toBe(first)
      expect(reads).toHaveLength(2)
    } finally {
      lstatFixture.current = undefined
      onStreamEnd.current = undefined
    }
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
