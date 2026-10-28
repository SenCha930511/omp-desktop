import { expect, it, vi } from 'vitest'
import { AgentRpcManager, OMP_RPC_ADAPTER } from '../../electron/main/agent-rpc'

it('protects commands awaiting asynchronous validation from idle retirement', async () => {
  vi.useFakeTimers()
  let validate!: (path: string) => void
  const validation = new Promise<string>((resolve) => { validate = resolve })
  const manager = new AgentRpcManager(null, async (cwd) => cwd, () => validation, undefined, OMP_RPC_ADAPTER, undefined, { idleMs: 100, warmCount: 0 })
  const runtime = {
    runtimeId: 'retained',
    snapshot: () => ({ runtimeId: 'retained', harness: 'omp', cwd: '/project', isStreaming: false }),
    command: vi.fn(async () => ({ type: 'response', success: true })),
    canRetireSafely: () => true,
    stop: vi.fn(async () => true),
  }
  ;(manager as unknown as { runtimes: Map<string, unknown> }).runtimes.set(runtime.runtimeId, runtime)
  try {
    await manager.command(runtime.runtimeId, { type: 'get_state' })
    await vi.advanceTimersByTimeAsync(80)
    const pending = manager.command(runtime.runtimeId, { type: 'switch_session', sessionPath: '/session.jsonl' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runtime.stop).not.toHaveBeenCalled()
    validate('/session.jsonl')
    await pending
    await vi.advanceTimersByTimeAsync(101)
    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(manager.list()).toEqual([])
  } finally { await manager.stopAll(); vi.useRealTimers() }
})

it('rechecks the warm budget after awaiting another child retirement', async () => {
  vi.useFakeTimers()
  let finishStop!: (stopped: boolean) => void
  const stopping = new Promise<boolean>((resolve) => { finishStop = resolve })
  const manager = new AgentRpcManager(null, async (cwd) => cwd, async (path) => path, undefined, OMP_RPC_ADAPTER, undefined, { idleMs: 100, warmCount: 1 })
  const make = (id: string) => ({ runtimeId: id, busy: false,
    snapshot() { return { runtimeId: id, harness: 'omp', cwd: '/project', isStreaming: this.busy } },
    command: vi.fn(async () => ({ success: true })), canRetireSafely: () => true, stop: vi.fn(async () => true) })
  const runtimes = [make('first'), make('second'), make('warm')]
  const entries = (manager as unknown as { runtimes: Map<string, unknown> }).runtimes
  for (const runtime of runtimes) entries.set(runtime.runtimeId, runtime)
  runtimes[1].stop.mockImplementationOnce(() => stopping)
  try {
    for (const runtime of runtimes) await manager.command(runtime.runtimeId, { type: 'get_state' })
    await vi.advanceTimersByTimeAsync(101)
    expect(runtimes[1].stop).toHaveBeenCalledOnce()
    runtimes[2].busy = true
    finishStop(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(runtimes[0].stop).not.toHaveBeenCalled()
  } finally { await manager.stopAll(); vi.useRealTimers() }
})

it('retires every idle runtime once the settings-backed window elapses', async () => {
  vi.useFakeTimers()
  const retention = { idleMs: 100, warmCount: 0 }
  const manager = new AgentRpcManager(null, async (cwd) => cwd, async (path) => path, undefined, OMP_RPC_ADAPTER, undefined, () => retention)
  const runtime = {
    runtimeId: 'idle-one',
    snapshot: () => ({ runtimeId: 'idle-one', harness: 'omp', cwd: '/project', isStreaming: false }),
    command: vi.fn(async () => ({ type: 'response', success: true })),
    canRetireSafely: () => true,
    stop: vi.fn(async () => true),
  }
  ;(manager as unknown as { runtimes: Map<string, unknown> }).runtimes.set(runtime.runtimeId, runtime)
  try {
    await manager.command(runtime.runtimeId, { type: 'get_state' })
    await vi.advanceTimersByTimeAsync(101)
    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(manager.list()).toEqual([])
  } finally { await manager.stopAll(); vi.useRealTimers() }
})

it('keeps idle runtimes resident when the preference disables the sweep', async () => {
  vi.useFakeTimers()
  const retention = { idleMs: 0, warmCount: 0 }
  const manager = new AgentRpcManager(null, async (cwd) => cwd, async (path) => path, undefined, OMP_RPC_ADAPTER, undefined, () => retention)
  const runtime = {
    runtimeId: 'idle-kept',
    snapshot: () => ({ runtimeId: 'idle-kept', harness: 'omp', cwd: '/project', isStreaming: false }),
    command: vi.fn(async () => ({ type: 'response', success: true })),
    canRetireSafely: () => true,
    stop: vi.fn(async () => true),
  }
  ;(manager as unknown as { runtimes: Map<string, unknown> }).runtimes.set(runtime.runtimeId, runtime)
  try {
    await manager.command(runtime.runtimeId, { type: 'get_state' })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(runtime.stop).not.toHaveBeenCalled()
    expect(manager.list()).toHaveLength(1)
  } finally { await manager.stopAll(); vi.useRealTimers() }
})

it('picks up a preference change through refreshRetention', async () => {
  vi.useFakeTimers()
  const retention = { idleMs: 0, warmCount: 0 }
  const manager = new AgentRpcManager(null, async (cwd) => cwd, async (path) => path, undefined, OMP_RPC_ADAPTER, undefined, () => retention)
  const runtime = {
    runtimeId: 'idle-live',
    snapshot: () => ({ runtimeId: 'idle-live', harness: 'omp', cwd: '/project', isStreaming: false }),
    command: vi.fn(async () => ({ type: 'response', success: true })),
    canRetireSafely: () => true,
    stop: vi.fn(async () => true),
  }
  ;(manager as unknown as { runtimes: Map<string, unknown> }).runtimes.set(runtime.runtimeId, runtime)
  try {
    await manager.command(runtime.runtimeId, { type: 'get_state' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(runtime.stop).not.toHaveBeenCalled()
    retention.idleMs = 100
    manager.refreshRetention()
    await vi.advanceTimersByTimeAsync(101)
    expect(runtime.stop).toHaveBeenCalledOnce()
  } finally { await manager.stopAll(); vi.useRealTimers() }
})
