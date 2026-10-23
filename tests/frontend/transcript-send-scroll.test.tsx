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
const messages: TranscriptMessage[] = [
  { id: 'user-1', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'Inspect the fixture.' }] },
  { id: 'assistant-1', role: 'assistant', timestamp: 2, parts: [{ type: 'text', text: 'Done.' }] },
]

function render(root: Root, next: TranscriptMessage[]): void {
  act(() => root.render(<Transcript messages={next} followKey="session-old" git={git} onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
}

let container: HTMLDivElement
let root: Root
let scroller: HTMLDivElement
let scrollTo: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  scrollTo = vi.fn()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** jsdom has no layout; the scroll math reads these properties off the element. */
function fakeScrollMetrics(scrollHeight: number, clientHeight: number, scrollTop: number): void {
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: scrollTop })
}

function jumpButton(): HTMLButtonElement | null {
  return container.querySelector('.transcript__jump-to-bottom')
}

/** Renders the base history, then parks the reader away from the bottom the
 *  way a deliberate scroll-up does, so the transcript stops following. */
function renderScrolledAway(): void {
  render(root, messages)
  scroller = container.querySelector('.transcript') as HTMLDivElement
  scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo
  fakeScrollMetrics(1000, 400, 0)
  act(() => scroller.dispatchEvent(new Event('scroll')))
  expect(jumpButton()).not.toBeNull()
}

describe('transcript scroll on send', () => {
  it('re-anchors the view to the tail when the reader sends after scrolling up', () => {
    renderScrolledAway()

    render(root, [...messages, { id: 'user-2', role: 'user', timestamp: 3, parts: [{ type: 'text', text: 'One more thing.' }] }])
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' })
    expect(jumpButton()).toBeNull()
  })

  it('re-anchors when a batch already carries the streaming reply behind the sent message', () => {
    renderScrolledAway()

    const batch: TranscriptMessage[] = [
      ...messages,
      { id: 'user-2', role: 'user', timestamp: 3, parts: [{ type: 'text', text: 'One more thing.' }] },
      { id: 'assistant-2', role: 'assistant', timestamp: 4, streaming: true, parts: [{ type: 'text', text: 'Working…' }] },
    ]
    render(root, batch)
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' })
    expect(jumpButton()).toBeNull()
  })

  it('keeps the reader parked when only the model appends output', () => {
    renderScrolledAway()

    render(root, [...messages, { id: 'assistant-2', role: 'assistant', timestamp: 3, streaming: true, parts: [{ type: 'text', text: 'Still working…' }] }])
    expect(scrollTo).not.toHaveBeenCalled()
    expect(jumpButton()).not.toBeNull()
  })
})
