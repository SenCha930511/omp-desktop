// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Transcript } from '../../src/components/Transcript'
import { INITIAL_HISTORY_PAGINATION, type HistoryPaginationState } from '../../src/lib/session-pagination'
import type { TranscriptMessage } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function msg(id: string, text: string): TranscriptMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

describe('Transcript pagination controls and scroll preservation', () => {
  it('renders Load older messages, invokes handler, and shows stale/budget recovery states', () => {
    const onLoadOlder = vi.fn()
    const onReload = vi.fn()
    const messages = [msg('m3', 'Message 3'), msg('m4', 'Message 4')]

    const readyState: HistoryPaginationState = {
      ...INITIAL_HISTORY_PAGINATION,
      snapshotId: 'snap-1',
      older: { state: 'ready', cursor: 'cur-1' },
    }

    act(() => {
      root.render(
        <Transcript
          messages={messages}
          git={{ isRepo: false, files: [] }}
          followKey="sess-1"
          historyPagination={readyState}
          onLoadOlderHistory={onLoadOlder}
          onReloadHistory={onReload}
          onOpenChanges={vi.fn()}
          onSuggestion={vi.fn()}
        />,
      )
    })

    const loadButton = container.querySelector<HTMLButtonElement>('.transcript__show-earlier')!
    expect(loadButton.textContent).toBe('Load older messages')
    act(() => loadButton.click())
    expect(onLoadOlder).toHaveBeenCalledOnce()

    act(() => {
      root.render(
        <Transcript
          messages={messages}
          git={{ isRepo: false, files: [] }}
          followKey="sess-1"
          historyPagination={{ ...readyState, older: { state: 'end' }, staleReason: 'file-changed' }}
          onLoadOlderHistory={onLoadOlder}
          onReloadHistory={onReload}
          onOpenChanges={vi.fn()}
          onSuggestion={vi.fn()}
        />,
      )
    })
    expect(container.textContent).toContain('Session history changed on disk.')
    const reloadButton = container.querySelector<HTMLButtonElement>('.transcript__pagination-notice button')!
    act(() => reloadButton.click())
    expect(onReload).toHaveBeenCalledOnce()

    act(() => {
      root.render(
        <Transcript
          messages={messages}
          git={{ isRepo: false, files: [] }}
          followKey="sess-1"
          historyPagination={{ ...readyState, older: { state: 'unavailable', reason: 'display-budget' } }}
          onLoadOlderHistory={onLoadOlder}
          onReloadHistory={onReload}
          onOpenChanges={vi.fn()}
          onSuggestion={vi.fn()}
        />,
      )
    })
    expect(container.textContent).toContain('Earlier history exceeds the desktop display budget.')
  })

  it('preserves scrollTop offset when older messages are prepended', () => {
    const onLoadOlder = vi.fn()
    const readyState: HistoryPaginationState = {
      ...INITIAL_HISTORY_PAGINATION,
      snapshotId: 'snap-1',
      older: { state: 'ready', cursor: 'cur-1' },
    }
    const initialMessages = [msg('m3', 'Message 3'), msg('m4', 'Message 4')]

    act(() => {
      root.render(
        <Transcript
          messages={initialMessages}
          git={{ isRepo: false, files: [] }}
          followKey="sess-1"
          historyPagination={readyState}
          onLoadOlderHistory={onLoadOlder}
          onOpenChanges={vi.fn()}
          onSuggestion={vi.fn()}
        />,
      )
    })

    const scroller = container.querySelector<HTMLDivElement>('.transcript')!
    let mockScrollHeight = 400
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => mockScrollHeight,
    })
    scroller.scrollTop = 40

    act(() => {
      container.querySelector<HTMLButtonElement>('.transcript__show-earlier')?.click()
    })

    mockScrollHeight = 720
    act(() => {
      root.render(
        <Transcript
          messages={[msg('m1', 'Message 1'), msg('m2', 'Message 2'), ...initialMessages]}
          git={{ isRepo: false, files: [] }}
          followKey="sess-1"
          historyPagination={{ ...readyState, older: { state: 'end' }, hasLoadedOlder: true }}
          onLoadOlderHistory={onLoadOlder}
          onOpenChanges={vi.fn()}
          onSuggestion={vi.fn()}
        />,
      )
    })

    expect(scroller.scrollTop).toBe(360)
  })
})
