import { describe, expect, it, vi } from 'vitest'
import { tokenizeSyntaxText } from '../../src/lib/syntax-text'

describe('tool syntax tokenization', () => {
  it('classifies duplicate strings from their offsets rather than searching the full input', () => {
    const input = '{"same": "same", "enabled": true, "count": -12.5}'
    const tokens = tokenizeSyntaxText(input)

    expect(tokens.map(({ text, kind }) => [text, kind])).toEqual([
      ['{', 'plain'], ['"same"', 'key'], [': ', 'plain'], ['"same"', 'string'], [', ', 'plain'],
      ['"enabled"', 'key'], [': ', 'plain'], ['true', 'keyword'], [', ', 'plain'],
      ['"count"', 'key'], [': ', 'plain'], ['-12.5', 'number'], ['}', 'plain'],
    ])
    expect(tokens.map((token) => input.slice(token.start, token.end)).join('')).toBe(input)
  })

  it('scans a 200k-character output without per-token indexOf searches', () => {
    const input = '{"key":"value","n":123,"ok":true}\n'.repeat(6_000).slice(0, 200_000)
    const indexOf = vi.spyOn(String.prototype, 'indexOf')
    try {
      const tokens = tokenizeSyntaxText(input)
      expect(tokens.map((token) => token.text).join('')).toBe(input)
      expect(tokens.length).toBeGreaterThan(20_000)
      expect(indexOf).not.toHaveBeenCalled()
    } finally {
      indexOf.mockRestore()
    }
  })

  it('stops scanning once the highlight budget is reached', () => {
    const input = Array.from({ length: 100 }, () => '"key":"value"').join(',')
    const tokens = tokenizeSyntaxText(input, 2)
    expect(tokens.filter((token) => token.kind !== 'plain')).toHaveLength(2)
    expect(tokens.at(-1)?.kind).toBe('plain')
    expect(tokens.map((token) => token.text).join('')).toBe(input)
  })
})
