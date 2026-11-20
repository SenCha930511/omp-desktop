import { describe, expect, it } from 'vitest'
import { createTrustedRendererUrlCache, isTrustedRendererUrl } from '../../electron/main/ipc'

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

describe('renderer URL trust cache', () => {
  const expected = 'omp-desktop://app/'

  it('reuses a verdict only for the identical URL pair', () => {
    const trusted = createTrustedRendererUrlCache(expected)
    expect(trusted(expected, expected)).toBe(true)
    expect(trusted(expected, expected)).toBe(true)
    // The same top-level URL with a different main frame is a different pair.
    expect(trusted(expected, 'https://example.com/')).toBe(false)
    expect(trusted(expected, expected)).toBe(true)
  })

  it('revalidates when only the top-level URL changes', () => {
    const trusted = createTrustedRendererUrlCache(expected)
    expect(trusted(`${expected}#anchor`, expected)).toBe(true)
    expect(trusted('omp-desktop://app/other', expected)).toBe(false)
    expect(trusted(expected, expected)).toBe(true)
  })

  it('keeps the fragment rule of the underlying check', () => {
    const trusted = createTrustedRendererUrlCache(expected)
    expect(trusted(`${expected}#result`, `${expected}#other`)).toBe(true)
    expect(trusted(`${expected}#result`, `${expected}?debug=true`)).toBe(false)
  })
})
