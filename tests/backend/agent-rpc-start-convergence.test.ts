import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRpcManager } from '../../electron/main/agent-rpc'
import { DesktopOpenUrlService } from '../../electron/main/desktop-open-url'
import { canonicalSessionPath } from '../../electron/main/session-paths'
import type { RuntimeInfo } from '../../src/types/api'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
const managers: AgentRpcManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface ConvergenceAgentOptions {
  /** Authoritative session file the fake reports from get_state. */
  sessionFile: string
  sessionId?: string
}

/**
 * Fake OMP child that records every spawn and inbound frame, and holds the
 * handshake open (`get_state` unanswered) until the test creates the release
 * file. `failFile` makes the held handshake answer with a failure instead.
 */
function convergenceAgent(options: ConvergenceAgentOptions) {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-start-convergence-'))
  dirs.push(cwd)
  const executable = join(cwd, 'convergence-agent.cjs')
  const spawnLog = join(cwd, 'spawns.jsonl')
  const framesLog = join(cwd, 'frames.jsonl')
  const releaseFile = join(cwd, 'release')
  const failFile = join(cwd, 'fail')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const spawnLog = ${JSON.stringify(spawnLog)}
const framesLog = ${JSON.stringify(framesLog)}
const releaseFile = ${JSON.stringify(releaseFile)}
const failFile = ${JSON.stringify(failFile)}
const state = {
  sessionId: ${JSON.stringify(options.sessionId ?? 'session-1')},
  sessionFile: ${JSON.stringify(options.sessionFile)},
}
const exists = (path) => { try { return fs.existsSync(path) } catch { return false } }
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
fs.appendFileSync(spawnLog, JSON.stringify({ pid: process.pid, at: Date.now() }) + '\\n')
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return
  fs.appendFileSync(framesLog, line + '\\n')
  const command = JSON.parse(line)
  if (command.type === 'negotiate_protocol') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { protocolVersion: command.protocolVersion } })
    return
  }
  if (command.type === 'get_state') {
    // Hold the handshake open until the test releases it, so concurrent starts
    // provably race inside the handshake window.
    const timer = setInterval(() => {
      if (!exists(releaseFile)) return
      clearInterval(timer)
      if (exists(failFile)) {
        send({ id: command.id, type: 'response', command: command.type, success: false, error: 'state unavailable' })
        return
      }
      send({ id: command.id, type: 'response', command: command.type, success: true, data: {
        sessionId: state.sessionId,
        sessionFile: state.sessionFile,
        isStreaming: false,
        isCompacting: false,
        isSettled: true,
        hasPendingAsyncWork: false,
        thinkingLevel: 'medium',
      } })
    }, 10)
    return
  }
  if (command.type === 'set_host_tools') {
    const toolNames = Array.isArray(command.tools) ? command.tools.map((tool) => tool.name) : []
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { toolNames } })
    return
  }
  if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
    return
  }
  send({ id: command.id, type: 'response', command: command.type, success: true })
})
`)
  chmodSync(executable, 0o755)
  const readJsonl = (path: string): Record<string, unknown>[] => {
    try {
      return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    } catch {
      return []
    }
  }
  return {
    cwd,
    executable,
    failFile,
    spawns: () => readJsonl(spawnLog),
    framesOf: (type: string) => readJsonl(framesLog).filter((frame) => frame.type === type),
    release: () => writeFileSync(releaseFile, '1'),
  }
}

function managerFor(executable: string, cwd: string, hostOpenUrl?: DesktopOpenUrlService): AgentRpcManager {
  const manager = new AgentRpcManager(executable, async () => cwd, async (path) => path)
  if (hostOpenUrl) manager.setHostOpenUrlService(hostOpenUrl)
  managers.push(manager)
  return manager
}

function hostService(): DesktopOpenUrlService {
  return new DesktopOpenUrlService({
    openExternal: async () => undefined,
    writeResult: async () => undefined,
  })
}

/** Records settlement without consuming the rejection the assertions inspect. */
function track(promise: Promise<RuntimeInfo>): { promise: Promise<RuntimeInfo>; settled: () => boolean } {
  let settled = false
  promise.then(() => { settled = true }, () => { settled = true })
  return { promise, settled: () => settled }
}

function sessionFileFor(cwd: string, name = 'session.jsonl'): string {
  const file = join(cwd, name)
  writeFileSync(file, `${JSON.stringify({ type: 'session', id: name, cwd })}\n`)
  return file
}

describe('agent RPC start convergence', () => {
  it('spawns once for concurrent starts of the same session and resolves both only when ready', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-start-convergence-same-'))
    dirs.push(cwd)
    const requested = sessionFileFor(cwd, 'requested.jsonl')
    const authoritative = sessionFileFor(cwd, 'authoritative.jsonl')
    const fake = convergenceAgent({ sessionFile: authoritative })
    const manager = managerFor(fake.executable, fake.cwd)

    const first = track(manager.start({ cwd: fake.cwd, sessionPath: requested }))
    await waitUntil(() => fake.framesOf('get_state').length >= 1)
    const second = track(manager.start({ cwd: fake.cwd, sessionPath: requested }))

    // Give the second call time to pass validation and reach its launch decision.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(fake.spawns()).toHaveLength(1)
    expect(first.settled()).toBe(false)
    expect(second.settled()).toBe(false)

    fake.release()
    const [a, b] = await Promise.all([first.promise, second.promise])
    expect(fake.spawns()).toHaveLength(1)
    expect(a.runtimeId).toBe(b.runtimeId)
    expect(a.sessionFile).toBe(canonicalSessionPath(authoritative))
    expect(b.sessionFile).toBe(canonicalSessionPath(authoritative))
    expect(fake.framesOf('prompt')).toHaveLength(0)
    expect(manager.list().map((runtime) => runtime.runtimeId)).toEqual([a.runtimeId])
  }, 20_000)

  it('rejects every waiting caller when the handshake fails and lets a later start spawn cleanly', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-start-convergence-failure-'))
    dirs.push(cwd)
    const sessionPath = sessionFileFor(cwd)
    const fake = convergenceAgent({ sessionFile: sessionPath })
    writeFileSync(fake.failFile, '1')
    const manager = managerFor(fake.executable, fake.cwd)

    const first = manager.start({ cwd: fake.cwd, sessionPath })
    await waitUntil(() => fake.framesOf('get_state').length >= 1)
    const second = manager.start({ cwd: fake.cwd, sessionPath })
    fake.release()

    await expect(first).rejects.toThrow('state unavailable')
    await expect(second).rejects.toThrow('state unavailable')
    expect(manager.list()).toEqual([])

    // No automatic retry: the failed launch is gone, and a manual start may spawn
    // exactly one new child that succeeds.
    rmSync(fake.failFile, { force: true })
    const later = await manager.start({ cwd: fake.cwd, sessionPath })
    expect(later.sessionFile).toBe(canonicalSessionPath(sessionPath))
    expect(fake.spawns()).toHaveLength(2)
  }, 20_000)

  it('hands callers the authoritative session file and stops matching the requested path', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-start-convergence-identity-'))
    dirs.push(cwd)
    const requested = sessionFileFor(cwd, 'requested.jsonl')
    const authoritative = sessionFileFor(cwd, 'authoritative.jsonl')
    const fake = convergenceAgent({ sessionFile: authoritative })
    const manager = managerFor(fake.executable, fake.cwd)

    const first = manager.start({ cwd: fake.cwd, sessionPath: requested })
    await waitUntil(() => fake.framesOf('get_state').length >= 1)
    const second = manager.start({ cwd: fake.cwd, sessionPath: requested })
    fake.release()

    const [a, b] = await Promise.all([first, second])
    expect(a.sessionFile).toBe(canonicalSessionPath(authoritative))
    expect(b.sessionFile).toBe(canonicalSessionPath(authoritative))
    expect(manager.getForSession(requested)).toBeUndefined()
    expect(manager.getForSession(authoritative)?.runtimeId).toBe(a.runtimeId)

    // The requested path no longer identifies a resident runtime, so a new start
    // for it spawns instead of joining the runtime that owns another file.
    const third = await manager.start({ cwd: fake.cwd, sessionPath: requested })
    expect(third.runtimeId).not.toBe(a.runtimeId)
    expect(fake.spawns()).toHaveLength(2)
  }, 20_000)

  it('waits for a launch owned by another audience instead of spawning a second child', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-start-convergence-audience-'))
    dirs.push(cwd)
    const sessionPath = sessionFileFor(cwd)
    const fake = convergenceAgent({ sessionFile: sessionPath })
    const manager = managerFor(fake.executable, fake.cwd)

    const interactive = track(manager.start({ cwd: fake.cwd, sessionPath }))
    await waitUntil(() => fake.framesOf('get_state').length >= 1)
    const unattended = track(manager.startUnattended({ cwd: fake.cwd, sessionPath }))

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(fake.spawns()).toHaveLength(1)
    expect(unattended.settled()).toBe(false)

    fake.release()
    const [owned, scheduled] = await Promise.all([interactive.promise, unattended.promise])
    expect(fake.spawns()).toHaveLength(1)
    expect(scheduled.runtimeId).toBe(owned.runtimeId)
    expect(scheduled.sessionFile).toBe(canonicalSessionPath(sessionPath))
  }, 20_000)

  it('registers host tools for an interactive caller that deferred behind an unattended launch', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-start-convergence-host-tools-'))
    dirs.push(cwd)
    const sessionPath = sessionFileFor(cwd)
    const fake = convergenceAgent({ sessionFile: sessionPath })
    const hostOpenUrl = hostService()
    const manager = managerFor(fake.executable, fake.cwd, hostOpenUrl)

    const unattended = manager.startUnattended({ cwd: fake.cwd, sessionPath })
    await waitUntil(() => fake.framesOf('get_state').length >= 1)
    const interactive = manager.start({ cwd: fake.cwd, sessionPath }, 42)

    fake.release()
    const [scheduled, owned] = await Promise.all([unattended, interactive])
    expect(fake.spawns()).toHaveLength(1)
    expect(owned.runtimeId).toBe(scheduled.runtimeId)
    expect(fake.framesOf('set_host_tools')).toHaveLength(1)
    expect(hostOpenUrl.snapshot(owned.runtimeId, 42).registrationGeneration).toBeGreaterThan(0)
  }, 20_000)

  it('never transfers an existing interactive owner registration to another owner', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-start-convergence-host-owner-'))
    dirs.push(cwd)
    const sessionPath = sessionFileFor(cwd)
    const fake = convergenceAgent({ sessionFile: sessionPath })
    const hostOpenUrl = hostService()
    const manager = managerFor(fake.executable, fake.cwd, hostOpenUrl)

    const first = manager.start({ cwd: fake.cwd, sessionPath }, 1)
    await waitUntil(() => fake.framesOf('get_state').length >= 1)
    const second = manager.start({ cwd: fake.cwd, sessionPath }, 2)

    fake.release()
    const [owned, other] = await Promise.all([first, second])
    expect(fake.spawns()).toHaveLength(1)
    expect(other.runtimeId).toBe(owned.runtimeId)
    expect(fake.framesOf('set_host_tools')).toHaveLength(1)
    expect(hostOpenUrl.snapshot(owned.runtimeId, 1).registrationGeneration).toBeGreaterThan(0)
    expect(hostOpenUrl.snapshot(owned.runtimeId, 2).registrationGeneration).toBe(0)
  }, 20_000)

  it('repairs host tools for a new owner after the previous owner was revoked', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-start-convergence-host-revoked-'))
    dirs.push(cwd)
    const sessionPath = sessionFileFor(cwd)
    const fake = convergenceAgent({ sessionFile: sessionPath })
    const hostOpenUrl = hostService()
    const manager = managerFor(fake.executable, fake.cwd, hostOpenUrl)

    const first = manager.start({ cwd: fake.cwd, sessionPath }, 1)
    await waitUntil(() => fake.framesOf('get_state').length >= 1)
    fake.release()
    const owned = await first
    expect(fake.framesOf('set_host_tools')).toHaveLength(1)

    // Closing the owning window revokes its registration; the resident runtime
    // then has no interactive owner and must be repaired for the next window.
    await hostOpenUrl.revokeOwner(1)
    expect(hostOpenUrl.snapshot(owned.runtimeId, 1).registrationGeneration).toBe(0)

    const reused = await manager.start({ cwd: fake.cwd, sessionPath }, 2)
    expect(reused.runtimeId).toBe(owned.runtimeId)
    expect(fake.spawns()).toHaveLength(1)
    expect(fake.framesOf('set_host_tools')).toHaveLength(2)
    expect(hostOpenUrl.snapshot(owned.runtimeId, 2).registrationGeneration).toBeGreaterThan(0)
  }, 20_000)

  it('does not join a launch from a stale capability environment', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-start-convergence-revision-'))
    dirs.push(cwd)
    const sessionPath = sessionFileFor(cwd)
    const fake = convergenceAgent({ sessionFile: sessionPath })
    const manager = managerFor(fake.executable, fake.cwd)

    const prewarm = manager.start({ cwd: fake.cwd, sessionPath }, 7)
    await waitUntil(() => fake.framesOf('get_state').length >= 1)
    await manager.requestRuntimeEnvironmentRefresh()
    const prompted = manager.start({ cwd: fake.cwd, sessionPath }, 7)

    fake.release()
    const [stale, current] = await Promise.all([prewarm, prompted])
    expect(current.runtimeId).not.toBe(stale.runtimeId)
    expect(fake.spawns()).toHaveLength(2)
    expect(manager.list().map((runtime) => runtime.runtimeId)).toEqual([current.runtimeId])
  }, 20_000)
})
