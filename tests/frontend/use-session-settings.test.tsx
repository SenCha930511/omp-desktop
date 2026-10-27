// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionSettings, type SessionSettingsApi } from '../../src/hooks/useSessionSettings'
import type { DesktopApi, RuntimeInfo } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function makeRuntime(sessionSettings?: RuntimeInfo['sessionSettings']): RuntimeInfo {
  return { runtimeId: 'rt-1', harness: 'omp', cwd: '/probe', isStreaming: false, sessionSettings }
}

describe('useSessionSettings', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function mount(bridge: DesktopApi | null, runtime: RuntimeInfo | null, reportError = vi.fn()) {
    let api!: SessionSettingsApi
    function Probe({ bridge: nextBridge, runtime: nextRuntime }: { bridge: DesktopApi | null; runtime: RuntimeInfo | null }) {
      api = useSessionSettings(nextBridge, nextRuntime, reportError)
      useEffect(() => undefined, [api])
      return null
    }
    const render = (nextBridge = bridge, nextRuntime = runtime) => act(() => root.render(<Probe bridge={nextBridge} runtime={nextRuntime} />))
    render()
    return { get api() { return api }, render, reportError }
  }

  const makeBridge = (command: ReturnType<typeof vi.fn<(runtimeId: string, commandBody: Record<string, unknown>) => Promise<Record<string, unknown>>>> = vi.fn(async (_runtimeId: string, _commandBody: Record<string, unknown>) => ({ success: true }))) => ({ agent: { command } }) as unknown as DesktopApi

  it('passes the runtime snapshot through as the initial values (get_state truth)', () => {
    const bridge = makeBridge()
    const settings = { autoCompaction: true, steeringMode: 'one-at-a-time', interruptMode: 'immediate' } as const
    const probe = mount(bridge, makeRuntime(settings))
    expect(probe.api.values).toBe(settings)
    expect(probe.api.ready).toBe(true)
    expect(probe.api.pending.size).toBe(0)
  })

  it('sends the exact upstream RPC for each of the six settings', async () => {
    const command = vi.fn(async (_runtimeId: string, _commandBody: Record<string, unknown>) => ({ success: true }))
    const bridge = makeBridge(command)
    const probe = mount(bridge, makeRuntime())
    await act(async () => { await probe.api.setAutoCompaction(false) })
    await act(async () => { await probe.api.setAutoRetry(true) })
    await act(async () => { await probe.api.setSteeringMode('all') })
    await act(async () => { await probe.api.setFollowUpMode('one-at-a-time') })
    await act(async () => { await probe.api.setInterruptMode('wait') })
    await act(async () => { await probe.api.setCacheWarming('idle') })
    expect(command.mock.calls.map((call) => call[0])).toEqual(['rt-1', 'rt-1', 'rt-1', 'rt-1', 'rt-1', 'rt-1'])
    expect(command.mock.calls.map((call) => call[1])).toEqual([
      { type: 'set_auto_compaction', enabled: false },
      { type: 'set_auto_retry', enabled: true },
      { type: 'set_steering_mode', mode: 'all' },
      { type: 'set_follow_up_mode', mode: 'one-at-a-time' },
      { type: 'set_interrupt_mode', mode: 'wait' },
      { type: 'set_cache_warming', mode: 'idle' },
    ])
  })

  it('is inert without a live runtime: nothing goes on the wire', async () => {
    const command = vi.fn(async (_runtimeId: string, _commandBody: Record<string, unknown>) => ({ success: true }))
    const bridge = makeBridge(command)
    const probe = mount(bridge, null)
    expect(probe.api.ready).toBe(false)
    expect(probe.api.values).toBeUndefined()
    await act(async () => { await probe.api.setSteeringMode('all') })
    expect(command).not.toHaveBeenCalled()
  })

  it('tracks pending per setting while the RPC is in flight', async () => {
    let settle!: (value: Record<string, unknown>) => void
    const command = vi.fn((_runtimeId: string, _commandBody: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => { settle = resolve }))
    const bridge = makeBridge(command)
    const probe = mount(bridge, makeRuntime({ autoCompaction: true }))
    let flight!: Promise<void>
    // setPending 在 await 之前同步派送;sync act 收尾時 flush,re-render 後讀
    // 到的是帶 pending 的新快照。務必透過 getter 讀——解構出的舊 api 是凍結物件。
    act(() => { flight = probe.api.setAutoCompaction(false) })
    expect(probe.api.pending.has('autoCompaction')).toBe(true)
    expect(probe.api.pending.has('autoRetry')).toBe(false)
    await act(async () => { settle({ success: true }); await flight })
    expect(probe.api.pending.size).toBe(0)
  })

  it('reports rejected RPCs and never mutates values optimistically', async () => {
    const command = vi.fn(async () => ({ success: false, error: 'unsupported here' }))
    const bridge = makeBridge(command)
    const reportError = vi.fn()
    const settings = { autoCompaction: true } as const
    const probe = mount(bridge, makeRuntime(settings), reportError)
    await act(async () => { await probe.api.setAutoCompaction(false) })
    expect(reportError).toHaveBeenCalledOnce()
    expect(String(reportError.mock.calls[0]?.[0])).toContain('unsupported here')
    // 快照只能由 runtime_state 更新;hook 自身不改值。
    expect(probe.api.values).toBe(settings)
  })

  it('reports transport failures through reportError', async () => {
    const command = vi.fn(async () => { throw new Error('runtime gone') })
    const bridge = makeBridge(command)
    const reportError = vi.fn()
    const probe = mount(bridge, makeRuntime(), reportError)
    await act(async () => { await probe.api.setCacheWarming('streaming') })
    expect(reportError).toHaveBeenCalledOnce()
    expect(probe.api.pending.size).toBe(0)
  })

  it('follows runtime replacement (new session snapshot)', () => {
    const bridge = makeBridge()
    const probe = mount(bridge, makeRuntime({ steeringMode: 'all' }))
    expect(probe.api.values).toMatchObject({ steeringMode: 'all' })
    // 新 runtime(runtime_state 快照替換)是權威:values 立即反映新工作階段,
    // 舊 snapshot 不殘留。同樣要透過 getter 讀 re-render 後的新 api。
    probe.render(bridge, { ...makeRuntime({ steeringMode: 'one-at-a-time' }), runtimeId: 'rt-2' })
    expect(probe.api.values).toMatchObject({ steeringMode: 'one-at-a-time' })
    expect(probe.api.ready).toBe(true)
  })
})
