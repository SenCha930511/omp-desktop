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

async function renderSidebar(projects: ProjectRecord[], sessions: SessionRecord[]) {
  await act(async () => {
    root.render(
      <Sidebar
        projects={projects} sessions={sessions} activeView="session" projectSortMode="recent"
        onSelectProject={noop} onSelectSession={noop} onNavigate={noop} onNewSession={noop} onAddProject={noop} onRemoveProject={noop}
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
})
