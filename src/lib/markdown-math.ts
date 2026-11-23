/**
 * Normalizes LaTeX backslash delimiters (`\(...\)` and `\[...\]`) into
 * `remark-math` dollar delimiters (`$...$` and `$$...$$`) while leaving
 * fenced code blocks, inline code spans, escaped `\\(`/`\\[`, and
 * unclosed streaming delimiters untouched.
 */
export function normalizeLatexDelimiters(markdown: string): string {
  if (!markdown.includes('\\(') && !markdown.includes('\\[')) return markdown

  const lines = markdown.split('\n')
  const output: string[] = []
  let activeFence: { char: '`' | '~'; length: number } | null = null
  let displayBlock: { rawStart: string; contentLines: string[] } | null = null

  const flushUnclosedDisplay = () => {
    if (!displayBlock) return
    output.push(displayBlock.rawStart, ...displayBlock.contentLines.slice(1))
    displayBlock = null
  }

  for (const line of lines) {
    if (displayBlock !== null) {
      const closeIndex = findUnescapedClose(line, '\\]')
      if (closeIndex !== -1) {
        const beforeClose = line.slice(0, closeIndex)
        const afterClose = line.slice(closeIndex + 2)
        if (beforeClose.trim().length > 0) displayBlock.contentLines.push(beforeClose)
        const inner = displayBlock.contentLines.join('\n').trim()
        output.push('', '$$', inner, '$$', '')
        displayBlock = null
        if (afterClose.trim().length > 0) output.push(convertInlineLine(afterClose))
      } else {
        displayBlock.contentLines.push(line)
      }
      continue
    }

    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      const char = marker[0] as '`' | '~'
      const length = marker.length
      if (!activeFence) {
        if (char === '~' || !fenceMatch[2].includes('`')) {
          activeFence = { char, length }
        }
      } else if (activeFence.char === char && length >= activeFence.length && /^\s*$/.test(fenceMatch[2])) {
        activeFence = null
      }
      output.push(line)
      continue
    }

    if (activeFence) {
      output.push(line)
      continue
    }

    const trimmed = line.trim()
    if (trimmed.startsWith('\\[') && !trimmed.startsWith('\\\\[')) {
      const openIndex = line.indexOf('\\[')
      const closeIndex = findUnescapedClose(line, '\\]', openIndex + 2)
      if (closeIndex !== -1) {
        output.push(convertInlineLine(line))
        continue
      }
      displayBlock = { rawStart: line, contentLines: [line.slice(openIndex + 2)] }
      continue
    }

    output.push(convertInlineLine(line))
  }

  flushUnclosedDisplay()
  return output.join('\n')
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function findUnescapedClose(text: string, closeToken: string, startIndex = 0): number {
  let index = text.indexOf(closeToken, startIndex)
  while (index !== -1) {
    if (!isEscaped(text, index)) return index
    index = text.indexOf(closeToken, index + 2)
  }
  return -1
}

function convertInlineLine(line: string): string {
  if (!line.includes('\\(') && !line.includes('\\[')) return line
  let result = ''
  let index = 0

  while (index < line.length) {
    // Skip inline code spans (matching exact backtick fence length).
    if (line[index] === '`') {
      let tickCount = 0
      while (index + tickCount < line.length && line[index + tickCount] === '`') tickCount += 1
      const fence = '`'.repeat(tickCount)
      const closeTicks = line.indexOf(fence, index + tickCount)
      if (closeTicks !== -1) {
        result += line.slice(index, closeTicks + tickCount)
        index = closeTicks + tickCount
        continue
      }
      result += fence
      index += tickCount
      continue
    }

    if (line.startsWith('\\[', index) && !isEscaped(line, index)) {
      const closeIndex = findUnescapedClose(line, '\\]', index + 2)
      if (closeIndex !== -1) {
        const inner = line.slice(index + 2, closeIndex).trim()
        result += `\n\n$$\n${inner}\n$$\n\n`
        index = closeIndex + 2
        continue
      }
    }

    if (line.startsWith('\\(', index) && !isEscaped(line, index)) {
      const closeIndex = findUnescapedClose(line, '\\)', index + 2)
      if (closeIndex !== -1) {
        const inner = line.slice(index + 2, closeIndex).trim()
        if (inner.length > 0) {
          result += `$${inner}$`
          index = closeIndex + 2
          continue
        }
      }
    }

    result += line[index]
    index += 1
  }

  return result
}
