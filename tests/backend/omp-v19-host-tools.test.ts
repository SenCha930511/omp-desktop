import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRpcManager, OMP_RPC_ADAPTER } from '../../electron/main/agent-rpc'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
const managers: AgentRpcManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface FakeOmpOptions {
  /** JavaScript statements the fake runs right after acknowledging set_host_tools. */
  onSetHostTools?: string
  /** JavaScript statements the fake runs after recording an inbound host_*_result frame. */
  onHostReply?: string
}

interface HostReply {
  type: string
  id: string
  isError?: boolean
  result: { content: Array<{ type: string; text: string }> }
}

function fakeOmpAgent(options: FakeOmpOptions = {}): { cwd: string; executable: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-host-tools-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-omp.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') { process.stdout.write('omp/1.2.3\\n'); process.exit(0) }
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let negotiated = false
send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line)
  if (frame.type === 'negotiate_protocol') {
    negotiated = true
    send({ id: frame.id, type: 'response', command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } })
    return
  }
  if (frame.type === 'host_tool_result' || frame.type === 'host_uri_result') {
    send({ type: 'host_reply_seen', reply: frame })
    ${options.onHostReply ?? ''}
    return
  }
  if (!negotiated) return
  if (frame.type === 'get_state') {
    send({ id: frame.id, type: 'response', command: 'get_state', success: true, data: {
      sessionId: 'omp-session', isStreaming: false, isCompacting: false, thinkingLevel: 'medium',
    } })
    return
  }
  if (frame.type === 'get_session_stats') {
    send({ id: frame.id, type: 'response', command: 'get_session_stats', success: true, data: {
      contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 },
    } })
    return
  }
  if (frame.type === 'set_host_tools') {
    send({ id: frame.id, type: 'response', command: 'set_host_tools', success: true, data: { toolNames: ['echo_host'] } })
    ${options.onSetHostTools ?? ''}
    return
  }
  if (frame.type === 'set_subagent_subscription' || frame.type === 'set_ask_dialog') {
    send({ id: frame.id, type: 'response', command: frame.type, success: true })
  }
})
`)
  chmodSync(executable, 0o755)
  return { cwd, executable }
}

function hostManager(executable: string): { manager: AgentRpcManager; events: Array<Record<string, unknown>> } {
  const manager = new AgentRpcManager(executable, async (cwd) => cwd, async (path) => path, undefined, OMP_RPC_ADAPTER)
  managers.push(manager)
  const events: Array<Record<string, unknown>> = []
  manager.setEventSink(({ event }) => events.push(event))
  return { manager, events }
}

function hostReplies(events: Array<Record<string, unknown>>): HostReply[] {
  return events
    .filter((event) => event.type === 'host_reply_seen')
    .map((event) => event.reply as HostReply)
}

const echoTool = {
  name: 'echo_host',
  description: 'Echo a message',
  parameters: { type: 'object', properties: { message: { type: 'string' } } },
}

const echoHandler = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => ({
  content: [{ type: 'text', text: `echo:${String(args.message)}` }],
})

describe('OMP v19 host tool execution', () => {
  it('runs a registered host tool and answers with host_tool_result', async () => {
    const fake = fakeOmpAgent({
      onSetHostTools: `send({ type: 'host_tool_call', id: 'host-1', toolCallId: 'tc-1', toolName: 'echo_host', arguments: { message: 'hello' } })`,
      onHostReply: `if (frame.id === 'host-1') send({ type: 'host_tool_call', id: 'host-2', toolCallId: 'tc-2', toolName: 'missing_tool', arguments: {} })`,
    })
    const { manager, events } = hostManager(fake.executable)
    manager.registerHostTool('echo_host', echoHandler)

    const runtime = await manager.start({ cwd: fake.cwd })
    const response = await manager.setHostTools(runtime.runtimeId, [echoTool])
    expect(response.data).toEqual({ toolNames: ['echo_host'] })

    await waitUntil(() => hostReplies(events).length >= 2)
    const replies = hostReplies(events)
    expect(replies[0]).toEqual({
      type: 'host_tool_result',
      id: 'host-1',
      result: { content: [{ type: 'text', text: 'echo:hello' }] },
    })
    expect(replies[1]).toEqual({
      type: 'host_tool_result',
      id: 'host-2',
      isError: true,
      result: { content: [{ type: 'text', text: 'Unknown host tool: missing_tool' }] },
    })
    // Host traffic never enters the session event stream.
    expect(events.some((event) => event.type === 'host_tool_call' || event.type === 'host_tool_result')).toBe(false)
  })

  it('cancels an in-flight host tool call without answering it', async () => {
    const fake = fakeOmpAgent({
      onSetHostTools: `
      send({ type: 'host_tool_call', id: 'host-3', toolCallId: 'tc-3', toolName: 'slow_host', arguments: {} })
      setTimeout(() => {
        send({ type: 'host_tool_cancel', id: 'cancel-1', targetId: 'host-3' })
        send({ type: 'host_tool_call', id: 'host-4', toolCallId: 'tc-4', toolName: 'echo_host', arguments: { message: 'after' } })
      }, 50)`,
    })
    const { manager, events } = hostManager(fake.executable)
    let resolveSlow: (value: Record<string, unknown>) => void = () => undefined
    let slowStarted = 0
    manager.registerHostTool('slow_host', () => {
      slowStarted += 1
      return new Promise((resolve) => { resolveSlow = resolve })
    })
    manager.registerHostTool('echo_host', echoHandler)

    const runtime = await manager.start({ cwd: fake.cwd })
    await manager.setHostTools(runtime.runtimeId, [echoTool])

    await waitUntil(() => slowStarted === 1)
    // The cancel is processed before host-4, so its reply proves the abort landed.
    await waitUntil(() => hostReplies(events).some((reply) => reply.id === 'host-4'))
    resolveSlow({ content: [{ type: 'text', text: 'too late' }] })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(hostReplies(events).some((reply) => reply.id === 'host-3')).toBe(false)
  })

  it('drops a result dispatched under an older host tool registry', async () => {
    const fake = fakeOmpAgent({
      onSetHostTools: `send({ type: 'host_tool_call', id: 'host-5', toolCallId: 'tc-5', toolName: 'slow_host', arguments: {} })`,
    })
    const { manager, events } = hostManager(fake.executable)
    let resolveSlow: (value: Record<string, unknown>) => void = () => undefined
    let slowStarted = 0
    manager.registerHostTool('slow_host', () => {
      slowStarted += 1
      return new Promise((resolve) => { resolveSlow = resolve })
    })

    const runtime = await manager.start({ cwd: fake.cwd })
    await manager.setHostTools(runtime.runtimeId, [echoTool])
    await waitUntil(() => slowStarted === 1)

    // A registry change makes the dispatched call stale.
    manager.registerHostTool('slow_host', async () => ({ content: [{ type: 'text', text: 'replacement' }] }))
    resolveSlow({ content: [{ type: 'text', text: 'stale' }] })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(hostReplies(events)).toEqual([])
  })
})
