// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recentSidebarSessions, Sidebar, SIDEBAR_RECENT_LIMIT } from '../../src/components/Sidebar'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project = (id: string, path: string): ProjectRecord => ({
  id, harness: 'omp', name: id, path, folders: [path], primaryFolder: path,
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
})
const session = (id: string, projectPath: string, updatedAt: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id, harness: 'omp', filePath: `${projectPath}/${id}.jsonl`, projectPath, title: id,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt, status: 'idle', depth: 0, ...extra,
})
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

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

async function renderSidebar(projects: ProjectRecord[], sessions: SessionRecord[]) {
  await act(async () => {
    root.render(
      <Sidebar
        projects={projects} sessions={sessions} activeView="session" projectSortMode="recent"
        onSelectSession={noop} onNavigate={noop} onNewSession={noop} onAddProject={noop} onRemoveProject={noop}
        onClose={noop} onOpenPalette={noop} onRenameSession={async () => undefined} onArchiveSession={async () => undefined}
      />,
    )
  })
}

describe('sidebar recent conversations', () => {
  it('orders the recent section by last updated time across projects', async () => {
    const alpha = project('alpha', '/alpha')
    const beta = project('beta', '/beta')
    const sessions = [
      session('oldest', '/alpha', hoursAgo(20)),
      session('newest', '/beta', hoursAgo(2)),
      session('middle', '/alpha', hoursAgo(8)),
    ]

    await renderSidebar([alpha, beta], sessions)

    const titles = [...container.querySelectorAll<HTMLElement>('.sidebar-recent .session-row__title')].map((row) => row.textContent)
    expect(titles).toEqual(['newest', 'middle', 'oldest'])
    expect(container.querySelectorAll('.sidebar-recent .session-row__time')).toHaveLength(3)
  })

  it('sorts by last updated time even when a session is pinned', () => {
    const sessions = [
      session('pinned', '/alpha', hoursAgo(20), { pinned: true }),
      session('fresh', '/alpha', hoursAgo(1)),
    ]

    expect(recentSidebarSessions(sessions).map((item) => item.id)).toEqual(['fresh', 'pinned'])
  })

  it('caps the section at the recent limit', () => {
    const sessions = Array.from({ length: SIDEBAR_RECENT_LIMIT + 3 }, (_, index) => session(`s-${index}`, '/alpha', hoursAgo(index + 1)))
    expect(recentSidebarSessions(sessions)).toHaveLength(SIDEBAR_RECENT_LIMIT)
  })

  it('filters the recent section with the sidebar search', async () => {
    const alpha = project('alpha', '/alpha')
    const sessions = [session('matching', '/alpha', hoursAgo(1)), session('other', '/alpha', hoursAgo(2))]
    await renderSidebar([alpha], sessions)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Search"]')?.click()
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    const input = container.querySelector<HTMLInputElement>('#session-search')
    expect(input).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, 'matching')
    input?.dispatchEvent(new Event('input', { bubbles: true }))

    const titles = [...container.querySelectorAll<HTMLElement>('.sidebar-recent .session-row__title')].map((row) => row.textContent)
    expect(titles).toEqual(['matching'])
  })
})
