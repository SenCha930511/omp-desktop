import { describe, expect, it } from 'vitest'
import { formatCompactRelative } from '../../src/lib/data'

const now = Date.parse('2026-11-20T12:00:00.000Z')
const ago = (ms: number) => new Date(now - ms).toISOString()

describe('formatCompactRelative', () => {
  it('uses compact units for dense session rows', () => {
    expect(formatCompactRelative(ago(30_000), { now })).toBe('now')
    expect(formatCompactRelative(ago(8 * 60_000), { now })).toBe('8m')
    expect(formatCompactRelative(ago(20 * 3_600_000), { now })).toBe('20h')
    expect(formatCompactRelative(ago(3 * 86_400_000), { now })).toBe('3d')
    expect(formatCompactRelative(ago(2 * 604_800_000), { now })).toBe('2w')
    expect(formatCompactRelative(ago(35 * 86_400_000), { now })).toBe('1mo')
    expect(formatCompactRelative(ago(400 * 86_400_000), { now })).toBe('1y')
  })

  it('localizes the sub-minute label and ignores malformed input', () => {
    expect(formatCompactRelative(ago(10_000), { now, nowLabel: '現在' })).toBe('現在')
    expect(formatCompactRelative('not-a-date', { now })).toBe('')
    expect(formatCompactRelative(undefined, { now })).toBe('')
  })
})
