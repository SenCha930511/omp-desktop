// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { harnessUpdateControlCopy, Sidebar } from '../../src/components/Sidebar'
import { type MessageKey, translate } from '../../src/lib/i18n'
import type { HarnessUpdateState, ProjectRecord, SessionRecord } from '../../src/types/api'

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
  vi.restoreAllMocks()
})

const noop = () => undefined

async function renderSidebar(harnessUpdateState?: HarnessUpdateState, onHarnessUpdateAction: () => void = noop) {
  await act(async () => {
    root.render(
      <Sidebar
        projects={[project]} sessions={[session]} activeView="session" harnessUpdateState={harnessUpdateState} onHarnessUpdateAction={onHarnessUpdateAction}
        onSelectSession={noop} onNavigate={noop} onNewSession={noop} onAddProject={noop} onRemoveProject={noop}
        onClose={noop} onOpenPalette={noop} onRenameSession={async () => undefined} onArchiveSession={async () => undefined}
      />,
    )
  })
}

const row = () => container.querySelector<HTMLButtonElement>('.sidebar-update--harness-available')

describe('sidebar harness update control', () => {
  it('shows the available omp version and routes the click to the prompt', async () => {
    const onHarnessUpdateAction = vi.fn()
    await renderSidebar({ phase: 'available', currentVersion: '18.12.6', availableVersion: '18.13.0' }, onHarnessUpdateAction)

    const button = row()
    expect(button).not.toBeNull()
    expect(button?.textContent).toContain('OMP 18.13.0 available')
    expect(button?.getAttribute('aria-label')).toContain('18.13.0')

    await act(async () => {
      button?.click()
    })
    expect(onHarnessUpdateAction).toHaveBeenCalledTimes(1)
  })

  it('stays hidden while idle or up to date', async () => {
    await renderSidebar({ phase: 'idle' })
    expect(row()).toBeNull()
    await renderSidebar({ phase: 'up-to-date', currentVersion: '18.12.6' })
    expect(row()).toBeNull()
  })

  it('disables the row and shows progress while installing', async () => {
    await renderSidebar({ phase: 'installing', currentVersion: '18.12.6', availableVersion: '18.13.0' })

    const button = container.querySelector<HTMLButtonElement>('.sidebar-update--harness-installing')
    expect(button).not.toBeNull()
    expect(button?.disabled).toBe(true)
    expect(button?.textContent).toContain('Updating OMP…')
  })

  it('labels the installed and error states for assistive tech', () => {
    const t = (key: MessageKey, values?: Record<string, string | number>) => translate('en', key, values)
    expect(harnessUpdateControlCopy({ phase: 'installed', availableVersion: '18.13.0' }, t).label).toBe('OMP 18.13.0 installed')
    expect(harnessUpdateControlCopy({ phase: 'error', message: 'registry unreachable' }, t)).toEqual({
      label: 'OMP update failed',
      title: 'registry unreachable',
    })
  })
})
