// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTranscriptScroll } from '../../src/components/transcript/scroll'
import type { TranscriptMessage } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
  unobserve() {}
})

const message = (id: string): TranscriptMessage => ({
  id, role: 'assistant', timestamp: 0, parts: [{ type: 'text', text: `message ${id}` }],
})

const messages = Array.from({ length: 5 }, (_, index) => message(`m-${index}`))

type ScrollApi = ReturnType<typeof useTranscriptScroll>

function Harness({ out }: { out: (value: ScrollApi) => void }) {
  const value = useTranscriptScroll(messages, true)
  out(value)
  return (
    <div ref={value.scrollRef} className="scroll-area" onScroll={value.updatePinnedState}>
      <div className="transcript__inner">{messages.map((item) => <div key={item.id}>{item.id}</div>)}</div>
    </div>
  )
}

let container: HTMLDivElement
let root: Root
let api: ScrollApi

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

const setMetrics = (element: HTMLElement, { scrollTop, scrollHeight = 1000, clientHeight = 400 }: { scrollTop: number; scrollHeight?: number; clientHeight?: number }) => {
  Object.defineProperty(element, 'scrollTop', { configurable: true, get: () => scrollTop })
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(element, 'scrollTo', { configurable: true, value: () => undefined })
}

const fireScroll = async (element: HTMLElement, metrics: { scrollTop: number; scrollHeight?: number; clientHeight?: number }) => {
  setMetrics(element, metrics)
  await act(async () => { element.dispatchEvent(new Event('scroll')) })
}

describe('transcript scroll landing recovery', () => {
  it('recovers following when the gesture settles at the bottom after a jittered landing', async () => {
    await act(async () => { root.render(<Harness out={(value) => { api = value }} />) })
    const scroller = container.querySelector<HTMLElement>('.scroll-area')!

    // Scrolled up: the jump button shows and following is off.
    await fireScroll(scroller, { scrollTop: 500 })
    expect(api.awayFromBottom).toBe(true)

    // A downward fling whose final frame jitters upward: the last scroll
    // event reads movedUp and marks the reader away even though the resting
    // position is the very bottom — the button used to linger from here.
    await fireScroll(scroller, { scrollTop: 603 })
    await fireScroll(scroller, { scrollTop: 601 })
    expect(api.awayFromBottom).toBe(true)

    // scrollend fires once the gesture — momentum included — has stopped.
    await act(async () => { scroller.dispatchEvent(new Event('scrollend')) })
    expect(api.awayFromBottom).toBe(false)
  })

  it('keeps the away state when the gesture settles away from the bottom', async () => {
    await act(async () => { root.render(<Harness out={(value) => { api = value }} />) })
    const scroller = container.querySelector<HTMLElement>('.scroll-area')!

    await fireScroll(scroller, { scrollTop: 500 })
    expect(api.awayFromBottom).toBe(true)

    await act(async () => { scroller.dispatchEvent(new Event('scrollend')) })
    expect(api.awayFromBottom).toBe(true)
  })
})
