const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d+[.)])\s+/
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:/
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^/
const INDENTED_CONTINUATION = /^[ \t]/
const BLOCKQUOTE = /^ {0,3}>/
const TABLE = /^ {0,3}\|/
const HTML = /^ {0,3}</

function startsUnsafeContinuation(line: string): boolean {
  return LIST_ITEM.test(line)
    || REFERENCE_DEFINITION.test(line)
    || FOOTNOTE_DEFINITION.test(line)
    || INDENTED_CONTINUATION.test(line)
    || BLOCKQUOTE.test(line)
    || TABLE.test(line)
    || HTML.test(line)
}

/**
 * Splits streamed Markdown at blank lines where the next line starts a block
 * that cannot continue the previous one. The tail block stays live; committed
 * blocks keep their parsed React tree between streaming ticks.
 */
export function splitMarkdownBlocks(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  const blocks: string[] = []
  let start = 0
  let fence: { char: string; length: number } | null = null
  let math = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      const char = marker[0]!
      if (!fence) fence = { char, length: marker.length }
      else if (char === fence.char && marker.length >= fence.length && fenceMatch[2]!.trim() === '') fence = null
      continue
    }
    if (fence) continue
    if (trimmed === '$$') {
      math = !math
      continue
    }
    if (!math && trimmed.startsWith('$$') && !trimmed.endsWith('$$')) {
      math = true
      continue
    }
    if (math && trimmed.endsWith('$$')) {
      math = false
      continue
    }
    if (math || trimmed !== '') continue

    let next = index + 1
    while (next < lines.length && lines[next]!.trim() === '') next += 1
    if (next >= lines.length) break
    if (startsUnsafeContinuation(lines[next]!)) continue

    const block = lines.slice(start, index).join('\n').trimEnd()
    if (block) blocks.push(block)
    start = next
    index = next - 1
  }

  const tail = lines.slice(start).join('\n').trimEnd()
  if (tail) blocks.push(tail)
  return blocks.length > 0 ? blocks : [text]
}
