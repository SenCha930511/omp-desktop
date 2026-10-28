import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import type { DesktopApi, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'
import { createSingleFlightAdmission } from '../../src/lib/workspace'

const project = {
  id: 'bash-project',
  harness: 'omp' as const,
  name: 'Bash project',
  path: '/bash-project',
  folders: ['/bash-project'],
  primaryFolder: '/bash-project',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 1,
}

const session = (): SessionRecord => ({
  id: 'bash-session',
  harness: 'omp',
  filePath: '/bash-project/session.jsonl',
  projectPath: '/bash-project',
  title: 'Bash session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
})

const ownedRuntime = (): RuntimeInfo => ({ runtimeId: 'bash-runtime', harness: 'omp', cwd: project.primaryFolder, sessionFile: session().filePath, isStreaming: false })

function fixture({ attached = true, bashResult, commandError }: { attached?: boolean; bashResult?: unknown; commandError?: Error } = {}) {
  let currentRuntime = attached ? ownedRuntime() : null
  let messages: TranscriptMessage[] = []
  const submissionAdmission = createSingleFlightAdmission()
  const currentSession = session()
  const workspaceRef = { current: { generation: 1, project, session: currentSession, cwd: project.primaryFolder, sessionFile: currentSession.filePath } }
  const onCommandStart = vi.fn()
  const onCommandFinish = vi.fn()
  const reportError = vi.fn()
  const command = vi.fn(async (_runtimeId: string, rpc: { type: string }) => {
    if (commandError) throw commandError
    return rpc.type === 'bash' ? { data: bashResult } : {}
  })
  const workspace = {
    get runtime() { return currentRuntime },
    workspaceRef,
    runtimeIdRef: { current: currentRuntime?.runtimeId ?? null as string | null },
    runtimeOwnerRef: { current: currentRuntime ? { runtimeId: currentRuntime.runtimeId, generation: 1 } : null as { runtimeId: string; generation: number } | null },
    pendingQueuedPrompts: [],
    setMessages: (next: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) => {
      messages = typeof next === 'function' ? next(messages) : next
    },
    setRuntime: vi.fn(),
    queuePrompt: vi.fn(() => 'queued-id'),
  }
  const bridge = { agent: { list: vi.fn(async () => []), command, start: vi.fn(), stop: vi.fn(async () => false) } } as unknown as DesktopApi
  const actions = createWorkspaceActions(() => ({
    bridge,
    projects: [project],
    sessions: [currentSession],
    activeProject: project,
    workspace,
    settingsState: { settings: { activeHarness: 'omp', locale: 'en' } },
    provider: { model: 'auto', effort: 'medium', fast: false },
    submissionAdmissionRef: { current: submissionAdmission },
    initialized: true,
    layout: {},
    pluginSkills: {},
    demoTimerRef: { current: [] },
    setProjects: vi.fn(),
    setSessions: vi.fn(),
    setView: vi.fn(),
    setPaletteOpen: vi.fn(),
    setToast: vi.fn(),
    setSubmitting: vi.fn(),
    refreshSchedules: vi.fn(),
    resetBrowserView: vi.fn(),
    closeTerminalForSession: vi.fn(),
    clearSessionAttention: vi.fn(),
    bumpRecentSessionOpen: vi.fn(),
    reportError,
    onCommandStart,
    onCommandFinish,
  } as unknown as WorkspaceActionsDeps))
  return { actions, command, onCommandStart, onCommandFinish, reportError, messages: () => messages }
}

describe('`!` shell shorthand routing', () => {
  it('runs `!cmd` through the OMP bash RPC and renders the result row', async () => {
    const state = fixture({ bashResult: { output: 'file.txt', cancelled: false, truncated: false, exitCode: 0 } })

    await state.actions.sendPrompt('!ls -la')

    expect(state.command).toHaveBeenCalledOnce()
    expect(state.command).toHaveBeenCalledWith('bash-runtime', { type: 'bash', command: 'ls -la' })
    expect(state.onCommandStart).toHaveBeenCalledWith('!ls -la', expect.any(Function))
    expect(state.onCommandFinish).toHaveBeenCalledWith(undefined)
    const rows = state.messages()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toMatch(/^bash-/)
    expect(rows[0]?.role).toBe('tool')
    expect(rows[0]?.parts[0]).toMatchObject({ type: 'toolCall', name: 'bash', args: { command: 'ls -la' } })
    expect(rows[0]?.parts[1]).toMatchObject({ type: 'toolResult', name: 'bash', text: 'file.txt', isError: false })
  })

  it('marks a non-zero exit as failed with the status line', async () => {
    const state = fixture({ bashResult: { output: 'boom', cancelled: false, truncated: false, exitCode: 2 } })

    await state.actions.sendPrompt('!false')

    expect(state.onCommandFinish).toHaveBeenCalledWith('[exit code 2]')
    expect(state.messages()[0]?.parts[1]).toMatchObject({ text: 'boom\n[exit code 2]', isError: true })
  })

  it('renders a cancelled result as failed with the cancelled marker', async () => {
    const state = fixture({ bashResult: { output: 'partial', cancelled: true, truncated: false } })

    await state.actions.sendPrompt('!sleep 999')

    expect(state.messages()[0]?.parts[1]).toMatchObject({ text: 'partial\n[cancelled]', isError: true })
  })

  it('routes non-text image output to image parts', async () => {
    const state = fixture({ bashResult: { output: '', cancelled: false, truncated: false, exitCode: 0, images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }] } })

    await state.actions.sendPrompt('!screenshot')

    expect(state.messages()[0]?.parts[2]).toMatchObject({ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' })
  })

  it('abort button sends abort_bash to the same runtime while running', async () => {
    const state = fixture({})
    let release!: (value: { data: unknown }) => void
    state.command.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const first = state.actions.sendPrompt('!sleep 999')

    const onAbort = state.onCommandStart.mock.calls[0]?.[1] as (() => void) | undefined
    expect(typeof onAbort).toBe('function')
    onAbort?.()
    await Promise.resolve()

    expect(state.command).toHaveBeenCalledWith('bash-runtime', { type: 'abort_bash' })
    release({ data: { output: '', cancelled: true, truncated: false } })
    await first
    expect(state.messages()[0]?.parts[1]).toMatchObject({ text: '[cancelled]', isError: true })
  })

  it('refuses `!!` because RPC cannot express exclude-from-context', async () => {
    const state = fixture({})

    await expect(state.actions.sendPrompt('!!secret-scan')).rejects.toThrow('not available over RPC')
    expect(state.command).not.toHaveBeenCalled()
    expect(state.messages()).toEqual([])
  })

  it('refuses the `$` Python shortcut as a documented RPC gap', async () => {
    const state = fixture({})

    await expect(state.actions.sendPrompt('$ print(1)')).rejects.toThrow('Python shortcut is not available')
    expect(state.command).not.toHaveBeenCalled()
  })

  it('rejects shell commands while another user bash is running', async () => {
    const state = fixture({})
    let release!: (value: { data: unknown }) => void
    state.command.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const first = state.actions.sendPrompt('!sleep 999')

    await expect(state.actions.sendPrompt('!echo busy')).rejects.toThrow('already running')
    expect(state.command).toHaveBeenCalledOnce()
    release({ data: { output: '', cancelled: true, truncated: false } })
    await first
  })

  it('rejects without a live runtime instead of faking local execution', async () => {
    const state = fixture({ attached: false })

    await expect(state.actions.sendPrompt('!ls')).rejects.toThrow('No live session')
    expect(state.command).not.toHaveBeenCalled()
    expect(state.messages()).toEqual([])
  })

  it('rejects attachments instead of silently dropping them', async () => {
    const state = fixture({})
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'aW1hZ2U=' }

    await state.actions.sendPrompt('!ls', [image])

    expect(state.command).not.toHaveBeenCalled()
    expect(state.reportError).toHaveBeenCalledOnce()
    expect(state.messages()).toEqual([])
  })

  it('surfaces a failed bash RPC without a transcript row', async () => {
    const state = fixture({ commandError: new Error('RPC command bash failed') })

    await expect(state.actions.sendPrompt('!ls')).rejects.toThrow('RPC command bash failed')
    expect(state.reportError).toHaveBeenCalledOnce()
    expect(state.messages()).toEqual([])
  })
})
