// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceRuntime } from '../../src/hooks/useWorkspaceRuntime'
import { ensureLocalStorage } from './storage-fixture'
import type { DesktopApi, ProjectRecord, RuntimeInfo, SessionRecord } from '../../src/types/api'

const project: ProjectRecord = {
  id: 'project', harness: 'omp', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const session: SessionRecord = {
  id: 'session', harness: 'omp', filePath: '/sessions/session.jsonl', projectPath: '/project', title: 'Session',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}
const runtime: RuntimeInfo = {
  runtimeId: 'runtime-a', harness: 'omp', cwd: '/project', sessionFile: session.filePath, isStreaming: true,
}

type Workspace = ReturnType<typeof useWorkspaceRuntime>
let latest: Workspace

const stableReportError = () => undefined

function Probe({ bridge }: { bridge: DesktopApi | null }) {
  latest = useWorkspaceRuntime({ bridge, initialProject: project, initialSession: session, sessions: [session], initialMessages: [], reportError: stableReportError })
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ensureLocalStorage()
  window.localStorage.clear()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const renderProbe = (bridge: DesktopApi | null) => act(() => { root.render(createElement(Probe, { bridge })) })

describe('harness-held queue removal and promotion', () => {
  it('returns the removal outcome with sanitized images and the native loss flag', async () => {
    const command = vi.fn(async () => ({
      data: {
        removed: true,
        images: [{ type: 'image', data: 'abc', mimeType: 'image/png', detail: 'low' }],
        imagesDropped: true,
      },
      sessionActions: { queuedCount: 0, steering: [], followUps: [] },
    }))
    renderProbe({ agent: { command } } as unknown as DesktopApi)
    act(() => { latest.attachRuntime(runtime, 0) })

    let result: Awaited<ReturnType<typeof latest.removeHarnessQueuedMessage>> | undefined
    await act(async () => { result = await latest.removeHarnessQueuedMessage('chip text', 'steering') })

    expect(command).toHaveBeenCalledWith('runtime-a', { type: 'remove_queued_message', message: 'chip text', queue: 'steering' })
    expect(result).toEqual({
      removed: true,
      images: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
      imagesDropped: true,
    })
    expect(latest.runtime).toMatchObject({ runtimeId: 'runtime-a', sessionActions: { queuedCount: 0 } })
  })

  it('reports a miss without inventing images or a loss flag', async () => {
    const command = vi.fn(async () => ({ data: { removed: false } }))
    renderProbe({ agent: { command } } as unknown as DesktopApi)
    act(() => { latest.attachRuntime(runtime, 0) })

    const result = await latest.removeHarnessQueuedMessage('gone chip', 'followUp')

    expect(command).toHaveBeenCalledWith('runtime-a', { type: 'remove_queued_message', message: 'gone chip', queue: 'followUp' })
    expect(result).toEqual({ removed: false })
  })

  it('returns null when the removal RPC fails', async () => {
    const command = vi.fn(async () => { throw new Error('unreachable') })
    renderProbe({ agent: { command } } as unknown as DesktopApi)
    act(() => { latest.attachRuntime(runtime, 0) })

    await expect(latest.removeHarnessQueuedMessage('chip text', 'steering')).resolves.toBeNull()
  })

  it('returns null with no runtime attached', async () => {
    const command = vi.fn(async () => ({}))
    renderProbe({ agent: { command } } as unknown as DesktopApi)

    await expect(latest.removeHarnessQueuedMessage('chip text', 'steering')).resolves.toBeNull()
    expect(command).not.toHaveBeenCalled()
  })

  it('promotes a held follow-up and reports the outcome', async () => {
    const command = vi.fn(async () => ({ data: { promoted: true } }))
    renderProbe({ agent: { command } } as unknown as DesktopApi)
    act(() => { latest.attachRuntime(runtime, 0) })

    await expect(latest.promoteHarnessQueuedMessage('chip text')).resolves.toEqual({ promoted: true })
    expect(command).toHaveBeenCalledWith('runtime-a', { type: 'promote_queued_message', message: 'chip text' })
  })

  it('returns null when the promotion RPC fails', async () => {
    const command = vi.fn(async () => { throw new Error('unreachable') })
    renderProbe({ agent: { command } } as unknown as DesktopApi)
    act(() => { latest.attachRuntime(runtime, 0) })

    await expect(latest.promoteHarnessQueuedMessage('chip text')).resolves.toBeNull()
  })
})
