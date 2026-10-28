// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../src/components/Sidebar'
import { sessionAttentionSignature } from '../../src/app/session-attention'
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
async function rightClick(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
}

describe('sidebar project context menu', () => {
  it('sorts projects from the section menu and toggles pinning from project options', async () => {
    const projects = [
      { ...project, id: 'zeta', name: 'Zeta', lastOpenedAt: '2026-01-01T00:00:00.000Z' },
      { ...project, id: 'alpha', name: 'Alpha', lastOpenedAt: '2026-02-01T00:00:00.000Z' },
    ]
    const onSetProjectSortMode = vi.fn()
    const onTogglePinProject = vi.fn()
    const menuItems: Array<{ id: string; label: string }> = []
    await act(async () => {
      root.render(
        <Sidebar
          projects={projects} sessions={[session]} activeView="session" projectSortMode="recent"
          onSetProjectSortMode={onSetProjectSortMode} onTogglePinProject={onTogglePinProject}
          onSelectSession={noop} onNavigate={noop} onNewSession={noop} onAddProject={noop} onRemoveProject={noop}
          onClose={noop} onOpenPalette={noop} onRenameSession={async () => undefined} onArchiveSession={async () => undefined}
          onPopupMenu={async (items) => {
            menuItems.push(...items)
            return 'pin'
          }}
        />,
      )
    })

    expect([...container.querySelectorAll('.project-row__main')].map((button) => button.textContent)).toEqual(['Alpha', 'Zeta'])
    await press(container.querySelector('[aria-label="Sort projects"]')!)
    const alphabetical = [...container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.includes('Alphabetical'))
    expect(alphabetical).toBeDefined()
    await press(alphabetical!)
    expect(onSetProjectSortMode).toHaveBeenCalledWith('alphabetical')

    await rightClick(container.querySelector('.project-row')!)
    expect(menuItems.some((item) => item.id === 'pin' && item.label.includes('Pin project'))).toBe(true)
    expect(onTogglePinProject).toHaveBeenCalledWith(projects[1])
  })

  it('dismisses the sort menu when adding a project', async () => {
    await act(async () => {
      root.render(
        <Sidebar
          projects={[project]} sessions={[session]} activeView="session" projectSortMode="recent"
          onSelectSession={noop} onNavigate={noop} onNewSession={noop} onAddProject={noop} onRemoveProject={noop}
          onClose={noop} onOpenPalette={noop} onRenameSession={async () => undefined} onArchiveSession={async () => undefined}
        />,
      )
    })

    await press(container.querySelector('[aria-label="Sort projects"]')!)
    expect(container.querySelector('[role="menuitemradio"]')).not.toBeNull()
    await act(async () => {
      container.querySelector('[aria-label="Add project"]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('[role="menuitemradio"]')).toBeNull()
  })

  it('omits pinning for inferred projects', async () => {
    await act(async () => {
      root.render(
        <Sidebar
          projects={[{ ...project, inferred: true }]} sessions={[session]} activeView="session"
          onSelectSession={noop} onNavigate={noop} onNewSession={noop} onAddProject={noop} onRemoveProject={noop}
          onClose={noop} onOpenPalette={noop} onRenameSession={async () => undefined} onArchiveSession={async () => undefined}
        />,
      )
    })
    await rightClick(container.querySelector('.project-row')!)
    expect([...container.querySelectorAll('[aria-label^="Project options"] button')].some((button) => button.textContent?.includes('Pin project'))).toBe(false)
  })

  it('requires confirmation before downloading and restarting an available update', async () => {
    const onUpdateAction = vi.fn()
    await act(async () => {
      root.render(
        <Sidebar
          projects={[project]} sessions={[session]} activeView="session" updateState={{ phase: 'available', version: '0.2.0' }} onUpdateAction={onUpdateAction}
          onSelectSession={noop} onNavigate={noop} onNewSession={noop} onAddProject={noop} onRemoveProject={noop}
          onClose={noop} onOpenPalette={noop} onRenameSession={async () => undefined} onArchiveSession={async () => undefined}
        />,
      )
    })

    const update = container.querySelector('.sidebar__footer .sidebar-update')
    const settings = container.querySelector('.sidebar__footer button[title="Settings"]')
    expect(update).not.toBeNull()
    expect(update?.nextElementSibling).toBe(settings)
    expect(update?.textContent).toContain('Download 0.2.0')
    expect(update?.querySelector('.lucide-download')).not.toBeNull()
    await press(update!)
    expect(onUpdateAction).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Download and Restart OMP Desktop?')

    const yes = [...document.body.querySelectorAll<HTMLButtonElement>('.modal__footer button')].find((button) => button.textContent === 'Yes')
    expect(yes).toBeDefined()
    await press(yes!)
    expect(onUpdateAction).toHaveBeenCalledOnce()
  })

  it('keeps the release control hidden when no update is available', async () => {
    await act(async () => {
      root.render(
        <Sidebar
          projects={[project]} sessions={[session]} activeView="session" updateState={{ phase: 'not-available' }}
          onSelectSession={noop} onNavigate={noop} onNewSession={noop} onAddProject={noop} onRemoveProject={noop}
          onClose={noop} onOpenPalette={noop} onRenameSession={async () => undefined} onArchiveSession={async () => undefined}
        />,
      )
    })

    expect(container.querySelector('.sidebar__footer .sidebar-update')).toBeNull()
    expect(container.querySelector('.sidebar__footer button[title="Settings"]')).not.toBeNull()
  })

  it('copies the exact session UUID from the session context menu', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await act(async () => {
      root.render(
        <Sidebar
          projects={[project]} sessions={[session]} activeView="session"
          onSelectSession={noop} onNavigate={noop} onNewSession={noop} onAddProject={noop} onRemoveProject={noop}
          onClose={noop} onOpenPalette={noop} onRenameSession={async () => undefined} onArchiveSession={async () => undefined}
          onPopupMenu={async (items) => (items.some((item) => item.label.includes('Copy session UUID')) ? 'copy' : null)}
        />,
      )
    })

    await rightClick(container.querySelector('.session-row')!)
    expect(writeText).toHaveBeenCalledWith(session.id)
  })

  it('offers a confirmed remove action without deleting the project folder', async () => {
    const onRemoveProject = vi.fn()
    await act(async () => {
      root.render(
        <Sidebar
          projects={[project]}
          sessions={[session]}
          activeView="session"
          onSelectSession={noop}
          onNavigate={noop}
          onNewSession={noop}
          onAddProject={noop}
          onRemoveProject={onRemoveProject}
          onClose={noop}
          onOpenPalette={noop}
          onRenameSession={async () => undefined}
          onArchiveSession={async () => undefined}
          onPopupMenu={async (items) => (items.some((item) => item.label.includes('Delete project')) ? 'remove' : null)}
        />,
      )
    })

    await rightClick(container.querySelector('.project-row')!)

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('All of its saved sessions will be permanently deleted from OMP Desktop.')
    await press(document.body.querySelector('.modal .button--danger')!)
    expect(onRemoveProject).toHaveBeenCalledOnce()
    expect(onRemoveProject).toHaveBeenCalledWith(project)
  })

  it('uses notebook icons for new sessions and a folder-plus icon for projects', async () => {
    await act(async () => {
      root.render(
        <Sidebar
          projects={[project]}
          sessions={[session]}
          activeView="session"
          onSelectSession={noop}
          onNavigate={noop}
          onNewSession={noop}
          onAddProject={noop}
          onRemoveProject={noop}
          onClose={noop}
          onOpenPalette={noop}
          onRenameSession={async () => undefined}
          onArchiveSession={async () => undefined}
        />,
      )
    })

    expect(container.querySelector('.sidebar__primary .lucide-notebook-pen')).not.toBeNull()
    expect(container.querySelector('.project-row__new-session .lucide-notebook-pen')).not.toBeNull()
    expect(container.querySelector('.sidebar__section-heading .lucide-folder-plus')).not.toBeNull()
    expect(container.querySelector('.sidebar__primary button[title="New session (⌘N)"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="New session in Project"][title="New session in Project"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Add project"][title="Add project"]')).not.toBeNull()
  })

  it('shows Linux shortcut names on Linux', async () => {
    await act(async () => {
      root.render(
        <Sidebar
          platform="linux"
          projects={[project]}
          sessions={[session]}
          activeView="session"
          onSelectSession={noop}
          onNavigate={noop}
          onNewSession={noop}
          onAddProject={noop}
          onRemoveProject={noop}
          onClose={noop}
          onOpenPalette={noop}
          onRenameSession={async () => undefined}
          onArchiveSession={async () => undefined}
        />,
      )
    })

    expect(container.querySelector('.sidebar__primary button[title="New session (Ctrl+N)"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Hide sidebar (Ctrl+B)"]')).not.toBeNull()
    expect(container.textContent).not.toContain('⌘')
  })
})

describe('sidebar delete confirmation', () => {
  it('requires confirmation and supports cancelling before deletion', async () => {
    const onArchiveSession = vi.fn(async () => undefined)
    await act(async () => {
      root.render(
        <Sidebar
          projects={[project]}
          sessions={[session]}
          activeView="session"
          onSelectSession={noop}
          onNavigate={noop}
          onNewSession={noop}
          onAddProject={noop}
          onRemoveProject={noop}
          onClose={noop}
          onOpenPalette={noop}
          onRenameSession={async () => undefined}
          onArchiveSession={onArchiveSession}
        />,
      )
    })

    const archive = container.querySelector('[aria-label="Delete Session"]')
    expect(archive).not.toBeNull()
    expect(archive?.getAttribute('title')).toBe('Delete Session')
    await press(archive!)
    expect(onArchiveSession).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Permanently delete')

    await act(async () => [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!.click())
    expect(document.body.textContent).not.toContain('Permanently delete')
    expect(container.querySelector('[aria-label="Delete Session"]')).not.toBeNull()

    const restarted = container.querySelector('[aria-label="Delete Session"]')
    await press(restarted!)
    const confirm = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Delete permanently')
    await press(confirm!)
    expect(onArchiveSession).toHaveBeenCalledOnce()
    expect(onArchiveSession).toHaveBeenCalledWith(session)
  })
})

describe('sidebar session notifications', () => {
  it('mutes an acknowledged failed session without changing its failed status', async () => {
    const failedSession = { ...session, status: 'failed' as const }
    const props = {
      projects: [project],
      sessions: [failedSession],
      activeView: 'session' as const,
      onSelectProject: noop,
      onSelectSession: noop,
      onNavigate: noop,
      onNewSession: noop,
      onAddProject: noop,
      onRemoveProject: noop,
      onClose: noop,
      onOpenPalette: noop,
      onRenameSession: async () => undefined,
      onArchiveSession: async () => undefined,
    }
    await act(async () => { root.render(<Sidebar {...props} />) })

    expect(container.querySelector('.session-row-wrap')?.classList.contains('has-attention')).toBe(true)

    const signature = sessionAttentionSignature(failedSession)!
    await act(async () => { root.render(<Sidebar {...props} clearedAttention={{ [failedSession.id]: signature }} />) })
    expect(container.querySelector('.session-row-wrap')?.classList.contains('has-attention')).toBe(false)
  })
})
