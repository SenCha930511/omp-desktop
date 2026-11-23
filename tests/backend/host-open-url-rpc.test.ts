import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRpcManager } from '../../electron/main/agent-rpc'
import { DesktopOpenUrlService } from '../../electron/main/desktop-open-url'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
const managers: AgentRpcManager[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface FakeHostToolAgentOptions {
  rejectHostTools?: boolean
}

function fakeHostToolAgent(options: FakeHostToolAgentOptions = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-host-url-rpc-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-omp-host-tools.cjs')
  const framesLog = join(cwd, 'inbound-frames.jsonl')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const rejectHostTools = ${JSON.stringify(Boolean(options.rejectHostTools))}
const logPath = ${JSON.stringify(framesLog)}

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\\n')
}

send({ type: 'ready', protocolVersion: 2 })

rl.on('line', (line) => {
  if (!line.trim()) return
  fs.appendFileSync(logPath, line + '\\n')
  const msg = JSON.parse(line)
  if (msg.type === 'negotiate_protocol') {
    send({ type: 'response', id: msg.id, command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } })
    return
  }
  if (msg.type === 'get_state') {
    send({
      type: 'response',
      id: msg.id,
      command: 'get_state',
      success: true,
      data: {
        isStreaming: false,
        isCompacting: false,
        isSettled: true,
        hasPendingAsyncWork: false,
        sessionFile: ${JSON.stringify(join(cwd, 'session.jsonl'))},
        sessionId: 'sess-host-url',
      },
    })
    return
  }
  if (msg.type === 'set_host_tools') {
    if (rejectHostTools) {
      send({ type: 'response', id: msg.id, command: 'set_host_tools', success: false, error: 'Unsupported command: set_host_tools' })
      return
    }
    const toolNames = Array.isArray(msg.tools) ? msg.tools.map((tool) => tool.name) : []
    send({ type: 'response', id: msg.id, command: 'set_host_tools', success: true, data: { toolNames } })
    return
  }
  if (msg.type === 'prompt') {
    send({ type: 'response', id: msg.id, command: 'prompt', success: true, data: { agentInvoked: true } })
    if (msg.message === 'call-approve') {
      send({ type: 'host_tool_call', id: 'ht-1', toolCallId: 'tc-1', toolName: 'desktop_open_url', arguments: { url: 'https://example.test/docs' } })
    } else if (msg.message === 'call-deny') {
      send({ type: 'host_tool_call', id: 'ht-2', toolCallId: 'tc-2', toolName: 'desktop_open_url', arguments: { url: 'https://example.test/deny' } })
    } else if (msg.message === 'call-cancel') {
      send({ type: 'host_tool_call', id: 'ht-3', toolCallId: 'tc-3', toolName: 'desktop_open_url', arguments: { url: 'https://example.test/cancel' } })
      setTimeout(() => send({ type: 'host_tool_cancel', id: 'cancel-3', targetId: 'ht-3' }), 15)
    } else if (msg.message === 'call-unregistered') {
      send({ type: 'host_tool_call', id: 'ht-4', toolCallId: 'tc-4', toolName: 'desktop_open_url', arguments: { url: 'https://example.test/blocked' } })
    }
    return
  }
  if (msg.type === 'abort') {
    send({ type: 'response', id: msg.id, command: 'abort', success: true })
  }
})
`)
  chmodSync(executable, 0o755)
  const readFrames = () => {
    try {
      return readFileSync(framesLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    } catch {
      return []
    }
  }
  return { cwd, executable, readFrames }
}

function createManager(executable: string, cwd: string, openExternal: (url: string) => Promise<void>) {
  const manager = new AgentRpcManager(
    executable,
    async () => cwd,
    async (sessionPath) => sessionPath,
  )
  const hostOpenUrl = new DesktopOpenUrlService({
    openExternal,
    writeResult: (runtimeId, result) => manager.writeHostToolResult(runtimeId, result),
  })
  manager.setHostOpenUrlService(hostOpenUrl)
  managers.push(manager)
  return { manager, hostOpenUrl }
}

describe('desktop_open_url RPC manager integration', () => {
  it('registers desktop_open_url for interactive owner runtimes and handles approve, deny, cancel, and stop', async () => {
    const { cwd, executable, readFrames } = fakeHostToolAgent()
    const openExternal = vi.fn(async (_url: string) => undefined)
    const { manager, hostOpenUrl } = createManager(executable, cwd, openExternal)

    const runtime = await manager.start({ cwd }, 42)
    const setToolsFrame = readFrames().find((frame) => frame.type === 'set_host_tools')
    expect(setToolsFrame).toMatchObject({
      type: 'set_host_tools',
      tools: [expect.objectContaining({ name: 'desktop_open_url', loadMode: 'discoverable' })],
    })

    // 1. Approve flow
    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'call-approve' })
    await waitUntil(() => hostOpenUrl.snapshot(runtime.runtimeId, 42).pending !== null)
    const approveSnap = hostOpenUrl.snapshot(runtime.runtimeId, 42)
    expect(approveSnap.pending).toEqual({
      requestId: 'ht-1',
      kind: 'open-url',
      url: 'https://example.test/docs',
    })
    expect(hostOpenUrl.hasPendingOperations(runtime.runtimeId)).toBe(true)

    await expect(hostOpenUrl.respond(42, {
      runtimeId: runtime.runtimeId,
      registrationGeneration: approveSnap.registrationGeneration,
      requestId: 'ht-1',
      decision: 'approve',
    })).resolves.toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://example.test/docs')
    await waitUntil(() => readFrames().some((frame) => frame.type === 'host_tool_result' && frame.id === 'ht-1'))
    expect(readFrames().find((frame) => frame.id === 'ht-1')).toMatchObject({
      type: 'host_tool_result',
      id: 'ht-1',
      result: { content: [{ type: 'text', text: 'Opened the approved web page.' }] },
    })

    // 2. Deny flow
    openExternal.mockClear()
    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'call-deny' })
    await waitUntil(() => hostOpenUrl.snapshot(runtime.runtimeId, 42).pending?.requestId === 'ht-2')
    const denySnap = hostOpenUrl.snapshot(runtime.runtimeId, 42)
    await expect(hostOpenUrl.respond(42, {
      runtimeId: runtime.runtimeId,
      registrationGeneration: denySnap.registrationGeneration,
      requestId: 'ht-2',
      decision: 'deny',
    })).resolves.toBe(true)
    expect(openExternal).not.toHaveBeenCalled()
    await waitUntil(() => readFrames().some((frame) => frame.type === 'host_tool_result' && frame.id === 'ht-2'))
    expect(readFrames().find((frame) => frame.id === 'ht-2')).toMatchObject({
      type: 'host_tool_result',
      id: 'ht-2',
      isError: true,
    })

    // 3. Cancel flow
    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'call-cancel' })
    await waitUntil(() => readFrames().some((frame) => frame.type === 'host_tool_result' && frame.id === 'ht-3'))
    expect(readFrames().find((frame) => frame.id === 'ht-3')).toMatchObject({
      type: 'host_tool_result',
      id: 'ht-3',
      isError: true,
      result: { content: [{ type: 'text', text: 'Open URL request cancelled.' }] },
    })
    expect(hostOpenUrl.snapshot(runtime.runtimeId, 42).pending).toBeNull()

    await manager.stop(runtime.runtimeId)
    expect(hostOpenUrl.snapshot(runtime.runtimeId, 42).registrationGeneration).toBe(0)
  })

  it('never registers host tools on unattended runtimes and rejects unsolicited calls', async () => {
    const { cwd, executable, readFrames } = fakeHostToolAgent()
    const openExternal = vi.fn(async (_url: string) => undefined)
    const { manager } = createManager(executable, cwd, openExternal)

    const runtime = await manager.startUnattended({ cwd })
    expect(readFrames().some((frame) => frame.type === 'set_host_tools')).toBe(false)

    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'call-unregistered' })
    await waitUntil(() => readFrames().some((frame) => frame.type === 'host_tool_result' && frame.id === 'ht-4'))
    expect(readFrames().find((frame) => frame.id === 'ht-4')).toMatchObject({
      type: 'host_tool_result',
      id: 'ht-4',
      isError: true,
      result: { content: [{ type: 'text', text: 'Host tool unavailable.' }] },
    })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('starts cleanly when the CLI rejects set_host_tools and keeps desktop_open_url unavailable', async () => {
    const { cwd, executable, readFrames } = fakeHostToolAgent({ rejectHostTools: true })
    const openExternal = vi.fn(async (_url: string) => undefined)
    const { manager } = createManager(executable, cwd, openExternal)

    const runtime = await manager.start({ cwd }, 7)
    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'call-unregistered' })
    await waitUntil(() => readFrames().some((frame) => frame.type === 'host_tool_result' && frame.id === 'ht-4'))
    expect(readFrames().find((frame) => frame.id === 'ht-4')).toMatchObject({
      type: 'host_tool_result',
      id: 'ht-4',
      isError: true,
      result: { content: [{ type: 'text', text: 'Host tool unavailable.' }] },
    })
    expect(openExternal).not.toHaveBeenCalled()
  })
})
