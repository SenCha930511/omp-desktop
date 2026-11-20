import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRpcManager, OMP_RPC_ADAPTER } from '../../electron/main/agent-rpc'
import { BROWSER_HOST_TOOLS, browserHostToolScope } from '../../electron/main/browser/host-tools'
import { AgentCollaborationBridge } from '../../electron/main/collaboration/agent-bridge'
import { COLLABORATION_HOST_TOOLS, COLLABORATION_HOST_WAIT_MAX_MS, collaborationHostToolScope } from '../../electron/main/collaboration/host-tools'
import { mergeHostToolScopes } from '../../electron/main/lib/host-tool-scope'
import type { SessionRecord, TranscriptMessage } from '../../src/types/api'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
const managers: AgentRpcManager[] = []
const bridges: AgentCollaborationBridge[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const source: SessionRecord = {
  id: '019f0000-0000-7000-8000-000000000001', harness: 'omp', filePath: '/sessions/source.jsonl', projectPath: '/project', title: 'Planner',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}
const target: SessionRecord = {
  id: '019f0000-0000-7000-8000-000000000002', harness: 'omp', filePath: '/sessions/target.jsonl', projectPath: '/project', title: 'API owner',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z', status: 'idle', depth: 0,
}
const transcripts: Record<string, TranscriptMessage[]> = {
  [source.filePath]: [{ id: 's1', role: 'user', parts: [{ type: 'text', text: 'Plan the release.' }] }],
  [target.filePath]: [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'The endpoint is ready.' }] }],
}

// ---- definitions and handlers -------------------------------------------

function tool(name: string) {
  const found = COLLABORATION_HOST_TOOLS.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`Tool ${name} was not defined`)
  return found
}

function parameters(name: string) {
  return tool(name).parameters as {
    type: string
    required?: string[]
    properties: Record<string, Record<string, unknown>>
  }
}

function scopedCall(answer: (method: string) => unknown = () => ({ ok: true })) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const scope = collaborationHostToolScope(async (method, params) => {
    calls.push({ method, params })
    return answer(method)
  })
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const handler = scope.handlers.get(name)
    if (!handler) throw new Error(`Handler ${name} was not registered`)
    return handler(args)
  }
  return { calls, run, scope }
}

const textOf = (result: Record<string, unknown>) => String((result.content as Array<{ text: string }>)[0].text)

describe('collaboration host tool definitions', () => {
  it('advertises the six migrated tools with the extension contracts', () => {
    expect(COLLABORATION_HOST_TOOLS.map((candidate) => candidate.name)).toEqual([
      'gooeypi_session_list',
      'gooeypi_session_models',
      'gooeypi_session_create',
      'gooeypi_session_read',
      'gooeypi_session_send',
      'gooeypi_session_wait',
    ])
    for (const candidate of COLLABORATION_HOST_TOOLS) {
      expect(candidate.label).toBeTypeOf('string')
      expect(String(candidate.label).length).toBeGreaterThan(0)
      expect(String(candidate.description).length).toBeGreaterThan(0)
      expect(parameters(String(candidate.name)).type).toBe('object')
    }
    expect(tool('gooeypi_session_list').label).toBe('List sessions')
    expect(tool('gooeypi_session_models').label).toBe('List session models')
    expect(tool('gooeypi_session_create').label).toBe('Create session')
    expect(tool('gooeypi_session_read').label).toBe('Read session')
    expect(tool('gooeypi_session_send').label).toBe('Message session')
    expect(tool('gooeypi_session_wait').label).toBe('Wait for session')
  })

  it('keeps each parameter shape from the extension', () => {
    expect(parameters('gooeypi_session_list').properties).toEqual({})
    expect(parameters('gooeypi_session_list').required).toBeUndefined()

    expect(parameters('gooeypi_session_models').required).toBeUndefined()
    expect(parameters('gooeypi_session_models').properties.query).toMatchObject({ type: 'string', maxLength: 256 })

    const create = parameters('gooeypi_session_create')
    expect(create.required).toEqual(['prompt'])
    expect(create.properties.prompt).toMatchObject({ type: 'string', minLength: 1, maxLength: 1_000_000 })
    expect(create.properties.title).toMatchObject({ type: 'string', minLength: 1, maxLength: 200 })
    expect(create.properties.model).toMatchObject({ type: 'string', minLength: 1, maxLength: 512 })
    expect(create.properties.reasoning).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 })
    expect(create.properties.fast).toMatchObject({ type: 'boolean' })

    expect(parameters('gooeypi_session_read').required).toEqual(['target_session_id'])
    expect(parameters('gooeypi_session_read').properties.target_session_id).toMatchObject({ type: 'string' })
    expect(String(parameters('gooeypi_session_read').properties.target_session_id.description)).toContain('gooeypi_session_list')

    const send = parameters('gooeypi_session_send')
    expect(send.required).toEqual(['target_session_id', 'message'])
    expect(send.properties.message).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 * 1024 })

    const wait = parameters('gooeypi_session_wait')
    expect(wait.required).toEqual(['target_session_id'])
    expect(wait.properties.after_cursor).toMatchObject({ type: 'string' })
    expect(wait.properties.timeout_ms).toMatchObject({ type: 'number', minimum: 0, maximum: COLLABORATION_HOST_WAIT_MAX_MS })
  })

  it('keeps the wait inside the manager host tool timeout', () => {
    // The manager kills any host tool call at 30 seconds; a valid wait must
    // return before that, so its advertised and handled cap stays lower.
    expect(COLLABORATION_HOST_WAIT_MAX_MS).toBeLessThan(30_000)
    expect(COLLABORATION_HOST_WAIT_MAX_MS).toBeGreaterThanOrEqual(20_000)
  })
})

describe('collaboration host tool handlers', () => {
  it('maps every tool onto its bridge method with the extension argument names', async () => {
    const { calls, run } = scopedCall()
    await run('gooeypi_session_list')
    expect(calls[0]).toEqual({ method: 'list', params: {} })
    await run('gooeypi_session_models', { query: 'sol' })
    expect(calls[1]).toEqual({ method: 'models', params: { query: 'sol' } })
    await run('gooeypi_session_create', { prompt: 'Review the model list', title: 'Model reviewer', model: 'openai-codex/gpt-5.6-sol', reasoning: 'high', fast: true })
    expect(calls[2]).toEqual({
      method: 'create',
      params: { prompt: 'Review the model list', title: 'Model reviewer', model: 'openai-codex/gpt-5.6-sol', reasoning: 'high', fast: true },
    })
    await run('gooeypi_session_read', { target_session_id: target.id })
    expect(calls[3]).toEqual({ method: 'read', params: { target_session_id: target.id } })
    await run('gooeypi_session_send', { target_session_id: target.id, message: 'Please ship it.' })
    expect(calls[4]).toEqual({ method: 'send', params: { target_session_id: target.id, message: 'Please ship it.' } })
    await run('gooeypi_session_wait', { target_session_id: target.id, after_cursor: 'cursor-1', timeout_ms: 5_000 })
    expect(calls[5]).toEqual({ method: 'wait', params: { target_session_id: target.id, after_cursor: 'cursor-1', timeout_ms: 5_000 } })
  })

  it('drops absent parameters so the bridge applies its own defaults', async () => {
    const { calls, run } = scopedCall()
    await run('gooeypi_session_models')
    await run('gooeypi_session_wait', { target_session_id: target.id })
    expect(calls[0]).toEqual({ method: 'models', params: {} })
    expect(calls[1]).toEqual({ method: 'wait', params: { target_session_id: target.id } })
  })

  it('caps a wait at the host tool budget without dropping the caller value', async () => {
    const { calls, run } = scopedCall()
    await run('gooeypi_session_wait', { target_session_id: target.id, timeout_ms: 30_000 })
    await run('gooeypi_session_wait', { target_session_id: target.id, timeout_ms: COLLABORATION_HOST_WAIT_MAX_MS })
    expect(calls[0].params.timeout_ms).toBe(COLLABORATION_HOST_WAIT_MAX_MS)
    expect(calls[1].params.timeout_ms).toBe(COLLABORATION_HOST_WAIT_MAX_MS)
  })

  it('serializes the bridge result as one JSON text block', async () => {
    const { run } = scopedCall(() => ({ delivered: true, cursor_before: 'cursor-1' }))
    const result = await run('gooeypi_session_send', { target_session_id: target.id, message: 'Please ship it.' })
    expect(result).toEqual({ content: [{ type: 'text', text: '{\n "delivered": true,\n "cursor_before": "cursor-1"\n}' }] })
  })

  it('passes a plain string result through without JSON quoting', async () => {
    const { run } = scopedCall(() => 'plain text')
    const result = await run('gooeypi_session_list')
    expect(result).toEqual({ content: [{ type: 'text', text: 'plain text' }] })
  })
})

// ---- bridge claim lookup -------------------------------------------------

async function bridgeFixture() {
  const records = [source, target]
  const sessions = {
    omp: {
      list: vi.fn(async () => records),
      read: vi.fn(async (filePath: unknown) => transcripts[String(filePath)] ?? []),
    },
  }
  const agents = {
    omp: {
      getForSession: vi.fn(() => undefined),
      start: vi.fn(),
      command: vi.fn(),
      list: vi.fn(() => []),
      stop: vi.fn(async () => true),
    },
  }
  const bridge = new AgentCollaborationBridge({
    extensionPath: '/app/extensions/omp-work-collaboration.ts',
    sessions: sessions as unknown as ConstructorParameters<typeof AgentCollaborationBridge>[0]['sessions'],
    agents: agents as unknown as ConstructorParameters<typeof AgentCollaborationBridge>[0]['agents'],
    catalogs: {
      omp: { catalog: vi.fn(async () => ({ primeVersion: 'test', refreshedAt: '2026-01-01T00:00:00.000Z', providers: [], models: [] })) },
    } as unknown as ConstructorParameters<typeof AgentCollaborationBridge>[0]['catalogs'],
  })
  await bridge.start()
  bridges.push(bridge)
  const claimFor = (sessionPath: string) => bridge.environmentFor({ cwd: '/project', sessionPath, harness: 'omp' })
  return { bridge, claimFor }
}

describe('AgentCollaborationBridge host tools', () => {
  it('resolves the claim of the calling session and runs the bridge method', async () => {
    const { bridge, claimFor } = await bridgeFixture()
    claimFor(source.filePath)
    const listed = await bridge.hostToolCall(source.filePath, 'list', {}) as Array<Record<string, unknown>>
    expect(listed).toEqual([expect.objectContaining({ id: target.id, title: 'API owner' })])
    const read = await bridge.hostToolCall(source.filePath, 'read', { target_session_id: target.id }) as Record<string, unknown>
    expect(JSON.stringify(read)).toContain('The endpoint is ready.')
  })

  it('refuses a session without a live claim instead of falling back to another claim', async () => {
    const { bridge, claimFor } = await bridgeFixture()
    claimFor(source.filePath)
    await expect(bridge.hostToolCall('/sessions/other.jsonl', 'list', {}))
      .rejects.toThrow('Session collaboration is not available for this session')
  })

  it('advertises tools once the runtime reports its session file', async () => {
    const { bridge } = await bridgeFixture()
    // A new runtime is minted before it has a session file; the manager binds
    // the file at handshake, which is when the scope becomes usable.
    const environment = bridge.environmentFor({ cwd: '/project', harness: 'omp' })
    expect(bridge.hostToolScope(source.filePath).tools).toEqual([])
    bridge.bindSession(environment.GOOEYPI_COLLABORATION_TOKEN, source.filePath, 'runtime-source')
    const scope = bridge.hostToolScope(source.filePath)
    expect(scope.tools).toBe(COLLABORATION_HOST_TOOLS)
    expect(textOf(await scope.handlers.get('gooeypi_session_list')!({}))).toContain('API owner')
  })

  it('binds scope handlers to the session they were built for', async () => {
    const { bridge, claimFor } = await bridgeFixture()
    claimFor(source.filePath)
    claimFor(target.filePath)
    const sourceScope = bridge.hostToolScope(source.filePath)
    const targetScope = bridge.hostToolScope(target.filePath)
    expect(sourceScope.tools).toBe(COLLABORATION_HOST_TOOLS)
    expect(targetScope.tools).toBe(COLLABORATION_HOST_TOOLS)

    // Each scope may only reach its own peers: the source reads the target,
    // the target reads the source, and the target cannot read itself.
    const readFromSource = await sourceScope.handlers.get('gooeypi_session_read')!({ target_session_id: target.id })
    expect(textOf(readFromSource)).toContain('The endpoint is ready.')
    const readFromTarget = await targetScope.handlers.get('gooeypi_session_read')!({ target_session_id: source.id })
    expect(textOf(readFromTarget)).toContain('Plan the release.')
    await expect(targetScope.handlers.get('gooeypi_session_read')!({ target_session_id: target.id }))
      .rejects.toThrow('not found in this working directory')
  })

  it('advertises no tools for a session without a live claim', async () => {
    const { bridge } = await bridgeFixture()
    const scope = bridge.hostToolScope(source.filePath)
    expect(scope.tools).toEqual([])
    expect(scope.handlers.size).toBe(0)
  })
})

// ---- merged capability scopes -------------------------------------------

describe('merged host tool scopes', () => {
  it('concatenates browser and collaboration tools and merges their handlers', async () => {
    const browserCalls: string[] = []
    const collaborationCalls: string[] = []
    const browser = browserHostToolScope(async (method) => { browserCalls.push(method); return { tabs: [] } })
    const collaboration = collaborationHostToolScope(async (method) => { collaborationCalls.push(method); return [] })
    const merged = mergeHostToolScopes(browser, collaboration)
    expect(merged).toBeDefined()
    expect(merged!.tools).toEqual([...BROWSER_HOST_TOOLS, ...COLLABORATION_HOST_TOOLS])
    expect([...merged!.handlers.keys()]).toEqual([...browser.handlers.keys(), ...collaboration.handlers.keys()])
    await merged!.handlers.get('browser_tabs')!({ action: 'list' })
    await merged!.handlers.get('gooeypi_session_list')!({})
    expect(browserCalls).toEqual(['tabs.list'])
    expect(collaborationCalls).toEqual(['list'])
  })

  it('returns undefined only when every scope is empty', () => {
    expect(mergeHostToolScopes(undefined, undefined)).toBeUndefined()
    expect(mergeHostToolScopes({ tools: [], handlers: new Map() }, { tools: [], handlers: new Map() })).toBeUndefined()
    const collaboration = collaborationHostToolScope(async () => ({}))
    expect(mergeHostToolScopes(undefined, collaboration)?.tools).toEqual(COLLABORATION_HOST_TOOLS)
    expect(mergeHostToolScopes({ tools: [], handlers: new Map() }, collaboration)?.handlers.size).toBe(COLLABORATION_HOST_TOOLS.length)
  })
})

// ---- manager per-runtime scopes -----------------------------------------

interface FakeOptions {
  hostCallOnSet?: boolean
  hostCallAfterMs?: number
  hostCallForSession?: string
}

function fakeOmpAgent(toolName: string, options: FakeOptions = {}): { cwd: string; executable: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-collaboration-host-tools-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-omp.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') { process.stdout.write('omp/1.2.3\\n'); process.exit(0) }
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const resumeIndex = process.argv.indexOf('--resume')
const sessionFile = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined
const sendCall = () => send({ type: 'host_tool_call', id: 'host-1', toolCallId: 'tc-1', toolName: ${JSON.stringify(toolName)}, arguments: {} })
let negotiated = false
send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })
${options.hostCallAfterMs === undefined ? '' : `if (sessionFile === ${JSON.stringify(options.hostCallForSession)}) setTimeout(sendCall, ${options.hostCallAfterMs})`}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line)
  if (frame.type === 'negotiate_protocol') {
    negotiated = true
    send({ id: frame.id, type: 'response', command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } })
    return
  }
  if (frame.type === 'host_tool_result' || frame.type === 'host_uri_result') {
    send({ type: 'host_reply_seen', reply: frame })
    return
  }
  if (!negotiated) return
  if (frame.type === 'get_state') {
    send({ id: frame.id, type: 'response', command: 'get_state', success: true, data: {
      sessionId: 'omp-session', sessionFile, isStreaming: false, isCompacting: false, thinkingLevel: 'medium',
    } })
    return
  }
  if (frame.type === 'get_session_lease') {
    send({ id: frame.id, type: 'response', command: 'get_session_lease', success: true, data: { held: [], unknown: [] } })
    return
  }
  if (frame.type === 'set_host_tools') {
    send({ type: 'set_host_tools_seen', names: frame.tools.map((entry) => entry.name) })
    send({ id: frame.id, type: 'response', command: 'set_host_tools', success: true, data: { toolNames: frame.tools.map((entry) => entry.name) } })
    ${options.hostCallOnSet === true ? 'sendCall()' : ''}
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

interface HostReply {
  type: string
  id: string
  isError?: boolean
  result: { content: Array<{ type: string; text?: string }> }
}

function hostReplies(events: Array<Record<string, unknown>>): HostReply[] {
  return events.filter((event) => event.type === 'host_reply_seen').map((event) => event.reply as HostReply)
}

function seenToolNames(events: Array<Record<string, unknown>>): string[][] {
  return events.filter((event) => event.type === 'set_host_tools_seen').map((event) => event.names as string[])
}

const collaborationToolNames = COLLABORATION_HOST_TOOLS.map((candidate) => String(candidate.name))

describe('OMP v19 per-runtime collaboration host tool scopes', () => {
  it('advertises collaboration tools to one runtime and runs its call on its own session', async () => {
    const fake = fakeOmpAgent('gooeypi_session_list', { hostCallOnSet: true })
    const { manager, events } = hostManager(fake.executable)
    const { bridge, claimFor } = await bridgeFixture()
    claimFor(source.filePath)
    manager.setHostToolScopeProvider((runtime) => runtime.sessionFile ? bridge.hostToolScope(runtime.sessionFile) : undefined)

    const runtime = await manager.start({ cwd: fake.cwd, sessionPath: source.filePath })
    expect(runtime.sessionFile).toBe(source.filePath)
    expect(seenToolNames(events)).toEqual([collaborationToolNames])

    await waitUntil(() => hostReplies(events).length >= 1)
    const reply = hostReplies(events)[0]
    expect(reply.id).toBe('host-1')
    expect(reply.isError).toBeUndefined()
    expect(String(reply.result.content[0].text)).toContain('API owner')
  })

  it('never lets a runtime without a scope use another runtime\'s handler', async () => {
    const fake = fakeOmpAgent('gooeypi_session_list', { hostCallOnSet: true, hostCallAfterMs: 300, hostCallForSession: '/sessions/other.jsonl' })
    const { manager, events } = hostManager(fake.executable)
    const { bridge, claimFor } = await bridgeFixture()
    claimFor(source.filePath)
    manager.setHostToolScopeProvider((runtime) => runtime.sessionFile ? bridge.hostToolScope(runtime.sessionFile) : undefined)

    await manager.start({ cwd: fake.cwd, sessionPath: source.filePath })
    await manager.start({ cwd: fake.cwd, sessionPath: '/sessions/other.jsonl' })
    // Only the claimed runtime was told about host tools.
    expect(seenToolNames(events)).toEqual([collaborationToolNames])

    await waitUntil(() => hostReplies(events).length >= 2)
    const replies = hostReplies(events)
    const succeeded = replies.filter((reply) => reply.isError === undefined)
    const refused = replies.filter((reply) => reply.isError === true)
    expect(succeeded).toHaveLength(1)
    expect(String(succeeded[0].result.content[0].text)).toContain('API owner')
    // The unclaimed runtime called the tool anyway and reached no handler.
    expect(refused).toHaveLength(1)
    expect(String(refused[0].result.content[0].text)).toBe('Unknown host tool: gooeypi_session_list')
  })
})
