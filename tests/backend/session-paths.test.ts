import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalSessionPath } from '../../electron/main/session-paths'

const realpathCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    realpathSync: (path: string): string => {
      realpathCalls.count += 1
      return path.startsWith('/virtual/') ? path : actual.realpathSync(path)
    },
  }
})

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-paths-')); dirs.push(dir); return dir }

describe('canonicalSessionPath cache', () => {
  it('serves a repeated path without another realpath', () => {
    const dir = temp()
    const target = join(dir, 'target')
    mkdirSync(target)
    const canonical = realpathSync(target)
    realpathCalls.count = 0

    expect(canonicalSessionPath(target)).toBe(canonical)
    const afterFirst = realpathCalls.count
    expect(afterFirst).toBeGreaterThan(0)
    expect(canonicalSessionPath(target)).toBe(canonical)
    expect(realpathCalls.count).toBe(afterFirst)
  })

  it('keeps one entry per resolved path', () => {
    const dir = temp()
    const first = join(dir, 'first')
    const second = join(dir, 'second')
    mkdirSync(first); mkdirSync(second)
    const firstLink = join(dir, 'first-link')
    const secondLink = join(dir, 'second-link')
    symlinkSync(first, firstLink, 'dir'); symlinkSync(second, secondLink, 'dir')

    expect(canonicalSessionPath(firstLink)).toBe(realpathSync(first))
    expect(canonicalSessionPath(secondLink)).toBe(realpathSync(second))
    expect(canonicalSessionPath(firstLink)).toBe(realpathSync(first))
    expect(canonicalSessionPath(secondLink)).toBe(realpathSync(second))
  })

  it('evicts the coldest entry instead of clearing the whole cache', () => {
    const dir = temp()
    const target = join(dir, 'target')
    mkdirSync(target)
    canonicalSessionPath(target)
    for (let index = 0; index < 1_024; index += 1) canonicalSessionPath(`/virtual/fill-${index}`)
    // The 1,025th insert evicts the target (the oldest entry) only: recent
    // entries survive, so the map never restarts from empty.
    canonicalSessionPath('/virtual/overflow')
    const afterFill = realpathCalls.count
    canonicalSessionPath('/virtual/fill-1000')
    expect(realpathCalls.count).toBe(afterFill)
    canonicalSessionPath(target)
    expect(realpathCalls.count).toBe(afterFill + 1)
  })

  it('keeps a re-read entry hot across a burst of distinct paths', () => {
    canonicalSessionPath('/virtual/hot')
    for (let index = 0; index < 1_023; index += 1) canonicalSessionPath(`/virtual/burst-${index}`)
    // Re-reading refreshes recency, so the next insert evicts `/virtual/burst-0`.
    canonicalSessionPath('/virtual/hot')
    canonicalSessionPath('/virtual/late')
    const before = realpathCalls.count
    canonicalSessionPath('/virtual/hot')
    expect(realpathCalls.count).toBe(before)
    canonicalSessionPath('/virtual/burst-0')
    expect(realpathCalls.count).toBe(before + 1)
  })
})
