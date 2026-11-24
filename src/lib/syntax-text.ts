export type SyntaxTokenKind = 'plain' | 'key' | 'string' | 'keyword' | 'number'

export interface SyntaxToken {
  start: number
  end: number
  text: string
  kind: SyntaxTokenKind
}

const TOKEN_PATTERN = /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?\b)/g

export const MAX_SYNTAX_HIGHLIGHTS = 10_000

/** Scan syntax-like tool text once, retaining offsets for stable rendering keys. */
export function tokenizeSyntaxText(text: string, maxHighlights = Number.POSITIVE_INFINITY): SyntaxToken[] {
  const tokens: SyntaxToken[] = []
  let cursor = 0
  let highlights = 0
  TOKEN_PATTERN.lastIndex = 0
  for (let match = TOKEN_PATTERN.exec(text); match; match = TOKEN_PATTERN.exec(text)) {
    if (match.index > cursor) tokens.push({ start: cursor, end: match.index, text: text.slice(cursor, match.index), kind: 'plain' })
    const end = TOKEN_PATTERN.lastIndex
    const kind: SyntaxTokenKind = match[1] ? 'key' : match[2] ? 'string' : match[3] ? 'keyword' : 'number'
    if (highlights >= maxHighlights) {
      tokens.push({ start: match.index, end: text.length, text: text.slice(match.index), kind: 'plain' })
      return tokens
    }
    highlights += 1
    tokens.push({ start: match.index, end, text: match[0], kind })
    cursor = end
  }
  if (cursor < text.length) tokens.push({ start: cursor, end: text.length, text: text.slice(cursor), kind: 'plain' })
  return tokens
}
