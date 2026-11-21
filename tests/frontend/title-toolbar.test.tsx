// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
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
          project={project} sessionTitle="Outline WSL architecture" view="session" sidebarOpen inspectorOpen
          onToggleSidebar={noop} onToggleInspector={noop} onOpenBrowser={noop}
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
          project={project} view="session" sidebarOpen inspectorOpen
          onToggleSidebar={noop} onToggleInspector={noop} onOpenBrowser={noop}
        />,
      )
    })
    expect(container.querySelector('.title-toolbar__identity strong')?.textContent).toBe('My Project')
  })
})

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy()
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const renderToolbar = async (props: Partial<ComponentProps<typeof TitleToolbar>> = {}) => {
  await act(async () => {
    root.render(
      <TitleToolbar
        project={project}
        view="session"
        sidebarOpen
        inspectorOpen
        onToggleSidebar={noop}
        onToggleInspector={noop}
        onOpenBrowser={noop}
        {...props}
      />,
    )
  })
}

describe('title toolbar session actions', () => {
  it('keeps the overview and More actions and folds the session tree, browser, and inspector into More', async () => {
    const onNewSession = vi.fn()
    await renderToolbar({ onNewSession, onOpenSessionTree: noop })

    expect([...container.querySelectorAll('.title-toolbar__actions button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Overview', 'More'])
    expect(container.querySelector('button[aria-label="Session tree"]')).toBeNull()

    await click(container.querySelector('button[aria-label="More"]'))
    const menu = container.querySelector('[role="dialog"]')
    expect(menu?.getAttribute('aria-label')).toBe('More')
    expect(menu?.querySelector('button[aria-label="Session tree"]')).not.toBeNull()
    expect(menu?.querySelector('button[aria-label^="Open browser"]')).not.toBeNull()
    expect(menu?.querySelector('button[aria-label="Toggle inspector"]')).not.toBeNull()

  })

  it('runs each More action and closes the menu', async () => {
    const onOpenSessionTree = vi.fn()
    const onOpenBrowser = vi.fn()
    const onToggleInspector = vi.fn()
    await renderToolbar({ onOpenSessionTree, onOpenBrowser, onToggleInspector, inspectorOpen: false })

    const choose = async (selector: string) => {
      await click(container.querySelector('button[aria-label="More"]'))
      await click(container.querySelector(`[role="dialog"] ${selector}`))
      expect(container.querySelector('[role="dialog"]')).toBeNull()
    }

    await choose('button[aria-label="Session tree"]')
    expect(onOpenSessionTree).toHaveBeenCalledTimes(1)
    await choose('button[aria-label^="Open browser"]')
    expect(onOpenBrowser).toHaveBeenCalledTimes(1)
    await choose('button[aria-label="Toggle inspector"]')
    expect(onToggleInspector).toHaveBeenCalledTimes(1)
    expect(onOpenSessionTree).toHaveBeenCalledTimes(1)
    expect(onOpenBrowser).toHaveBeenCalledTimes(1)
  })

  it('opens live voice from the More menu and closes it', async () => {
    const onOpenLiveVoice = vi.fn()
    await renderToolbar({ onOpenLiveVoice })
    await click(container.querySelector('button[aria-label="More"]'))
    const action = container.querySelector('[role="dialog"] button[aria-label="Live voice"]')
    expect(action).not.toBeNull()
    await click(action)
    expect(onOpenLiveVoice).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('hides the live voice action when the app does not provide it', async () => {
    await renderToolbar()
    await click(container.querySelector('button[aria-label="More"]'))
    expect(container.querySelector('[role="dialog"] button[aria-label="Live voice"]')).toBeNull()
  })

  it('marks the inspector action active while the inspector is open', async () => {
    await renderToolbar({ inspectorOpen: true })
    await click(container.querySelector('button[aria-label="More"]'))
    const action = container.querySelector('[role="dialog"] button[aria-label="Toggle inspector"]')
    expect(action?.className).toContain('is-active')

    await click(container.querySelector('button[aria-label="More"]'))
    await renderToolbar({ inspectorOpen: false })
    await click(container.querySelector('button[aria-label="More"]'))
    expect(container.querySelector('[role="dialog"] button[aria-label="Toggle inspector"]')?.className).not.toContain('is-active')
  })

  it('closes the More menu on Escape and on an outside pointer down', async () => {
    await renderToolbar()
    const more = container.querySelector('button[aria-label="More"]')

    await click(more)
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    await click(more)
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    await click(more)
    await act(async () => {
      container.querySelector('[role="dialog"]')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('keeps the Overview and More popovers mutually exclusive', async () => {
    await renderToolbar()

    await click(container.querySelector('button[aria-label="More"]'))
    await click(container.querySelector('button[aria-label="Overview"]'))
    const dialogs = [...container.querySelectorAll('[role="dialog"]')]
    expect(dialogs.map((dialog) => dialog.getAttribute('aria-label'))).toEqual(['Workspace overview'])

    await click(container.querySelector('button[aria-label="More"]'))
    expect([...container.querySelectorAll('[role="dialog"]')].map((dialog) => dialog.getAttribute('aria-label'))).toEqual(['More'])
  })

  it('toggles the Overview popover and reports the workspace counts', async () => {
    await renderToolbar({ projectCount: 3, sessionCount: 12, agentCount: 4, runningAgentCount: 2, scheduleCount: 1 })
    const overview = container.querySelector<HTMLButtonElement>('button[aria-label="Overview"]')
    expect(overview?.getAttribute('aria-expanded')).toBe('false')

    await click(overview)
    expect(overview?.getAttribute('aria-expanded')).toBe('true')
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-label')).toBe('Workspace overview')
    const rows = [...container.querySelectorAll('.toolbar-overview__counts > div')].map((row) => [
      row.querySelector('dt')?.textContent,
      row.querySelector('dd')?.textContent,
    ])
    expect(rows).toEqual([
      ['Projects', '3'],
      ['Sessions', '12'],
      ['Agents', '4'],
      ['Running agents', '2'],
      ['Active schedules', '1'],
    ])

    await click(overview)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(overview?.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens settings from the Overview popover and closes it', async () => {
    const onOpenSettings = vi.fn()
    await renderToolbar({ onOpenSettings })

    await click(container.querySelector('button[aria-label="Overview"]'))
    const dialog = container.querySelector('[role="dialog"]')
    expect([...(dialog?.querySelectorAll('button') ?? [])].map((button) => button.textContent?.trim())).toEqual(['Open settings'])

    await click(dialog?.querySelector('button'))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('starts a new session from the Overview popover and closes it', async () => {
    const onNewSession = vi.fn()
    await renderToolbar({ onNewSession, onOpenSettings: noop })

    await click(container.querySelector('button[aria-label="Overview"]'))
    const dialog = container.querySelector('[role="dialog"]')
    expect([...(dialog?.querySelectorAll('button') ?? [])].map((button) => button.textContent?.trim())).toEqual(['New session', 'Open settings'])

    await click(dialog?.querySelector('button'))
    expect(onNewSession).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes the Overview popover on Escape and on an outside pointer down', async () => {
    await renderToolbar()
    const overview = container.querySelector('button[aria-label="Overview"]')

    await click(overview)
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    await click(overview)
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    await click(overview)
    await act(async () => {
      container.querySelector('[role="dialog"]')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  })
})
