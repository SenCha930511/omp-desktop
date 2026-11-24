import { Fragment, memo } from 'react'
import { MAX_SYNTAX_HIGHLIGHTS, type SyntaxTokenKind, tokenizeSyntaxText } from '@/lib/syntax-text'

export type { SyntaxTokenKind }

export interface SyntaxToken {
  kind: SyntaxTokenKind
  text: string
}

export { MAX_SYNTAX_HIGHLIGHTS }

export function tokenizeSyntax(text: string): SyntaxToken[] {
  const tokens = tokenizeSyntaxText(text, MAX_SYNTAX_HIGHLIGHTS)
  const bounded: SyntaxToken[] = []
  for (const token of tokens) {
    const previous = bounded.at(-1)
    if (token.kind === 'plain' && previous?.kind === 'plain') previous.text += token.text
    else bounded.push({ kind: token.kind, text: token.text })
  }
  return bounded
}

/**
 * Bounded LRU of per-line tokens. A streaming re-parse rebuilds every code
 * block's element, so without this each already-finished block re-tokenizes
 * all of its lines on every parse. Tokenization is a pure function of the
 * line text (the language only picks the badge), so the line is the whole
 * key; the cap keeps a long transcript from pinning unbounded memory.
 */
export const SYNTAX_LINE_CACHE_LIMIT = 2_000
const lineTokenCache = new Map<string, SyntaxToken[]>()

export function tokenizeSyntaxLine(line: string): SyntaxToken[] {
  const cached = lineTokenCache.get(line)
  if (cached) {
    // Re-insert so the eviction order stays least-recently-used.
    lineTokenCache.delete(line)
    lineTokenCache.set(line, cached)
    return cached
  }
  const tokens = tokenizeSyntax(line)
  if (lineTokenCache.size >= SYNTAX_LINE_CACHE_LIMIT) {
    const oldest = lineTokenCache.keys().next()
    if (!oldest.done) lineTokenCache.delete(oldest.value)
  }
  lineTokenCache.set(line, tokens)
  return tokens
}

/**
 * Bounded LRU of whole-text tokens for `SyntaxText`. Re-renders of the same
 * code block (virtual-scroll recycling, tab switches) used the uncached
 * tokenizer and re-ran the scanner on identical input. Both caps keep a long
 * transcript from pinning unbounded token arrays.
 */
const SYNTAX_TEXT_CACHE_LIMIT = 64
const SYNTAX_TEXT_MAX_CHARS = 16_384
const SYNTAX_TEXT_CACHE_CHARS = 524_288
const textTokenCache = new Map<string, SyntaxToken[]>()
let textTokenCacheChars = 0

export function tokenizeSyntaxCached(text: string): SyntaxToken[] {
  if (text.length > SYNTAX_TEXT_MAX_CHARS) return tokenizeSyntax(text)
  const cached = textTokenCache.get(text)
  if (cached) {
    textTokenCache.delete(text)
    textTokenCache.set(text, cached)
    return cached
  }
  const tokens = tokenizeSyntax(text)
  while (textTokenCache.size >= SYNTAX_TEXT_CACHE_LIMIT || textTokenCacheChars + text.length > SYNTAX_TEXT_CACHE_CHARS) {
    const oldest = textTokenCache.keys().next()
    if (oldest.done) break
    textTokenCache.delete(oldest.value)
    textTokenCacheChars -= oldest.value.length
  }
  textTokenCache.set(text, tokens)
  textTokenCacheChars += text.length
  return tokens
}

export const SyntaxText = memo(function SyntaxText({ text }: { text: string }) {
  return (
    <>
      {tokenizeSyntaxCached(text).map((token, index) => (
        <span className={token.kind === 'plain' ? undefined : `syntax-${token.kind}`} key={`${index}-${token.text.slice(0, 8)}`}>
          {token.text}
        </span>
      ))}
    </>
  )
})

export function InlineText({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, lineIndex) => (
        <Fragment key={`${lineIndex}-${line.slice(0, 12)}`}>
          {line
            .split(/(`[^`]+`)/g)
            .map((fragment, index) => (fragment.startsWith('`') && fragment.endsWith('`') ? <code key={index}>{fragment.slice(1, -1)}</code> : <Fragment key={index}>{fragment}</Fragment>))}
          {lineIndex < lines.length - 1 ? <br /> : null}
        </Fragment>
      ))}
    </>
  )
}
