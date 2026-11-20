// @vitest-environment jsdom

import './jsdom-storage'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { WorkspaceInspector } from '../../src/components/WorkspaceInspector'
import { useBrowserAnnotations, type BrowserAnnotationsApi } from '../../src/hooks/useBrowserAnnotations'
import type { InspectorProps } from '../../src/components/Inspector'
import type { TranscriptStore } from '../../src/app/transcript-store'
import type { TranscriptMessage } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const observed = vi.hoisted(() => ({ inspectorProps: [] as unknown[], changesPanelRenders: 0, summaryPanelRenders: 0 }))

// Wraps the memoized Inspector, so every App render is observed even when the
// memo (correctly) skips the inspector subtree.
vi.mock('../../src/components/Inspector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/Inspector')>()
  return {
    ...actual,
    Inspector(props: InspectorProps) {
      observed.inspectorProps.push(props)
      return <actual.Inspector {...props} />
    },
  }
})

// Rendered inside the memo, so its render count is exactly the number of times
// the memo let a re-render through on the changes tab.
vi.mock('../../src/components/inspector/ChangesPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/inspector/ChangesPanel')>()
  return {
    ...actual,
    ChangesPanel(props: Parameters<typeof actual.ChangesPanel>[0]) {
      observed.changesPanelRenders += 1
      return <actual.ChangesPanel {...props} />
    },
  }
})

// Rendered inside the memo, so its render count is exactly the number of summary
// snapshots the Summary tab let through.
vi.mock('../../src/components/inspector/SummaryPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/inspector/SummaryPanel')>()
  return {
    ...actual,
    SummaryPanel(props: Parameters<typeof actual.SummaryPanel>[0]) {
      observed.summaryPanelRenders += 1
      return <actual.SummaryPanel {...props} />
    },
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  observed.inspectorProps = []
  observed.changesPanelRenders = 0
  observed.summaryPanelRenders = 0
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class { observe() {} unobserve() {} disconnect() {} },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const toggleSidebar = async () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true })) })

const renderApp = async () => {
  // Resolve the lazy inspector chunk up front so its Suspense boundary settles on mount.
  await import('../../src/components/WorkspaceInspector')
  await act(async () => { root.render(<App />) })
  await act(async () => {})
}

const openChangesTab = async () => {
  const changesTab = [...container.querySelectorAll<HTMLButtonElement>('.inspector__tabs button')].find((button) => button.textContent?.startsWith('Changes'))
  expect(changesTab).toBeDefined()
  await act(async () => { changesTab?.click() })
  expect(container.querySelector('#inspector-panel-changes')).not.toBeNull()
}

describe('inspector re-render containment', () => {
  it('keeps the memoized inspector subtree mounted across App re-renders on the changes tab', async () => {
    await renderApp()
    await openChangesTab()

    const rendersAfterTabChange = observed.changesPanelRenders
    const appRendersAfterTabChange = observed.inspectorProps.length
    expect(rendersAfterTabChange).toBeGreaterThan(0)

    await toggleSidebar()
    await toggleSidebar()

    // App re-rendered, the memo held: no work reached the inspector subtree.
    expect(observed.inspectorProps.length).toBeGreaterThan(appRendersAfterTabChange)
    expect(observed.changesPanelRenders).toBe(rendersAfterTabChange)
  })

  it('hands the inspector the store summary and stable git and annotation identities while the changes tab is active', async () => {
    await renderApp()
    const props = observed.inspectorProps as InspectorProps[]
    // The summary tab is the default and does consume the transcript summary.
    expect(props[props.length - 1]!.summary.count).toBeGreaterThan(0)

    await openChangesTab()
    const first = props[props.length - 1]!
    await toggleSidebar()
    const last = props[props.length - 1]!
    expect(last).not.toBe(first)
    // Off the summary tab nothing reads the transcript, so only the empty summary reaches the memo boundary.
    expect(last.summary.count).toBe(0)
    expect(last.summary).toBe(first.summary)
    expect(last.git).toBe(first.git)
    expect(last.browserAnnotations).toBe(first.browserAnnotations)
    expect(last.automations).toBe(first.automations)
    expect(last.onSelectAgentTab).toBe(first.onSelectAgentTab)
    expect(last.onPreviewContext).toBe(first.onPreviewContext)
    expect(last.onNavigateAgentTab).toBe(first.onNavigateAgentTab)
    expect(last.onGrantProject).toBe(first.onGrantProject)
    expect(last.onOpenAutomation).toBe(first.onOpenAutomation)
    expect(last.onShowBrowserPreview).toBe(first.onShowBrowserPreview)
  })
})

describe('summary tab data flow', () => {
  const liveMessages = (text: string): TranscriptMessage[] => [
    { id: 'user', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'ask' }] },
    { id: 'live', role: 'assistant', timestamp: 2, streaming: true, parts: [{ type: 'toolCall', id: 'tool', name: 'Read' }, { type: 'text', text }] },
  ]

  function Harness({ transcript }: { transcript: TranscriptStore }) {
    return (
      <WorkspaceInspector
        transcript={transcript}
        activeTab="summary"
        onTabChange={() => undefined}
        onClose={() => undefined}
        git={{ isRepo: false, files: [] }}
        automations={[]}
        onOpenAutomation={() => undefined}
        browserHome="about:blank"
        browserAnnotations={useBrowserAnnotations()}
        agentBrowserTabs={[]}
        activeAgentTabId={null}
        agentPreviewSelected={false}
        onSelectAgentTab={() => undefined}
        onCloseAgentTab={() => undefined}
        onShowBrowserPreview={() => undefined}
        onAgentSlotRect={() => undefined}
        onPreviewContext={() => undefined}
        previewPointerEvent={null}
        onNavigateAgentTab={() => undefined}
        onRefreshGit={() => undefined}
        onOpenExternal={() => undefined}
        onRevealPath={() => undefined}
        onGrantProject={() => undefined}
      />
    )
  }

  it('renders the summary snapshot and never subscribes to or rescans the message list', async () => {
    const { createTranscriptStore } = await import('../../src/app/transcript-store')
    const store = createTranscriptStore(liveMessages('Answer:'))
    const subscribe = vi.spyOn(store, 'subscribe')
    const getSnapshot = vi.spyOn(store, 'getSnapshot')
    await act(async () => { root.render(<Harness transcript={store} />) })

    expect(observed.inspectorProps.length).toBeGreaterThan(0)
    expect(observed.inspectorProps.at(-1)).not.toHaveProperty('messages')
    expect((observed.inspectorProps.at(-1) as InspectorProps).summary).toMatchObject({ count: 2, toolCount: 1, lastText: 'Answer:', streaming: true })

    // A streamed token republishes the summary snapshot; the tab re-renders from it, never from messages.
    const rendersBeforeToken = observed.summaryPanelRenders
    await act(async () => { store.update(liveMessages('Answer: streaming')) })
    expect(observed.summaryPanelRenders).toBeGreaterThan(rendersBeforeToken)
    expect((observed.inspectorProps.at(-1) as InspectorProps).summary.lastText).toBe('Answer: streaming')

    // A frame the summary ignores keeps its identity, so the memoized panel does no work at all.
    const summary = store.getSummary()
    const rendersAfterToken = observed.summaryPanelRenders
    await act(async () => { store.update((current) => [{ ...current[0]!, parts: [{ type: 'text', text: 'ask again' }] }, current[1]!]) })
    expect(store.getSummary()).toBe(summary)
    expect(observed.summaryPanelRenders).toBe(rendersAfterToken)

    expect(subscribe).not.toHaveBeenCalled()
    expect(getSnapshot).not.toHaveBeenCalled()
  })
})

describe('useBrowserAnnotations identity', () => {
  it('keeps one container identity across re-renders and swaps it only when its data changes', async () => {
    const seen: BrowserAnnotationsApi[] = []
    let rerender = () => {}
    function Harness() {
      const [, setTick] = useState(0)
      rerender = () => setTick((tick) => tick + 1)
      seen.push(useBrowserAnnotations())
      return null
    }

    await act(async () => { root.render(<Harness />) })
    await act(async () => { rerender() })
    await act(async () => { rerender() })
    expect(seen.length).toBeGreaterThan(2)
    expect(seen[seen.length - 1]).toBe(seen[0])

    const stable = seen[seen.length - 1]
    await act(async () => {
      stable.add({
        comment: 'Tighten this copy',
        element: { selector: '#cta', tagName: 'BUTTON', id: 'cta', classes: ['btn'], text: 'Join now', rect: { x: 5, y: 6, width: 100, height: 30 } },
        pageUrl: 'https://example.com/',
        pageTitle: 'Example Page',
      })
    })
    const updated = seen[seen.length - 1]
    expect(updated).not.toBe(stable)
    expect(updated.annotations).toHaveLength(1)
  })
})
