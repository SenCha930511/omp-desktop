// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Transcript } from '../../src/components/Transcript'
import type { GitStatus, TranscriptMessage } from '../../src/types/api'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const git: GitStatus = { isRepo: true, branch: 'main', files: [] }
const history: TranscriptMessage[] = [
  { id: 'user-1', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'Inspect the fixture.' }] },
  { id: 'assistant-1', role: 'assistant', timestamp: 2, parts: [{ type: 'text', text: 'Done.' }] },
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function render(messages: TranscriptMessage[], followKey?: string): void {
  act(() => root.render(<Transcript messages={messages} git={git} followKey={followKey} onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
}

function enterRows(): string[] {
  return [...container.querySelectorAll('.message--enter')].map((row) => row.textContent ?? '')
}

describe('transcript entrance animation', () => {
  it('gives no entrance class to messages present on the initial render', () => {
    render(history)
    expect(container.querySelector('.message--enter')).toBeNull()
    expect(container.querySelectorAll('article.message').length).toBe(2)
  })

  it('animates a user message appended after the transcript settles', () => {
    render(history)
    render([...history, { id: 'user-2', role: 'user', timestamp: 3, parts: [{ type: 'text', text: 'Now write the test.' }] }])
    const rows = container.querySelectorAll('article.message--user.message--enter')
    expect(rows.length).toBe(1)
    expect(rows[0]?.textContent).toContain('Now write the test.')
    // History rows keep their animation-free render.
    expect(enterRows().length).toBe(1)
  })

  it('animates an assistant message appended after the transcript settles', () => {
    render(history)
    render([
      ...history,
      { id: 'user-2', role: 'user', timestamp: 3, parts: [{ type: 'text', text: 'Another question.' }] },
      { id: 'assistant-2', role: 'assistant', timestamp: 4, parts: [{ type: 'text', text: 'Fresh reply.' }] },
    ])
    const rows = container.querySelectorAll('article.message--assistant.message--enter')
    expect(rows.length).toBe(1)
    expect(rows[0]?.textContent).toContain('Fresh reply.')
  })

  it('does not animate rows when switching sessions', () => {
    render(history, 'session-a')
    act(() => root.render(<Transcript messages={[]} git={git} followKey="session-b" loading onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
    const other: TranscriptMessage[] = [
      { id: 'other-user', role: 'user', timestamp: 4, parts: [{ type: 'text', text: 'Old conversation.' }] },
      { id: 'other-assistant', role: 'assistant', timestamp: 5, parts: [{ type: 'text', text: 'Old reply.' }] },
    ]
    render(other, 'session-b')
    expect(container.querySelector('.message--enter')).toBeNull()
    expect(container.querySelectorAll('article.message').length).toBe(2)
  })

  it('keeps the entrance class on a streaming assistant turn without re-adding it', () => {
    render(history)
    const streaming: TranscriptMessage = { id: 'assistant-2', role: 'assistant', timestamp: 4, streaming: true, parts: [{ type: 'text', text: 'Partial' }] }
    const turn: TranscriptMessage[] = [{ id: 'user-2', role: 'user', timestamp: 3, parts: [{ type: 'text', text: 'Another question.' }] }, streaming]
    render([...history, ...turn])
    render([...history, turn[0], { ...streaming, parts: [{ type: 'text', text: 'Partial more' }] }])
    expect(container.querySelectorAll('article.message--assistant.message--enter').length).toBe(1)
  })
})
