import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRpcManager, OMP_RPC_ADAPTER } from '../../electron/main/agent-rpc'
import { validateRpcCommand } from '../../electron/main/agent-rpc/command-schema'

// Session 設定六件組的端到端行為:schema 開放 set_interrupt_mode / set_cache_warming,
// runtime 從 get_state 讀初值、set_* 成功後回讀快照並採用回聲(autoRetry /
// cacheWarming 在 18.13 的 get_state 缺席)。真相一律在 RPC 側。
const dirs: string[] = []
const managers: AgentRpcManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const validate = (command: unknown) => validateRpcCommand(command, async (path) => path)

describe('session settings command schema', () => {
  it('validates the interrupt mode toggle', async () => {
    await expect(validate({ type: 'set_interrupt_mode', mode: 'immediate' })).resolves.toEqual({ type: 'set_interrupt_mode', mode: 'immediate' })
    await expect(validate({ type: 'set_interrupt_mode', mode: 'wait' })).resolves.toEqual({ type: 'set_interrupt_mode', mode: 'wait' })
    await expect(validate({ type: 'set_interrupt_mode', mode: 'polite' })).rejects.toThrow('Invalid interrupt mode')
    // 未知鍵訊息沿用 rejectUnknownKeys 慣例:'command.<key> is not supported'。
    await expect(validate({ type: 'set_interrupt_mode', mode: 'wait', extra: 1 })).rejects.toThrow('command.extra is not supported')
  })

  it('validates the cache warming override modes', async () => {
    await expect(validate({ type: 'set_cache_warming', mode: 'off' })).resolves.toEqual({ type: 'set_cache_warming', mode: 'off' })
    await expect(validate({ type: 'set_cache_warming', mode: 'streaming' })).resolves.toEqual({ type: 'set_cache_warming', mode: 'streaming' })
    await expect(validate({ type: 'set_cache_warming', mode: 'idle' })).resolves.toEqual({ type: 'set_cache_warming', mode: 'idle' })
    await expect(validate({ type: 'set_cache_warming', mode: 'warm' })).rejects.toThrow('Invalid cache warming mode')
  })
})

describe('session settings runtime plumbing', () => {
  it('reads initial values from get_state, refreshes after set_*, and adopts echoes get_state omits', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-session-settings-'))
    dirs.push(cwd)
    const executable = join(cwd, 'settings-agent.cjs')
    // 模仿 OMP 18.13:get_state 回報 steering/followUp/interrupt/autoCompaction,
    // 不回報 autoRetry 與 cacheWarming;set_cache_warming 回傳生效 mode,
    // set_auto_retry 只回 success。
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const state = { sessionId: 'settings-probe', isStreaming: false, isCompacting: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', interruptMode: 'immediate', autoCompactionEnabled: true }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'negotiate_protocol') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { protocolVersion: 2 } })
  } else if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { ...state } })
  } else if (command.type === 'get_tree') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { leafId: 'a'.repeat(64), tree: {} } })
  } else if (command.type === 'set_steering_mode' || command.type === 'set_follow_up_mode') {
    state[command.type === 'set_steering_mode' ? 'steeringMode' : 'followUpMode'] = command.mode
    send({ id: command.id, type: 'response', command: command.type, success: true })
  } else if (command.type === 'set_interrupt_mode') {
    state.interruptMode = command.mode
    send({ id: command.id, type: 'response', command: command.type, success: true })
  } else if (command.type === 'set_auto_compaction') {
    state.autoCompactionEnabled = command.enabled
    send({ id: command.id, type: 'response', command: command.type, success: true })
  } else if (command.type === 'set_auto_retry') {
    send({ id: command.id, type: 'response', command: command.type, success: true })
  } else if (command.type === 'set_cache_warming') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { mode: command.mode } })
  }
})
`)
    chmodSync(executable, 0o755)
    const manager = new AgentRpcManager(executable, async (dir) => dir, async (path) => path, undefined, OMP_RPC_ADAPTER)
    managers.push(manager)
    const runtimeStates: Array<Record<string, unknown>> = []
    manager.setEventSink((envelope) => {
      const event = envelope.event as Record<string, unknown>
      if (event.type === 'runtime_state') runtimeStates.push((event.state as Record<string, unknown>).sessionSettings as Record<string, unknown>)
    })
    const runtime = await manager.start({ cwd })
    try {
      // 初值:get_state 回報的四項;18.13 不回報 autoRetry / cacheWarming → 保持未知。
      expect(runtime.sessionSettings).toEqual({
        autoCompaction: true,
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        interruptMode: 'immediate',
      })

      // set_steering_mode:後續 get_state 回讀,快照帶新值。
      await manager.command(runtime.runtimeId, { type: 'set_steering_mode', mode: 'all' })
      expect(runtimeStates.at(-1)).toMatchObject({ steeringMode: 'all', followUpMode: 'one-at-a-time' })

      // set_interrupt_mode:立即生效且可回讀(TUI 讀 get_state 看到同值)。
      await manager.command(runtime.runtimeId, { type: 'set_interrupt_mode', mode: 'wait' })
      expect(runtimeStates.at(-1)).toMatchObject({ interruptMode: 'wait' })

      // set_auto_compaction:關閉後快照回報 false。
      await manager.command(runtime.runtimeId, { type: 'set_auto_compaction', enabled: false })
      expect(runtimeStates.at(-1)).toMatchObject({ autoCompaction: false })

      // set_auto_retry:get_state 不回報,採用成功命令的回聲;先前值不被清掉。
      await manager.command(runtime.runtimeId, { type: 'set_auto_retry', enabled: false })
      expect(runtimeStates.at(-1)).toMatchObject({ autoRetry: false, steeringMode: 'all', autoCompaction: false })

      // set_cache_warming:回應 data.mode 是生效的 session-only 覆寫。
      await manager.command(runtime.runtimeId, { type: 'set_cache_warming', mode: 'idle' })
      expect(runtimeStates.at(-1)).toMatchObject({ cacheWarming: 'idle', autoRetry: false })
    } finally {
      await manager.stop(runtime.runtimeId)
    }
  })

  it('keeps the echo-derived values across later get_state snapshots', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-session-settings-echo-'))
    dirs.push(cwd)
    const executable = join(cwd, 'echo-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'negotiate_protocol') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { protocolVersion: 2 } })
  } else if (command.type === 'get_state') {
    // 權威快照只回報四項——autoRetry/cacheWarming 缺席不得清掉已知回聲值。
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { sessionId: 'echo-probe', isStreaming: false, isCompacting: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', interruptMode: 'immediate', autoCompactionEnabled: true } })
  } else if (command.type === 'get_tree') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { leafId: 'a'.repeat(64), tree: {} } })
  } else if (command.type === 'set_auto_retry') {
    send({ id: command.id, type: 'response', command: command.type, success: true })
  }
})
`)
    chmodSync(executable, 0o755)
    const manager = new AgentRpcManager(executable, async (dir) => dir, async (path) => path, undefined, OMP_RPC_ADAPTER)
    managers.push(manager)
    const runtimeStates: Array<Record<string, unknown>> = []
    manager.setEventSink((envelope) => {
      const event = envelope.event as Record<string, unknown>
      if (event.type === 'runtime_state') runtimeStates.push((event.state as Record<string, unknown>).sessionSettings as Record<string, unknown>)
    })
    const runtime = await manager.start({ cwd })
    try {
      await manager.command(runtime.runtimeId, { type: 'set_auto_retry', enabled: true })
      const refreshed = await manager.refreshState(runtime.runtimeId)
      expect(refreshed.sessionSettings).toMatchObject({ autoRetry: true })
      expect(runtimeStates.at(-1)).toMatchObject({ autoRetry: true, steeringMode: 'one-at-a-time' })
    } finally {
      await manager.stop(runtime.runtimeId)
    }
  })
})

// 編譯防呆:OMP adapter 存在即代表 RuntimeInfo.sessionSettings 型別鏈完整。
it('uses the OMP adapter for the session settings runtime', () => {
  expect(OMP_RPC_ADAPTER.id).toBe('omp')
})
