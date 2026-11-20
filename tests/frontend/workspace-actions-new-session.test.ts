// @vitest-environment jsdom

import './jsdom-storage'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import { readComposerDraft, saveComposerDraft } from '../../src/lib/composer-draft'
import { createSingleFlightAdmission } from '../../src/lib/workspace'
import type { DesktopApi, ProjectRecord } from '../../src/types/api'

const project: ProjectRecord = {
  id: 'draft-project',
  harness: 'omp',
  name: 'Draft project',
  path: '/draft-project',
  folders: ['/draft-project'],
  primaryFolder: '/draft-project',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 1,
}

const otherProject: ProjectRecord = {
  ...project,
  id: 'other-project',
  name: 'Other project',
  path: '/other-project',
  folders: ['/other-project'],
  primaryFolder: '/other-project',
}

function fixture({ bridge = true }: { bridge?: boolean } = {}) {
  const activateWorkspace = vi.fn(() => 3)
  const setMessages = vi.fn()
  const setView = vi.fn()
  const setPaletteOpen = vi.fn()
  const setSidebarOpen = vi.fn()
  const start = vi.fn()
  const command = vi.fn()
  const stop = vi.fn()
  const agent = bridge ? ({ start, command, stop } as unknown as DesktopApi['agent']) : null
  const actions = createWorkspaceActions(
    () =>
      ({
        bridge: agent ? ({ agent } as unknown as DesktopApi) : null,
        projects: [project, otherProject],
        sessions: [],
        activeProject: project,
        workspace: {
          workspaceRef: { current: { project, session: undefined, generation: 3 } },
          activateWorkspace,
          setMessages,
        },
        settingsState: { setSidebarOpen, settings: { activeHarness: 'omp', locale: 'en' } },
        submissionAdmissionRef: { current: createSingleFlightAdmission() },
        initialized: true,
        layout: { compactLayout: false, setSmallestSidebarAllowed: vi.fn() },
        setView,
        setPaletteOpen,
        reportError: vi.fn(),
      }) as unknown as WorkspaceActionsDeps,
  )
  return { actions, activateWorkspace, setMessages, setView, setPaletteOpen, setSidebarOpen, start, command, stop }
}

describe('new session draft', () => {
  it('opens an empty draft without creating an engine session or a catalog row', () => {
    saveComposerDraft('draft-project:new', { text: 'stale text' })
    const state = fixture()

    state.actions.newSession(project)

    expect(state.activateWorkspace).toHaveBeenCalledWith(project)
    expect(state.setView).toHaveBeenCalledWith('session')
    expect(state.setPaletteOpen).toHaveBeenCalledWith(false)
    expect(readComposerDraft('draft-project:new')).toBeNull()
    expect(state.start).not.toHaveBeenCalled()
    expect(state.command).not.toHaveBeenCalled()
    expect(state.stop).not.toHaveBeenCalled()
  })

  it('switches projects without touching the current runtime', () => {
    const state = fixture()

    state.actions.newSession(otherProject)

    expect(state.activateWorkspace).toHaveBeenCalledWith(otherProject)
    expect(state.start).not.toHaveBeenCalled()
    expect(state.command).not.toHaveBeenCalled()
    expect(state.stop).not.toHaveBeenCalled()
  })

  it('clears the transcript in demo mode without a bridge', () => {
    const state = fixture({ bridge: false })

    state.actions.newSession(project)

    expect(state.activateWorkspace).toHaveBeenCalledWith(project)
    expect(state.setMessages).toHaveBeenCalledWith([])
    expect(state.start).not.toHaveBeenCalled()
  })
})
