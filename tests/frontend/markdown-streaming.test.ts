// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownText, STREAMING_PARSE_INTERVAL_MS } from '../../src/components/MarkdownText'
import { Transcript } from '../../src/components/Transcript'
import type { TranscriptMessage } from '../../src/types/api'

describe('streaming Markdown rendering', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  })

  it('holds punctuation in the pending snapshot instead of rendering it as a separate block', () => {
    const render = (text: string) => act(() => root.render(createElement(MarkdownText, { text, streaming: true })))

    render('Let me do some web searches')
    render('Let me do some web searches|')
    render('Let me do some web searches|.')

    expect(container.textContent).toBe('Let me do some web searches|')
    expect(container.querySelectorAll('.prose > p')).toHaveLength(1)
    expect(container.querySelector('.prose-stream-tail')).toBeNull()

    act(() => vi.advanceTimersByTime(STREAMING_PARSE_INTERVAL_MS))

    expect(container.textContent).toBe('Let me do some web searches|.')
    expect(container.querySelectorAll('.prose > p')).toHaveLength(1)
  })

  it.each([false, true])('throttles the actual assistant path with activity=%s and flushes its final answer', (withActivity) => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const render = (text: string, streaming = true) => {
      const message: TranscriptMessage = {
        id: 'answer', role: 'assistant', timestamp: 1, streaming,
        parts: [...(withActivity ? [{ type: 'thinking' as const, text: 'Checking' }] : []), { type: 'text', text }],
      }
      act(() => root.render(createElement(Transcript, {
        messages: [message], active: streaming, git: { isRepo: false, files: [] },
        onOpenChanges: () => undefined, onSuggestion: () => undefined,
      })))
    }
    try {
      render('Answer')
      render('Answer one')
      render('Answer one two')
      expect(container.querySelector('.prose')?.textContent).toBe('Answer one')
      act(() => vi.advanceTimersByTime(STREAMING_PARSE_INTERVAL_MS))
      expect(container.querySelector('.prose')?.textContent).toBe('Answer one two')
      render('Answer one two final', false)
      expect(container.querySelector('.prose')?.textContent).toBe('Answer one two final')
    } finally { vi.unstubAllGlobals() }
  })
})
