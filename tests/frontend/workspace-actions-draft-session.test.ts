// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import { readComposerDraft, saveComposerDraft } from '../../src/lib/composer-draft'
import { createSingleFlightAdmission } from '../../src/lib/workspace'
import type { DesktopApi, RuntimeInfo, SessionRecord } from '../../src/types/api'

const project = {
  id: 'draft-project',
  harness: 'omp' as const,
  name: 'Draft project',
  path: '/draft-project',
  folders: ['/draft-project'],
  primaryFolder: '/draft-project',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 1,
}

const session = (id = 'draft-session'): SessionRecord => ({
  id,
  harness: 'omp',
  filePath: `/draft-project/${id}.jsonl`,
  projectPath: '/draft-project',
  title: 'Draft session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
})

const runtime = (overrides: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  runtimeId: 'started-runtime',
  harness: 'omp',
  cwd: project.primaryFolder,
  sessionFile: session().filePath,
  isStreaming: false,
  ...overrides,
})

describe('openDraftSession', () => {
  it('keeps the current draft and its composer text instead of re-activating', () => {
    saveComposerDraft('draft-project:new', { text: 'untyped thought' })
    const activateWorkspace = vi.fn()
    const setView = vi.fn()
    const actions = createWorkspaceActions(
      () =>
        ({
          layout: { compactLayout: false, setSmallestSidebarAllowed: vi.fn() },
          settingsState: { setSidebarOpen: vi.fn() },
          workspace: {
            workspaceRef: { current: { project, session: undefined, generation: 1 } },
            activateWorkspace,
          },
          setView,
        }) as unknown as WorkspaceActionsDeps,
    )

    actions.openDraftSession(project)

    expect(activateWorkspace).not.toHaveBeenCalled()
    expect(setView).toHaveBeenCalledWith('session')
    expect(readComposerDraft('draft-project:new')).toMatchObject({ text: 'untyped thought' })
  })

  it('activates the project draft when another session is on screen', () => {
    const activateWorkspace = vi.fn()
    const setView = vi.fn()
    const actions = createWorkspaceActions(
      () =>
        ({
          layout: { compactLayout: false, setSmallestSidebarAllowed: vi.fn() },
          settingsState: { setSidebarOpen: vi.fn() },
          workspace: {
            workspaceRef: { current: { project, session: session(), generation: 3 } },
            activateWorkspace,
          },
          setView,
        }) as unknown as WorkspaceActionsDeps,
    )

    actions.openDraftSession(project)

    expect(activateWorkspace).toHaveBeenCalledWith(project)
    expect(setView).toHaveBeenCalledWith('session')
  })
})

describe('discardDraftSession', () => {
  it('activates the newest unarchived session of the project without any backend delete', async () => {
    const current = session('current')
    const archived = { ...session('archived'), archived: true, updatedAt: '2026-01-03T00:00:00.000Z' }
    const activateWorkspace = vi.fn(() => 7)
    const reconcileRuntime = vi.fn()
    const clearSessionAttention = vi.fn()
    const setView = vi.fn()
    const actions = createWorkspaceActions(
      () =>
        ({
          sessions: [archived, current],
          workspace: {
            workspaceRef: { current: { project, session: undefined, generation: 7 } },
            activateWorkspace,
            reconcileRuntime,
          },
          setSessions: vi.fn(),
          setView,
          clearSessionAttention,
          reportError: vi.fn(),
        }) as unknown as WorkspaceActionsDeps,
    )

    await actions.discardDraftSession(project)

    expect(activateWorkspace).toHaveBeenCalledWith(project, current)
    expect(reconcileRuntime).toHaveBeenCalledWith(7)
    expect(clearSessionAttention).toHaveBeenCalledWith(current)
    expect(setView).toHaveBeenCalledWith('session')
  })

  it('stays in draft when the project has no session', async () => {
    const activateWorkspace = vi.fn(() => 2)
    const setView = vi.fn()
    const actions = createWorkspaceActions(
      () =>
        ({
          sessions: [],
          workspace: {
            workspaceRef: { current: { project, session: undefined, generation: 2 } },
            activateWorkspace,
            reconcileRuntime: vi.fn(),
          },
          setSessions: vi.fn(),
          setView,
          clearSessionAttention: vi.fn(),
      bumpRecentSessionOpen: vi.fn(),
          reportError: vi.fn(),
        }) as unknown as WorkspaceActionsDeps,
    )

    await actions.discardDraftSession(project)

    expect(activateWorkspace).toHaveBeenCalledWith(project, undefined)
    expect(setView).toHaveBeenCalledWith('session')
  })
})

describe('draft session adoption on first prompt', () => {
  function promptFixture({ sessionFile, catalog, provider = { model: 'auto', effort: 'medium', fast: false } }: { sessionFile: string | undefined; catalog: SessionRecord[]; provider?: { model: string; effort: string; fast: boolean; resolveSelection?(): Promise<{ model: string; effort: string; fast: boolean }> } }) {
    const workspaceRef = {
      current: {
        generation: 1,
        project,
        session: sessionFile ? session() : undefined,
        cwd: project.primaryFolder,
        sessionFile,
      },
    }
    let sessions = [...catalog]
    const adoptSessionId = vi.fn()
    const setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>> = (update) => {
      sessions = typeof update === 'function' ? update(sessions) : update
    }
    const agentMocks = {
      list: vi.fn(async () => []),
      start: vi.fn(async () => runtime({ sessionFile: sessionFile ?? session().filePath })),
      command: vi.fn(async () => ({})),
      stop: vi.fn(async () => false),
    }
    const bridge = {
      agent: agentMocks,
      sessions: { list: vi.fn(async () => catalog) },
    } as unknown as DesktopApi
    const actions = createWorkspaceActions(
      () =>
        ({
          bridge,
          projects: [project],
          sessions,
          activeProject: project,
          workspace: {
            runtime: null,
            workspaceRef,
            runtimeIdRef: { current: null },
            runtimeOwnerRef: { current: null },
            prepareForPrompt: () => true,
            attachRuntime: vi.fn(),
            setRuntime: vi.fn(),
            setMessages: vi.fn(),
            queuePrompt: vi.fn(),
            removeQueuedPrompt: vi.fn(),
            markQueuedPromptFlushFailed: vi.fn(),
            adoptSessionId,
          },
          settingsState: { settings: { activeHarness: 'omp', locale: 'en' } },
          provider,
          submissionAdmissionRef: { current: createSingleFlightAdmission() },
          initialized: true,
          layout: {},
          pluginSkills: {},
          gitRequestRef: { current: 0 },
          demoTimerRef: { current: [] },
          setProjects: vi.fn(),
          setSessions,
          setGitSnapshot: vi.fn(),
          setView: vi.fn(),
          setPaletteOpen: vi.fn(),
          setToast: vi.fn(),
          setSubmitting: vi.fn(),
          refreshSchedules: vi.fn(),
          resetBrowserView: vi.fn(),
          closeTerminalForSession: vi.fn(),
          clearSessionAttention: vi.fn(),
      bumpRecentSessionOpen: vi.fn(),
          reportError: vi.fn(),
        }) as unknown as WorkspaceActionsDeps,
    )
    return { actions, bridge, agentMocks, adoptSessionId, workspaceRef, getSessions: () => sessions }
  }

  it('adopts the session indexed by a prompt sent from the draft placeholder', async () => {
    const { actions, bridge, adoptSessionId } = promptFixture({ sessionFile: undefined, catalog: [{ ...session(), title: 'Untitled session' }] })

    await actions.sendPrompt('first draft prompt')

    expect(bridge.agent.start).toHaveBeenCalledWith(expect.objectContaining({ sessionPath: undefined }))
    expect(adoptSessionId).toHaveBeenCalledWith(expect.objectContaining({ filePath: session().filePath }))
  })

  it('waits for initial model resolution before starting a draft runtime', async () => {
    const resolveSelection = vi.fn(async () => ({ model: 'fixture/ready-model', effort: 'auto', fast: false }))
    const { actions, bridge } = promptFixture({ sessionFile: undefined, catalog: [session()], provider: { model: '', effort: 'medium', fast: false, resolveSelection } })
    await actions.sendPrompt('first prompt before models finish loading')
    expect(resolveSelection).toHaveBeenCalledOnce()
    expect(bridge.agent.start).toHaveBeenCalledWith(expect.objectContaining({ model: 'fixture/ready-model', thinking: 'auto' }))
  })

  it('does not adopt when a real session was already active', async () => {
    const { actions, adoptSessionId } = promptFixture({ sessionFile: session().filePath, catalog: [session()] })

    await actions.sendPrompt('follow up in a real session')

    expect(adoptSessionId).not.toHaveBeenCalled()
  })

  it('does not adopt when the catalog has not indexed the started session', async () => {
    const { actions, adoptSessionId } = promptFixture({ sessionFile: undefined, catalog: [] })

    await actions.sendPrompt('first draft prompt')

    expect(adoptSessionId).not.toHaveBeenCalled()
  })

  it('keeps the launched session alive when the workspace switches mid-launch', async () => {
    const { actions, agentMocks, adoptSessionId, workspaceRef, getSessions } = promptFixture({ sessionFile: undefined, catalog: [{ ...session(), title: 'Untitled session' }] })
    // Simulates clicking another session while the harness is still starting:
    // activateWorkspace bumps the generation during agent.start.
    agentMocks.start.mockImplementationOnce(async () => {
      workspaceRef.current = { ...workspaceRef.current, generation: 2 }
      return runtime({ sessionFile: session().filePath })
    })

    await actions.sendPrompt('first draft prompt')

    // The submitted prompt is authored work: the launch must survive, the
    // prompt is still delivered, and the session row persists in the sidebar.
    expect(agentMocks.stop).not.toHaveBeenCalled()
    expect(agentMocks.command).toHaveBeenCalledWith('started-runtime', expect.objectContaining({ type: 'prompt', message: 'first draft prompt' }))
    expect(adoptSessionId).not.toHaveBeenCalled()
    expect(getSessions()).toEqual(expect.arrayContaining([expect.objectContaining({ filePath: session().filePath })]))
  })
})
