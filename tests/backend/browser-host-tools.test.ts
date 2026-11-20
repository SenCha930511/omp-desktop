import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRpcManager, OMP_RPC_ADAPTER } from '../../electron/main/agent-rpc'
import { AgentBrowserBridge } from '../../electron/main/browser/agent-bridge'
import type { AgentBrowserService } from '../../electron/main/browser/agent-service'
import { BROWSER_HOST_TOOLS, browserHostToolScope } from '../../electron/main/browser/host-tools'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
const managers: AgentRpcManager[] = []
const bridges: AgentBrowserBridge[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---- definitions and handlers -------------------------------------------

function scopedCall(answer: (method: string) => unknown = () => ({ ok: true })) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const scope = browserHostToolScope(async (method, params) => {
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

const tool = (name: string) => {
  const found = BROWSER_HOST_TOOLS.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`Tool ${name} was not defined`)
  return found
}

const parameters = (name: string) => tool(name).parameters as {
  type: string
  required?: string[]
  properties: Record<string, unknown>
}

describe('browser host tool definitions', () => {
  it('advertises the nine migrated tools with the extension contracts', () => {
    expect(BROWSER_HOST_TOOLS.map((candidate) => candidate.name)).toEqual([
      'browser_tabs',
      'browser_navigate',
      'browser_screenshot',
      'browser_read_page',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_scroll',
      'browser_evaluate',
    ])
    for (const candidate of BROWSER_HOST_TOOLS) {
      expect(candidate.label).toBeTypeOf('string')
      expect(candidate.description).toBeTypeOf('string')
      expect(parameters(String(candidate.name)).type).toBe('object')
    }
    expect(parameters('browser_tabs').required).toEqual(['action'])
    expect(parameters('browser_tabs').properties.action).toEqual({ type: 'string', enum: ['list', 'open', 'close', 'select'] })
    expect(parameters('browser_tabs').properties.tab_id).toMatchObject({ type: 'string' })
    expect(parameters('browser_navigate').required).toBeUndefined()
    expect(parameters('browser_type').required).toEqual(['text'])
    expect(parameters('browser_press_key').required).toEqual(['key'])
    expect(parameters('browser_press_key').properties.modifiers).toEqual({ type: 'array', items: { type: 'string', enum: ['shift', 'control', 'alt', 'meta'] } })
    expect(parameters('browser_scroll').required).toEqual(['direction'])
    expect(parameters('browser_evaluate').required).toEqual(['code'])
    expect(parameters('browser_click').properties.ref).toMatchObject({ type: 'number' })
  })

  it('maps browser_tabs actions onto the bridge tab methods', async () => {
    const { calls, run } = scopedCall((method) => method === 'tabs.open'
      ? { tabId: 'tab-1', url: 'https://example.test/', title: 'Example' }
      : { tabs: [] })
    const listed = await run('browser_tabs', { action: 'list' })
    expect(calls[0]).toEqual({ method: 'tabs.list', params: {} })
    expect(String((listed.content as Array<{ text: string }>)[0].text)).toContain('"tabs": []')
    const opened = await run('browser_tabs', { action: 'open', url: 'https://example.test/' })
    expect(calls[1]).toEqual({ method: 'tabs.open', params: { url: 'https://example.test/' } })
    expect(String((opened.content as Array<{ text: string }>)[0].text)).toContain('Opened tab tab-1')
    await run('browser_tabs', { action: 'close', tab_id: 'tab-2' })
    expect(calls[2]).toEqual({ method: 'tabs.close', params: { tabId: 'tab-2' } })
    await run('browser_tabs', { action: 'select', tab_id: 'tab-3' })
    expect(calls[3]).toEqual({ method: 'tabs.select', params: { tabId: 'tab-3' } })
  })

  it('maps every page tool onto its bridge method and fences the result', async () => {
    const { calls, run } = scopedCall(() => ({ ok: true }))
    const read = await run('browser_read_page', { mode: 'text', tab_id: 'tab-1' })
    expect(calls[0]).toEqual({ method: 'read_page', params: { mode: 'text', tabId: 'tab-1' } })
    const text = String((read.content as Array<{ text: string }>)[0].text)
    expect(text).toContain('<untrusted-page-content>')
    expect(text).toContain('"ok": true')
    await run('browser_navigate', { url: 'https://example.test/', tab_id: 'tab-1' })
    expect(calls[1]).toEqual({ method: 'navigate', params: { url: 'https://example.test/', tabId: 'tab-1' } })
    await run('browser_click', { ref: 3, button: 'left', double: true, tab_id: 'tab-1' })
    expect(calls[2]).toEqual({ method: 'click', params: { ref: 3, button: 'left', double: true, tabId: 'tab-1' } })
    await run('browser_type', { text: 'hello', ref: 4, submit: true })
    expect(calls[3]).toEqual({ method: 'type', params: { text: 'hello', ref: 4, submit: true } })
    await run('browser_press_key', { key: 'enter', modifiers: ['shift'] })
    expect(calls[4]).toEqual({ method: 'press_key', params: { key: 'enter', modifiers: ['shift'] } })
    await run('browser_scroll', { direction: 'down', amount: 600, x: 10, y: 20 })
    expect(calls[5]).toEqual({ method: 'scroll', params: { direction: 'down', amount: 600, x: 10, y: 20 } })
    await run('browser_evaluate', { code: 'return 1', tab_id: 'tab-1' })
    expect(calls[6]).toEqual({ method: 'evaluate', params: { code: 'return 1', tabId: 'tab-1' } })
  })

  it('requires url or action for browser_navigate', async () => {
    const { calls, run } = scopedCall()
    await expect(run('browser_navigate', {})).rejects.toThrow('Provide url or action')
    expect(calls).toHaveLength(0)
  })

  it('returns screenshots as an image block plus fenced metadata', async () => {
    const { run } = scopedCall(() => ({ data: 'aGVsbG8=', mimeType: 'image/jpeg', url: 'https://example.test/', title: 'Example', width: 800, height: 600 }))
    const result = await run('browser_screenshot', { tab_id: 'tab-1' })
    const content = result.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>
    expect(content[0]).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' })
    expect(content[1].type).toBe('text')
    expect(content[1].text).toContain('<untrusted-page-content>')
    expect(content[1].text).toContain('"width": 800')
  })

  it('rejects an empty screenshot payload', async () => {
    const { run } = scopedCall(() => ({ data: '' }))
    await expect(run('browser_screenshot', {})).rejects.toThrow('The screenshot came back empty')
  })
})

// ---- bridge claim lookup -------------------------------------------------

function fakeService() {
  const calls: Array<{ method: string; sessionKey: string; params: Record<string, unknown> }> = []
  const record = (method: string, result: unknown = { method }) => async (sessionKey: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, sessionKey, params })
    return result
  }
  const service = {
    listTabs: record('tabs.list', { tabs: [] }),
    openTab: record('tabs.open', { tabId: 'tab-1', url: 'https://example.test/', title: 'Example' }),
    closeTabScoped: record('tabs.close', { tabs: [] }),
    selectTabScoped: record('tabs.select', { tabs: [] }),
    navigate: record('navigate', { url: 'https://example.test/next', title: 'Next' }),
    screenshot: record('screenshot', { data: 'aGVsbG8=', mimeType: 'image/jpeg', url: 'https://example.test/', title: 'Example', width: 800, height: 600 }),
    click: record('click', { clicked: { tag: 'button' } }),
    type: record('type'),
    pressKey: record('press_key'),
    scroll: record('scroll'),
    readPage: record('read_page'),
    evaluate: record('evaluate'),
  }
  return { calls, service: service as unknown as AgentBrowserService }
}

async function browserBridgeFixture() {
  const { calls, service } = fakeService()
  const bridge = new AgentBrowserBridge({
    service,
    terminals: { readActive: vi.fn(() => undefined) },
    extensionPath: '/app/extensions/omp-work-browser.ts',
    skillPath: '/app/skills/omp-desktop-browser',
  })
  await bridge.start()
  bridges.push(bridge)
  return { bridge, calls }
}

describe('AgentBrowserBridge host tools', () => {
  it('resolves the claim of the calling session and runs the bridge method', async () => {
    const { bridge, calls } = await browserBridgeFixture()
    bridge.environmentFor({ cwd: '/project', sessionPath: '/sessions/one.jsonl' })
    await expect(bridge.hostToolCall('/sessions/one.jsonl', 'tabs.list', {})).resolves.toEqual({ tabs: [] })
    expect(calls[0]).toMatchObject({ method: 'tabs.list', sessionKey: '/sessions/one.jsonl' })
  })

  it('refuses a session without a live claim instead of falling back to another claim', async () => {
    const { bridge, calls } = await browserBridgeFixture()
    bridge.environmentFor({ cwd: '/project', sessionPath: '/sessions/one.jsonl' })
    await expect(bridge.hostToolCall('/sessions/two.jsonl', 'tabs.list', {}))
      .rejects.toThrow('Browser control is not available for this session')
    expect(calls).toHaveLength(0)
  })

  it('binds scope handlers to the session they were built for', async () => {
    const { bridge, calls } = await browserBridgeFixture()
    bridge.environmentFor({ cwd: '/project', sessionPath: '/sessions/one.jsonl' })
    const scope = bridge.hostToolScope('/sessions/one.jsonl')
    expect(scope.tools).toBe(BROWSER_HOST_TOOLS)
    const handler = scope.handlers.get('browser_tabs')!
    await handler({ action: 'list' })
    expect(calls[0]).toMatchObject({ method: 'tabs.list', sessionKey: '/sessions/one.jsonl' })
  })

  it('advertises no tools for a session without a live claim', async () => {
    const { bridge } = await browserBridgeFixture()
    const scope = bridge.hostToolScope('/sessions/one.jsonl')
    expect(scope.tools).toEqual([])
    expect(scope.handlers.size).toBe(0)
  })
})

// ---- manager per-runtime scopes -----------------------------------------

interface FakeOptions {
  rejectHostTools?: boolean
  hostCallOnSet?: boolean
  hostCallAfterMs?: number
}

function fakeOmpAgent(options: FakeOptions = {}): { cwd: string; executable: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-desktop-browser-host-tools-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-omp.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') { process.stdout.write('omp/1.2.3\\n'); process.exit(0) }
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const resumeIndex = process.argv.indexOf('--resume')
const sessionFile = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined
const sendCall = () => send({ type: 'host_tool_call', id: 'host-1', toolCallId: 'tc-1', toolName: 'browser_tabs', arguments: { action: 'list' } })
let negotiated = false
send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })
${options.hostCallAfterMs === undefined ? '' : `setTimeout(sendCall, ${options.hostCallAfterMs})`}
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
    if (${options.rejectHostTools === true}) {
      send({ id: frame.id, type: 'response', command: 'set_host_tools', success: false, error: 'host tools rejected' })
      return
    }
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

const browserToolNames = BROWSER_HOST_TOOLS.map((candidate) => String(candidate.name))

describe('OMP v19 per-runtime host tool scopes', () => {
  it('advertises browser tools to one runtime and runs its call on its own session', async () => {
    const fake = fakeOmpAgent({ hostCallOnSet: true })
    const { manager, events } = hostManager(fake.executable)
    const { bridge, calls } = await browserBridgeFixture()
    bridge.environmentFor({ cwd: fake.cwd, sessionPath: '/sessions/one.jsonl' })
    manager.setHostToolScopeProvider((runtime) => runtime.sessionFile ? bridge.hostToolScope(runtime.sessionFile) : undefined)

    const runtime = await manager.start({ cwd: fake.cwd, sessionPath: '/sessions/one.jsonl' })
    expect(runtime.sessionFile).toBe('/sessions/one.jsonl')
    expect(seenToolNames(events)).toEqual([browserToolNames])

    await waitUntil(() => hostReplies(events).length >= 1)
    const reply = hostReplies(events)[0]
    expect(reply.id).toBe('host-1')
    expect(reply.isError).toBeUndefined()
    expect(String(reply.result.content[0].text)).toContain('"tabs": []')
    expect(calls).toEqual([{ method: 'tabs.list', sessionKey: '/sessions/one.jsonl', params: {} }])
  })

  it('never lets a runtime without a scope use another runtime\'s handler', async () => {
    const fake = fakeOmpAgent({ hostCallAfterMs: 300 })
    const { manager, events } = hostManager(fake.executable)
    const { bridge, calls } = await browserBridgeFixture()
    bridge.environmentFor({ cwd: fake.cwd, sessionPath: '/sessions/one.jsonl' })
    manager.setHostToolScopeProvider((runtime) => runtime.sessionFile === '/sessions/one.jsonl'
      ? bridge.hostToolScope(runtime.sessionFile)
      : undefined)

    await manager.start({ cwd: fake.cwd, sessionPath: '/sessions/one.jsonl' })
    await manager.start({ cwd: fake.cwd, sessionPath: '/sessions/two.jsonl' })
    // Only the scoped runtime was told about host tools.
    expect(seenToolNames(events)).toEqual([browserToolNames])

    await waitUntil(() => hostReplies(events).length >= 1)
    const reply = hostReplies(events)[0]
    expect(reply.isError).toBe(true)
    expect(String(reply.result.content[0].text)).toBe('Unknown host tool: browser_tabs')
    // The scoped runtime's handler never ran for the other session.
    expect(calls).toHaveLength(0)
  })

  it('gives each scoped runtime handlers bound to its own session', async () => {
    const fake = fakeOmpAgent({ hostCallOnSet: true })
    const { manager, events } = hostManager(fake.executable)
    const { bridge, calls } = await browserBridgeFixture()
    for (const session of ['/sessions/one.jsonl', '/sessions/two.jsonl']) {
      bridge.environmentFor({ cwd: fake.cwd, sessionPath: session })
    }
    manager.setHostToolScopeProvider((runtime) => runtime.sessionFile ? bridge.hostToolScope(runtime.sessionFile) : undefined)

    await manager.start({ cwd: fake.cwd, sessionPath: '/sessions/one.jsonl' })
    await manager.start({ cwd: fake.cwd, sessionPath: '/sessions/two.jsonl' })
    await waitUntil(() => hostReplies(events).length >= 2)
    expect(calls.map((call) => call.sessionKey).sort()).toEqual(['/sessions/one.jsonl', '/sessions/two.jsonl'])
    expect(hostReplies(events).every((reply) => reply.isError === undefined)).toBe(true)
  })

  it('fails the start when the runtime rejects its host tools', async () => {
    const fake = fakeOmpAgent({ rejectHostTools: true })
    const { manager } = hostManager(fake.executable)
    const { bridge } = await browserBridgeFixture()
    bridge.environmentFor({ cwd: fake.cwd, sessionPath: '/sessions/one.jsonl' })
    manager.setHostToolScopeProvider((runtime) => runtime.sessionFile ? bridge.hostToolScope(runtime.sessionFile) : undefined)
    await expect(manager.start({ cwd: fake.cwd, sessionPath: '/sessions/one.jsonl' })).rejects.toThrow('host tools rejected')
  })

  it('does not send set_host_tools when the provider has no scope', async () => {
    const fake = fakeOmpAgent()
    const { manager, events } = hostManager(fake.executable)
    await manager.start({ cwd: fake.cwd, sessionPath: '/sessions/one.jsonl' })
    expect(seenToolNames(events)).toEqual([])
  })

  it('does not advertise an empty scope', async () => {
    const fake = fakeOmpAgent()
    const { manager, events } = hostManager(fake.executable)
    manager.setHostToolScopeProvider(() => ({ tools: [], handlers: new Map() }))
    await manager.start({ cwd: fake.cwd, sessionPath: '/sessions/one.jsonl' })
    expect(seenToolNames(events)).toEqual([])
  })
})
