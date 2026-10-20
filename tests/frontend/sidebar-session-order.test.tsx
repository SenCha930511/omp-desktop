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

  it('pins the session in use ahead of more recent peers', () => {
    const sessions = [session('older', '2026-01-02T00:00:00.000Z'), session('newer', '2026-01-03T00:00:00.000Z'), session('in-use', '2026-01-01T00:00:00.000Z')]
    const { sessionsByProject } = indexSidebarSessions([project], sessions, undefined, 'in-use')
    expect(sessionsByProject.get('project')?.map((item) => item.id)).toEqual(['in-use', 'newer', 'older'])
  })

  it('moves the clicked session to the top of its project', async () => {
    const sessions = [session('older', '2026-01-02T00:00:00.000Z'), session('newer', '2026-01-03T00:00:00.000Z'), session('in-use', '2026-01-01T00:00:00.000Z')]
    await act(async () => {
      root.render(
        <Sidebar
          projects={[project]} sessions={sessions} activeView="session" activeSessionId="in-use" projectSortMode="recent"
          onSelectProject={noop} onSelectSession={noop} onNavigate={noop} onNewSession={noop} onAddProject={noop} onRemoveProject={noop}
          onClose={noop} onOpenPalette={noop} onRenameSession={async () => undefined} onArchiveSession={async () => undefined}
        />,
      )
    })
    expect([...container.querySelectorAll<HTMLElement>('.session-row__title')].map((row) => row.textContent)).toEqual(['in-use', 'newer', 'older'])
  })
})
