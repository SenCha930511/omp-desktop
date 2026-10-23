// @vitest-environment jsdom

import './jsdom-storage'
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SIDEBAR_SESSION_LIMIT, Sidebar } from '../../src/components/Sidebar'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project',
  harness: 'omp',
  name: 'Project',
  path: '/project',
  folders: ['/project'],
  primaryFolder: '/project',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 1,
}

/** Later timestamps sort first, so titled sessions stay in a stable order. */
const session = (id: string, index: number): SessionRecord => ({
  id,
  harness: 'omp',
  filePath: `/sessions/${id}.jsonl`,
  projectPath: '/project',
  title: `Session ${id}`,
  createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 60_000).toISOString(),
  updatedAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 60_000).toISOString(),
  status: 'idle',
  depth: 0,
})

const sessions = Array.from({ length: SIDEBAR_SESSION_LIMIT + 2 }, (_, index) => session(`s-${index}`, index))

let container: HTMLDivElement
let root: Root

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

const noop = () => undefined

async function renderSidebar(props: Partial<ComponentProps<typeof Sidebar>>) {
  await act(async () => {
    root.render(
      <Sidebar
        projects={[project]}
        sessions={sessions}
        activeView="session"
        projectSortMode="recent"
        onSelectProject={noop}
        onSelectSession={noop}
        onNavigate={noop}
        onNewSession={noop}
        onAddProject={noop}
        onRemoveProject={noop}
        onClose={noop}
        onOpenPalette={noop}
        onRenameSession={async () => undefined}
        onArchiveSession={async () => undefined}
        {...props}
      />,
    )
  })
}

const rowTitles = () => [...container.querySelectorAll<HTMLElement>('.session-row-wrap .session-row__title')].map((row) => row.textContent)

const toggle = () => container.querySelector<HTMLButtonElement>('.session-row--expand')

/** Opens the collapsible search box, then types into it like a reader would. */
async function searchFor(text: string): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('nav.sidebar__primary button[title="Search"]')?.click()
  })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  })
  const input = container.querySelector<HTMLInputElement>('#session-search')
  expect(input).not.toBeNull()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, text)
  input?.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('sidebar session expansion', () => {
  it('previews the recent sessions and offers to show the rest', async () => {
    await renderSidebar({})

    expect(rowTitles()).toHaveLength(SIDEBAR_SESSION_LIMIT)
    expect(toggle()?.textContent).toContain(`Show all ${sessions.length} sessions`)
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
  })

  it('expands to every session and collapses back', async () => {
    await renderSidebar({})

    await act(async () => {
      toggle()?.click()
    })
    expect(rowTitles()).toHaveLength(sessions.length)
    expect(toggle()?.textContent).toContain('Show less')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      toggle()?.click()
    })
    expect(rowTitles()).toHaveLength(SIDEBAR_SESSION_LIMIT)
    expect(toggle()?.textContent).toContain(`Show all ${sessions.length} sessions`)
  })

  it('lists every matching session while searching, past the preview cap', async () => {
    await renderSidebar({})

    await searchFor('session s-')
    // The project name keeps every row in the filtered set; none may be cut.
    expect(rowTitles()).toHaveLength(sessions.length)
    expect(toggle()).toBeNull()
  })

  it('hides the toggle while searching even when only some rows match', async () => {
    await renderSidebar({})

    await searchFor('session s-8')
    expect(rowTitles()).toEqual(['Session s-8'])
    expect(toggle()).toBeNull()
  })
})
