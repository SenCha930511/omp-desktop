// @vitest-environment jsdom

import './jsdom-storage'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { createTranscriptStore } from '../../src/app/transcript-store'
import { WorkspaceInspector } from '../../src/components/WorkspaceInspector'
import { INSPECTOR_ACTIVE_TAB_KEY, INSPECTOR_OPEN_TABS_KEY, readInitialActiveTab, readInitialInspectorTabs } from '../../src/hooks/useAppSettings'
import { useBrowserAnnotations, type BrowserAnnotationsApi } from '../../src/hooks/useBrowserAnnotations'
import type { InspectorProps } from '../../src/components/Inspector'
import { I18nProvider } from '../../src/lib/i18n'
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
    expect(last.transcript).toBe(first.transcript)
    expect(last.commandOutputHistory).toBe(first.commandOutputHistory)
    expect(last.sideChat).toBe(first.sideChat)
    expect(last.onCancelBackgroundTask).toBe(first.onCancelBackgroundTask)
    expect(last.onRefreshBackgroundTasks).toBe(first.onRefreshBackgroundTasks)
    expect(last.onSelectAgentTab).toBe(first.onSelectAgentTab)
    expect(last.onPreviewContext).toBe(first.onPreviewContext)
    expect(last.onNavigateAgentTab).toBe(first.onNavigateAgentTab)
    expect(last.onGrantProject).toBe(first.onGrantProject)
    expect(last.onShowBrowserPreview).toBe(first.onShowBrowserPreview)
    // The Agents tab receives one memoized bundle, so unrelated App renders
    // never reopen the inspector through a fresh roster object.
    expect(last.subagents).toBe(first.subagents)
  })

  it('omits Capabilities from New tab and shows OMP session tasks instead of schedules on Background Tasks', async () => {
    await renderApp()
    const newTab = container.querySelector<HTMLButtonElement>('.inspector__tab-actions button[aria-label="New tab"]')
    expect(newTab).not.toBeNull()
    await act(async () => { newTab?.click() })
    const items = [...container.querySelectorAll<HTMLButtonElement>('.inspector-new-tab__item')]
    expect(items.some((button) => button.textContent?.includes('Capabilities'))).toBe(false)
    const tasksTab = items.find((button) => button.textContent?.includes('Background Tasks'))
    expect(tasksTab).toBeDefined()
    await act(async () => { tasksTab?.click() })
    expect(container.querySelector('#inspector-panel-tasks .background-tasks')).not.toBeNull()
    expect(container.querySelector('#inspector-panel-tasks')?.textContent).not.toContain('Morning issue triage')
  })
})

describe('inspector tabs', () => {
  function Harness({
    initialTab = 'changes',
    subagents,
    transcript,
    isStreaming,
    hasRuntime,
    onCancelBackgroundTask,
  }: {
    initialTab?: InspectorTab
    subagents?: InspectorProps['subagents']
    transcript?: InspectorProps['transcript']
    isStreaming?: boolean
    hasRuntime?: boolean
    onCancelBackgroundTask?: InspectorProps['onCancelBackgroundTask']
  }) {
    const [activeTab, setActiveTab] = useState<InspectorTab>(initialTab)
    return (
      <WorkspaceInspector
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onClose={() => undefined}
        git={{ isRepo: false, files: [] }}
        transcript={transcript}
        isStreaming={isStreaming}
        hasRuntime={hasRuntime}
        onCancelBackgroundTask={onCancelBackgroundTask}
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

  it('keeps consecutive arrow keys on the newly selected tab before the next animation frame', async () => {
    const deferredFrames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      deferredFrames.push(callback)
      return deferredFrames.length
    })
    function RovingHarness() {
      const [activeTab, setActiveTab] = useState<InspectorTab>('changes')
      return (
        <WorkspaceInspector
          openTabs={['changes', 'files', 'agents']}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onClose={() => undefined}
          git={{ isRepo: false, files: [] }}
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
    await act(async () => { root.render(<RovingHarness />) })
    const pressArrowOnFocusedTab = async () => act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    const changes = container.querySelector<HTMLButtonElement>('#inspector-tab-changes')!
    const files = container.querySelector<HTMLButtonElement>('#inspector-tab-files')!
    const agents = container.querySelector<HTMLButtonElement>('#inspector-tab-agents')!
    changes.focus()
    await pressArrowOnFocusedTab()
    expect(files.getAttribute('aria-selected')).toBe('true')

    // The selection can render before a deferred focus callback. A real second
    // key event still goes to document.activeElement during that interval.
    await pressArrowOnFocusedTab()
    expect(agents.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(agents)
  })

  it('renders the Agents tab roster and selected transcript inside the inspector body', async () => {
    const state = { agents: [{ id: 'a', agent: 'Explore', status: 'running', messages: [] }], selectedId: 'a', select: () => undefined }
    await act(async () => { root.render(<Harness initialTab="agents" subagents={{ state, connected: true }} />) })
    expect([...container.querySelectorAll('.inspector__tabs button')].some((button) => button.textContent?.includes('Agents'))).toBe(true)
    expect(container.querySelector('#inspector-panel-agents .subagents__roster')).not.toBeNull()
    expect(container.querySelector('#inspector-panel-agents .subagents__transcript h2')?.textContent).toBe('Explore')
  })

  it('localizes known New tab subagent statuses and marks unknown upstream states unavailable in every locale', async () => {
    const state = {
      agents: [
        { id: 'running', agent: 'Explore', status: 'running', messages: [] },
        { id: 'completed', agent: 'Reviewer', status: 'completed', messages: [] },
        { id: 'unknown', agent: 'Custom', status: 'queued_upstream', messages: [] },
      ],
      selectedId: undefined,
      select: () => undefined,
    }
    const cases = [
      ['en', ['Running', 'Completed', 'Status unavailable']],
      ['zh-TW', ['執行中', '已完成', '狀態不明']],
      ['zh-CN', ['运行中', '已完成', '状态不明']],
    ] as const

    for (const [preference, statuses] of cases) {
      await act(async () => {
        root.render(<I18nProvider preference={preference}><Harness subagents={{ state, connected: true }} /></I18nProvider>)
      })
      if (!container.querySelector('.inspector-new-tab')) {
        await act(async () => { container.querySelector<HTMLButtonElement>('.inspector__tab-actions button')?.click() })
      }

      expect([...container.querySelectorAll('.inspector-new-tab__subitem .inspector-new-tab__detail')].map((status) => status.textContent)).toEqual([...statuses])
      expect(container.querySelector('.inspector-new-tab')?.textContent).not.toContain('queued_upstream')
      expect([...container.querySelectorAll('.inspector-new-tab__subitem')].map((item) => item.textContent)).toEqual([
        `Explore${statuses[0]}`, `Reviewer${statuses[1]}`, `Custom${statuses[2]}`,
      ])
    }
  })

  it('renders active OMP session background jobs on the Background Tasks tab and triggers cancel', async () => {
    const onCancel = vi.fn()
    const transcript = createTranscriptStore([
      {
        id: 'm-1',
        role: 'assistant',
        timestamp: '2026-01-01T00:00:00.000Z',
        parts: [
          { type: 'toolCall', id: 'tc-1', name: 'bash', args: { command: 'npm run watch:docs', async: true } },
          { type: 'toolResult', name: 'bash', text: 'Backgrounded as job job-88' },
        ],
      },
    ])
    await act(async () => {
      root.render(<Harness initialTab="tasks" transcript={transcript} hasRuntime onCancelBackgroundTask={onCancel} />)
    })
    const list = container.querySelector('#inspector-panel-tasks .background-tasks__list')
    expect(list?.textContent).toContain('npm run watch:docs')
    const cancelBtn = list?.querySelector<HTMLButtonElement>('button[aria-label="Cancel task"]')
    expect(cancelBtn).not.toBeNull()
    await act(async () => {
      cancelBtn?.click()
    })
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-88', kind: 'job' }))
  })

  it('opens Browser on URL Enter in New tab, renders Side questions, and supports middle-click and drag reorder', async () => {
    const sideChat = {
      state: { supported: true, topics: [], live: {}, activeTopicId: null, sending: false },
      hasSession: true,
      onAsk: () => undefined,
      onCancel: () => undefined,
      onSelectTopic: () => undefined,
      onClose: () => undefined,
    }
    function ControlledHarness() {
      const [openTabs, setOpenTabs] = useState<InspectorTab[]>(['changes', 'files'])
      const [activeTab, setActiveTab] = useState<InspectorTab>('changes')
      const [reordered, setReordered] = useState<string[]>([])
      return (
        <div data-reordered={reordered.join(',')}>
          <WorkspaceInspector
            openTabs={openTabs}
            activeTab={activeTab}
            onTabChange={(tab) => {
              setOpenTabs((current) => (current.includes(tab) ? current : [...current, tab]))
              setActiveTab(tab)
            }}
            onCloseTab={(tab) => {
              const next = openTabs.filter((item) => item !== tab)
              setOpenTabs(next)
              if (activeTab === tab && next[0]) setActiveTab(next[0])
            }}
            onReorderTabs={(src, dst) => {
              setReordered([src, dst])
              setOpenTabs((current) => {
                const next = [...current]
                const si = next.indexOf(src)
                const di = next.indexOf(dst)
                const [moved] = next.splice(si, 1)
                next.splice(di, 0, moved)
                return next
              })
            }}
            onClose={() => undefined}
            git={{ isRepo: false, files: [] }}
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
            sideChat={sideChat}
          />
        </div>
      )
    }

    await act(async () => { root.render(<ControlledHarness />) })
    const newTab = container.querySelector<HTMLButtonElement>('.inspector__tab-actions button[aria-label="New tab"]')
    await act(async () => { newTab?.click() })

    const input = container.querySelector<HTMLInputElement>('.inspector-new-tab__search input')
    expect(input).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, 'https://example.com')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(container.querySelector('#inspector-panel-browser')).not.toBeNull()

    await act(async () => { newTab?.click() })
    const sideItem = [...container.querySelectorAll<HTMLButtonElement>('.inspector-new-tab__item')].find((button) => button.textContent?.includes('Side questions'))
    expect(sideItem).toBeDefined()
    await act(async () => { sideItem?.click() })
    expect(container.querySelector('#inspector-panel-sidechat .side-chat')).not.toBeNull()

    const filesTabWrap = container.querySelector('#inspector-tab-files')?.closest('.inspector-tab')
    const changesTabWrap = container.querySelector('#inspector-tab-changes')?.closest('.inspector-tab')
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: () => undefined, getData: () => 'files' }
    await act(async () => {
      filesTabWrap?.dispatchEvent(Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer }))
    })
    await act(async () => {
      changesTabWrap?.dispatchEvent(Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), { dataTransfer }))
      changesTabWrap?.dispatchEvent(Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }))
    })
    expect(container.querySelector('[data-reordered]')?.getAttribute('data-reordered')).toBe('files,changes')

    const filesButton = container.querySelector<HTMLButtonElement>('#inspector-tab-files')
    await act(async () => {
      filesButton?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 }))
    })
    expect(container.querySelector('#inspector-panel-files')).toBeNull()
  })

  it('persists inspector open tabs and active tab in localStorage without sidechat', () => {
    window.localStorage.removeItem(INSPECTOR_OPEN_TABS_KEY)
    window.localStorage.removeItem(INSPECTOR_ACTIVE_TAB_KEY)
    expect(readInitialInspectorTabs()).toEqual(['changes'])

    window.localStorage.setItem(INSPECTOR_OPEN_TABS_KEY, JSON.stringify([]))
    expect(readInitialInspectorTabs()).toEqual([])

    window.localStorage.setItem(INSPECTOR_OPEN_TABS_KEY, JSON.stringify(['files', 'sidechat', 'agents', 'files']))
    const tabs = readInitialInspectorTabs()
    expect(tabs).toEqual(['files', 'agents'])

    window.localStorage.setItem(INSPECTOR_ACTIVE_TAB_KEY, 'sidechat')
    expect(readInitialActiveTab(tabs)).toBe('files')

    window.localStorage.setItem(INSPECTOR_ACTIVE_TAB_KEY, 'agents')
    expect(readInitialActiveTab(tabs)).toBe('agents')
    window.localStorage.removeItem(INSPECTOR_OPEN_TABS_KEY)
    window.localStorage.removeItem(INSPECTOR_ACTIVE_TAB_KEY)
  })

  it('omits File Preview from New tab and opens preview files directly as top-level inspector tabs', async () => {
    function FileTabsHarness() {
      const [openTabs] = useState<InspectorTab[]>(['changes', 'files'])
      const [activeTab, setActiveTab] = useState<InspectorTab>('files')
      const [previewFiles, setPreviewFiles] = useState<string[]>(['/repo/notes.md', '/repo/spec.pdf'])
      const [activePreviewFile, setActivePreviewFile] = useState<string | null>('/repo/spec.pdf')
      const [rev, setRev] = useState(1)
      return (
        <WorkspaceInspector
          openTabs={openTabs}
          activeTab={activeTab}
          onTabChange={(tab) => {
            setActivePreviewFile(null)
            setActiveTab(tab)
          }}
          onClose={() => undefined}
          git={{ isRepo: false, files: [] }}
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
          previewFiles={previewFiles}
          activePreviewFile={activePreviewFile}
          previewActivationRevision={rev}
          onSelectPreviewFile={(filePath) => {
            setActivePreviewFile(filePath)
            if (filePath) setRev((v) => v + 1)
          }}
          onClosePreviewFile={(filePath) => {
            const remaining = previewFiles.filter((item) => item !== filePath)
            setPreviewFiles(remaining)
            if (activePreviewFile === filePath) setActivePreviewFile(remaining[0] ?? null)
          }}
          onOpenPreviewFile={(filePath) => {
            setPreviewFiles((current) => (current.includes(filePath) ? current : [...current, filePath]))
            setActivePreviewFile(filePath)
            setRev((v) => v + 1)
          }}
        />
      )
    }

    await act(async () => {
      root.render(<FileTabsHarness />)
      await Promise.resolve()
    })

    const fileTab0 = container.querySelector<HTMLButtonElement>('#inspector-tab-file-0')
    const fileTab1 = container.querySelector<HTMLButtonElement>('#inspector-tab-file-1')
    expect(fileTab0?.textContent).toBe('notes.md')
    expect(fileTab1?.textContent).toBe('spec.pdf')
    expect(fileTab1?.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('.file-preview__tabs')).toBeNull()

    const newTab = container.querySelector<HTMLButtonElement>('.inspector__tab-actions button[aria-label="New tab"]')
    await act(async () => { newTab?.click() })
    const newTabItems = [...container.querySelectorAll('.inspector-new-tab__item')].map((el) => el.textContent)
    expect(newTabItems.some((text) => text?.includes('File Preview'))).toBe(false)

    await act(async () => { fileTab0?.click() })
    expect(fileTab0?.getAttribute('aria-selected')).toBe('true')

    const closeNotes = container.querySelector<HTMLButtonElement>('.inspector-tab__close[aria-label="Close notes.md"]')
    await act(async () => { closeNotes?.click() })
    expect(container.querySelector('#inspector-tab-file-1')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('#inspector-tab-file-0')?.textContent).toBe('spec.pdf')

    const filesTab = container.querySelector<HTMLButtonElement>('#inspector-tab-files')
    await act(async () => { filesTab?.click() })
    expect(filesTab?.getAttribute('aria-selected')).toBe('true')
  })

  it('opens and closes multiple top-level browser tabs', async () => {
    await act(async () => {
      root.render(<Harness initialTab="browser" />)
    })
    expect(container.querySelector('#inspector-tab-browser')).not.toBeNull()
    expect(container.querySelectorAll('webview.browser-webview')).toHaveLength(1)

    const addBrowserTabBtn = container.querySelector<HTMLButtonElement>('#inspector-panel-browser button[aria-label="New browser tab"]')
    expect(addBrowserTabBtn).not.toBeNull()
    await act(async () => { addBrowserTabBtn?.click() })

    const extraTab = container.querySelector<HTMLButtonElement>('#inspector-tab-browser-extra-1')
    expect(extraTab).not.toBeNull()
    expect(extraTab?.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelectorAll('webview.browser-webview')).toHaveLength(2)

    const newTab = container.querySelector<HTMLButtonElement>('.inspector__tab-actions button[aria-label="New tab"]')
    await act(async () => { newTab?.click() })
    const input = container.querySelector<HTMLInputElement>('.inspector-new-tab__search input')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, 'https://docs.example.com')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(container.querySelector('#inspector-tab-browser-extra-2')?.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelectorAll('webview.browser-webview')).toHaveLength(3)

    const closeExtra = container.querySelector<HTMLButtonElement>('#inspector-tab-browser-extra-2')?.parentElement?.querySelector<HTMLButtonElement>('.inspector-tab__close')
    await act(async () => { closeExtra?.click() })
    expect(container.querySelector('#inspector-tab-browser-extra-2')).toBeNull()
    expect(container.querySelectorAll('webview.browser-webview')).toHaveLength(2)
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
