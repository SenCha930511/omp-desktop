// @vitest-environment jsdom

import './jsdom-storage'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { WorkspaceInspector } from '../../src/components/WorkspaceInspector'
import { useBrowserAnnotations, type BrowserAnnotationsApi } from '../../src/hooks/useBrowserAnnotations'
import type { InspectorProps } from '../../src/components/Inspector'
import type { InspectorTab } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const observed = vi.hoisted(() => ({ inspectorProps: [] as unknown[], changesPanelRenders: 0 }))

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

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  observed.inspectorProps = []
  observed.changesPanelRenders = 0
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

  it('keeps the inspector git and annotation identities stable across App renders', async () => {
    await renderApp()
    const props = observed.inspectorProps as InspectorProps[]
    const first = props[props.length - 1]!

    await openChangesTab()
    await toggleSidebar()
    const last = props[props.length - 1]!

    expect(last).not.toBe(first)
    expect(last.git).toBe(first.git)
    expect(last.browserAnnotations).toBe(first.browserAnnotations)
    expect(last.automations).toBe(first.automations)
    expect(last.onSelectAgentTab).toBe(first.onSelectAgentTab)
    expect(last.onPreviewContext).toBe(first.onPreviewContext)
    expect(last.onNavigateAgentTab).toBe(first.onNavigateAgentTab)
    expect(last.onGrantProject).toBe(first.onGrantProject)
    expect(last.onOpenAutomation).toBe(first.onOpenAutomation)
    expect(last.onOpenSchedules).toBe(first.onOpenSchedules)
    expect(last.backgroundTasks).toBe(first.backgroundTasks)
    expect(last.onShowBrowserPreview).toBe(first.onShowBrowserPreview)
    // The Agents tab receives one memoized bundle, so unrelated App renders
    // never reopen the inspector through a fresh roster object.
    expect(last.subagents).toBe(first.subagents)
  })

  it('lists the full sample automation set on the Background Tasks tab', async () => {
    await renderApp()
    const newTab = container.querySelector<HTMLButtonElement>('.inspector__tab-actions button[aria-label="New tab"]')
    expect(newTab).not.toBeNull()
    await act(async () => { newTab?.click() })
    const tasksTab = [...container.querySelectorAll<HTMLButtonElement>('.inspector-new-tab__item')].find((button) => button.textContent?.includes('Background Tasks'))
    expect(tasksTab).toBeDefined()
    await act(async () => { tasksTab?.click() })
    expect(container.querySelector('#inspector-panel-tasks .background-tasks__list')?.textContent).toContain('Morning issue triage')
  })
})

describe('inspector tabs', () => {
  function Harness({ initialTab = 'changes', subagents }: { initialTab?: InspectorTab; subagents?: InspectorProps['subagents'] }) {
    const [activeTab, setActiveTab] = useState<InspectorTab>(initialTab)
    return (
      <WorkspaceInspector
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onClose={() => undefined}
        git={{ isRepo: false, files: [] }}
        automations={[]}
        onOpenAutomation={() => undefined}
        onOpenSchedules={() => undefined}
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
        subagents={subagents}
      />
    )
  }

  it('opens and closes tabs from the new-tab page', async () => {
    await act(async () => { root.render(<Harness />) })
    expect(container.querySelector('#inspector-panel-changes')).not.toBeNull()

    const newTab = container.querySelector<HTMLButtonElement>('.inspector__tab-actions button[aria-label="New tab"]')
    expect(newTab).not.toBeNull()
    await act(async () => { newTab?.click() })
    expect(container.querySelector('.inspector-new-tab')).not.toBeNull()

    const files = [...container.querySelectorAll<HTMLButtonElement>('.inspector-new-tab__item')].find((button) => button.textContent?.includes('Files'))
    expect(files).toBeDefined()
    await act(async () => { files?.click() })
    expect(container.querySelector('#inspector-panel-files')).not.toBeNull()

    const close = container.querySelector<HTMLButtonElement>('.inspector-tab__close[aria-label="Close Files"]')
    expect(close).not.toBeNull()
    await act(async () => { close?.click() })
    expect(container.querySelector('#inspector-panel-files')).toBeNull()
  })

  it('renders the Agents tab roster and selected transcript inside the inspector body', async () => {
    const state = { agents: [{ id: 'a', agent: 'Explore', status: 'running', messages: [] }], selectedId: 'a', select: () => undefined }
    await act(async () => { root.render(<Harness initialTab="agents" subagents={{ state, connected: true }} />) })
    expect([...container.querySelectorAll('.inspector__tabs button')].some((button) => button.textContent?.includes('Agents'))).toBe(true)
    expect(container.querySelector('#inspector-panel-agents .subagents__roster')).not.toBeNull()
    expect(container.querySelector('#inspector-panel-agents .subagents__transcript h2')?.textContent).toBe('Explore')
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
