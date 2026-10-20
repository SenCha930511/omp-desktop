// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TitleToolbar } from '../../src/components/TitleToolbar'
import type { ProjectRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project', harness: 'omp', name: 'My Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1, gitBranch: 'main',
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
  vi.restoreAllMocks()
})

const noop = () => undefined

describe('title toolbar identity', () => {
  it('shows the session name instead of the project while a session is open', async () => {
    await act(async () => {
      root.render(
        <TitleToolbar
          project={project} sessionTitle="Outline WSL architecture" view="session" sidebarOpen inspectorOpen terminalOpen
          onToggleSidebar={noop} onToggleInspector={noop} onToggleTerminal={noop} onOpenBrowser={noop}
        />,
      )
    })
    const identity = container.querySelector('.title-toolbar__identity strong')
    expect(identity?.textContent).toBe('Outline WSL architecture')
    expect(container.querySelector('.branch-pill')?.textContent).toBe('main')
  })

  it('falls back to the project name for a brand-new session', async () => {
    await act(async () => {
      root.render(
        <TitleToolbar
          project={project} view="session" sidebarOpen inspectorOpen terminalOpen
          onToggleSidebar={noop} onToggleInspector={noop} onToggleTerminal={noop} onOpenBrowser={noop}
        />,
      )
    })
    expect(container.querySelector('.title-toolbar__identity strong')?.textContent).toBe('My Project')
  })
})
