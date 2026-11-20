// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentBrowserLayer } from '../../src/components/AgentBrowserLayer'
import type { StampedActivityEvent } from '../../src/hooks/useAgentBrowserTabs'
import type { AgentBrowserTabRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom renders <webview> as HTMLUnknownElement; give the prototype the one
// guest method the layer calls so dom-ready can be simulated.
const webviewProto = window.HTMLUnknownElement.prototype as unknown as Record<string, unknown>
const WEB_CONTENTS_ID = 4242
const webviewMethods = { getWebContentsId: () => WEB_CONTENTS_ID }

const activeTab: AgentBrowserTabRecord = {
  tabId: 'bt-active',
  sessionFile: '/sessions/active.jsonl',
  url: 'https://active.example/',
  title: 'Active',
  attached: true,
  active: true,
  canGoBack: false,
  canGoForward: false,
}

const backgroundTab: AgentBrowserTabRecord = {
  tabId: 'bt-background',
  sessionFile: '/sessions/background.jsonl',
  url: 'https://background.example/',
  title: 'Background',
  attached: true,
  active: true,
  canGoBack: false,
  canGoForward: false,
}

const IDLE_MS = 1_000

let container: HTMLDivElement
let root: Root
let onAttach: ReturnType<typeof vi.fn<(tabId: string, webContentsId: number) => void>>

interface RenderOptions {
  tabs?: AgentBrowserTabRecord[]
  activeSessionFiles?: string[]
  visibleTabId?: string | null
  activityEvent?: StampedActivityEvent | null
}

async function renderLayer(options: RenderOptions = {}) {
  await act(async () => {
    root.render(
      <AgentBrowserLayer
        tabs={options.tabs ?? [activeTab, backgroundTab]}
        visibleTabId={options.visibleTabId ?? null}
        rect={null}
        pointerEvent={null}
        onAttach={onAttach}
        activeSessionFiles={options.activeSessionFiles ?? ['/sessions/active.jsonl']}
        activityEvent={options.activityEvent ?? null}
        idleUnloadMs={IDLE_MS}
      />,
    )
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function mountedTabIds(): string[] {
  return [...container.querySelectorAll<HTMLElement>('.agent-browser-tab')].map((element) => element.dataset.tabId ?? '')
}

function webviewOf(tabId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`.agent-browser-tab[data-tab-id="${tabId}"] webview`)
  if (!element) throw new Error(`No webview mounted for ${tabId}`)
  return element
}

function activityEvent(tabId: string, seq: number): StampedActivityEvent {
  return { sessionFile: '/sessions/background.jsonl', tabId, seq }
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(webviewProto, webviewMethods)
  onAttach = vi.fn<(tabId: string, webContentsId: number) => void>()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  for (const key of Object.keys(webviewMethods)) delete webviewProto[key]
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AgentBrowserLayer idle guest release', () => {
  it('releases only the idle background session guest and keeps the active session mounted', async () => {
    await renderLayer()
    expect(mountedTabIds()).toEqual(['bt-active', 'bt-background'])

    await advance(IDLE_MS - 1)
    expect(mountedTabIds()).toEqual(['bt-active', 'bt-background'])

    await advance(2)
    expect(mountedTabIds()).toEqual(['bt-active'])
  })

  it('keeps a background tab mounted while it is the visible agent tab', async () => {
    await renderLayer({ visibleTabId: 'bt-background' })

    await advance(IDLE_MS + 1)

    expect(mountedTabIds()).toEqual(['bt-active', 'bt-background'])
  })

  it('remounts the released guest on return to its session and reports it for the saved-url reload', async () => {
    await renderLayer()
    await advance(IDLE_MS + 1)
    expect(mountedTabIds()).toEqual(['bt-active'])

    // The user switches back to the background session.
    await renderLayer({ activeSessionFiles: ['/sessions/background.jsonl'] })
    expect(mountedTabIds()).toEqual(['bt-active', 'bt-background'])

    // dom-ready is what lets the main process reload the tab's saved url.
    act(() => {
      webviewOf('bt-background').dispatchEvent(new Event('dom-ready'))
    })
    expect(onAttach).toHaveBeenCalledWith('bt-background', WEB_CONTENTS_ID)
  })

  it('remounts an idle-released tab when the agent acts on it and restarts its idle clock', async () => {
    await renderLayer()
    await advance(IDLE_MS + 1)
    expect(mountedTabIds()).toEqual(['bt-active'])

    await renderLayer({ activityEvent: activityEvent('bt-background', 1) })
    expect(mountedTabIds()).toEqual(['bt-active', 'bt-background'])

    await advance(IDLE_MS - 1)
    expect(mountedTabIds()).toEqual(['bt-active', 'bt-background'])

    await advance(2)
    expect(mountedTabIds()).toEqual(['bt-active'])
  })

  it('leaves tabs of the active session mounted across repeated snapshots', async () => {
    await renderLayer()
    for (let snapshot = 0; snapshot < 3; snapshot += 1) {
      await renderLayer({ tabs: [{ ...activeTab }, { ...backgroundTab }] })
      await advance(600)
    }
    // Repeated pushes must not restart the background tab's clock.
    expect(mountedTabIds()).toEqual(['bt-active'])

    await advance(IDLE_MS)
    expect(mountedTabIds()).toEqual(['bt-active'])
  })
})
