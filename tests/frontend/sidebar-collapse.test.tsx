// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../src/components/Sidebar'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project', harness: 'omp', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const session: SessionRecord = {
  id: 'session', harness: 'omp', filePath: '/sessions/session.jsonl', projectPath: '/project', title: 'Session',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}

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

async function press(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function renderSidebar(projects: ProjectRecord[], sessions: SessionRecord[], activeIds: { activeProjectId?: string; activeSessionId?: string } = {}) {
  await act(async () => {
    root.render(
      <Sidebar
        projects={projects} sessions={sessions} activeView="session" projectSortMode="recent" activeProjectId={activeIds.activeProjectId} activeSessionId={activeIds.activeSessionId}
        onSelectSession={noop} onNavigate={noop} onNewSession={noop} onAddProject={noop} onRemoveProject={noop}
        onClose={noop} onOpenPalette={noop} onRenameSession={async () => undefined} onArchiveSession={async () => undefined}
      />,
    )
  })
}

const expandAllButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Expand all projects"]')
const collapseAllButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Collapse all projects"]')
const sessionRows = () => [...container.querySelectorAll<HTMLElement>('.session-row')]

describe('sidebar expand and collapse all projects', () => {
  it('collapses and expands every project with one click', async () => {
    const projects = [
      { ...project, id: 'first', name: 'First', path: '/first', folders: ['/first'], primaryFolder: '/first' },
      { ...project, id: 'second', name: 'Second', path: '/second', folders: ['/second'], primaryFolder: '/second' },
    ]
    const sessions = [
      session,
      { ...session, id: 'session-two', filePath: '/sessions/two.jsonl', projectPath: '/second', title: 'Second session' },
    ]
    await renderSidebar(projects, sessions)

    expect(sessionRows().length).toBe(2)
    expect(expandAllButton()).toBeNull()
    expect(collapseAllButton()?.disabled).toBe(false)

    await press(collapseAllButton()!)
    expect(sessionRows().length).toBe(0)
    expect(collapseAllButton()).toBeNull()
    expect(expandAllButton()?.disabled).toBe(false)

    await press(expandAllButton()!)
    expect(sessionRows().length).toBe(2)
    expect(expandAllButton()).toBeNull()
    expect(collapseAllButton()?.disabled).toBe(false)
  })

  it('moves the running spinner from the session rows to the collapsed project row', async () => {
    await renderSidebar([project], [{ ...session, status: 'running' }])

    // Expanded: only the running session row spins; the folder row stays quiet.
    expect(container.querySelector('.session-row__spinner')).not.toBeNull()
    expect(container.querySelector('.project-working')).toBeNull()

    // Collapsed: the folder row takes over so activity stays visible without expanding.
    await press(collapseAllButton()!)
    expect(sessionRows().length).toBe(0)
    expect(container.querySelector('.project-working')).not.toBeNull()

    await press(expandAllButton()!)
    expect(container.querySelector('.session-row__spinner')).not.toBeNull()
    expect(container.querySelector('.project-working')).toBeNull()
  })

  it('moves the selected fill from the session row to the collapsed project row', async () => {
    await renderSidebar([project], [session], { activeProjectId: project.id, activeSessionId: session.id })

    // Expanded: the session row owns the selection; the folder row stays plain.
    expect(container.querySelector('.project-row.is-selected')).toBeNull()
    expect(container.querySelector('.session-row-wrap.is-selected')).not.toBeNull()

    // Collapsed: the folder row carries the selection instead, or the active
    // project would be invisible entirely.
    await press(collapseAllButton()!)
    expect(container.querySelector('.project-row.is-selected')).not.toBeNull()

    await press(expandAllButton()!)
    expect(container.querySelector('.project-row.is-selected')).toBeNull()
  })
})

describe('project row click', () => {
  it('expands and collapses the session list instead of opening a session', async () => {
    await renderSidebar([project], [session])
    const mainButton = () => container.querySelector<HTMLButtonElement>('.project-row__main')!

    expect(sessionRows().length).toBe(1)
    await press(mainButton())
    expect(sessionRows().length).toBe(0)
    await press(mainButton())
    expect(sessionRows().length).toBe(1)
  })
})
