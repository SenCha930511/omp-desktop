// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from '../../src/components/inspector/BrowserPanel'
import type { BrowserAnnotationsApi } from '../../src/hooks/useBrowserAnnotations'
import type { AgentBrowserTabRecord } from '../../src/types/api'
import type { AgentSlotRect } from '../../src/components/AgentBrowserLayer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface MutableRect {
  left: number
  top: number
  width: number
  height: number
}

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []

  readonly observe = vi.fn()
  readonly unobserve = vi.fn()
  readonly disconnect = vi.fn()

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this)
  }

  fire() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

const annotations: BrowserAnnotationsApi = {
  annotations: [],
  atCapacity: false,
  add: vi.fn(() => false),
  remove: vi.fn(),
  clear: vi.fn(),
  handleNavigation: vi.fn(),
  sendSignal: 0,
  requestSend: vi.fn(),
}

const agentTab: AgentBrowserTabRecord = {
  tabId: 'agent-tab',
  sessionFile: '/sessions/active.jsonl',
  url: 'https://example.com/',
  title: 'Example',
  attached: true,
  active: true,
  canGoBack: false,
  canGoForward: false,
}

let workspace: HTMLDivElement
let container: HTMLDivElement
let root: Root
let mounted: boolean
let currentRect: MutableRect
let onAgentSlotRect: ReturnType<typeof vi.fn<(rect: AgentSlotRect | null) => void>>

function domRect({ left, top, width, height }: MutableRect): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

async function renderPanel(previewSelected = false) {
  await act(async () => {
    root.render(
      <BrowserPanel
        home="https://example.com/"
        onOpenExternal={() => undefined}
        annotations={annotations}
        agentTabs={[agentTab]}
        activeAgentTabId={agentTab.tabId}
        previewSelected={previewSelected}
        onAgentSlotRect={onAgentSlotRect}
      />,
    )
  })
}

function latestObserver() {
  const observer = ResizeObserverMock.instances.at(-1)
  if (!observer) throw new Error('BrowserPanel did not create a ResizeObserver')
  return observer
}

beforeEach(() => {
  vi.useFakeTimers()
  ResizeObserverMock.instances = []
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  currentRect = { left: 10.2, top: 20.3, width: 100.4, height: 50.49 }
  onAgentSlotRect = vi.fn<(rect: AgentSlotRect | null) => void>()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return domRect(this.classList.contains('browser-agent-slot') ? currentRect : { left: 0, top: 0, width: 0, height: 0 })
  })
  workspace = document.createElement('div')
  workspace.className = 'session-workspace'
  container = document.createElement('div')
  workspace.append(container)
  document.body.append(workspace)
  root = createRoot(container)
  mounted = true
})

afterEach(async () => {
  if (mounted) await act(async () => root.unmount())
  workspace.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('BrowserPanel agent slot measurement', () => {
  it('emits the initial rounded rectangle once and never polls for layout', async () => {
    const interval = vi.spyOn(window, 'setInterval')
    await renderPanel()

    expect(onAgentSlotRect.mock.calls).toEqual([[{ left: 10, top: 20, width: 100, height: 50 }]])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    expect(onAgentSlotRect).toHaveBeenCalledTimes(1)
    expect(interval).not.toHaveBeenCalled()
  })

  it('observes the slot and its session workspace for geometry changes', async () => {
    await renderPanel()
    const observer = latestObserver()

    expect(observer.observe.mock.calls.map(([target]) => (target as HTMLElement).className)).toEqual([
      'browser-agent-slot',
      'session-workspace',
    ])

    currentRect = { ...currentRect, top: 60 }
    act(() => observer.fire())

    expect(onAgentSlotRect.mock.calls).toEqual([
      [{ left: 10, top: 20, width: 100, height: 50 }],
      [{ left: 10, top: 60, width: 100, height: 50 }],
    ])
  })

  it('still reports through the window resize listener when ResizeObserver is unavailable', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    await renderPanel()

    currentRect = { ...currentRect, top: 60 }
    act(() => window.dispatchEvent(new Event('resize')))

    expect(ResizeObserverMock.instances).toHaveLength(0)
    expect(onAgentSlotRect.mock.calls).toEqual([
      [{ left: 10, top: 20, width: 100, height: 50 }],
      [{ left: 10, top: 60, width: 100, height: 50 }],
    ])
  })

  it('emits once for every changed field and shares rounded equality across all triggers', async () => {
    await renderPanel()
    const observer = latestObserver()

    currentRect = { ...currentRect, left: 10.49 }
    act(() => observer.fire())
    act(() => window.dispatchEvent(new Event('resize')))
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(onAgentSlotRect).toHaveBeenCalledTimes(1)

    currentRect = { ...currentRect, left: 11.2 }
    act(() => observer.fire())
    expect(onAgentSlotRect).toHaveBeenLastCalledWith({ left: 11, top: 20, width: 100, height: 50 })

    act(() => window.dispatchEvent(new Event('resize')))
    expect(onAgentSlotRect).toHaveBeenCalledTimes(2)

    currentRect = { ...currentRect, top: 21.6 }
    act(() => window.dispatchEvent(new Event('resize')))
    expect(onAgentSlotRect).toHaveBeenLastCalledWith({ left: 11, top: 22, width: 100, height: 50 })

    currentRect = { ...currentRect, width: 101.6 }
    act(() => observer.fire())
    expect(onAgentSlotRect).toHaveBeenLastCalledWith({ left: 11, top: 22, width: 102, height: 50 })

    currentRect = { ...currentRect, height: 51.6 }
    act(() => observer.fire())
    expect(onAgentSlotRect).toHaveBeenLastCalledWith({ left: 11, top: 22, width: 102, height: 52 })
    expect(onAgentSlotRect).toHaveBeenCalledTimes(5)

    act(() => window.dispatchEvent(new Event('resize')))
    act(() => observer.fire())
    expect(onAgentSlotRect).toHaveBeenCalledTimes(5)
  })

  it('skips forced layout reads while the document is hidden and catches up when it is visible again', async () => {
    await renderPanel()
    const observer = latestObserver()
    const reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect)
    reads.mockClear()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)

    currentRect = { ...currentRect, top: 70 }
    act(() => observer.fire())
    act(() => window.dispatchEvent(new Event('resize')))

    expect(reads).not.toHaveBeenCalled()
    expect(onAgentSlotRect).toHaveBeenCalledTimes(1)

    hidden.mockReturnValue(false)
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    expect(onAgentSlotRect).toHaveBeenLastCalledWith({ left: 10, top: 70, width: 100, height: 50 })
    expect(onAgentSlotRect).toHaveBeenCalledTimes(2)
  })

  it('emits null once on hide and resets so re-show reports current geometry', async () => {
    await renderPanel()
    const visibleObserver = latestObserver()
    await renderPanel(true)

    expect(onAgentSlotRect.mock.calls).toEqual([
      [{ left: 10, top: 20, width: 100, height: 50 }],
      [null],
    ])
    expect(container.querySelector('.browser-agent-slot')).toBeNull()
    expect(visibleObserver.disconnect).toHaveBeenCalledOnce()

    currentRect = { left: 30, top: 40, width: 200, height: 90 }
    await renderPanel()

    expect(onAgentSlotRect.mock.calls).toEqual([
      [{ left: 10, top: 20, width: 100, height: 50 }],
      [null],
      [{ left: 30, top: 40, width: 200, height: 90 }],
    ])
    expect(container.querySelector('.browser-agent-slot')).not.toBeNull()
  })

  it('emits null exactly once when an active slot unmounts', async () => {
    await renderPanel()

    await act(async () => root.unmount())
    mounted = false

    expect(onAgentSlotRect.mock.calls).toEqual([
      [{ left: 10, top: 20, width: 100, height: 50 }],
      [null],
    ])
    expect(latestObserver().disconnect).toHaveBeenCalledOnce()
  })
})
