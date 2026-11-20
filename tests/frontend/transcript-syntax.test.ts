import { describe, expect, it, vi } from 'vitest'
import { MAX_SYNTAX_HIGHLIGHTS, SYNTAX_LINE_CACHE_LIMIT, tokenizeSyntax, tokenizeSyntaxLine } from '../../src/components/transcript/syntax'

describe('transcript syntax tokenizer', () => {
  it('classifies repeated text from its current position', () => {
    const highlighted = tokenizeSyntax('{"same":"same","same":"same","value":true,"count":12}')
      .filter((token) => token.kind !== 'plain')

    expect(highlighted).toEqual([
      { kind: 'key', text: '"same"' },
      { kind: 'string', text: '"same"' },
      { kind: 'key', text: '"same"' },
      { kind: 'string', text: '"same"' },
      { kind: 'key', text: '"value"' },
      { kind: 'keyword', text: 'true' },
      { kind: 'key', text: '"count"' },
      { kind: 'number', text: '12' },
    ])
  })

  it('scans large repeated output without rescanning from the beginning and bounds styled fragments', () => {
    const input = Array.from({ length: 20_000 }, () => '"same":"same"').join(',')
    const indexOf = vi.spyOn(String.prototype, 'indexOf')
    try {
      const tokens = tokenizeSyntax(input)
      expect(tokens.map((token) => token.text).join('')).toBe(input)
      expect(tokens.filter((token) => token.kind !== 'plain')).toHaveLength(MAX_SYNTAX_HIGHLIGHTS)
      expect(tokens.length).toBeLessThanOrEqual(MAX_SYNTAX_HIGHLIGHTS * 2 + 1)
      expect(indexOf).not.toHaveBeenCalled()
    } finally {
      indexOf.mockRestore()
    }
  })
})

describe('per-line syntax cache', () => {
  it('reuses the tokens of a repeated line and evicts the least recently used one', () => {
    const line = '{"cachedLineProbe": true}'
    const first = tokenizeSyntaxLine(line)
    expect(first).toEqual(tokenizeSyntax(line))
    expect(tokenizeSyntaxLine(line)).toBe(first)

    for (let index = 0; index < SYNTAX_LINE_CACHE_LIMIT + 1; index += 1) tokenizeSyntaxLine(`{"filler": ${index}}`)

    const retokenized = tokenizeSyntaxLine(line)
    expect(retokenized).not.toBe(first)
    expect(retokenized).toEqual(first)
  })
})
