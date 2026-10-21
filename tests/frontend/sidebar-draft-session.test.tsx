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
const other: ProjectRecord = {
  ...project,
  id: 'other',
  name: 'Other',
  path: '/other',
  folders: ['/other'],
  primaryFolder: '/other',
}
const session = (id: string): SessionRecord => ({
  id,
  harness: 'omp',
  filePath: `/sessions/${id}.jsonl`,
  projectPath: '/project',
  title: id,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
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

async function renderSidebar(props: Partial<ComponentProps<typeof Sidebar>>) {
  await act(async () => {
    root.render(
      <Sidebar
        projects={[project]}
        sessions={[]}
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

describe('sidebar draft session placeholder', () => {
  it('renders a selected placeholder ahead of the project sessions in draft state', async () => {
    await renderSidebar({ sessions: [session('one')], activeProjectId: 'project' })

    const placeholder = container.querySelector<HTMLElement>('.session-row-wrap.is-placeholder')
    expect(placeholder).not.toBeNull()
    expect(placeholder?.classList.contains('is-selected')).toBe(true)
    expect(container.querySelectorAll('.session-row-wrap.is-placeholder')).toHaveLength(1)
    expect(container.querySelector('.project-row')?.classList.contains('is-selected')).toBe(false)
    expect(container.querySelector('.is-placeholder .session-row__title')?.textContent).toBe('Untitled session')
    // The placeholder leads its project's list, ahead of every real row.
    expect([...container.querySelectorAll<HTMLElement>('.session-row__title')].map((row) => row.textContent)).toEqual(['Untitled session', 'one'])
  })

  it('shows no placeholder and keeps the project selected once a real session is active', async () => {
    await renderSidebar({ sessions: [session('one')], activeProjectId: 'project', activeSessionId: 'one' })

    expect(container.querySelector('.session-row-wrap.is-placeholder')).toBeNull()
    expect(container.querySelector('.project-row')?.classList.contains('is-selected')).toBe(true)
  })

  it('keeps the placeholder visible but unselected outside the session view', async () => {
    await renderSidebar({ sessions: [session('one')], activeProjectId: 'project', activeView: 'settings' })

    const placeholder = container.querySelector<HTMLElement>('.session-row-wrap.is-placeholder')
    expect(placeholder).not.toBeNull()
    expect(placeholder?.classList.contains('is-selected')).toBe(false)
    expect(container.querySelector('.project-row')?.classList.contains('is-selected')).toBe(false)
  })

  it('suppresses the empty-project new-session row for the draft project only', async () => {
    await renderSidebar({ projects: [project, other], sessions: [], activeProjectId: 'project' })

    expect(container.querySelectorAll('.session-row-wrap.is-placeholder')).toHaveLength(1)
    expect(container.querySelectorAll('.session-row--empty')).toHaveLength(1)
    expect(container.querySelector('.session-row--empty')?.textContent).toContain('New session')
  })

  it('renders the placeholder on top of the capped session list', async () => {
    const sessions = Array.from({ length: SIDEBAR_SESSION_LIMIT + 2 }, (_, index) => session(`s-${index}`))
    await renderSidebar({ sessions, activeProjectId: 'project' })

    expect(container.querySelectorAll('.session-row-wrap')).toHaveLength(SIDEBAR_SESSION_LIMIT + 1)
    expect(container.querySelector('.is-placeholder .session-row__title')?.textContent).toBe('Untitled session')
  })

  it('activates the draft through its own callback when the row is clicked', async () => {
    const onSelectDraftSession = vi.fn()
    const onNewSession = vi.fn()
    await renderSidebar({ sessions: [session('one')], activeProjectId: 'project', onSelectDraftSession, onNewSession })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.is-placeholder .session-row')?.click()
    })

    expect(onSelectDraftSession).toHaveBeenCalledWith(project)
    expect(onNewSession).not.toHaveBeenCalled()
  })

  it('discards the draft without opening a confirmation dialog', async () => {
    const onDiscardDraftSession = vi.fn()
    await renderSidebar({ sessions: [session('one')], activeProjectId: 'project', onDiscardDraftSession })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.is-placeholder .session-row__archive')?.click()
    })

    expect(onDiscardDraftSession).toHaveBeenCalledWith(project)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('labels the discard action for assistive tech', async () => {
    await renderSidebar({ sessions: [session('one')], activeProjectId: 'project' })

    expect(container.querySelector('.is-placeholder button[aria-label="Delete Untitled session"]')).not.toBeNull()
  })
})
