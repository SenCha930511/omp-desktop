import { describe, expect, it } from 'vitest'
import { turnFileDeltas } from '../../src/lib/workspace'
import type { GitFileChange } from '../../src/types/api'

const file = (path: string, additions: number, deletions = 0): GitFileChange => ({ path, status: 'M', staged: false, additions, deletions })

describe('turn file deltas', () => {
  it('reports nothing before any turn has run in the window', () => {
    expect(turnFileDeltas([file('src/old.ts', 40)], null)).toEqual([])
  })

  it('counts newly dirty files in full and drops untouched baseline files', () => {
    const baseline = [file('src/old.ts', 40)]
    const current = [file('src/old.ts', 40), file('src/new.ts', 12, 3)]
    expect(turnFileDeltas(current, baseline)).toEqual([file('src/new.ts', 12, 3)])
  })

  it('counts only the growth of files that were already dirty', () => {
    const baseline = [file('src/shared.ts', 30, 10)]
    const current = [file('src/shared.ts', 45, 12)]
    expect(turnFileDeltas(current, baseline)).toEqual([file('src/shared.ts', 15, 2)])
  })

  it('drops files whose counts did not grow during the turn', () => {
    const baseline = [file('src/same.ts', 20, 5)]
    expect(turnFileDeltas([file('src/same.ts', 20, 5)], baseline)).toEqual([])
  })

  it('drops files that the turn cleaned up entirely', () => {
    const baseline = [file('src/reverted.ts', 20)]
    expect(turnFileDeltas([], baseline)).toEqual([])
  })
})
