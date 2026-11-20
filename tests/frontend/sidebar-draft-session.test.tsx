// @vitest-environment jsdom

import './jsdom-storage'
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../src/components/Sidebar'
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

describe('sidebar draft session', () => {
  it('renders no placeholder row for a draft workspace before the first prompt', async () => {
    await renderSidebar({ sessions: [session('one')], activeProjectId: 'project', activeView: 'session' })

    expect(container.querySelector('.session-row-wrap.is-placeholder')).toBeNull()
    expect([...container.querySelectorAll<HTMLElement>('.project-group .session-row__title')].map((row) => row.textContent)).toEqual(['one'])
    expect(container.querySelector('.project-row')?.classList.contains('is-selected')).toBe(true)
  })

  it('keeps a real session row selected instead of the project row', async () => {
    await renderSidebar({ sessions: [session('one')], activeProjectId: 'project', activeSessionId: 'one' })

    expect(container.querySelector('.project-row')?.classList.contains('is-selected')).toBe(false)
    expect(container.querySelector('.session-row-wrap.is-selected')?.querySelector('.session-row__title')?.textContent).toBe('one')
  })

  it('offers the empty-project new-session row only when the project has no sessions', async () => {
    await renderSidebar({ projects: [project, other], sessions: [], activeProjectId: 'project' })

    expect(container.querySelector('.session-row-wrap')).toBeNull()
    expect(container.querySelector('.session-row--empty')).not.toBeNull()
  })
})
