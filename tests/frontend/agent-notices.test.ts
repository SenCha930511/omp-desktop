// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentEvents } from '../../src/hooks/useAgentEvents'
import type { DesktopApi, RuntimeInfo, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const session: SessionRecord = {
  id: 'session', harness: 'omp', projectPath: '/project', filePath: '/sessions/current.jsonl', title: 'Current',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}
const runtime: RuntimeInfo = { runtimeId: 'runtime', harness: 'omp', cwd: '/project', sessionFile: session.filePath, isStreaming: false }

/** Exact upstream shape: { type: 'notice', level, message, source? } — severity is `level`. */
const compactionSyncNotice = {
  type: 'notice',
  level: 'warning',
  message: 'Compaction completed, but session state could not be synchronized. Refresh the session before continuing; do not repeat compaction.',
  source: 'desktop.compaction-sync',
} as const
const compactionSyncText = `Warning: desktop.compaction-sync: ${compactionSyncNotice.message}`
const persistenceErrorText = 'Error: session-persistence: Failed to append entries to the session history file.'

type AgentEventHandler = (payload: { runtimeId: string; event: Record<string, unknown> }) => void

interface MountOptions {
  activeSessionVisible?: boolean
  runtimeId?: string | null
  refreshGitOnTerminalEvent?: boolean
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function mountAgentEvents({ activeSessionVisible = true, runtimeId = 'runtime', refreshGitOnTerminalEvent = false }: MountOptions = {}) {
  let handler!: AgentEventHandler
  const bridge = {
    agent: { onEvent: (callback: AgentEventHandler) => { handler = callback; return vi.fn() } },
  } as unknown as DesktopApi
  const calls = {
    onNotice: vi.fn(),
    onCommandOutput: vi.fn(),
    queueAgentEvent: vi.fn(),
    reconcileTranscriptForEvent: vi.fn(),
    refreshGit: vi.fn(async () => undefined),
    setSessions: vi.fn(),
    setRuntime: vi.fn(),
  }
  function AgentEventsProbe() {
    useAgentEvents({
      bridge,
      runtimeIdRef: { current: runtimeId },
      runtimeSessionsRef: { current: new Map([['runtime', session.filePath]]) },
      runtimeOwnerRef: { current: null },
      workspaceRef: { current: { generation: 0, sessionFile: session.filePath, cwd: '/project' } },
      setSessions: calls.setSessions,
      setRuntime: calls.setRuntime,
      queueAgentEvent: calls.queueAgentEvent,
      onNotice: calls.onNotice,
      onCommandOutput: calls.onCommandOutput,
      reconcileTranscriptForEvent: calls.reconcileTranscriptForEvent,
      showExtensionUi: vi.fn(),
      clearExtensionUi: vi.fn(),
      refreshGit: calls.refreshGit,
      refreshGitOnTerminalEvent,
      activeSessionVisible,
    })
    return null
  }
  return {
    calls,
    emit: (event: Record<string, unknown>, eventRuntimeId = 'runtime') => handler({ runtimeId: eventRuntimeId, event }),
    render: async () => { await act(async () => { root.render(createElement(AgentEventsProbe)) }) },
  }
}

describe('agent notice routing', () => {
  it('keeps an active visible session notice in the transcript without a toast, marking the runtime sync-pending', async () => {
    const harness = mountAgentEvents()
    await harness.render()

    act(() => { harness.emit({ ...compactionSyncNotice }) })

    expect(harness.calls.queueAgentEvent).toHaveBeenCalledWith({ ...compactionSyncNotice })
    expect(harness.calls.reconcileTranscriptForEvent).toHaveBeenCalledWith('runtime', { ...compactionSyncNotice })
    expect(harness.calls.onNotice).not.toHaveBeenCalled()
    // The desktop.compaction-sync notice now tracks the pending sync on the
    // runtime so the transcript divider can offer a manual refresh retry.
    expect(harness.calls.setRuntime).toHaveBeenCalledTimes(1)
    const update: unknown = harness.calls.setRuntime.mock.calls[0]?.[0]
    if (typeof update !== 'function') throw new Error('setRuntime was not called with an updater function')
    expect(update(runtime)).toMatchObject({ synchronizationPending: true })
    expect(harness.calls.setSessions).not.toHaveBeenCalled()
  })

  it('toasts background-runtime notices instead of dropping them', async () => {
    const harness = mountAgentEvents({ runtimeId: 'other' })
    await harness.render()

    act(() => {
      harness.emit({ type: 'notice', level: 'error', message: 'Failed to append entries to the session history file.', source: 'session-persistence' })
    })

    expect(harness.calls.onNotice).toHaveBeenCalledWith(persistenceErrorText, 'error')
    expect(harness.calls.queueAgentEvent).not.toHaveBeenCalled()
    expect(harness.calls.setSessions).not.toHaveBeenCalled()
  })

  it('maps each notice level to its toast tone', async () => {
    const harness = mountAgentEvents({ runtimeId: 'other' })
    await harness.render()

    act(() => {
      harness.emit({ type: 'notice', level: 'info', message: 'Cache warmed.' })
      harness.emit({ ...compactionSyncNotice })
    })

    expect(harness.calls.onNotice).toHaveBeenNthCalledWith(1, 'Notice: Cache warmed.', 'info')
    expect(harness.calls.onNotice).toHaveBeenNthCalledWith(2, compactionSyncText, 'warning')
  })

  it('toasts active-runtime notices when the session view is hidden, keeping the transcript row', async () => {
    const harness = mountAgentEvents({ activeSessionVisible: false })
    await harness.render()

    act(() => { harness.emit({ ...compactionSyncNotice }) })

    expect(harness.calls.onNotice).toHaveBeenCalledWith(compactionSyncText, 'warning')
    expect(harness.calls.queueAgentEvent).toHaveBeenCalledWith({ ...compactionSyncNotice })
  })

  it('raises no toast for malformed notices', async () => {
    const harness = mountAgentEvents({ runtimeId: 'other' })
    await harness.render()

    act(() => {
      harness.emit({ type: 'notice', message: 'missing level' })
      harness.emit({ type: 'notice', level: 'severe', message: 'unknown level' })
      harness.emit({ type: 'notice', severity: 'warning', message: 'wrong severity field' })
    })

    expect(harness.calls.onNotice).not.toHaveBeenCalled()
    expect(harness.calls.queueAgentEvent).not.toHaveBeenCalled()
  })
})

describe('agent notice terminal safety', () => {
  it('never ends the streaming turn or refreshes git for a notice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const harness = mountAgentEvents({ refreshGitOnTerminalEvent: true })
      let runtimeState: RuntimeInfo | null = { ...runtime }
      await harness.render()
      harness.calls.setRuntime.mockImplementation((update: RuntimeInfo | null | ((current: RuntimeInfo | null) => RuntimeInfo | null)) => {
        runtimeState = typeof update === 'function' ? update(runtimeState) : update
      })

      act(() => { harness.emit({ type: 'agent_start' }) })
      expect(runtimeState?.isStreaming).toBe(true)

      act(() => { harness.emit({ ...compactionSyncNotice }) })
      expect(runtimeState?.isStreaming).toBe(true)
      expect(runtimeState?.isCompacting).toBe(false)

      act(() => { vi.advanceTimersByTime(1_000) })
      expect(harness.calls.refreshGit).not.toHaveBeenCalled()

      act(() => { harness.emit({ type: 'agent_end' }) })
      expect(runtimeState?.isStreaming).toBe(false)
      act(() => { vi.advanceTimersByTime(200) })
      expect(harness.calls.refreshGit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('pre-existing event wiring (notice change regressions)', () => {
  it('still routes command_output text to onCommandOutput', async () => {
    const harness = mountAgentEvents()
    await harness.render()

    act(() => { harness.emit({ type: 'command_output', text: 'build ok' }) })

    expect(harness.calls.onCommandOutput).toHaveBeenCalledWith('build ok')
    expect(harness.calls.onNotice).not.toHaveBeenCalled()
  })

  it('still routes extension notify messages to onCommandOutput with the failure flag', async () => {
    const harness = mountAgentEvents()
    await harness.render()

    act(() => {
      harness.emit({ type: 'extension_ui_request', method: 'notify', message: 'extension notice', notifyType: 'error' })
      harness.emit({ type: 'extension_ui_request', method: 'notify', message: 'extension info' })
    })

    expect(harness.calls.onCommandOutput).toHaveBeenNthCalledWith(1, 'extension notice', true)
    expect(harness.calls.onCommandOutput).toHaveBeenNthCalledWith(2, 'extension info', false)
    expect(harness.calls.onNotice).not.toHaveBeenCalled()
  })

  it('still updates the executing model on retry_fallback_applied', async () => {
    const harness = mountAgentEvents()
    let runtimeState: RuntimeInfo | null = { ...runtime }
    await harness.render()
    harness.calls.setRuntime.mockImplementation((update: RuntimeInfo | null | ((current: RuntimeInfo | null) => RuntimeInfo | null)) => {
      runtimeState = typeof update === 'function' ? update(runtimeState) : update
    })

    act(() => {
      harness.emit({ type: 'retry_fallback_applied', from: 'anthropic/claude-opus', to: 'anthropic/claude-sonnet', role: 'fallback' })
    })

    expect(runtimeState?.executingModel).toEqual({
      provider: 'anthropic',
      id: 'claude-sonnet',
      label: 'anthropic/claude-sonnet',
      isFallback: true,
    })
  })
})
