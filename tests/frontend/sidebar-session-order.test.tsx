// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { indexSidebarSessions, Sidebar } from '../../src/components/Sidebar'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project', harness: 'omp', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 3,
}
const session = (id: string, lastUserMessageAt: string): SessionRecord => ({
  id, harness: 'omp', filePath: `/sessions/${id}.jsonl`, projectPath: '/project', title: id,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0, lastUserMessageAt,
})

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

describe('sidebar session ordering', () => {
  it('sorts sessions by most recent message by default', () => {
    const sessions = [session('older', '2026-01-02T00:00:00.000Z'), session('newer', '2026-01-03T00:00:00.000Z')]
    const { sessionsByProject } = indexSidebarSessions([project], sessions)
    expect(sessionsByProject.get('project')?.map((item) => item.id)).toEqual(['newer', 'older'])
  })

  it('keeps message order for sessions with no recorded open', () => {
    const sessions = [session('older', '2026-01-02T00:00:00.000Z'), session('newer', '2026-01-03T00:00:00.000Z'), session('unopened', '2026-01-01T00:00:00.000Z')]
    const { sessionsByProject } = indexSidebarSessions([project], sessions)
    expect(sessionsByProject.get('project')?.map((item) => item.id)).toEqual(['newer', 'older', 'unopened'])
  })

  it('floats the most recently opened session above message order', () => {
    const sessions = [session('older', '2026-01-02T00:00:00.000Z'), session('newer', '2026-01-03T00:00:00.000Z'), session('in-use', '2026-01-01T00:00:00.000Z')]
    const { sessionsByProject } = indexSidebarSessions([project], sessions, undefined, new Map([['in-use', Date.now()]]))
    expect(sessionsByProject.get('project')?.map((item) => item.id)).toEqual(['in-use', 'newer', 'older'])
  })

  it('re-sorts rows through the recent-open map when a session is opened', async () => {
    const sessions = [session('older', '2026-01-02T00:00:00.000Z'), session('newer', '2026-01-03T00:00:00.000Z'), session('in-use', '2026-01-01T00:00:00.000Z')]
    const renderSidebar = (recentSessionOpens?: ReadonlyMap<string, number>) => act(async () => {
      root.render(
        <Sidebar
          projects={[project]} sessions={sessions} activeView="session" activeSessionId="in-use" projectSortMode="recent"
          recentSessionOpens={recentSessionOpens}
          onSelectSession={noop} onNavigate={noop} onNewSession={noop} onAddProject={noop} onRemoveProject={noop}
          onClose={noop} onOpenPalette={noop} onRenameSession={async () => undefined} onArchiveSession={async () => undefined}
        />,
      )
    })
    const rowTitles = () => [...container.querySelectorAll<HTMLElement>('.session-row__title')].map((row) => row.textContent)

    await renderSidebar()
    expect(rowTitles()).toEqual(['newer', 'older', 'in-use'])

    // Opening a session records the use: the row jumps to the top of its
    // group so the session in play is always the easiest to reach.
    await renderSidebar(new Map([['in-use', Date.now()]]))
    expect(rowTitles()).toEqual(['in-use', 'newer', 'older'])
  })

  it('floats pinned sessions above recency', () => {
    const pinned = { ...session('pinned-old', '2026-01-01T00:00:00.000Z'), pinned: true }
    const sessions = [session('newer', '2026-01-03T00:00:00.000Z'), pinned]
    const { sessionsByProject } = indexSidebarSessions([project], sessions)
    expect(sessionsByProject.get('project')?.map((item) => item.id)).toEqual(['pinned-old', 'newer'])
  })

  it('claims subdirectory sessions for the containing project', () => {
    const nested: ProjectRecord = { ...project, id: 'nested', path: '/project/packages/app', folders: ['/project/packages/app'], primaryFolder: '/project/packages/app' }
    const sessions = [
      session('root', '2026-01-02T00:00:00.000Z'),
      { ...session('deep', '2026-01-03T00:00:00.000Z'), projectPath: '/project/packages/app' },
      { ...session('mid', '2026-01-03T00:00:00.000Z'), projectPath: '/project/packages' },
    ]
    const { sessionsByProject } = indexSidebarSessions([project, nested], sessions)
    // The nested project claims its own directory; the parent keeps the rest.
    expect(sessionsByProject.get('nested')?.map((item) => item.id)).toEqual(['deep'])
    expect(sessionsByProject.get('project')?.map((item) => item.id)).toEqual(['mid', 'root'])
  })

  it('opens the native session menu and dispatches its actions', async () => {
    const menuItems: Array<{ id: string }> = []
    const onBranchSession = vi.fn()
    const target = session('branch-me', '2026-01-02T00:00:00.000Z')
    await act(async () => {
      root.render(
        <Sidebar
          projects={[project]} sessions={[target]} activeView="session" projectSortMode="recent"
          onSelectSession={noop} onNavigate={noop} onNewSession={noop} onAddProject={noop} onRemoveProject={noop}
          onClose={noop} onOpenPalette={noop} onRenameSession={async () => undefined} onArchiveSession={async () => undefined}
          onPopupMenu={async (items) => {
            menuItems.push(...items)
            return 'branch'
          }}
          onBranchSession={onBranchSession}
        />,
      )
    })
    const row = container.querySelector<HTMLElement>('.session-row')
    expect(row).not.toBeNull()
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(menuItems.map((item) => item.id)).toEqual(['pin', 'branch', 'separator', 'copy', 'rename'])
    expect(onBranchSession).toHaveBeenCalledWith(target)
  })
})
