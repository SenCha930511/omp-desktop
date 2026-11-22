// @vitest-environment jsdom

import './jsdom-storage'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { useHarnessUpdates } from '../../src/hooks/useHarnessUpdates'
import type { DesktopApi } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Captures every props object App hands a memoized child. The wrappers are not
// memoized on purpose: each App render must be visible here, and the assertion
// is that the props themselves keep their identities (so the child's memo can
// bail out instead of re-rendering the subtree).
const observed = vi.hoisted(() => ({
  sidebar: [] as unknown[],
  composer: [] as unknown[],
  toolbar: [] as unknown[],
  transcript: [] as unknown[],
}))

vi.mock('../../src/components/Sidebar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/Sidebar')>()
  return {
    ...actual,
    Sidebar(props: Parameters<typeof actual.Sidebar>[0]) {
      observed.sidebar.push(props)
      return <actual.Sidebar {...props} />
    },
  }
})

vi.mock('../../src/components/Composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/Composer')>()
  return {
    ...actual,
    Composer(props: Parameters<typeof actual.Composer>[0]) {
      observed.composer.push(props)
      return <actual.Composer {...props} />
    },
  }
})

vi.mock('../../src/components/TitleToolbar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/TitleToolbar')>()
  return {
    ...actual,
    TitleToolbar(props: Parameters<typeof actual.TitleToolbar>[0]) {
      observed.toolbar.push(props)
      return <actual.TitleToolbar {...props} />
    },
  }
})

vi.mock('../../src/components/ConversationTranscript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/ConversationTranscript')>()
  return {
    ...actual,
    ConversationTranscript(props: Parameters<typeof actual.ConversationTranscript>[0]) {
      observed.transcript.push(props)
      return <actual.ConversationTranscript {...props} />
    },
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  observed.sidebar = []
  observed.composer = []
  observed.toolbar = []
  observed.transcript = []
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class { observe() {} unobserve() {} disconnect() {} },
  })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const renderApp = async () => {
  // Resolve the lazy transcript chunk up front so its Suspense boundary settles on mount.
  await import('../../src/components/ConversationTranscript')
  await act(async () => { root.render(<App />) })
  await act(async () => {})
}

/** Opens the command palette: App state changes, no sidebar/composer/toolbar prop does. */
const openPalette = async () => {
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })) })
}

const expectStableProps = (before: Record<string, unknown>, after: Record<string, unknown>) => {
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  for (const key of Object.keys(after)) {
    expect(Object.is(after[key], before[key]), `${key} changed identity`).toBe(true)
  }
}

describe('memo boundaries across App re-renders', () => {
  it('hands the sidebar, composer, toolbar, and transcript stable props so their memos hold', async () => {
    await renderApp()

    const sidebarBefore = observed.sidebar.at(-1) as Record<string, unknown>
    const composerBefore = observed.composer.at(-1) as Record<string, unknown>
    const toolbarBefore = observed.toolbar.at(-1) as Record<string, unknown>
    const transcriptBefore = observed.transcript.at(-1) as Record<string, unknown>
    expect(sidebarBefore).toBeDefined()
    expect(composerBefore).toBeDefined()
    expect(toolbarBefore).toBeDefined()
    expect(transcriptBefore).toBeDefined()
    const counts = {
      sidebar: observed.sidebar.length,
      composer: observed.composer.length,
      toolbar: observed.toolbar.length,
      transcript: observed.transcript.length,
    }

    await openPalette()

    // App re-rendered and re-created every child element...
    expect(observed.sidebar.length).toBeGreaterThan(counts.sidebar)
    expect(observed.composer.length).toBeGreaterThan(counts.composer)
    expect(observed.toolbar.length).toBeGreaterThan(counts.toolbar)
    expect(observed.transcript.length).toBeGreaterThan(counts.transcript)

    // ...but every prop it handed them is the same value, so each memo bails
    // out instead of re-rendering the subtree on unrelated state changes.
    expectStableProps(sidebarBefore, observed.sidebar.at(-1) as Record<string, unknown>)
    expectStableProps(composerBefore, observed.composer.at(-1) as Record<string, unknown>)
    expectStableProps(toolbarBefore, observed.toolbar.at(-1) as Record<string, unknown>)
    expectStableProps(transcriptBefore, observed.transcript.at(-1) as Record<string, unknown>)
  })

  it('keeps the transcript store subscription out of the App render path', async () => {
    await renderApp()
    const transcript = observed.transcript.at(-1) as { transcript: unknown; onOpenChanges: unknown; onSuggestion: unknown; onRetry: unknown; onRestorePrompt: unknown; onOpenSessionReference: unknown }
    const store = transcript.transcript
    const callbacks = [transcript.onOpenChanges, transcript.onSuggestion, transcript.onRetry, transcript.onRestorePrompt, transcript.onOpenSessionReference]

    await openPalette()

    const next = observed.transcript.at(-1) as Record<string, unknown>
    expect(next.transcript).toBe(store)
    expect([next.onOpenChanges, next.onSuggestion, next.onRetry, next.onRestorePrompt, next.onOpenSessionReference]).toEqual(callbacks)
  })
})

describe('useHarnessUpdates result identity', () => {
  it('returns the same object while the observed state is unchanged', async () => {
    const onChanged = vi.fn(() => () => undefined)
    const bridge = {
      harnessUpdates: {
        onChanged,
        getState: () => Promise.resolve({ phase: 'idle' as const }),
        install: () => Promise.resolve(null),
      },
    } as unknown as DesktopApi
    // Stable like App's useCallback: an unstable reporter would re-run the
    // subscription effect on every render (the hook's documented contract).
    const reportError = () => undefined
    const results: ReturnType<typeof useHarnessUpdates>[] = []
    let bump!: () => void

    function Harness() {
      const [, setTick] = useState(0)
      bump = () => setTick((value) => value + 1)
      results.push(useHarnessUpdates(bridge, reportError))
      return null
    }

    await act(async () => { root.render(<Harness />) })
    // Let the initial getState() resolve before comparing identities.
    await act(async () => {})
    const settled = results.at(-1)
    expect(settled).toBeDefined()

    await act(async () => bump())

    expect(results.length).toBeGreaterThan(1)
    expect(results.at(-1)).toBe(settled)
    expect(results.at(-1)?.state).toBe(settled?.state)
    expect(results.at(-1)?.install).toBe(settled?.install)
  })
})
