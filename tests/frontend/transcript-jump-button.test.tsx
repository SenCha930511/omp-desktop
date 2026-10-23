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
let resizeCallbacks: ResizeObserverCallback[]

beforeEach(() => {
  resizeCallbacks = []
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback) } observe() {} disconnect() {} })
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

  it('ignores an upward wheel flick when the transcript fits without scrolling', () => {
    // Content shorter than the viewport can never scroll up; flagging away
    // here used to stick the button on a transcript pinned at its bottom.
    fakeScrollMetrics(400, 400, 0)

    act(() => scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })))

    expect(jumpButton()).toBeNull()
  })

  it('ignores an upward wheel flick while the scroller is at its top', () => {
    fakeScrollMetrics(1000, 400, 0)

    act(() => scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })))

    expect(jumpButton()).toBeNull()
  })

  it('unpins on an upward wheel when upward travel exists', () => {
    fakeScrollMetrics(1000, 400, 600)

    act(() => scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })))

    expect(jumpButton()).not.toBeNull()
  })

  it('self-heals a stuck jump button when a resize lands the viewport at the bottom', () => {
    fakeScrollMetrics(1000, 400, 200)
    act(() => scroller.dispatchEvent(new Event('scroll')))
    expect(jumpButton()).not.toBeNull()

    // Content shrank back underneath the parked scroll position: no scroll
    // events fire for that, only the layout observer sees the new bottom.
    fakeScrollMetrics(600, 400, 200)
    act(() => resizeCallbacks[resizeCallbacks.length - 1]([], {} as ResizeObserver))

    expect(jumpButton()).toBeNull()
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

  it('hides the jump button when a shrinking placeholder clamps scrollTop at the bottom', () => {
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo
    fakeScrollMetrics(1000, 400, 600)
    act(() => scroller.dispatchEvent(new Event('scroll')))
    expect(jumpButton()).toBeNull()

    // The streaming placeholder unmounts: scrollHeight drops to 900, the
    // browser clamps scrollTop from 600 to 500 and fires a scroll event.
    // That clamp is engine reflow, not user intent — following must hold.
    fakeScrollMetrics(900, 400, 500)
    act(() => scroller.dispatchEvent(new Event('scroll')))
    expect(jumpButton()).toBeNull()

    act(() => root.render(<Transcript messages={[...messages, { id: 'assistant-2', role: 'assistant', timestamp: 3, streaming: true, parts: [{ type: 'text', text: 'Still working…' }] }]} git={git} onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: 'auto' })
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

describe('work-record expansion over the tail', () => {
  // The accordion's 200ms animation outlives the manual scroll window, so
  // these cases drive performance.now() directly instead of racing real time.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['performance'] }) })
  afterEach(() => { vi.useRealTimers() })

  const agentMessages: TranscriptMessage[] = [
    ...messages,
    { id: 'agent-1', role: 'agent', timestamp: 3, agentName: 'Researcher', parts: [{ type: 'text', text: 'Agent findings.' }] },
  ]

  it('holds the reader in place while an expanded record grows over the tail', () => {
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo
    act(() => root.render(<Transcript messages={agentMessages} git={git} onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
    const summary = container.querySelector('.agent-message__summary') as HTMLButtonElement
    fakeScrollMetrics(1000, 400, 600) // reading at the tail, following engaged

    // Expanding the record: the accordion's early frames still read as "at
    // the bottom", which is exactly what used to re-engage following.
    act(() => summary.click())
    fakeScrollMetrics(1000, 400, 600)
    act(() => resizeCallbacks[resizeCallbacks.length - 1]([], {} as ResizeObserver))
    expect(scrollTo).not.toHaveBeenCalled()

    // The animation keeps growing past the manual window; still no yank.
    vi.advanceTimersByTime(300)
    fakeScrollMetrics(2400, 400, 600)
    act(() => resizeCallbacks[resizeCallbacks.length - 1]([], {} as ResizeObserver))
    expect(scrollTo).not.toHaveBeenCalled()

    // Live output keeps streaming below the record; the reader stays put.
    act(() => root.render(<Transcript messages={[...agentMessages, { id: 'assistant-2', role: 'assistant', timestamp: 4, streaming: true, parts: [] }]} git={git} onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
    expect(scrollTo).not.toHaveBeenCalled()

    // A deliberate scroll back to the tail re-engages following.
    fakeScrollMetrics(2400, 400, 2000)
    act(() => scroller.dispatchEvent(new Event('scroll')))
    fakeScrollMetrics(2600, 400, 2000)
    act(() => resizeCallbacks[resizeCallbacks.length - 1]([], {} as ResizeObserver))
    expect(scrollTo).toHaveBeenCalledWith({ top: 2600, behavior: 'auto' })
  })

  it('resumes following once the expanded record collapses back over the tail', () => {
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo
    act(() => root.render(<Transcript messages={agentMessages} git={git} onOpenChanges={() => undefined} onSuggestion={() => undefined} />))
    const summary = container.querySelector('.agent-message__summary') as HTMLButtonElement
    fakeScrollMetrics(1000, 400, 600)

    act(() => summary.click()) // open
    act(() => summary.click()) // close
    expect(summary.getAttribute('aria-expanded')).toBe('false')

    // Collapsing shrinks the record away; the tail is visible again and the
    // near-bottom self-heal re-engages following like any reflow does.
    fakeScrollMetrics(1000, 400, 600)
    act(() => resizeCallbacks[resizeCallbacks.length - 1]([], {} as ResizeObserver))
    expect(scrollTo).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    fakeScrollMetrics(1400, 400, 600)
    act(() => resizeCallbacks[resizeCallbacks.length - 1]([], {} as ResizeObserver))
    expect(scrollTo).toHaveBeenCalledWith({ top: 1400, behavior: 'auto' })
  })
})
