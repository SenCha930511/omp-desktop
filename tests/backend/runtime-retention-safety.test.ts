import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRpcManager, OMP_RPC_ADAPTER } from '../../electron/main/agent-rpc'
import { FramedRpcTransport } from '../../electron/main/agent-rpc/transport'
import { RepositoryUseError, RepositoryUseGate } from '../../electron/main/repository-use-gate'
import type { PrimeEventEnvelope } from '../../src/types/api'

/**
 * Safe-retirement regression coverage: every automatic runtime reclamation
 * path (idle timeout, stale capability environment, workspace checkout, and
 * new-runtime pressure) must honor OMP's authoritative settlement state
 * (get_state isSettled/hasPendingAsyncWork, the session_settled frame) and
 * every extension dialog that is still waiting for a user answer.
 *
 * The tests drive the public AgentRpcManager against a fake OMP RPC child,
 * following the fake-agent patterns in tests/backend/agent-rpc.test.ts.
 * Child IO is awaited through event promises; the retirement clocks run on
 * fake timers so no test sleeps in real time.
 */

const dirs: string[] = []
const managers: AgentRpcManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** get_state data for a session OMP reports as fully settled. */
const SETTLED_STATE = "{ sessionId: 'settled-session', isStreaming: false, isCompacting: false, isSettled: true, hasPendingAsyncWork: false }"

interface RetentionFakeOptions {
  /** JS source of the get_state data object; `stateCalls` counts get_state requests. */
  stateData: string
  /** JS source of frames to write when the child boots (before the handshake). */
  emitOnBoot?: string
  /** JS source of frames to write 120ms after boot, with no command in flight. */
  emitOnBootDelayed?: string
  /** JS source of frames to write after answering set_session_name; branch on command.name. */
  emitOnRename?: string
  /** When true, get_state beyond the handshake never answers. */
  stallStateAfterHandshake?: boolean
  /** When true, get_state beyond the handshake stalls until 'release-state', answering newest first. */
  stallStateUntilRelease?: boolean
}

function retentionFakeAgent(options: RetentionFakeOptions): { cwd: string; executable: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-retention-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-omp.cjs')
  const stallNever = options.stallStateAfterHandshake === true
  const stallRelease = options.stallStateUntilRelease === true
  writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let stateCalls = 0
const stalled = []
${options.emitOnBoot ?? ''}
${options.emitOnBootDelayed === undefined ? '' : `setTimeout(() => { ${options.emitOnBootDelayed} }, 120)`}
const input = readline.createInterface({ input: process.stdin })
input.on('close', () => process.exit(0))
input.on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'negotiate_protocol') {
    send({ id: command.id, type: 'response', command: 'negotiate_protocol', success: true, data: { protocolVersion: command.protocolVersion } })
  } else if (command.type === 'get_state') {
    stateCalls += 1
    const data = ${options.stateData}
    if (${stallNever} && stateCalls > 1) return
    if (${stallRelease} && stateCalls > 1) {
      stalled.push({ id: command.id, data })
      send({ type: 'fake_state_stalled', call: stateCalls })
      return
    }
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 1000, contextWindow: 200000, percent: 1 } } })
  } else if (command.type === 'extension_ui_response') {
    // Fire-and-forget on the real wire: no response frame.
  } else {
    if (command.type === 'set_session_name') {
      if (command.name === 'release-state') {
        while (stalled.length) {
          const pending = stalled.pop()
          send({ id: pending.id, type: 'response', command: 'get_state', success: true, data: pending.data })
        }
      }
      ${options.emitOnRename ?? ''}
    }
    send({ id: command.id, type: 'response', command: command.type, success: true })
  }
})
`)
  chmodSync(executable, 0o755)
  return { cwd, executable }
}

/** A dialog request frame for one of the methods that await a user answer. */
function dialogScript(id: string, method: string): string {
  const payloads: Record<string, string> = {
    select: `{ type: 'extension_ui_request', id: ${JSON.stringify(id)}, method: 'select', title: 'Pick one', options: ['Red', 'Blue'] }`,
    confirm: `{ type: 'extension_ui_request', id: ${JSON.stringify(id)}, method: 'confirm', title: 'Continue?', message: 'Proceed with the deploy?' }`,
    input: `{ type: 'extension_ui_request', id: ${JSON.stringify(id)}, method: 'input', title: 'Project name' }`,
    editor: `{ type: 'extension_ui_request', id: ${JSON.stringify(id)}, method: 'editor', title: 'Edit the plan', prefill: 'step one' }`,
    ask: `{ type: 'extension_ui_request', id: ${JSON.stringify(id)}, method: 'ask', questions: [{ id: 'q1', prompt: 'Name?', kind: 'text' }] }`,
  }
  return `send(${payloads[method]})`
}

/** OMP settled the dialog itself and told the host to close it. */
function cancelScript(targetId: string): string {
  return `send({ type: 'extension_ui_request', id: 'cancel-frame', method: 'cancel', targetId: ${JSON.stringify(targetId)} })`
}

type EventPredicate = (event: Record<string, unknown>) => boolean

/** Records manager envelopes and resolves waits from the sink callback itself, with no polling timers. */
class EventLog {
  private readonly envelopes: PrimeEventEnvelope[] = []
  private readonly waiters: Array<{ predicate: EventPredicate; resolve: () => void }> = []

  push(envelope: PrimeEventEnvelope): void {
    this.envelopes.push(envelope)
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.predicate(envelope.event as Record<string, unknown>)) waiter.resolve()
      else this.waiters.push(waiter)
    }
  }

  wait(predicate: EventPredicate): Promise<void> {
    if (this.envelopes.some((envelope) => predicate(envelope.event as Record<string, unknown>))) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    this.waiters.push({ predicate, resolve })
    return promise
  }
}

const dialogEvent = (id: string): EventPredicate => (event) => event.type === 'extension_ui_request' && event.id === id
const cancelEvent = (targetId: string): EventPredicate => (event) => event.type === 'extension_ui_request' && event.method === 'cancel' && event.targetId === targetId
const eventType = (type: string): EventPredicate => (event) => event.type === type

function retentionManager(executable: string, retention: { idleMs?: number; warmCount?: number } = {}): AgentRpcManager {
  const manager = new AgentRpcManager(executable, async (cwd) => cwd, async (path) => path, undefined, OMP_RPC_ADAPTER, undefined, retention)
  managers.push(manager)
  return manager
}

function recordEvents(manager: AgentRpcManager): EventLog {
  const log = new EventLog()
  manager.setEventSink((envelope) => log.push(envelope))
  return log
}

/** Deterministic probe of the workspace-checkout retirement path. */
async function checkoutProbe(manager: AgentRpcManager, gate: RepositoryUseGate, cwd: string): Promise<'retired' | 'blocked'> {
  try {
    await gate.runBranchCheckout(cwd, async () => 'checked-out')
  } catch (error) {
    if (error instanceof RepositoryUseError) return 'blocked'
    throw error
  }
  expect(manager.list()).toEqual([])
  return 'retired'
}

interface GatedRuntime {
  manager: AgentRpcManager
  gate: RepositoryUseGate
  cwd: string
  runtime: { runtimeId: string }
  log: EventLog
}

async function gatedRuntime(options: RetentionFakeOptions): Promise<GatedRuntime> {
  const fake = retentionFakeAgent(options)
  const manager = retentionManager(fake.executable)
  const gate = new RepositoryUseGate()
  manager.setWorkspaceUseProvider((cwd, owner, retireIfIdle) => gate.beginWorkspaceUse(cwd, owner, retireIfIdle))
  const log = recordEvents(manager)
  const runtime = await manager.start({ cwd: fake.cwd })
  return { manager, gate, cwd: fake.cwd, runtime, log }
}

describe('runtime retention safety', () => {
  it.each(['select', 'confirm', 'input', 'editor', 'ask'] as const)('keeps a runtime with a pending %s dialog from being reclaimed', async (method) => {
    const { manager, gate, cwd, runtime, log } = await gatedRuntime({ stateData: SETTLED_STATE, emitOnRename: dialogScript('ui-dialog', method) })
    await manager.command(runtime.runtimeId, { type: 'set_session_name', name: 'open dialog' })
    await log.wait(dialogEvent('ui-dialog'))
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('blocked')

    await manager.command(runtime.runtimeId, { type: 'extension_ui_response', id: 'ui-dialog', cancelled: true })
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('retired')
  }, 10_000)

  it('clears only the dialog that the upstream cancel frame targets', async () => {
    const { manager, gate, cwd, runtime, log } = await gatedRuntime({
      stateData: SETTLED_STATE,
      emitOnRename: `
        if (command.name === 'open') {
          ${dialogScript('dialog-a', 'select')}
          ${dialogScript('dialog-b', 'confirm')}
        } else if (command.name === 'cancel-a') {
          ${cancelScript('dialog-a')}
        } else if (command.name === 'cancel-b') {
          ${cancelScript('dialog-b')}
        }
      `,
    })
    await manager.command(runtime.runtimeId, { type: 'set_session_name', name: 'open' })
    await log.wait(dialogEvent('dialog-a'))
    await log.wait(dialogEvent('dialog-b'))
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('blocked')

    await manager.command(runtime.runtimeId, { type: 'set_session_name', name: 'cancel-a' })
    await log.wait(cancelEvent('dialog-a'))
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('blocked')

    await manager.command(runtime.runtimeId, { type: 'set_session_name', name: 'cancel-b' })
    await log.wait(cancelEvent('dialog-b'))
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('retired')
  }, 10_000)

  it('keeps a dialog pending until the extension_ui_response write succeeds', async () => {
    const { manager, gate, cwd, runtime, log } = await gatedRuntime({ stateData: SETTLED_STATE, emitOnRename: dialogScript('ui-dialog', 'select') })
    await manager.command(runtime.runtimeId, { type: 'set_session_name', name: 'open dialog' })
    await log.wait(dialogEvent('ui-dialog'))

    const realEnqueue = FramedRpcTransport.prototype.enqueue
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const enqueue = vi.spyOn(FramedRpcTransport.prototype, 'enqueue').mockImplementation(function (this: FramedRpcTransport, line: string) {
      if (line.includes('"extension_ui_response"')) {
        return { done: Promise.reject(new Error('simulated stdin write failure')), cancel: () => 'cancelled' as const }
      }
      return realEnqueue.call(this, line)
    })
    try {
      await expect(manager.command(runtime.runtimeId, { type: 'extension_ui_response', id: 'ui-dialog', cancelled: true })).rejects.toThrow('simulated stdin write failure')
      await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('blocked')
    } finally {
      enqueue.mockRestore()
      errorLog.mockRestore()
    }

    await manager.command(runtime.runtimeId, { type: 'extension_ui_response', id: 'ui-dialog', cancelled: true })
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('retired')
  }, 10_000)

  it('treats settlement as unknown until OMP reports it authoritatively', async () => {
    const { manager, gate, cwd } = await gatedRuntime({ stateData: "{ sessionId: 'legacy-session', isStreaming: false, isCompacting: false }" })
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('blocked')
  }, 10_000)

  it('requires both authoritative settlement fields before reclaiming', async () => {
    const { manager, gate, cwd } = await gatedRuntime({ stateData: "{ sessionId: 'partial-session', isStreaming: false, isCompacting: false, isSettled: true }" })
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('blocked')
  }, 10_000)

  it('blocks reclamation while OMP reports the session unsettled', async () => {
    const { manager, gate, cwd } = await gatedRuntime({ stateData: "{ sessionId: 'unsettled-session', isStreaming: false, isCompacting: false, isSettled: false, hasPendingAsyncWork: false }" })
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('blocked')
  }, 10_000)

  it('blocks reclamation while OMP reports pending background work', async () => {
    const { manager, gate, cwd } = await gatedRuntime({ stateData: "{ sessionId: 'background-session', isStreaming: false, isCompacting: false, isSettled: true, hasPendingAsyncWork: true }" })
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('blocked')
  }, 10_000)

  it('allows reclamation once a later get_state reports the session settled', async () => {
    const { manager, gate, cwd, runtime } = await gatedRuntime({
      stateData: "{ sessionId: 'late-settled', isStreaming: false, isCompacting: false, isSettled: stateCalls > 1, hasPendingAsyncWork: false }",
    })
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('blocked')
    await manager.command(runtime.runtimeId, { type: 'get_state' })
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('retired')
  }, 10_000)

  it('marks the session settled on the upstream session_settled event', async () => {
    const { manager, gate, cwd, runtime, log } = await gatedRuntime({
      stateData: "{ sessionId: 'settled-by-event', isStreaming: false, isCompacting: false, isSettled: false, hasPendingAsyncWork: false }",
      emitOnRename: `if (command.name === 'settle') send({ type: 'session_settled' })`,
    })
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('blocked')
    await manager.command(runtime.runtimeId, { type: 'set_session_name', name: 'settle' })
    await log.wait(eventType('session_settled'))
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('retired')
  }, 10_000)

  it('does not treat agent_end as settled while background work may re-wake the session', async () => {
    const { manager, gate, cwd, runtime, log } = await gatedRuntime({
      stateData: SETTLED_STATE,
      emitOnRename: `
        if (command.name === 'run') {
          send({ type: 'agent_start' })
          send({ type: 'agent_end' })
        } else if (command.name === 'settle') {
          send({ type: 'session_settled' })
        }
      `,
    })
    await manager.command(runtime.runtimeId, { type: 'set_session_name', name: 'run' })
    await log.wait(eventType('agent_end'))
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('blocked')

    await manager.command(runtime.runtimeId, { type: 'set_session_name', name: 'settle' })
    await log.wait(eventType('session_settled'))
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('retired')
  }, 10_000)

  it('marks work unsettled the moment a prompt is admitted', async () => {
    const { manager, gate, cwd, runtime, log } = await gatedRuntime({
      stateData: SETTLED_STATE,
      stallStateAfterHandshake: true,
      emitOnRename: `if (command.name === 'settle') send({ type: 'session_settled' })`,
    })
    // The post-prompt get_state never answers, so only the admission itself
    // can keep the runtime from looking safely idle before agent_start.
    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'begin work' })
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('blocked')

    await manager.command(runtime.runtimeId, { type: 'set_session_name', name: 'settle' })
    await log.wait(eventType('session_settled'))
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('retired')
  }, 10_000)

  it('ignores a stale settled get_state response that predates admitted work', async () => {
    const { manager, gate, cwd, runtime, log } = await gatedRuntime({
      stateData: "{ sessionId: 'stale-response', isStreaming: false, isCompacting: false, isSettled: stateCalls !== 3, hasPendingAsyncWork: false }",
      stallStateUntilRelease: true,
    })
    // A get_state issued before the prompt stalls; the prompt's own follow-up
    // get_state stalls behind it. Releasing answers newest first, so the stale
    // pre-prompt response (settled) arrives last and must not resurrect safety.
    const stateQuery = manager.command(runtime.runtimeId, { type: 'get_state' })
    await log.wait((event) => event.type === 'fake_state_stalled' && event.call === 2)
    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'begin work' })
    await log.wait((event) => event.type === 'fake_state_stalled' && event.call === 3)
    await manager.command(runtime.runtimeId, { type: 'set_session_name', name: 'release-state' })
    await stateQuery
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('blocked')
  }, 10_000)

  it('keeps query and configuration commands from marking the session busy', async () => {
    const { manager, gate, cwd, runtime } = await gatedRuntime({ stateData: SETTLED_STATE })
    await manager.command(runtime.runtimeId, { type: 'get_state' })
    await manager.command(runtime.runtimeId, { type: 'get_session_stats' })
    await manager.command(runtime.runtimeId, { type: 'set_session_name', name: 'renamed' })
    await expect(checkoutProbe(manager, gate, cwd)).resolves.toBe('retired')
  }, 10_000)

  it('keeps the idle-timeout retirement path from reclaiming a runtime with a pending dialog', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const fake = retentionFakeAgent({ stateData: SETTLED_STATE, emitOnBoot: dialogScript('ui-idle', 'select') })
      const manager = retentionManager(fake.executable, { idleMs: 100, warmCount: 0 })
      const log = recordEvents(manager)
      const runtime = await manager.start({ cwd: fake.cwd })
      await log.wait(dialogEvent('ui-idle'))
      // Drive the idle clock far past the deadline: the pending dialog must keep the child alive.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(manager.list().map((info) => info.runtimeId)).toEqual([runtime.runtimeId])

      await manager.command(runtime.runtimeId, { type: 'extension_ui_response', id: 'ui-idle', cancelled: true })
      await vi.advanceTimersByTimeAsync(200)
      await log.wait(eventType('runtime_exit'))
      expect(manager.list()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  }, 10_000)

  it('resumes idle-timeout reclamation after a delayed session_settled event', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const fake = retentionFakeAgent({
        stateData: "{ sessionId: 'delayed-settled', isStreaming: false, isCompacting: false, isSettled: false, hasPendingAsyncWork: false }",
        emitOnBootDelayed: `send({ type: 'session_settled' })`,
      })
      const manager = retentionManager(fake.executable, { idleMs: 100, warmCount: 0 })
      const log = recordEvents(manager)
      await manager.start({ cwd: fake.cwd })
      await log.wait(eventType('session_settled'))
      await vi.advanceTimersByTimeAsync(300)
      await log.wait(eventType('runtime_exit'))
      expect(manager.list()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  }, 10_000)

  it('keeps the stale-environment retirement path from reclaiming a runtime with a pending dialog', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const fake = retentionFakeAgent({ stateData: SETTLED_STATE, emitOnRename: dialogScript('ui-stale', 'confirm') })
      const manager = retentionManager(fake.executable)
      const log = recordEvents(manager)
      const runtime = await manager.start({ cwd: fake.cwd })
      await manager.command(runtime.runtimeId, { type: 'set_session_name', name: 'open dialog' })
      await log.wait(dialogEvent('ui-stale'))

      void manager.requestRuntimeEnvironmentRefresh()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(manager.list().map((info) => info.runtimeId)).toEqual([runtime.runtimeId])

      await manager.command(runtime.runtimeId, { type: 'extension_ui_response', id: 'ui-stale', cancelled: true })
      await vi.advanceTimersByTimeAsync(400)
      await log.wait(eventType('runtime_exit'))
      expect(manager.list()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  }, 10_000)

  it('keeps new-runtime pressure from reclaiming a runtime with a pending dialog', async () => {
    const fake = retentionFakeAgent({
      stateData: SETTLED_STATE,
      emitOnBoot: `if (require('node:fs').existsSync(require('node:path').join(process.cwd(), 'open-dialog'))) {
        ${dialogScript('ui-pressure', 'select')}
      }`,
    })
    writeFileSync(join(fake.cwd, 'open-dialog'), '')
    const quietCwd = mkdtempSync(join(tmpdir(), 'omp-desktop-retention-'))
    dirs.push(quietCwd)
    const manager = retentionManager(fake.executable)
    const log = recordEvents(manager)
    const blocked = await manager.start({ cwd: fake.cwd })
    await log.wait(dialogEvent('ui-pressure'))

    const kept = await manager.start({ cwd: quietCwd })
    let ids = manager.list().map((info) => info.runtimeId)
    expect(ids).toHaveLength(2)
    expect(ids).toContain(blocked.runtimeId)
    expect(ids).toContain(kept.runtimeId)

    await manager.command(blocked.runtimeId, { type: 'extension_ui_response', id: 'ui-pressure', cancelled: true })
    const replacement = await manager.start({ cwd: quietCwd })
    ids = manager.list().map((info) => info.runtimeId)
    expect(ids).toHaveLength(2)
    expect(ids).toContain(kept.runtimeId)
    expect(ids).toContain(replacement.runtimeId)
    expect(ids).not.toContain(blocked.runtimeId)
  }, 10_000)

  it('keeps the manual fork guard on the plain idle predicate', async () => {
    const fake = retentionFakeAgent({
      stateData: `{ sessionId: 'fork-session', isStreaming: false, isCompacting: false, isSettled: true, hasPendingAsyncWork: false, sessionFile: require('node:path').join(process.cwd(), 'session.jsonl') }`,
      emitOnRename: dialogScript('ui-fork', 'select'),
    })
    const source = join(fake.cwd, 'session.jsonl')
    const manager = retentionManager(fake.executable)
    const log = recordEvents(manager)
    const runtime = await manager.start({ cwd: fake.cwd, sessionPath: source })
    await manager.command(runtime.runtimeId, { type: 'set_session_name', name: 'open dialog' })
    await log.wait(dialogEvent('ui-fork'))

    // A pending dialog must block automatic reclamation, not the manual
    // mutation guard: forkForSession may still pass the idle check. The fake
    // never confirms a forked path, so the flow ends at path confirmation.
    await expect(manager.forkForSession(source, fake.cwd)).rejects.toThrow(/did not confirm/i)
  }, 10_000)
})
