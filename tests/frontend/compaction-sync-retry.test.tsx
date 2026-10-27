// @vitest-environment jsdom

import './jsdom-storage'
import { act, type SetStateAction } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkTimeline } from '../../src/components/transcript/timeline'
import { useAgentEvents } from '../../src/hooks/useAgentEvents'
import { compactionSyncPendingStore } from '../../src/lib/compaction-sync-state'
import type { DesktopApi, MessagePart, RuntimeInfo, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const session: SessionRecord = {
  id: 'session', harness: 'omp', projectPath: '/project', filePath: '/sessions/current.jsonl', title: 'Current',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}
const runtime: RuntimeInfo = { runtimeId: 'runtime', harness: 'omp', cwd: '/project', sessionFile: session.filePath, isStreaming: false }

const compactionSyncNotice = {
  type: 'notice',
  level: 'warning',
  message: 'Compaction completed, but session state could not be synchronized. Refresh the session before continuing; do not repeat compaction.',
  source: 'desktop.compaction-sync',
} as const

type AgentEventHandler = (payload: { runtimeId: string; event: Record<string, unknown> }) => void

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
  compactionSyncPendingStore.clear()
  Reflect.deleteProperty(window, 'desktop')
  vi.restoreAllMocks()
})

function installBridge(refreshState: (runtimeId: string) => Promise<RuntimeInfo>): void {
  Object.defineProperty(window, 'desktop', { configurable: true, value: { agent: { refreshState } } })
}

function renderParts(parts: MessagePart[]): void {
  act(() => root.render(<WorkTimeline parts={parts} showReasoning showTools />))
}

type SetRuntime = (value: SetStateAction<RuntimeInfo | null>) => void

/** Latest setRuntime updater, which every tracked event path in the hook uses. */
function lastRuntimeUpdater(setRuntime: ReturnType<typeof vi.fn<SetRuntime>>): (current: RuntimeInfo | null) => RuntimeInfo | null {
  const update = setRuntime.mock.calls.at(-1)?.[0]
  if (typeof update !== 'function') throw new Error('setRuntime was not called with an updater function')
  return update
}

function mountAgentEvents() {
  let handler!: AgentEventHandler
  const bridge = {
    agent: { onEvent: (callback: AgentEventHandler) => { handler = callback; return vi.fn() } },
  } as unknown as DesktopApi
  const setRuntime = vi.fn<SetRuntime>()
  function AgentEventsProbe() {
    useAgentEvents({
      bridge,
      runtimeIdRef: { current: 'runtime' },
      runtimeSessionsRef: { current: new Map([['runtime', session.filePath]]) },
      runtimeOwnerRef: { current: null },
      workspaceRef: { current: { generation: 0, sessionFile: session.filePath, cwd: '/project' } },
      setSessions: vi.fn(),
      setRuntime,
      queueAgentEvent: vi.fn(),
      reconcileTranscriptForEvent: vi.fn(),
      showExtensionUi: vi.fn(),
      clearExtensionUi: vi.fn(),
      refreshGit: vi.fn(async () => undefined),
      refreshGitOnTerminalEvent: false,
      activeSessionVisible: true,
    })
    return null
  }
  return {
    setRuntime,
    emit: (event: Record<string, unknown>, eventRuntimeId = 'runtime') => handler({ runtimeId: eventRuntimeId, event }),
    render: async () => { await act(async () => { root.render(createElement(AgentEventsProbe)) }) },
  }
}

describe('compaction sync retry affordance', () => {
  it('keeps the quiet divider unchanged while no sync is pending', () => {
    renderParts([{ type: 'compaction', status: 'sync_pending', reason: 'threshold' }])

    const divider = container.querySelector('.compaction-divider.is-sync_pending')
    expect(divider?.textContent).toBe('Compaction outcome pending synchronization')
    expect(container.querySelector('.compaction-sync-retry__button')).toBeNull()
  })

  it('shows an in-flight state, then resolves through the authoritative refresh', async () => {
    const gate = Promise.withResolvers<RuntimeInfo>()
    const refreshState = vi.fn((_runtimeId: string) => gate.promise)
    installBridge(refreshState)
    act(() => { compactionSyncPendingStore.setPending('runtime') })
    renderParts([{ type: 'compaction', status: 'sync_pending', reason: 'threshold' }])

    const button = container.querySelector<HTMLButtonElement>('.compaction-sync-retry__button')!
    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('Retry sync')

    act(() => { button.click() })
    expect(refreshState).toHaveBeenCalledWith('runtime')
    expect(button.textContent).toContain('Syncing…')
    expect(button.disabled).toBe(true)
    expect(refreshState).toHaveBeenCalledTimes(1)

    await act(async () => { gate.resolve({ ...runtime, synchronizationPending: false }) })
    expect(container.querySelector('.compaction-sync-retry__note')?.textContent).toBe('Session state synchronized')

    // The runtime_state snapshot clears the store; the affordance disappears.
    act(() => { compactionSyncPendingStore.clear('runtime') })
    expect(container.querySelector('.compaction-sync-retry')).toBeNull()
  })

  it('keeps sync_pending, surfaces the failure once, and never retries on its own', async () => {
    const refreshState = vi.fn(async (_runtimeId: string): Promise<RuntimeInfo> => { throw new Error('OMP session state could not be synchronized') })
    installBridge(refreshState)
    act(() => { compactionSyncPendingStore.setPending('runtime') })
    renderParts([{ type: 'compaction', status: 'sync_pending', reason: 'threshold' }])

    const button = container.querySelector<HTMLButtonElement>('.compaction-sync-retry__button')!
    await act(async () => { button.click() })
    await act(async () => undefined)

    expect(refreshState).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.compaction-sync-retry__error')?.textContent).toBe('Sync failed; the state is still pending — try again.')
    expect(compactionSyncPendingStore.getSnapshot()).toEqual({ runtimeId: 'runtime' })
    expect(button.disabled).toBe(false)

    // A second tap is an explicit manual retry, not a loop.
    await act(async () => { button.click() })
    expect(refreshState).toHaveBeenCalledTimes(2)
  })

  it('degrades to a disabled desktop-only hint without a bridge', () => {
    act(() => { compactionSyncPendingStore.setPending('runtime') })
    renderParts([{ type: 'compaction', status: 'sync_pending', reason: 'threshold' }])

    const button = container.querySelector<HTMLButtonElement>('.compaction-sync-retry__button')!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Retrying synchronization requires the desktop app')
    act(() => { button.click() })
    expect(compactionSyncPendingStore.getSnapshot()).toEqual({ runtimeId: 'runtime' })
    expect(button.disabled).toBe(true)
  })
})

describe('useAgentEvents sync-pending lifecycle', () => {
  it('flags the runtime on compaction_sync_pending and clears both marks on the authoritative runtime_state', async () => {
    const harness = mountAgentEvents()
    await harness.render()

    act(() => { harness.emit({ type: 'compaction_sync_pending', synthetic: true }) })
    expect(compactionSyncPendingStore.getSnapshot()).toEqual({ runtimeId: 'runtime' })
    expect(lastRuntimeUpdater(harness.setRuntime)(runtime)).toMatchObject({ isCompacting: false, synchronizationPending: true })

    const snapshot: RuntimeInfo = { ...runtime, contextUsage: { tokens: 8_000, contextWindow: 128_000, percent: 6 } }
    act(() => { harness.emit({ type: 'runtime_state', state: snapshot }) })
    expect(compactionSyncPendingStore.getSnapshot()).toBeNull()
    expect(lastRuntimeUpdater(harness.setRuntime)({ ...runtime, synchronizationPending: true })).toBe(snapshot)
  })

  it('treats a formal compaction_end as resolved synchronization', async () => {
    const harness = mountAgentEvents()
    await harness.render()

    act(() => { harness.emit({ type: 'compaction_sync_pending', synthetic: true }) })
    expect(compactionSyncPendingStore.getSnapshot()).toEqual({ runtimeId: 'runtime' })

    act(() => { harness.emit({ type: 'compaction_end', reason: 'threshold', aborted: false }) })
    expect(compactionSyncPendingStore.getSnapshot()).toBeNull()
    expect(lastRuntimeUpdater(harness.setRuntime)({ ...runtime, synchronizationPending: true })).toMatchObject({ synchronizationPending: false })
  })

  it('tracks the manual compact warning notice for the active runtime only', async () => {
    const harness = mountAgentEvents()
    await harness.render()

    act(() => { harness.emit({ ...compactionSyncNotice }, 'other-runtime') })
    expect(compactionSyncPendingStore.getSnapshot()).toBeNull()

    act(() => { harness.emit({ ...compactionSyncNotice }) })
    expect(compactionSyncPendingStore.getSnapshot()).toEqual({ runtimeId: 'runtime' })
    expect(lastRuntimeUpdater(harness.setRuntime)(runtime)).toMatchObject({ synchronizationPending: true })
  })

  it('clears the pending retry when the runtime exits', async () => {
    const harness = mountAgentEvents()
    await harness.render()

    act(() => { harness.emit({ type: 'compaction_sync_pending', synthetic: true }) })
    expect(compactionSyncPendingStore.getSnapshot()).toEqual({ runtimeId: 'runtime' })

    act(() => { harness.emit({ type: 'runtime_exit' }) })
    expect(compactionSyncPendingStore.getSnapshot()).toBeNull()
  })
})
