import { describe, expect, it } from 'vitest'
import { splitMarkdownBlocks } from '../../src/lib/markdown-blocks'

describe('streaming Markdown block split', () => {
  it('splits paragraphs and headings at blank lines', () => {
    expect(splitMarkdownBlocks('First paragraph.\n\n## Heading\n\nSecond paragraph.')).toEqual([
      'First paragraph.',
      '## Heading',
      'Second paragraph.',
    ])
  })

  it('keeps fenced code and display math in one block', () => {
    const fenced = 'Intro\n\n```ts\nconst value = 1\n\nconst next = 2\n```\n\nOutro'
    expect(splitMarkdownBlocks(fenced)).toEqual(['Intro', '```ts\nconst value = 1\n\nconst next = 2\n```', 'Outro'])

    const math = 'Intro\n\n$$\nx = 1\n\ny = 2\n$$\n\nOutro'
    expect(splitMarkdownBlocks(math)).toEqual(['Intro', '$$\nx = 1\n\ny = 2\n$$', 'Outro'])
  })

  it('does not split before list items or indented continuations', () => {
    const list = '- one\n\n- two\n\n  continuation'
    expect(splitMarkdownBlocks(list)).toEqual([list])

    const ordered = '1. one\n\n2. two'
    expect(splitMarkdownBlocks(ordered)).toEqual([ordered])
  })

  it('keeps reference and footnote definitions with their uses', () => {
    const text = '[ref]: https://example.com\n\nUse [ref] and [^note].\n\n[^note]: Footnote.'
    expect(splitMarkdownBlocks(text)).toEqual([text])
  })

  it('does not split before blockquotes, tables, or reference definitions', () => {
    expect(splitMarkdownBlocks('Intro\n\n> quote')).toEqual(['Intro\n\n> quote'])
    expect(splitMarkdownBlocks('Intro\n\n| A | B |\n| - | - |')).toEqual(['Intro\n\n| A | B |\n| - | - |'])
    expect(splitMarkdownBlocks('Intro\n\n[ref]: https://example.com')).toEqual(['Intro\n\n[ref]: https://example.com'])
  })

  it('returns the original text when no safe boundary exists', () => {
    const text = 'One line\nwith a soft break\n\n- item\n\n  continuation'
    expect(splitMarkdownBlocks(text)).toEqual([text])
  })
})
