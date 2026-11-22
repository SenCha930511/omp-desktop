import { describe, expect, it } from 'vitest'
import { parseVitestReport } from '../../src/lib/vitest-report'

const FULL_FOOTER = 'Test Files 1 failed | 2 passed | 1 expected fail | 1 skipped | 1 todo (6)\nTests 3 failed | 9 passed | 2 expected fail | 4 skipped | 1 todo (19)'

describe('parseVitestReport', () => {
  it('parses every flat Vitest count category and checks both totals', () => {
    expect(parseVitestReport(FULL_FOOTER)).toEqual({
      files: { failed: 1, passed: 2, expectedFailed: 1, skipped: 1, todo: 1, total: 6 },
      tests: { failed: 3, passed: 9, expectedFailed: 2, skipped: 4, todo: 1, total: 19 },
    })
  })

  it('accepts genuine padStart(11) titles and strips SGR around padded footer labels', () => {
    const output = '\u001b[32m✓ example.test.ts\u001b[0m\n\u001b[2m Test Files\u001b[22m  \u001b[32m1 passed\u001b[39m (1)\n\u001b[2m      Tests\u001b[22m  1 passed (1)\nDuration 12ms'
    expect(parseVitestReport(output)).toEqual({
      files: { failed: 0, passed: 1, expectedFailed: 0, skipped: 0, todo: 0, total: 1 },
      tests: { failed: 0, passed: 1, expectedFailed: 0, skipped: 0, todo: 0, total: 1 },
    })
  })

  it('accepts CRLF as ordinary Windows footer line endings', () => {
    expect(parseVitestReport(' Test Files  2 passed (2)\r\n      Tests  8 passed (8)\r\n')).toEqual({
      files: { failed: 0, passed: 2, expectedFailed: 0, skipped: 0, todo: 0, total: 2 },
      tests: { failed: 0, passed: 8, expectedFailed: 0, skipped: 0, todo: 0, total: 8 },
    })
  })

  it('replaces all previous suite counts with the latest complete snapshot', () => {
    const old = 'Test Files 1 failed | 1 passed (2)\nTests 4 failed | 2 passed (6)'
    const latest = 'Test Files 2 passed (2)\nTests 8 passed (8)'
    expect(parseVitestReport(`${old}\n${latest}`)).toEqual({
      files: { failed: 0, passed: 2, expectedFailed: 0, skipped: 0, todo: 0, total: 2 },
      tests: { failed: 0, passed: 8, expectedFailed: 0, skipped: 0, todo: 0, total: 8 },
    })
    expect(parseVitestReport(`${FULL_FOOTER}\nTest Files 1 failed | 1 passed (2)`)).toMatchObject({ files: { total: 6 }, tests: { total: 19 } })
  })

  it.each([
    'Tests 220 passed',
    'Tests 50% passed',
    'Test Files 1 passed (1)',
    'Tests 1 passed (1)',
    'Test Files 1 passed (1)\nTests 2 passed (1)',
    'Test Files 1 passed | 1 passed (1)\nTests 1 passed (1)',
    'Test Files 1 passed | unknown 2 (1)\nTests 1 passed (1)',
    'Test Files one passed (1)\nTests 1 passed (1)',
    'Test Files 1 passed (1) trailing\nTests 1 passed (1)',
    ' Test Files  1 passed (1)\n      Tests  8 passed',
  ])('returns no summary for unsupported or inconsistent footer %j', (output) => {
    expect(parseVitestReport(output)).toBeUndefined()
  })

  it.each([
    '\u001b[2JTest Files 1 passed (1)\nTests 1 passed (1)',
    '\u001b]0;title\u0007Test Files 1 passed (1)\nTests 1 passed (1)',
    'Test Files 1 passed (1)\rTests 1 passed (1)',
    '\u001b[31Test Files 1 passed (1)\nTests 1 passed (1)',
    'Test Files 1 passed (1)\nTests 1 passed (1)\u0007',
    `${'x'.repeat(256 * 1024 + 1)}\n${FULL_FOOTER}`,
    `clipped\n… [truncated] …\n${FULL_FOOTER}`,
  ])('rejects active control sequences, partial lines, and truncated input', (output) => {
    expect(parseVitestReport(output)).toBeUndefined()
  })

  it('does not infer a summary or exit status from arbitrary shell output', () => {
    expect(parseVitestReport('All checks passed. 100% complete.')).toBeUndefined()
    expect(parseVitestReport('Wall time: 1.5 seconds')).toBeUndefined()
    expect(parseVitestReport('')).toBeUndefined()
  })
})
