import { describe, expect, it } from 'vitest'
import { isTrustedRendererUrl } from '../../electron/main/ipc'

describe('renderer URL trust', () => {
  it('allows only in-document fragments on the exact renderer URL', () => {
    const expected = 'omp-desktop://app/'
    expect(isTrustedRendererUrl(expected, expected)).toBe(true)
    expect(isTrustedRendererUrl(`${expected}#result`, expected)).toBe(true)
    expect(isTrustedRendererUrl('omp-desktop://app/other', expected)).toBe(false)
    expect(isTrustedRendererUrl('omp-desktop://app/?debug=true', expected)).toBe(false)
    expect(isTrustedRendererUrl('https://example.com/#result', expected)).toBe(false)
  })
})
