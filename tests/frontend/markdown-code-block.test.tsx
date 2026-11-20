// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODE_BLOCK_COPY_RESET_MS, MarkdownText } from '../../src/components/MarkdownText'
import * as clipboard from '../../src/lib/clipboard'

// Counts real tokenizer work: the code block must serve an unchanged line from
// its cache instead of re-tokenizing it on every Markdown re-parse.
const observed = vi.hoisted(() => ({ tokenizeCalls: 0 }))
vi.mock('../../src/lib/syntax-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/syntax-text')>()
  return {
    ...actual,
    tokenizeSyntaxText(text: string) {
      observed.tokenizeCalls += 1
      return actual.tokenizeSyntaxText(text)
    },
  }
})
describe('MarkdownCodeBlock', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    observed.tokenizeCalls = 0
    vi.useFakeTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  })

  it('renders fenced code blocks with header, data-lang badge, and syntax highlighting tokens', () => {
    const markdown = ['```json', '{"enabled": true, "count": 42, "label": "ok"}', '```'].join('\n')

    act(() => {
      root.render(createElement(MarkdownText, { text: markdown }))
    })

    const block = container.querySelector<HTMLElement>('.markdown-code-block')
    expect(block).not.toBeNull()
    expect(block?.getAttribute('dir')).toBe('ltr')

    const header = block?.querySelector<HTMLElement>('.markdown-code-block__header')
    expect(header).not.toBeNull()

    const langBadge = header?.querySelector<HTMLElement>('.markdown-code-block__lang')
    expect(langBadge).not.toBeNull()
    expect(langBadge?.getAttribute('data-lang')).toBe('json')
    expect(langBadge?.textContent).toBe('')

    expect(block?.querySelector('.syntax-key')?.textContent).toBe('"enabled"')
    expect(block?.querySelector('.syntax-keyword')?.textContent).toBe('true')
    expect(block?.querySelector('.syntax-number')?.textContent).toBe('42')
    expect(block?.querySelector('.syntax-string')?.textContent).toBe('"ok"')
  })

  it('copies code on click, transitions to is-copied / Copied aria-label, and resets after 2500ms', async () => {
    const writeSpy = vi.spyOn(clipboard, 'writeClipboardText').mockResolvedValue(undefined)
    const markdown = ['```ts', 'const answer = 42', 'const ok = true', '```'].join('\n')

    act(() => {
      root.render(createElement(MarkdownText, { text: markdown }))
    })

    const copyButton = container.querySelector<HTMLButtonElement>('.markdown-code-block__copy')
    expect(copyButton).not.toBeNull()
    expect(copyButton?.classList.contains('is-copied')).toBe(false)
    expect(copyButton?.getAttribute('aria-label')).toBe('Copy')

    await act(async () => {
      copyButton?.click()
      await Promise.resolve()
    })

    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy).toHaveBeenCalledWith('const answer = 42\nconst ok = true')
    expect(copyButton?.classList.contains('is-copied')).toBe(true)
    expect(copyButton?.getAttribute('aria-label')).toBe('Copied')
    expect(copyButton?.getAttribute('title')).toBe('Copied')

    act(() => {
      vi.advanceTimersByTime(CODE_BLOCK_COPY_RESET_MS - 1)
    })
    expect(copyButton?.classList.contains('is-copied')).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(copyButton?.classList.contains('is-copied')).toBe(false)
    expect(copyButton?.getAttribute('aria-label')).toBe('Copy')
    expect(copyButton?.getAttribute('title')).toBe('Copy')
  })

  it('keeps <article> and <pre> textContent strictly limited to prose and raw code without header/button text pollution', () => {
    const markdown = ['Intro paragraph.', '', '```ts', 'const clean = true', '```'].join('\n')

    act(() => {
      root.render(createElement('article', { className: 'message message--assistant' }, createElement(MarkdownText, { text: markdown })))
    })

    const pre = container.querySelector<HTMLPreElement>('pre')
    expect(pre?.textContent).toBe('const clean = true')

    const article = container.querySelector<HTMLElement>('article.message--assistant')
    expect(article?.textContent).toBe('Intro paragraph.\nconst clean = true')
    expect(article?.textContent).not.toContain('Copy')
    expect(article?.textContent).not.toContain('ts')
  })

  it('re-tokenizes nothing when the surrounding Markdown re-parses unchanged code', () => {
    const code = ['```json', '{"cacheProbe": true}', '{"cacheProbeTwo": 2}', '```'].join('\n')
    const render = (text: string) => act(() => root.render(createElement(MarkdownText, { text })))

    render(code)
    expect(observed.tokenizeCalls).toBe(2)
    expect(container.querySelector('.markdown-code-block .syntax-key')?.textContent).toBe('"cacheProbe"')

    observed.tokenizeCalls = 0
    // New prose re-parses the whole document; the block's own code is unchanged.
    render(`${code}\n\nAppended prose.`)

    expect(container.textContent).toContain('Appended prose.')
    expect(container.querySelector('.markdown-code-block .syntax-key')?.textContent).toBe('"cacheProbe"')
    expect(observed.tokenizeCalls).toBe(0)

    // A remount re-runs the component with empty memos; the bounded cache still
    // has to serve the lines instead of tokenizing them again.
    act(() => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    render(`${code}\n\nAppended prose.`)

    expect(container.querySelector('.markdown-code-block .syntax-key')?.textContent).toBe('"cacheProbe"')
    expect(observed.tokenizeCalls).toBe(0)
  })
})
