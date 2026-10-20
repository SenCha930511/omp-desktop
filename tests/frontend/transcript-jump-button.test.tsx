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

let container: HTMLDivElement
let root: Root
let scroller: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<Transcript messages={messages} git={git} onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
  scroller = container.querySelector('.transcript') as HTMLDivElement
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

describe('transcript jump-to-bottom button', () => {
  it('shows the live working word with the shine treatment while streaming', () => {
    act(() => root.render(<Transcript messages={[...messages, { id: 'assistant-2', role: 'assistant', timestamp: 3, streaming: true, parts: [] }]} git={git} active onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
    const word = container.querySelector('.streaming-state .shine-sweep')
    expect(word).not.toBeNull()
    expect(word?.textContent).toContain('working')
  })


  it('keeps a reader near the bottom in place when streaming continues', () => {
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo
    fakeScrollMetrics(1000, 400, 600)
    act(() => scroller.dispatchEvent(new Event('scroll')))
    fakeScrollMetrics(1000, 400, 580)
    act(() => scroller.dispatchEvent(new Event('scroll')))
    expect(jumpButton()).not.toBeNull()
    act(() => root.render(<Transcript messages={[...messages.slice(0, 1), { ...messages[1], streaming: true }]} git={git} onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
    expect(scrollTo).not.toHaveBeenCalled()
  })
  it('stays hidden while the transcript is at the bottom', () => {
    fakeScrollMetrics(1000, 400, 620)

    act(() => scroller.dispatchEvent(new Event('scroll')))

    expect(jumpButton()).toBeNull()
  })

  it('appears after scrolling away from the latest message', () => {
    fakeScrollMetrics(1000, 400, 0)

    act(() => scroller.dispatchEvent(new Event('scroll')))

    const button = jumpButton()
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('Scroll to the latest message')
  })

  it('scrolls back to the latest message and hides itself on click', () => {
    fakeScrollMetrics(1000, 400, 0)
    act(() => scroller.dispatchEvent(new Event('scroll')))
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo

    act(() => jumpButton()?.click())

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' })
    expect(jumpButton()).toBeNull()
  })

  it('treats the smooth ride as following the whole way down', () => {
    fakeScrollMetrics(1000, 400, 0)
    act(() => scroller.dispatchEvent(new Event('scroll')))
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo

    act(() => jumpButton()?.click())
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' })

    // Mid-flight distance must not unfollow or resurrect the jump button.
    act(() => {
      scroller.scrollTop = 320
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(jumpButton()).toBeNull()

    // Landing at the bottom ends the guard early; streaming growth follows again.
    act(() => {
      scroller.scrollTop = 600
      scroller.dispatchEvent(new Event('scroll'))
    })
    act(() => root.render(<Transcript messages={[...messages, { id: 'assistant-2', role: 'assistant', timestamp: 3, streaming: true, parts: [{ type: 'text', text: 'Still working…' }] }]} git={git} onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' })
  })

  it('keeps following live output after the jump button is clicked', () => {
    fakeScrollMetrics(1000, 400, 0)
    act(() => scroller.dispatchEvent(new Event('scroll')))
    expect(jumpButton()).not.toBeNull()

    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo
    act(() => jumpButton()?.click())
    act(() => {
      scroller.scrollTop = 600
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(jumpButton()).toBeNull()

    act(() => root.render(<Transcript messages={[...messages, { id: 'assistant-2', role: 'assistant', timestamp: 3, streaming: true, parts: [{ type: 'text', text: 'Still working…' }] }]} git={git} onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' })
  })

  it('re-engages following when the reader scrolls back down to the bottom while streaming', () => {
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo
    fakeScrollMetrics(1000, 400, 0)
    act(() => scroller.dispatchEvent(new Event('scroll')))
    expect(jumpButton()).not.toBeNull()

    act(() => root.render(<Transcript messages={[...messages, { id: 'assistant-2', role: 'assistant', timestamp: 3, streaming: true, parts: [{ type: 'text', text: 'Still working…' }] }]} git={git} onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
    expect(scrollTo).not.toHaveBeenCalled()

    act(() => {
      scroller.scrollTop = 580
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(jumpButton()).toBeNull()

    act(() => root.render(<Transcript messages={[...messages, { id: 'assistant-3', role: 'assistant', timestamp: 4, streaming: true, parts: [{ type: 'text', text: 'More output follows.' }] }]} git={git} onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' })
  })

  it('does not let content growth alone unfollow — parked scrollTop keeps tracking', () => {
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo
    fakeScrollMetrics(1000, 400, 600)
    act(() => scroller.dispatchEvent(new Event('scroll')))

    // The model appends more content: scrollHeight grows to 1400 while the
    // parked top stays at 600. Growth emits no scroll event, so following
    // continues and the next message snaps the view to the new tail.
    fakeScrollMetrics(1400, 400, 600)
    act(() => root.render(<Transcript messages={[...messages, { id: 'assistant-2', role: 'assistant', timestamp: 3, streaming: true, parts: [{ type: 'text', text: 'Still working…' }] }]} git={git} onOpenChanges={() => undefined} onSuggestion={() => undefined} />))

    expect(scrollTo).toHaveBeenCalled()
    expect(jumpButton()).toBeNull()
  })
})
