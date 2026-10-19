import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME } from '../../electron/main/store'

let app: ElectronApplication | undefined
let page: Page
let fixtureRoot = ''
let fixtureSessionFile = ''
let fixturePrimarySessionFile = ''
let actionableErrors: string[] = []

const ISSUE_131_LONG_TOKEN = 'ReProductSkuController.getProductPoolDetail,ReProductSkuController.getProductPoolPriceWave'

const instrumentedPages = new WeakSet<Page>()

const attachDiagnostics = (target: Page) => {
  if (instrumentedPages.has(target)) return
  instrumentedPages.add(target)
  target.on('pageerror', (error) => actionableErrors.push(error.message))
  target.on('console', (message) => {
    if (message.type() === 'error') actionableErrors.push(message.text())
  })
}

async function closeHermeticApp(target: ElectronApplication | undefined): Promise<void> {
  if (!target) return
  const child = target.process()
  const closeEvent = target.waitForEvent('close', { timeout: 15_000 }).then(() => undefined, () => undefined)
  const gracefulClose = target.close().then(() => true, () => false)
  const closedGracefully = await Promise.race([
    gracefulClose,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ])
  if (closedGracefully) return
  if (child.exitCode === null) child.kill('SIGKILL')
  await closeEvent
}

interface CapturedClosePrompt {
  message: string
  detail?: string
  buttons: string[]
}

/** Records the async close confirmations and answers Cancel until `__closeResponse` says otherwise. */
async function stubCloseDialog(target: ElectronApplication): Promise<void> {
  await target.evaluate(({ dialog }) => {
    const scope = globalThis as { __closePrompts?: unknown[]; __closeResponse?: number }
    scope.__closePrompts = []
    scope.__closeResponse = 0
    const closeDialog = dialog as unknown as { showMessageBox: (...args: unknown[]) => Promise<{ response: number }> }
    closeDialog.showMessageBox = (...args) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { message: string; detail?: string; buttons?: string[] }
      scope.__closePrompts?.push({ message: options.message, detail: options.detail, buttons: options.buttons ?? [] })
      return Promise.resolve({ response: scope.__closeResponse ?? 0 })
    }
  })
}

function closePrompts(target: ElectronApplication): Promise<CapturedClosePrompt[]> {
  return target.evaluate(() => (globalThis as { __closePrompts?: unknown[] }).__closePrompts ?? []) as Promise<CapturedClosePrompt[]>
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Pads a `{"type":"title",...}` line to exactly 255 bytes so the file slot spans 256 bytes with its newline. */
function ompTitleSlot(title: string, updatedAt: string): string {
  const unpadded = JSON.stringify({ type: 'title', v: 1, title, updatedAt, pad: '' })
  return JSON.stringify({ type: 'title', v: 1, title, updatedAt, pad: ' '.repeat(255 - Buffer.byteLength(unpadded, 'utf8')) })
}

function createHermeticFixture(): { userData: string; home: string; project: string; ompExecutable: string; cuaExecutable: string; sessionFile: string; primarySessionFile: string } {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'omp-desktop-e2e-'))
  const userData = join(fixtureRoot, 'user-data')
  const home = join(fixtureRoot, 'home')
  const project = join(fixtureRoot, 'project')
  const secondary = join(fixtureRoot, 'secondary-project')
  const sessions = join(home, '.omp', 'agent', 'sessions', '-omp-project')
  mkdirSync(userData, { recursive: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(secondary, { recursive: true })
  mkdirSync(sessions, { recursive: true })
  const canonicalProject = realpathSync(project)
  const canonicalSecondary = realpathSync(secondary)
  const initializeRepository = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), 'base\n')
    for (const args of [
      ['init', '-q'],
      ['config', 'user.name', 'OMP Desktop E2E'],
      ['config', 'user.email', 'e2e@example.com'],
      ['add', file],
      ['commit', '-qm', 'base'],
      ['branch', 'feature/e2e'],
    ]) {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
    }
  }
  initializeRepository(project, 'primary.txt')
  initializeRepository(secondary, 'secondary-change.txt')
  writeFileSync(join(secondary, 'secondary-change.txt'), 'base\nsecondary workspace change\n')
  writeFileSync(join(project, 'README.md'), '# Hermetic OMP Desktop fixture\n')
  const writeOmpSession = (fileName: string, title: string, updatedAt: string, entries: string[]): string => {
    const file = join(sessions, fileName)
    writeFileSync(file, [ompTitleSlot(title, updatedAt), ...entries, ''].join('\n'))
    return file
  }
  // Newest session is auto-selected at startup and sorts first in the sidebar.
  const fixtureSessionPath = writeOmpSession(
    '2026-04-01T00-00-00-000Z_019fdf24-aaaa-7000-8000-000000000001.jsonl',
    'Hermetic desktop fixture',
    '2026-04-01T00:00:00.000Z',
    [
      JSON.stringify({ type: 'session', version: 3, id: 'fixture-session', timestamp: '2026-04-01T00:00:00.000Z', cwd: canonicalSecondary }),
      JSON.stringify({ type: 'message', id: 'fixture-message', parentId: null, timestamp: '2026-04-01T00:00:01.000Z', message: { role: 'user', content: [
        { type: 'text', text: 'Hermetic desktop fixture' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' },
      ], timestamp: 1775001601000 } }),
      JSON.stringify({
        type: 'custom_message', id: 'fixture-agent-message', parentId: 'fixture-message', customType: 'agent_message', display: true,
        content: '[from child:fixture-reviewer]\nAgent-to-agent message received.\n\nEnvelope metadata that should stay hidden.',
        details: { message: 'Fixture review complete. The readable agent response is available here.', from: { sessionName: 'fixture-reviewer', runtimeKind: 'subagent' } },
        timestamp: '2026-04-01T00:00:01.000Z',
      }),
      JSON.stringify({
        type: 'custom_message', id: 'fixture-goal-summary', parentId: 'fixture-agent-message', customType: 'goal_context', display: true,
        content: '<goal_context>Fixture control envelope that should stay hidden.</goal_context>',
        details: { kind: 'created', goalId: 'fixture-goal', objective: 'Verify the readable blue goal summary.', status: 'active', continuationsUsed: 0 },
        timestamp: '2026-04-01T00:00:02.000Z',
      }),
    ],
  )
  const primarySessionPath = writeOmpSession(
    '2026-03-15T00-00-00-000Z_019fdf24-bbbb-7000-8000-000000000002.jsonl',
    'Primary workspace fixture',
    '2026-03-15T00:00:00.000Z',
    [
      JSON.stringify({ type: 'session', version: 3, id: 'primary-session', timestamp: '2026-03-15T00:00:00.000Z', cwd: canonicalProject }),
      JSON.stringify({ type: 'message', id: 'primary-message', parentId: null, timestamp: '2026-03-15T00:00:01.000Z', message: { role: 'user', content: 'Primary workspace fixture', timestamp: 1773835201000 } }),
    ],
  )
  writeOmpSession(
    '2026-02-01T00-00-00-000Z_019fdf24-dddd-7000-8000-000000000004.jsonl',
    'OMP hermetic fixture',
    '2026-02-01T00:00:00.000Z',
    [
      JSON.stringify({ type: 'session', version: 3, id: '019fdf24-dddd-7000-8000-000000000004', timestamp: '2026-02-01T00:00:00.000Z', cwd: canonicalProject }),
      JSON.stringify({ type: 'message', id: 'omp-user', parentId: null, timestamp: '2026-02-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: `OMP hermetic fixture\n${ISSUE_131_LONG_TOKEN}` }], timestamp: 1769913601000 } }),
      JSON.stringify({ type: 'message', id: 'omp-assistant', parentId: 'omp-user', timestamp: '2026-02-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'OMP fixture reply.' }] } }),
    ],
  )
  writeOmpSession(
    '2024-01-01T00-00-00-000Z_019fdf24-cccc-7000-8000-000000000003.jsonl',
    'Ownership peer fixture',
    '2024-01-01T00:00:00.000Z',
    [
      JSON.stringify({ type: 'session', version: 3, id: '019fdf24-cccc-7000-8000-000000000003', timestamp: '2024-01-01T00:00:00.000Z', cwd: canonicalSecondary }),
      JSON.stringify({ type: 'message', id: 'collaboration-peer-message', parentId: null, timestamp: '2024-01-01T00:00:01.000Z', message: { role: 'user', content: 'Ownership peer fixture', timestamp: 1704108801000 } }),
    ],
  )
  const identity = (path: string) => {
    const info = lstatSync(path, { bigint: true })
    return {
      dev: info.dev.toString(),
      ino: info.ino.toString(),
      birthtimeNs: info.birthtimeNs > 0n ? info.birthtimeNs.toString() : undefined,
    }
  }
  writeFileSync(join(userData, LEGACY_DESKTOP_STATE_FILENAME), JSON.stringify({
    version: 1,
    projects: [{
      id: 'multi-folder-project', name: 'Multi-folder fixture', path: canonicalProject,
      folders: [canonicalProject, canonicalSecondary], primaryFolder: canonicalProject,
      pinned: false, createdAt: '2025-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z',
      folderIdentities: { [canonicalProject]: identity(canonicalProject), [canonicalSecondary]: identity(canonicalSecondary) },
    }],
    settings: { activeHarness: 'prime', browserHome: 'about:blank', telemetry: true, locale: 'en' },
    archivedSessions: [],
    dismissedProjectPaths: [],
  }))

  const ompExecutable = join(fixtureRoot, 'omp-fixture.cjs')
  writeFileSync(ompExecutable, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const args = process.argv.slice(2)
const fixtureRoot = ${JSON.stringify(fixtureRoot)}
const marker = (name) => path.join(fixtureRoot, name)
if (args.includes('--version')) { process.stdout.write('omp/17.2.15\\n'); process.exit(0) }
if (args[0] === 'plugin' && ['install', 'enable', 'disable', 'uninstall'].includes(args[1])) {
  const target = args[2]
  const pluginsRoot = ${JSON.stringify(join(home, '.omp', 'plugins'))}
  if (args[1] === 'install') {
    fs.mkdirSync(path.join(pluginsRoot, 'node_modules', target), { recursive: true })
    fs.writeFileSync(path.join(pluginsRoot, 'node_modules', target, 'package.json'), JSON.stringify({ name: target.split('@')[0], description: 'Fixture OMP plugin package.', omp: {} }, null, 2) + '\\n')
  } else {
    const lockPath = path.join(pluginsRoot, 'omp-plugins.lock.json')
    let lock = {}
    try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) } catch {}
    const plugins = lock.plugins && typeof lock.plugins === 'object' ? lock.plugins : {}
    plugins[target.split('@')[0]] = { ...(plugins[target.split('@')[0]] ?? {}), enabled: args[1] !== 'disable' }
    fs.mkdirSync(pluginsRoot, { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ plugins }, null, 2) + '\\n')
  }
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n')
  process.exit(0)
}
if (args[0] === 'models' && args.includes('--json')) {
  process.stdout.write(JSON.stringify({ models: [
    { provider: 'anthropic', id: 'claude-fixture', name: 'Claude Fixture', contextWindow: 100000, maxTokens: 8192, reasoning: true, thinking: ['low', 'high'], input: ['text', 'image'] },
    { provider: 'openai-codex', id: 'gpt-fixture', name: 'GPT Fixture', contextWindow: 200000, maxTokens: 8192, reasoning: true, thinking: ['low', 'high'], input: ['text'] },
  ] }) + '\\n')
  process.exit(0)
}
if (!args.includes('--mode') || args[args.indexOf('--mode') + 1] !== 'rpc') process.exit(2)
fs.writeFileSync(marker('omp-runtime.pid'), String(process.pid))
fs.writeFileSync(marker('omp-runtime-args.json'), JSON.stringify(args))
const resumeIndex = args.indexOf('--resume')
const sessionFile = resumeIndex >= 0 ? args[resumeIndex + 1] : ${JSON.stringify(realpathSync(fixtureSessionPath))}
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const lastEntryId = () => {
  try {
    const lines = fs.readFileSync(sessionFile, 'utf8').split('\\n').filter((line) => line.trim())
    const value = JSON.parse(lines[lines.length - 1])
    return typeof value.id === 'string' ? value.id : null
  } catch { return null }
}
const rewriteTitleSlot = (title) => {
  try {
    const fd = fs.openSync(sessionFile, 'r+')
    try {
      const slot = Buffer.alloc(256)
      if (fs.readSync(fd, slot, 0, 256, 0) !== 256 || slot[255] !== 0x0a) return
      const existing = JSON.parse(slot.toString('utf8', 0, 255))
      if (!existing || existing.type !== 'title') return
      const updatedAt = new Date().toISOString()
      const build = (name, pad) => JSON.stringify({ ...existing, title: name, updatedAt, pad })
      let name = title
      while (name.length > 0 && Buffer.byteLength(build(name, ''), 'utf8') > 255) name = name.slice(0, -1)
      const unpadded = build(name, '')
      const line = build(name, ' '.repeat(255 - Buffer.byteLength(unpadded, 'utf8')))
      if (Buffer.byteLength(line, 'utf8') !== 255) return
      fs.writeSync(fd, line, 0, 'utf8')
    } finally { fs.closeSync(fd) }
  } catch {}
}
let negotiated = false
let streaming = false
let pendingPrompt
let answers = {}
send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'negotiate_protocol') {
    negotiated = true
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { protocolVersion: 2 } })
  } else if (!negotiated) {
    send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Protocol was not negotiated' })
  } else if (command.type === 'get_state') {
    setTimeout(() => send({ id: command.id, type: 'response', command: command.type, success: true, data: {
      sessionId: 'fixture-session', sessionFile, isStreaming: streaming, thinkingLevel: 'medium',
      model: { provider: 'openai-codex', id: 'gpt-fixture', name: 'GPT Fixture' },
      contextUsage: { tokens: 12000, contextWindow: 100000, percent: 12 },
      fastModeEnabled: false, queuedMessageCount: 0,
    } }), Number(process.env.OMP_FIXTURE_START_DELAY_MS || 0))
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { contextUsage: { tokens: 12000, contextWindow: 100000, percent: 12 }, cost: 0.42, tokens: { input: 10000, output: 2000, cacheRead: 0, cacheWrite: 0, total: 12000 } } })
  } else if (command.type === 'set_subagent_subscription') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { level: command.level } })
    send({ type: 'available_commands_update', commands: [{ name: 'context', description: 'Show runtime context' }, { name: 'effort', subcommands: [{ name: 'high', description: 'Deep reasoning' }] }, { name: 'modelpreset', source: 'builtin', subcommands: [{ name: 'list', description: 'List presets' }] }] })
  } else if (command.type === 'get_subagents') {
    fs.writeFileSync(marker('subagent-subscription-ready'), 'ready')
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { subagents: [] } })
  } else if (command.type === 'get_subagent_messages') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { messages: [{ role: 'user', timestamp: 0, content: 'A long assignment from the parent. '.repeat(80) }, { role: 'assistant', timestamp: 1, content: [{ type: 'thinking', thinking: 'Inspecting fixture code' }, { type: 'text', text: 'Subagent fixture result' }, { type: 'text', text: '\\n\\n' + 'A detailed progress line.\\n\\n'.repeat(80) }] }], nextByte: 100, reset: false } })
  } else if (command.type === 'steer') {
    fs.writeFileSync(marker('steer-args.json'), JSON.stringify(command))
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {} })
  } else if (command.type === 'branch') {
    fs.writeFileSync(marker('branch-args.json'), JSON.stringify(command))
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {} })
  } else if (command.type === 'prompt' || command.type === 'follow_up') {
    fs.writeFileSync(marker('prompt-args.json'), JSON.stringify(command))
    const message = typeof command.message === 'string' ? command.message : ''
    if (message === 'conversation failure fixture') {
      send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Fixture turn failed' })
      return
    }
    if (message === '/retry') {
      send({ type: 'command_output', text: 'Retry accepted' })
      send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: false } })
      return
    }
    if (message === '/modelpreset list') {
      send({ type: 'command_output', text: '\\u001b[32mModel presets\\u001b[0m\\r\\nfixture-default' })
      send({ type: 'extension_ui_request', id: 'fixture-notice', method: 'notify', message: 'Preset list loaded', notifyType: 'info' })
      setTimeout(() => send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: false } }), 600)
      return
    }
    if (message === '/fixture-empty') {
      send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: false } })
      return
    }
    if (message === '/fixture-notify-error') {
      send({ type: 'extension_ui_request', id: 'fixture-error-notice', method: 'notify', message: 'Extension command rejected', notifyType: 'error' })
      send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: false } })
      return
    }
    if (message === '/fixture-failure') {
      send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Fixture command failed' })
      return
    }
    if (message === 'subagent overview fixture') {
      send({ type: 'subagent_lifecycle', payload: { id: 'running-worker', agent: 'Explore', status: 'started', description: 'Inspect active module' } })
      send({ type: 'subagent_progress', payload: { progress: { id: 'running-worker', status: 'running', currentTool: 'bash', currentToolIntent: 'Running tests', durationMs: 12000 } } })
      send({ type: 'subagent_lifecycle', payload: { id: 'failed-worker', agent: 'Reviewer', status: 'failed', description: 'Review the patch', error: 'Fixture review failed' } })
      send({ type: 'subagent_lifecycle', payload: { id: 'waiting-worker', agent: 'Task', status: 'started', description: 'Choose a target' } })
      send({ type: 'subagent_progress', payload: { progress: { id: 'waiting-worker', status: 'running', currentTool: 'ask_user', currentToolIntent: 'Choose a target', durationMs: 5000 } } })
      send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: false } })
      return
    }
    if (message === '/context') {
      send({ type: 'command_output', text: 'Runtime context: 12 percent' })
      send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: false } })
      return
    }
    if (message === 'subagent fixture') {
      send({ type: 'subagent_lifecycle', payload: { id: 'fixture-worker', agent: 'Explore', status: 'started', description: 'Inspect fixture' } })
      send({ type: 'subagent_event', payload: { id: 'fixture-worker', event: { type: 'message_update', message: { role: 'assistant', timestamp: 1, content: [{ type: 'thinking', thinking: 'Inspecting fixture code' }] } } } })
      send({ type: 'subagent_lifecycle', payload: { id: 'fixture-worker', agent: 'Explore', status: 'completed' } })
      send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: false } })
      return
    }
    if (message.includes('barrier turn')) {
      fs.writeFileSync(marker('prompt-admission-barrier-started'), 'ready')
      streaming = true
      send({ type: 'agent_start' })
      send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
      const release = marker('prompt-admission-barrier-release')
      const watcher = fs.watch(fixtureRoot, (_event, filename) => {
        if (filename?.toString() !== 'prompt-admission-barrier-release' || !fs.existsSync(release)) return
        watcher.close()
        streaming = false
        send({ type: 'agent_end' })
      })
      return
    }
    if (message.includes('barrier follow-up')) {
      fs.writeFileSync(marker('prompt-admission-barrier-accepted'), JSON.stringify(command))
      const completedAt = new Date().toISOString()
      const parentId = lastEntryId()
      fs.appendFileSync(sessionFile, [
        JSON.stringify({ type: 'message', id: 'fixture-barrier-user', parentId, timestamp: completedAt, message: { role: 'user', content: command.message } }),
        JSON.stringify({ type: 'message', id: 'fixture-barrier-assistant', parentId: 'fixture-barrier-user', timestamp: completedAt, message: { role: 'assistant', content: 'The barrier follow-up was accepted.' } }),
      ].join('\\n') + '\\n')
      send({ type: 'agent_start' })
      send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
      send({ type: 'agent_end' })
      return
    }
    if (message.includes('stay busy')) {
      streaming = true
      send({ type: 'agent_start' })
      send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
      return
    }
    if (message.includes('chunked reply')) {
      const text = 'Chunked fixture reply. ' + 'x'.repeat(4096)
      send({ type: 'agent_start' })
      const frame = JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } })
      const parts = []
      for (let index = 0; index < frame.length; index += 2048) parts.push(frame.slice(index, index + 2048))
      parts.forEach((part, index) => send({ type: 'rpc_chunk', chunkId: 'fixture-chunk-1', index, count: parts.length, data: Buffer.from(part, 'utf8').toString('base64'), byteLength: Buffer.byteLength(part, 'utf8') }))
      const completedAt = new Date().toISOString()
      fs.appendFileSync(sessionFile, JSON.stringify({ type: 'message', id: 'fixture-chunked-assistant', parentId: lastEntryId(), timestamp: completedAt, message: { role: 'assistant', content: text } }) + '\\n')
      send({ type: 'agent_end' })
      send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
      return
    }
    if (message.includes('two questions')) {
      pendingPrompt = command
      answers = {}
      send({ type: 'agent_start' })
      send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '**Reviewing the available OMP release channels before asking for input.**' } })
      send({ type: 'tool_execution_start', toolCallId: 'omp-ask-2', toolName: 'ask_user', args: { questions: [
        { question: 'Which OMP release channel?', options: ['Stable', 'Beta'] },
        { question: 'What should OMP optimize for?', options: ['Speed', 'Safety'] },
      ] } })
      send({ type: 'extension_ui_request', id: 'omp-fixture-question-1', method: 'select', title: 'Which OMP release channel?', options: ['__prime_ask_user__omp-fixture-group:0:2', 'Stable', 'Beta', 'Other (type your own answer)'] })
      send({ type: 'extension_ui_request', id: 'omp-fixture-question-2', method: 'select', title: 'What should OMP optimize for?', options: ['__prime_ask_user__omp-fixture-group:1:2', 'Speed', 'Safety', 'Other (type your own answer)'] })
      return
    }
    send({ type: 'agent_start' })
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Fixture response.' } })
    send({ type: 'agent_end' })
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
  } else if (command.type === 'extension_ui_response') {
    answers[command.id] = command.value
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {} })
    if (!pendingPrompt || Object.keys(answers).length < 2) return
    const prompt = pendingPrompt
    pendingPrompt = undefined
    fs.writeFileSync(marker('omp-questionnaire-values.json'), JSON.stringify(answers))
    send({ type: 'tool_execution_end', toolCallId: 'omp-ask-2', toolName: 'ask_user', result: { values: answers } })
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'The OMP questionnaire answers are ready.' } })
    const completedAt = new Date().toISOString()
    const parentId = lastEntryId()
    fs.appendFileSync(sessionFile, [
      JSON.stringify({ type: 'message', id: 'fixture-live-assistant-multi', parentId, timestamp: completedAt, message: { role: 'assistant', timestamp: completedAt, content: [{ type: 'toolCall', id: 'omp-ask-2', name: 'ask_user', arguments: { questions: [{ question: 'Which OMP release channel?', options: ['Stable', 'Beta'] }, { question: 'What should OMP optimize for?', options: ['Speed', 'Safety'] }] } }] } }),
      JSON.stringify({ type: 'message', id: 'fixture-live-result-multi', parentId: 'fixture-live-assistant-multi', timestamp: completedAt, message: { role: 'toolResult', timestamp: completedAt, toolCallId: 'omp-ask-2', toolName: 'ask_user', content: JSON.stringify({ values: answers }) } }),
      JSON.stringify({ type: 'message', id: 'fixture-live-final-multi', parentId: 'fixture-live-result-multi', timestamp: completedAt, message: { role: 'assistant', timestamp: completedAt, content: 'The OMP questionnaire answers are ready.' } }),
    ].join('\\n') + '\\n')
    send({ type: 'agent_end' })
    setTimeout(() => rewriteTitleSlot('Post-completion catalog refresh'), 250)
  } else if (command.id) {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {} })
  }
})
`)
  chmodSync(ompExecutable, 0o755)
  const cuaExecutable = join(fixtureRoot, 'cua-driver-fixture.cjs')
  writeFileSync(cuaExecutable, `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('cua-driver 0.19.0\\n'); process.exit(0) }
process.exit(2)
`)
  chmodSync(cuaExecutable, 0o755)
  return { userData, home, project, ompExecutable, cuaExecutable, sessionFile: realpathSync(fixtureSessionPath), primarySessionFile: primarySessionPath }
}

function hermeticEnvironment(home: string, ompExecutable: string, cuaExecutable: string, restrictPath = false): NodeJS.ProcessEnv {
  let path = process.env.PATH
  if (restrictPath) {
    const bin = join(fixtureRoot, 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(process.execPath, join(bin, 'node'))
    path = bin
  }
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: path,
    TMPDIR: fixtureRoot,
    SHELL: '/bin/zsh',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    OMP_DESKTOP_E2E_HIDE_WINDOWS: '1',
    OMP_BINARY: ompExecutable,
    CUA_DRIVER_PATH: cuaExecutable,
  }
  for (const key of ['USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING', 'DISPLAY', 'XAUTHORITY']) if (process.env[key]) env[key] = process.env[key]
  return env
}


test.describe('OMP Desktop desktop smoke', () => {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright derives fixture usage from this destructuring pattern
  test.beforeEach(async ({}, testInfo) => {
    actionableErrors = []
    app = undefined
    const noOmp = testInfo.title === 'connects to OMP after it is installed while the app is open'
      || testInfo.title === 'opens Harness settings from the no-harness recovery prompt'
    const networkMcp = testInfo.title === 'shows externally managed OMP MCP servers without inspecting authorization'
    let startupError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fixture = createHermeticFixture()
      if (networkMcp) writeFileSync(join(fixture.home, '.omp', 'agent', 'mcp.json'), JSON.stringify({ mcpServers: { Notion: { type: 'http', url: 'https://mcp.notion.test/mcp' } } }))
      fixtureSessionFile = fixture.sessionFile
      fixturePrimarySessionFile = fixture.primarySessionFile
      if (noOmp) renameSync(fixture.ompExecutable, `${fixture.ompExecutable}.pending`)
      try {
        const environment = hermeticEnvironment(fixture.home, fixture.ompExecutable, fixture.cuaExecutable, noOmp)
        if (testInfo.title === 'shows a new conversation immediately while the harness starts') environment.OMP_FIXTURE_START_DELAY_MS = '2500'
        if (testInfo.title === 'Command-Q backgrounds the window and menu-bar Open restores it') environment.OMP_DESKTOP_E2E_HIDE_WINDOWS = '0'
        app = await electron.launch({
          args: ['.', `--user-data-dir=${fixture.userData}`],
          cwd: process.cwd(),
          env: environment as Record<string, string>,
          timeout: 20_000,
        })
        app.context().on('page', attachDiagnostics)
        for (const target of app.windows()) attachDiagnostics(target)
        page = await app.firstWindow({ timeout: 15_000 })
        attachDiagnostics(page)
        await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
        return
      } catch (error) {
        startupError = error
        await closeHermeticApp(app)
        app = undefined
        if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
        fixtureRoot = ''
        fixtureSessionFile = ''
        fixturePrimarySessionFile = ''
      }
    }
    throw startupError ?? new Error('OMP Desktop did not create its initial window')
  })

  test.afterEach(async () => {
    await closeHermeticApp(app)
    app = undefined
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
    fixtureSessionFile = ''
    fixturePrimarySessionFile = ''
  })

  test('runs slash commands and inspects a subagent transcript', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await page.getByRole('button', { name: 'Add context', exact: true }).click()
    await page.getByRole('option', { name: 'Commands Choose a command for this conversation' }).click()
    await expect(page.getByRole('option').filter({ hasText: '/context' })).toBeVisible()
    await composer.fill('/effort')
    await expect(page.getByRole('option').filter({ hasText: '/effort' })).toHaveCount(0)
    await composer.fill('/model')
    await expect(page.getByRole('option').filter({ hasText: /^\/model(?:\s|$)/ })).toHaveCount(0)
    await expect(page.getByRole('option').filter({ hasText: '/modelpreset' })).toBeVisible()
    await composer.fill('/context')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByText('Runtime context: 12 percent')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Command result', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close command result', exact: true }).click()
    await expect(page.getByText('Runtime context: 12 percent')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Stop OMP', exact: true })).toHaveCount(0)
    await composer.fill('/effort h')
    await expect(page.getByRole('option').filter({ hasText: '/effort high' })).toHaveCount(0)
    await composer.fill('/modelpreset l')
    await expect(page.getByRole('option').filter({ hasText: '/modelpreset list' })).toBeVisible()
    await composer.fill('subagent fixture')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByRole('button', { name: /Subagents ·/ }).click()
    await page.getByRole('button', { name: /Explore.*Completed/ }).click()
    await page.locator('.subagents__messages .work-disclosure__button').click()
    // Each thinking row folds on its own (dsh shape); open it to read the body.
    await page.locator('.subagents__messages .reasoning-disclosure > summary').first().click()
    await expect(page.locator('.reasoning-disclosure .prose').getByText('Inspecting fixture code', { exact: true })).toBeVisible()
    await expect(page.getByText('Subagent fixture result')).toBeVisible()
    await expect(page.locator('.subagents__instruction')).toHaveJSProperty('open', false)
    for (const width of [1280, 1600, 680]) {
      await page.setViewportSize({ width, height: 900 })
      const columns = await page.locator('.subagents__transcript').evaluate((element) => {
        const bounds = (selector: string) => {
          const rect = element.querySelector(selector)!.getBoundingClientRect()
          return { left: rect.left, right: rect.right }
        }
        return { heading: bounds('.subagents__heading'), instruction: bounds('.subagents__instruction'), message: bounds('.subagents__message') }
      })
      expect(columns.message.left).toBeCloseTo(columns.heading.left, 0)
      expect(columns.message.right).toBeCloseTo(columns.heading.right, 0)
      expect(columns.instruction.left).toBeCloseTo(columns.heading.left, 0)
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect.poll(() => page.locator('.subagents__transcript').evaluate((element) => {
      const heading = element.querySelector('.subagents__heading')!.getBoundingClientRect()
      const message = element.querySelector('.subagents__message')!.getBoundingClientRect()
      return Math.abs(heading.left - message.left) + Math.abs(heading.right - message.right)
    })).toBeLessThan(1)
    await expect(page.locator('.subagents__footnote')).toHaveCount(0)
    const overviewTop = await page.locator('.subagents__overview').evaluate((element) => element.getBoundingClientRect().top)
    await page.locator('.subagents__messages').evaluate((element) => { element.scrollTop = element.scrollHeight })
    expect(await page.locator('.subagents__overview').evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(overviewTop, 0)
    await page.locator('.subagents__messages').evaluate((element) => { element.scrollTop = 0 })
    await expect(page.locator('.subagents__back')).toHaveCount(0)
    await expect(page.locator('.subagents__commands-toggle')).toHaveCount(0)
    await expect(page.locator('.project-run-control')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('subagents.png') })
    await expect(composer).not.toBeVisible()
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(composer).toBeVisible()
  })

  test('offers auto effort and persists the thinking disclosure setting', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true })
    await expect(effort.locator('option[value="auto"]')).toHaveText('Auto')
    await effort.selectOption('auto')
    await expect(effort).toHaveValue('auto')
    await page.evaluate(() => window.desktop!.settings.update({ reasoningExpandedByDefault: true }))
    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
    expect(await page.evaluate(async () => (await window.desktop!.settings.get()).reasoningExpandedByDefault)).toBe(true)
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('subagent fixture')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByRole('button', { name: /Subagents ·/ }).click()
    await page.getByRole('button', { name: /Explore.*Completed/ }).click()
    await expect(page.locator('.subagents__messages .work-disclosure__button')).toHaveAttribute('aria-expanded', 'true')
    // Thinking rows keep their labelled header (dsh shape); the expand-by-default
    // setting means the section itself opens with its content visible.
    const reasoning = page.locator('.subagents__messages .reasoning-disclosure').first()
    await expect(reasoning).toBeVisible()
    await expect(reasoning).toHaveAttribute('open', '')
    await expect(reasoning.locator('.prose').first()).toBeVisible()
    await page.locator('.subagents__messages .work-disclosure__button').click()
    await expect(page.locator('.subagents__messages .work-disclosure__button')).toHaveAttribute('aria-expanded', 'false')
  })

  test('pins an agent overview, prioritizes attention and preserves it while switching views', async () => {
    await page.setViewportSize({ width: 1800, height: 950 })
    if (await page.locator('.inspector').count()) await page.locator('.inspector').getByRole('button', { name: 'Close inspector' }).click()
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')
    // This fixture emits a one-shot roster, so attach the observer before asking
    // it to spawn agents. A real harness can also recover its registry snapshot.
    await page.getByRole('combobox', { name: 'Message OMP' }).fill('/context')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => existsSync(join(fixtureRoot, 'subagent-subscription-ready'))).toBe(true)
    await expect(page.locator('.command-output__status')).toHaveText('Completed')
    await page.getByRole('combobox', { name: 'Message OMP' }).fill('subagent overview fixture')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByRole('button', { name: /Subagents ·/ }).click()
    await page.getByRole('button', { name: 'Pin agent list', exact: true }).click()
    const roster = page.locator('.subagents__roster.is-pinned')
    await expect(roster).toBeVisible()
    await expect(roster.locator('.subagents__agent')).toHaveCount(3)
    await expect(roster.locator('.subagents__agent').nth(0)).toHaveAttribute('aria-label', /Task · Waiting for input/)
    await expect(roster.locator('.subagents__agent').nth(1)).toHaveAttribute('aria-label', /Reviewer · Failed/)
    await expect(roster.locator('.subagents__agent').nth(2)).toContainText('Running tests')
    await roster.getByRole('button', { name: /Task · Waiting for input/ }).click()
    const activeAgent = page.locator('.subagents__page:not([hidden])')
    await expect(activeAgent.locator('.subagents__heading h2')).toHaveText('Task')
    await activeAgent.locator('.subagents__details summary').click()
    // The subagent turn is still running, so the work disclosure streams open;
    // only click when the default decided to stay closed (e.g. it completed).
    const agentDisclosure = activeAgent.locator('.work-disclosure__button')
    if (await agentDisclosure.getAttribute('aria-expanded') !== 'true') await agentDisclosure.click()
    await activeAgent.locator('.subagents__messages').evaluate((element) => { element.scrollTop = 200; element.dispatchEvent(new Event('scroll')) })
    const previousTop = await activeAgent.locator('.subagents__messages').evaluate((element) => element.scrollTop)
    expect(previousTop).toBeGreaterThan(0)
    await expect(roster).toBeVisible()
    await roster.getByRole('button', { name: /Reviewer · Failed/ }).click()
    await expect(activeAgent.locator('.subagents__heading h2')).toHaveText('Reviewer')
    await expect(activeAgent.locator('.subagents__heading')).toContainText('Fixture review failed')
    await roster.getByRole('button', { name: /Task · Waiting for input/ }).click()
    await expect(activeAgent.locator('.subagents__details')).toHaveJSProperty('open', true)
    await expect(activeAgent.locator('.work-disclosure__button')).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => activeAgent.locator('.subagents__messages').evaluate((element) => element.scrollTop)).toBeCloseTo(previousTop, 0)
    await expect(activeAgent.getByRole('button', { name: /Jump to/ })).toBeVisible()
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Message OMP' })).toBeVisible()
    const positions = await page.locator('.subagents__body').evaluate((element) => {
      const main = element.querySelector('main')!.getBoundingClientRect()
      const list = element.querySelector('.subagents__roster')!.getBoundingClientRect()
      return { mainRight: main.right, listLeft: list.left }
    })
    expect(positions.mainRight).toBeCloseTo(positions.listLeft, 0)
    await page.screenshot({ path: test.info().outputPath('agent-overview-wide.png') })
    await page.setViewportSize({ width: 680, height: 850 })
    await expect(roster).toBeVisible()
    expect(await roster.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(400)
    await page.screenshot({ path: test.info().outputPath('agent-overview-compact.png') })
    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
    await expect(page.locator('.subagents__roster.is-pinned')).toBeVisible()
    await page.getByRole('button', { name: 'Close agent list', exact: true }).click()
    await expect(page.locator('.subagents__roster')).toHaveCount(0)
    await expect.poll(async () => page.evaluate(async () => (await window.desktop.settings.get()).subagentsPanelPinned)).toBe(false)
  })

  test('adapts terminal command output, notifications, empty results and failures to the desktop panel', async () => {
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    const panel = page.getByRole('region', { name: 'Command result', exact: true })
    await composer.fill('/modelpreset list')
    await composer.press('Enter')
    await expect(panel.getByRole('status')).toHaveText('Running command…')
    await expect(panel.getByRole('status')).toHaveText('Completed')
    await expect(page.locator('.subagents__toolbar > .execution-status')).not.toContainText('Waiting for input')
    await expect(panel.locator('pre')).toHaveText('Model presets\nfixture-default\nPreset list loaded')
    await expect(page.locator('.transcript .user-bubble').filter({ hasText: '/modelpreset list' })).toHaveCount(0)
    await expect(page.locator('.transcript .thinking-dots')).toHaveCount(0)
    await panel.locator('button[aria-expanded]').click()
    await expect(panel.locator('pre')).toHaveCount(0)
    await panel.locator('button[aria-expanded]').click()
    await page.screenshot({ path: test.info().outputPath('native-command-panel.png') })
    await composer.fill('/fixture-empty')
    await composer.press('Enter')
    await expect(panel).toContainText('Command completed without text output.')
    await expect(panel).not.toContainText('fixture-default')
    await composer.fill('/fixture-notify-error')
    await composer.press('Enter')
    await expect(panel.getByRole('status')).toHaveText('Failed')
    await expect(panel.locator('pre')).toContainText('Extension command rejected')
    await composer.fill('/fixture-failure')
    await composer.press('Enter')
    await expect(panel.getByRole('status')).toHaveText('Failed')
    await expect(panel.locator('pre')).toContainText('Fixture command failed')
    await expect(composer).toHaveValue('/fixture-failure')
    await composer.fill('/todo:expand')
    await composer.press('Enter')
    await expect(panel.locator('pre')).toContainText('uses a terminal selector')
    await expect(composer).toHaveValue('/todo:expand')
    const delivered = JSON.parse(readFileSync(join(fixtureRoot, 'prompt-args.json'), 'utf8'))
    expect(delivered.message).toBe('/fixture-failure')
  })

  test('searches collapsed content and old history and records conversation performance', async () => {
    const search = page.getByRole('textbox', { name: 'Find in conversation', exact: true })
    await page.keyboard.press('Meta+f')
    await search.fill('readable agent response')
    await expect(page.locator('.agent-message__summary')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.agent-message__content')).toContainText('Fixture review complete')
    await search.press('Escape')
    await expect(page.locator('.agent-message__summary')).toHaveAttribute('aria-expanded', 'false')

    const cdp = await page.context().newCDPSession(page)
    const heap = async () => (await cdp.send('Runtime.getHeapUsage')).usedSize
    const before = await heap()
    const timestamp = new Date().toISOString()
    const started = Date.now()
    appendFileSync(fixtureSessionFile, `${Array.from({ length: 1000 }, (_, index) => JSON.stringify({
      type: 'message', id: `search-history-${index}`, parentId: index ? `search-history-${index - 1}` : 'fixture-goal-summary', timestamp,
      message: { role: index % 2 ? 'assistant' : 'user', timestamp, content: index === 601 ? [
        { type: 'thinking', thinking: 'Historical reasoning needle' },
        { type: 'toolCall', id: 'history-tool', name: 'bash', arguments: { command: 'historical-tool-needle' } },
        { type: 'text', text: 'Historical answer needle' },
      ] : [{ type: 'text', text: `History entry ${index}` }] },
    })).join('\n')}\n`)
    await expect(page.locator('.transcript').getByText('History entry 999', { exact: true })).toHaveCount(1)
    const loadedMs = Date.now() - started
    const recentNodes = await page.locator('.transcript [data-message-id]').count()
    expect(recentNodes).toBe(250)
    const afterLoad = await heap()
    await page.keyboard.press('Meta+f')
    const searchStarted = Date.now()
    await search.fill('Historical reasoning needle')
    await page.getByRole('combobox', { name: 'Search content', exact: true }).selectOption('thinking')
    await expect(page.locator('.is-search-match .work-disclosure__button')).toHaveAttribute('aria-expanded', 'true')
    // The needle must be visible in the expanded reasoning body (the collapsed
    // row's preview line repeats the same leading text but is display-hidden).
    await expect(page.locator('.is-search-match .reasoning-disclosure .prose').getByText('Historical reasoning needle', { exact: true })).toBeVisible()
    const searchMs = Date.now() - searchStarted
    await expect.poll(() => page.evaluate(() => CSS.highlights.get('conversation-search')?.size ?? 0)).toBeGreaterThan(0)
    const searchedNodes = await page.locator('.transcript [data-message-id]').count()
    expect(searchedNodes).toBeLessThanOrEqual(250)
    const afterSearch = await heap()
    await search.fill('historical-tool-needle')
    await page.getByRole('combobox', { name: 'Search content', exact: true }).selectOption('tools')
    await expect(page.locator('.is-search-match .activity-tool__details')).toContainText('historical-tool-needle')
    await search.press('Escape')
    await expect(page.locator('.transcript .work-disclosure__button')).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: 'Scroll to the latest message', exact: true }).click()
    await expect(page.locator('.transcript').getByText('History entry 999', { exact: true })).toBeInViewport()
    await test.info().attach('conversation-performance', { body: JSON.stringify({ persistedMessages: 1003, loadedMs, searchMs, recentNodes, searchedNodes, heapBefore: before, heapAfterLoad: afterLoad, heapAfterSearch: afterSearch }), contentType: 'application/json' })
    await page.locator('.conversation-column').evaluate((element) => { element.style.flex = '0 0 360px' })
    await page.keyboard.press('Meta+f')
    await search.fill('A query without any matching results')
    const compact = await page.locator('.conversation-search').evaluate((element) => ({ width: element.clientWidth, overflow: element.scrollWidth }))
    expect(compact.overflow).toBeLessThanOrEqual(compact.width + 1)
    await cdp.detach()
  })

  test('recovers a failed turn without replacing a draft and uses the native retry command', async () => {
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')
    await composer.fill('conversation failure fixture')
    await composer.press('Enter')
    const recovery = page.getByRole('region', { name: 'This turn needs attention', exact: true })
    await expect(recovery).toBeVisible()
    await recovery.getByRole('button', { name: 'Restore prompt to composer', exact: true }).click()
    await expect(composer).toHaveValue('conversation failure fixture')
    await composer.fill('Existing draft')
    await recovery.getByRole('button', { name: 'Restore prompt to composer', exact: true }).click()
    await expect(composer).toHaveValue('Existing draft\n\nconversation failure fixture')
    await recovery.getByRole('button', { name: 'Copy error', exact: true }).click()
    await expect(recovery.getByRole('status')).toHaveText('Error copied')
    await recovery.getByRole('button', { name: 'Retry failed turn', exact: true }).click()
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'prompt-args.json'), 'utf8')).message).toBe('/retry')
    await expect(page.locator('.command-output pre')).toHaveText('Retry accepted')
    await expect(composer).toHaveValue('Existing draft\n\nconversation failure fixture')
  })

  test('browses recent command results and reopens them after closing', async () => {
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')
    for (const command of ['/context', '/modelpreset list']) {
      await composer.fill(command)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect(page.locator('.command-output__status')).toHaveText('Completed')
    }
    const history = page.getByRole('combobox', { name: 'Recent command results', exact: true })
    await history.selectOption({ label: '/context' })
    await expect(page.locator('.command-output pre')).toHaveText('Runtime context: 12 percent')
    await page.getByRole('button', { name: 'Close command result', exact: true }).click()
    await page.getByRole('button', { name: 'Recent command results · 2', exact: true }).click()
    await expect(page.locator('.command-output pre')).toContainText('fixture-default')
  })

  test('filters unread agent updates and measures retained view switching', async () => {
    await page.setViewportSize({ width: 1600, height: 950 })
    if (await page.locator('.inspector').count()) await page.locator('.inspector').getByRole('button', { name: 'Close inspector' }).click()
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('/context')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.locator('.command-output__status')).toHaveText('Completed')
    await composer.fill('subagent overview fixture')
    await composer.press('Enter')
    await page.getByRole('button', { name: /Subagents ·/ }).click()
    await page.getByRole('button', { name: 'Pin agent list', exact: true }).click()
    const roster = page.locator('.subagents__roster.is-pinned')
    await expect(roster.locator('.subagents__unread')).toHaveCount(3)
    const times: number[] = []
    for (const name of ['Task', 'Reviewer', 'Explore', 'Task']) {
      const started = Date.now()
      await roster.getByRole('button', { name: new RegExp(`^${name} ·`) }).click()
      await expect(page.locator('.subagents__page:not([hidden]) h2')).toHaveText(name)
      times.push(Date.now() - started)
    }
    await expect(roster.locator('.subagents__unread')).toHaveCount(0)
    const filter = roster.getByRole('combobox', { name: 'Filter agents', exact: true })
    await filter.selectOption('running')
    await expect(roster.locator('.subagents__agent')).toHaveCount(1)
    await expect(roster.locator('.subagents__agent')).toContainText('Explore')
    await filter.selectOption('attention')
    await expect(roster.locator('.subagents__agent')).toHaveCount(2)
    await filter.selectOption('completed')
    await expect(roster.locator('.subagents__agent')).toHaveCount(0)
    await test.info().attach('agent-switch-performance', { body: JSON.stringify({ agents: 3, switchMs: times, retainedViews: await page.locator('.subagents__page').count() }), contentType: 'application/json' })
  })

  test('captures the current localized conversation and agent workspace', async () => {
    await page.evaluate(() => window.desktop.settings.update({ locale: 'zh-TW', theme: 'dark', reasoningExpandedByDefault: false }))
    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
    await page.setViewportSize({ width: 1540, height: 980 })
    if (await page.locator('.inspector').count()) await page.locator('.inspector').getByRole('button', { name: '關閉檢查器' }).click()
    const timestamp = new Date().toISOString()
    appendFileSync(fixtureSessionFile, `${JSON.stringify({ type: 'message', id: 'preview-user', parentId: 'fixture-goal-summary', timestamp,
      message: { role: 'user', timestamp, content: [{ type: 'text', text: '請整理這次介面更新，並確認測試結果。' }] },
    })}\n${JSON.stringify({ type: 'message', id: 'preview-answer', parentId: 'preview-user', timestamp,
      message: { role: 'assistant', timestamp, content: [
        { type: 'thinking', thinking: '先確認對話的閱讀順序，再檢查搜尋、指令結果與子代理狀態。' },
        { type: 'toolCall', id: 'preview-tool', name: 'read', arguments: { path: 'src/components/Transcript.tsx' } },
        { type: 'text', text: '## 對話工作區\n\n現在可以直接在目前對話中搜尋，快速找到訊息、工具輸出或模型提供的思考內容。\n\n- **對話搜尋**：按 ⌘F，依內容類型篩選並跳到符合的訊息。\n- **子代理進度**：固定右側清單，查看未讀更新與需要處理的工作。\n- **指令結果**：在輸入框上方檢視最近五筆輸出，關閉後也能重新開啟。\n\n搜尋結果會暫時展開相關內容，關閉搜尋後恢復原本的收折狀態。' },
      ] },
    })}\n`)
    await expect(page.locator('.transcript').getByText('對話工作區', { exact: true })).toBeVisible()
    const composer = page.locator('.composer-input textarea')
    for (const command of ['/context', '/modelpreset list', 'subagent overview fixture']) {
      await composer.fill(command)
      await page.getByRole('button', { name: '傳送訊息', exact: true }).click()
      if (command.startsWith('/')) await expect(page.locator('.command-output__status')).toHaveText('已完成')
      else await expect(page.locator('.subagents__count')).toHaveText('3')
    }
    await page.locator('.subagents__roster-toggle').click()
    await page.getByRole('button', { name: '固定代理清單', exact: true }).click()
    await page.keyboard.press('Meta+f')
    await page.getByRole('textbox', { name: '在對話中尋找', exact: true }).fill('子代理進度')
    await expect(page.locator('.is-search-match')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('conversation-search.png') })
    await page.getByRole('button', { name: '關閉對話搜尋', exact: true }).click()
    await page.locator('[data-message-id="preview-user"]').evaluate((element) => element.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: join(tmpdir(), 'omp-desktop-current-workspace.png') })
    await page.screenshot({ path: test.info().outputPath('current-workspace.png') })
  })

  test('localizes agent controls, command results and delete confirmation in Chinese', async () => {
    for (const [locale, result, remove, title, cancel] of [
      ['zh-TW', '指令結果', '刪除', '刪除對話？', '取消'],
      ['zh-CN', '指令结果', '删除', '删除对话？', '取消'],
    ] as const) {
      await page.evaluate(async (locale) => window.desktop!.settings.update({ locale }), locale)
      await page.reload()
      await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
      const row = page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' })
      await row.locator('.session-row').click()
      await expect(page.locator('.subagents__roster-toggle')).toContainText('子代理')
      await page.locator('.composer-input textarea').fill('/context')
      await page.locator('.composer .send-button').click()
      await expect(page.getByRole('region', { name: result, exact: true })).toBeVisible()
      await page.screenshot({ path: test.info().outputPath(`${locale}-command-result.png`) })
      await row.getByTitle(`${remove} Hermetic desktop fixture`).click()
      await expect(page.getByRole('dialog')).toContainText(title)
      await page.getByRole('dialog').getByRole('button', { name: cancel, exact: true }).click()
      await expect(row).toHaveCount(1)
      expect(existsSync(fixtureSessionFile)).toBe(true)
    }
  })

  test('steers the active turn with Ctrl+Enter', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('stay busy while I steer')
    await composer.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop OMP' })).toBeVisible()

    await composer.fill('send this queued task now')
    await composer.press('Enter')
    const queuedTray = page.getByRole('region', { name: 'Queued messages' })
    await queuedTray.locator('.composer-queue__item').hover()
    await expect(queuedTray.locator('.composer-queue__actions')).toHaveCSS('opacity', '1')
    await expect(queuedTray.locator('.composer-queue__item')).toHaveCount(1)
    const sendImmediately = queuedTray.getByRole('button', { name: /^Send queued message immediately:/ })
    await expect(sendImmediately).toHaveAttribute('title', 'Send queued message immediately')
    await sendImmediately.click()
    await expect(queuedTray.locator('.composer-queue__item')).toHaveCount(0)
    const queuedSteerMarker = join(fixtureRoot, 'steer-args.json')
    await expect.poll(() => existsSync(queuedSteerMarker)).toBe(true)
    expect(JSON.parse(readFileSync(queuedSteerMarker, 'utf8'))).toMatchObject({ type: 'steer', message: 'send this queued task now' })
    await composer.fill('change direction now')
    await composer.press('Control+Enter')
    await expect(page.locator('.message--user').filter({ hasText: 'change direction now' })).toBeVisible()
    const marker = join(fixtureRoot, 'steer-args.json')
    await expect.poll(() => {
      if (!existsSync(marker)) return ''
      return JSON.parse(readFileSync(marker, 'utf8')).message
    }).toBe('change direction now')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ type: 'steer', message: 'change direction now' })
    await expect(composer).toHaveValue('')
  })

  test('admits a queued prompt across the OMP terminal-event barrier', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('barrier turn')
    await composer.press('Enter')
    await expect.poll(() => existsSync(join(fixtureRoot, 'prompt-admission-barrier-started'))).toBe(true)
    await expect(page.getByRole('button', { name: 'Stop OMP' })).toBeVisible()

    await composer.fill('barrier follow-up')
    await composer.press('Enter')
    const queuedTray = page.getByRole('region', { name: 'Queued messages' })
    await expect(queuedTray.locator('.composer-queue__item')).toHaveCount(1)

    writeFileSync(join(fixtureRoot, 'prompt-admission-barrier-release'), 'release')
    const acceptedPath = join(fixtureRoot, 'prompt-admission-barrier-accepted')
    await expect.poll(() => existsSync(acceptedPath)).toBe(true)
    const accepted = JSON.parse(readFileSync(acceptedPath, 'utf8')) as { type: string; message: string; streamingBehavior?: string }
    expect(accepted).toMatchObject({ type: 'prompt', message: 'barrier follow-up' })
    expect(accepted.streamingBehavior).toBeUndefined()
    await expect(queuedTray.locator('.composer-queue__item')).toHaveCount(0)
    await expect(page.locator('.message--user').filter({ hasText: 'barrier follow-up' })).toHaveCount(1)
    await expect(page.locator('.message--activity').filter({ hasText: 'Cannot send prompt' })).toHaveCount(0)
  })

  test('translates a renderer fork into an OMP branch command', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('Start a turn to fork')
    await composer.press('Enter')
    const runtimes = await page.evaluate(() => window.desktop.agent.list())
    expect(runtimes).toHaveLength(1)
    await page.evaluate((runtimeId) => window.desktop.agent.command(runtimeId, { type: 'fork', entryId: 'fixture-goal-summary' }), runtimes[0].runtimeId)
    const marker = join(fixtureRoot, 'branch-args.json')
    await expect.poll(() => existsSync(marker)).toBe(true)
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ type: 'branch', entryId: 'fixture-goal-summary' })
  })

  test('centers the compact context-usage dial', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const dial = page.locator('.context-usage-dial')
    await expect(dial).toBeVisible()
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('Refresh context usage')
    await composer.press('Enter')
    await expect(dial).toHaveText('12')
    await expect(dial).toHaveAttribute('title', '12,000 / 100,000 tokens \u00b7 $0.42 session cost')
    const offset = await dial.evaluate((node) => {
      const textNode = node.querySelector('span')?.firstChild
      if (!textNode) throw new Error('Missing context dial text')
      const dialRect = node.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(textNode)
      const textRect = range.getBoundingClientRect()
      return {
        x: (textRect.left + textRect.right - dialRect.left - dialRect.right) / 2,
        y: (textRect.top + textRect.bottom - dialRect.top - dialRect.bottom) / 2,
        size: dialRect.width,
      }
    })
    expect(offset.size).toBeCloseTo(26.4, 1)
    expect(Math.abs(offset.x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(offset.y)).toBeLessThanOrEqual(0.5)
  })

  test('reassembles base64 rpc_chunk frames into a transcript message', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('Send a chunked reply')
    await composer.press('Enter')
    await expect(page.locator('.transcript').getByText('Chunked fixture reply.')).toBeVisible()
    await expect(page.locator('.message--system')).toHaveCount(0)
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
    await expect(page.getByText(/OMP RPC exited|Request failed/)).toHaveCount(0)
  })

  test('picks, previews, and removes an image in the composer', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const imagePath = join(fixtureRoot, 'picker.png')
    writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))

    await page.getByRole('button', { name: 'Add context' }).click()
    const fileChooser = page.waitForEvent('filechooser')
    await page.getByRole('option', { name: /Add files/ }).click()
    await (await fileChooser).setFiles(imagePath)
    await expect(page.locator('.composer-attachment').filter({ hasText: 'picker.png' })).toBeVisible()
    await expect(page.locator('.composer p[role="status"]')).toHaveText('1 file attached.')
    await page.getByRole('button', { name: 'Remove picker.png' }).click()
    await expect(page.locator('.composer-attachment').filter({ hasText: 'picker.png' })).toHaveCount(0)
  })

  test('collapses composer selectors and keeps the checkout menu usable in a narrow conversation pane', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await page.locator('.conversation-column').evaluate((node) => {
      node.style.flex = '0 0 560px'
      const pane = node.querySelector<HTMLElement>('.conversation-pane')
      if (pane) pane.style.minWidth = '0'
    })

    const model = page.locator('.model-picker')
    const modelTrigger = model.locator('.model-picker__trigger')
    const reasoning = page.locator('.select-control').filter({ has: page.getByRole('combobox', { name: 'Reasoning effort' }) })
    await expect(modelTrigger.locator('span')).toHaveCSS('display', 'block')
    await expect(reasoning.locator('.select-control__chevron')).toHaveCSS('display', 'none')
    await expect(reasoning.getByRole('combobox')).toHaveCSS('opacity', '1')

    await page.locator('.conversation-column').evaluate((node) => { node.style.flex = '0 0 300px' })
    await expect(modelTrigger.locator('span')).toHaveCSS('display', 'none')
    await expect(modelTrigger.locator('svg').first()).not.toHaveCSS('display', 'none')
    await expect(reasoning.getByRole('combobox')).toHaveCSS('opacity', '0')
    await expect(reasoning.locator('.select-control__icon')).not.toHaveCSS('display', 'none')

    const controlBounds = await page.locator('.composer__footer').evaluate((footer) => {
      const controls = footer.querySelector<HTMLElement>('.composer__controls')!
      const actions = footer.querySelector<HTMLElement>('.composer__actions')!
      const controlsRect = controls.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      return { controlsRight: controlsRect.right, actionsLeft: actionsRect.left }
    })
    expect(controlBounds.controlsRight).toBeLessThanOrEqual(controlBounds.actionsLeft)

    await page.getByRole('button', { name: /^Checkout:/ }).click()
    const menuBounds = await page.getByRole('menu', { name: 'Git worktrees' }).evaluate((menu) => {
      const menuRect = menu.getBoundingClientRect()
      return { menuLeft: menuRect.left, menuRight: menuRect.right, menuWidth: menuRect.width, viewport: window.innerWidth }
    })
    // The menu opens rightward from the chip at usable width even in a narrow
    // composer, and always stays inside the window — never footer's width.
    expect(menuBounds.menuWidth).toBeGreaterThanOrEqual(300)
    expect(menuBounds.menuLeft).toBeGreaterThanOrEqual(-0.5)
    expect(menuBounds.menuRight).toBeLessThanOrEqual(menuBounds.viewport + 0.5)
  })

  test('loads the sandboxed preload bridge and hermetic service data', async () => {
    const bridge = await page.evaluate(() => {
      const bridge = (window as typeof window & { desktop?: Record<string, unknown> }).desktop
      const voice = bridge?.voice
      return { type: typeof bridge, groups: bridge ? Object.keys(bridge).sort() : [], voiceMethods: voice && typeof voice === 'object' ? Object.keys(voice).sort() : [] }
    })
    expect(bridge.type).toBe('object')
    expect(bridge.groups).toEqual(['agent', 'app', 'browser', 'git', 'plugins', 'projects', 'providers', 'schedules', 'sessions', 'settings', 'terminal', 'updates', 'voice'])
    expect(bridge.voiceMethods).toContain('testSelfHosted')
    const updateMenu = await app!.evaluate(({ Menu }) => {
      const parents = Menu.getApplicationMenu()?.items ?? []
      const parent = parents.find((item) => item.submenu?.items.some((child) => child.label === 'Check for Updates…'))
      return { found: Boolean(parent), parent: parent?.label, platform: process.platform }
    })
    expect(updateMenu.found).toBe(true)
    expect(updateMenu.parent).toBe(updateMenu.platform === 'darwin' ? 'OMP Desktop' : 'Help')
    await expect(page.evaluate(() => window.desktop.updates.getState())).resolves.toMatchObject({ phase: 'unsupported' })
    const credentialStatus = await page.evaluate(() => window.desktop.voice.credentialStatus())
    expect(typeof credentialStatus.storage.available).toBe('boolean')
    if (!credentialStatus.storage.available) expect(credentialStatus.storage.message).toMatch(/secure|credential|keyring|kwallet/i)
    const invalidSelfHostedTest = await page.evaluate(async () => {
      try { await window.desktop.voice.testSelfHosted({ url: '', model: '' }); return '' }
      catch (error) { return String(error) }
    })
    expect(invalidSelfHostedTest).toMatch(/too short|Invalid URL/)
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => !window.isVisible()))).toBe(true)
    await expect(page.locator('.sidebar__brand')).toHaveCount(0)
    await expect(page.locator('.sidebar__footer .sidebar-update')).toHaveCount(0)
    await expect(page.locator('.sidebar__footer button[title="Settings"]')).toBeVisible()
  })

  test('opens General settings when the main process requests Settings', async () => {
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Theme' })).toBeVisible()

    await app!.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('app:open-settings')
    })

    await expect(page.getByRole('heading', { name: 'Startup & background' })).toBeVisible()
  })

  test('uses the branch checkout picker after changing the global checkout style', async () => {
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('combobox', { name: 'Git checkout style' }).selectOption('branch')
    await page.getByRole('button', { name: 'Back to session' }).click()

    await page.getByRole('button', { name: /^Checkout:/ }).click()
    const branchMenu = page.getByRole('menu', { name: 'Git branches' })
    await expect(branchMenu).toBeVisible()
    await expect(branchMenu.getByRole('menuitemradio').filter({ hasText: 'feature/e2e' })).toBeVisible()
  })

  test('returns from settings with its back button, New session, Escape, and Ctrl+W', async () => {
    const openSettings = async () => {
      await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
      await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
    }

    await openSettings()
    await page.getByRole('button', { name: 'Back to session' }).click()
    await expect(page.getByRole('combobox', { name: 'Message OMP' })).toBeVisible()

    await openSettings()
    await page.locator('.sidebar__primary').getByRole('button', { name: /^New session/ }).click()
    await expect(page.getByRole('combobox', { name: 'Message OMP' })).toBeVisible()

    await openSettings()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('combobox', { name: 'Message OMP' })).toBeVisible()

    await openSettings()
    await page.keyboard.press('Control+w')
    await expect(page.getByRole('combobox', { name: 'Message OMP' })).toBeVisible()
  })

  test('keeps the application shell fixed when focus reveals root overflow', async () => {
    const layout = await page.evaluate(() => {
      const root = document.getElementById('root')
      const shell = document.querySelector<HTMLElement>('.app-shell')
      if (!root || !shell) throw new Error('Application shell is missing')

      const probe = document.createElement('button')
      probe.type = 'button'
      probe.textContent = 'Root overflow focus probe'
      root.append(probe)

      try {
        const initialShellTop = shell.getBoundingClientRect().top
        probe.focus()
        probe.scrollIntoView({ block: 'end' })
        return {
          activeElement: document.activeElement === probe,
          clientHeight: root.clientHeight,
          overflow: getComputedStyle(root).overflow,
          scrollHeight: root.scrollHeight,
          scrollTop: root.scrollTop,
          initialShellTop,
          shellTop: shell.getBoundingClientRect().top,
        }
      } finally {
        probe.remove()
      }
    })

    expect(layout.activeElement).toBe(true)
    expect(layout.overflow).toBe('clip')
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight)
    expect(layout.scrollTop).toBe(0)
    expect(layout.shellTop).toBe(layout.initialShellTop)
  })

  test('lists the OMP session catalog and opens a saved thread', async () => {
    await expect(page.locator('.sidebar__brand')).toHaveCount(0)
    await expect(page.locator('.session-row__title').filter({ hasText: 'Hermetic desktop fixture' })).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'Primary workspace fixture' })).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Scheduled' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Capabilities' })).toBeVisible()
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    await expect(page.getByRole('main').getByText('OMP fixture reply.')).toBeVisible()
  })

  test('wraps an unbroken user-message token inside its chat bubble', async () => {
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()

    const bubble = page.locator('.user-bubble').filter({ hasText: ISSUE_131_LONG_TOKEN })
    await expect(bubble).toBeVisible()
    const dimensions = await bubble.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
  })

  test('searches and filters the custom model picker by provider', async () => {
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()

    const picker = page.locator('.model-picker')
    await picker.locator('.model-picker__trigger').click()
    const search = picker.getByRole('combobox', { name: 'Search models' })
    await expect(search).toBeFocused()
    await picker.locator('.model-picker__providers').getByRole('button', { name: 'anthropic', exact: true }).click()
    await expect(picker.getByRole('option', { name: /Claude Fixture/ })).toHaveCount(1)
    await expect(picker.getByRole('option', { name: /GPT Fixture/ })).toHaveCount(0)

    await search.fill('gpt')
    await expect(picker.getByText('No models match this search.')).toBeVisible()
    await picker.locator('.model-picker__providers').getByRole('button', { name: 'All', exact: true }).click()
    await expect(picker.getByRole('option', { name: /GPT Fixture/ })).toHaveCount(1)
  })

  test('persists a desktop-only OMP provider toggle and removes its models from the picker', async () => {
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    const modelNamesBefore = await page.evaluate(async () => {
      const catalog = await window.desktop.providers.catalog(true, 'omp')
      const enabledProviders = new Set(catalog.providers.filter((provider) => provider.enabled).map((provider) => provider.id))
      return catalog.models.filter((model) => model.available && model.enabled !== false && enabledProviders.has(model.provider)).map((model) => model.name)
    })
    expect(modelNamesBefore.sort()).toEqual(['Claude Fixture', 'GPT Fixture'])
    const anthropic = page.getByRole('checkbox', { name: 'Show anthropic provider' })
    await expect(anthropic).toBeChecked()
    await page.getByTitle('Hide provider in OMP').filter({ has: anthropic }).click()
    await expect(anthropic).not.toBeChecked()
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledProviders).toEqual(['anthropic'])
    const modelNamesAfter = await page.evaluate(async () => {
      const catalog = await window.desktop.providers.catalog(true, 'omp')
      const enabledProviders = new Set(catalog.providers.filter((provider) => provider.enabled).map((provider) => provider.id))
      return catalog.models.filter((model) => model.available && model.enabled !== false && enabledProviders.has(model.provider)).map((model) => model.name)
    })
    expect(modelNamesAfter).toEqual(['GPT Fixture'])

    await page.getByRole('button', { name: 'Back to session' }).click()
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    const modelPicker = page.locator('.model-picker')
    await modelPicker.locator('.model-picker__trigger').click()
    await expect(modelPicker.getByRole('option', { name: /GPT Fixture/ })).toHaveCount(1)
    await expect(modelPicker.getByRole('option', { name: /Claude Fixture/ })).toHaveCount(0)
  })

  test('persists an OMP model toggle and removes only that model from every picker', async () => {
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    await page.getByRole('tab', { name: /Models/ }).click()

    const toggle = page.getByRole('checkbox', { name: 'Show GPT Fixture model' })
    const groupHeader = page.locator('.provider-model-group__heading[aria-controls="provider-models-openai-codex"]')
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'true')
    await groupHeader.click()
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeHidden()
    await groupHeader.click()
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toBeVisible()
    await expect(toggle).toBeChecked()
    const row = page.locator('.provider-model-row').filter({ has: toggle })
    await expect(row.locator('.provider-model-row__capabilities')).toBeVisible()
    await expect(row.locator('.provider-model-row__toggle')).toBeVisible()
    await row.locator('.provider-model-row__toggle').click()
    await expect(toggle).not.toBeChecked()
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledModels).toEqual(['openai-codex/gpt-fixture'])
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledProviders).toEqual(['openai-codex'])
    const groups = page.locator('.provider-model-group')
    await expect(groups.nth(0)).toContainText('Claude Fixture')
    await expect(groups.nth(1)).toContainText('GPT Fixture')

    const visibleModelNames = await page.evaluate(async () => {
      const catalog = await window.desktop.providers.catalog(true, 'omp')
      const enabledProviders = new Set(catalog.providers.filter((provider) => provider.enabled).map((provider) => provider.id))
      return catalog.models.filter((model) => model.available && model.enabled !== false && enabledProviders.has(model.provider)).map((model) => model.name)
    })
    expect(visibleModelNames).toEqual(['Claude Fixture'])
    await page.getByRole('button', { name: 'Back to session' }).click()
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    const modelPicker = page.locator('.model-picker')
    await modelPicker.locator('.model-picker__trigger').click()
    await expect(modelPicker.getByRole('option', { name: /GPT Fixture/ })).toHaveCount(0)
    await expect(modelPicker.getByRole('option', { name: /Claude Fixture/ })).toHaveCount(1)

    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    await page.getByRole('tab', { name: /Models/ }).click()
    const hiddenToggle = page.getByRole('checkbox', { name: 'Show GPT Fixture model' })
    await page.locator('.provider-model-row').filter({ has: hiddenToggle }).locator('.provider-model-row__toggle').click()
    await expect(hiddenToggle).toBeChecked()
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledModels).toEqual([])
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledProviders).toEqual([])
    await page.getByRole('tab', { name: /Providers/ }).click()
    await expect(page.getByRole('checkbox', { name: 'Show openai-codex provider' })).toBeChecked()
  })

  test('refreshes harness discovery through the live settings and preload path', async () => {
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Harness', exact: true }).click()

    const refresh = page.getByRole('button', { name: 'Refresh harnesses' })
    await expect(refresh).toBeVisible()
    await refresh.click()
    await expect(refresh).toBeEnabled()
    await expect(page.getByText('OMP is ready', { exact: true })).toBeVisible()

    const result = await page.evaluate(() => window.desktop.app.refreshHarnesses())
    expect(result.meta.harnesses.omp.path).toBeTruthy()
    expect(result.settings.activeHarness).toBe('omp')
  })

  test('connects to OMP after it is installed while the app is open', async () => {
    await expect(page.getByRole('heading', { name: 'OMP is not installed' })).toBeVisible()
    await page.getByRole('button', { name: 'Take me there' }).click()
    await expect(page.getByRole('heading', { name: 'Harness', exact: true, level: 1 })).toBeVisible()
    await expect(page.getByText('OMP not detected', { exact: true })).toBeVisible()

    renameSync(join(fixtureRoot, 'omp-fixture.cjs.pending'), join(fixtureRoot, 'omp-fixture.cjs'))
    await page.getByRole('button', { name: 'Refresh harnesses' }).click()
    await expect(page.getByText('OMP is ready', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Back to session' }).click()
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('Connect to the newly installed harness')
    await composer.press('Enter')
    await expect.poll(() => existsSync(join(fixtureRoot, 'omp-runtime-args.json'))).toBe(true)
  })

  test('opens Harness settings from the no-harness recovery prompt', async () => {
    await expect(page.getByRole('heading', { name: 'OMP is not installed' })).toBeVisible()
    await expect(page.getByText('Install it to get started.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Take me there' }).click()
    await expect(page.getByRole('heading', { name: 'Harness', exact: true, level: 1 })).toBeVisible()
    const refresh = page.getByRole('button', { name: 'Refresh harnesses' })
    await expect(refresh).toBeVisible()
    await expect(page.getByLabel('OMP executable override')).toBeVisible()
    await refresh.click()
    await expect(refresh).toBeEnabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('keeps thread order stable and mutes acknowledged failure indicators', async () => {
    const titles = page.locator('.session-row__title')
    await expect(titles.nth(0)).toHaveText('Hermetic desktop fixture')
    await expect(titles.nth(1)).toHaveText('Primary workspace fixture')
    const primaryFile = fixturePrimarySessionFile
    appendFileSync(primaryFile, `${JSON.stringify({
      type: 'message', id: 'primary-background-assistant', parentId: 'primary-message', timestamp: '2027-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: 'Background work failed.', stopReason: 'error' },
    })}\n`)

    const primaryRow = page.locator('.session-row-wrap').filter({ hasText: 'Primary workspace fixture' })
    await expect(primaryRow).toHaveClass(/has-attention/)
    const activityCount = page.locator('.sidebar__primary button[title="Activity"] .nav-count')
    await expect(activityCount).toHaveText('1')
    await expect(titles.nth(0)).toHaveText('Hermetic desktop fixture')
    const attentionColor = await primaryRow.evaluate((node) => getComputedStyle(node).backgroundColor.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [])
    expect(attentionColor.length).toBeGreaterThanOrEqual(3)
    expect(attentionColor[2]).toBeGreaterThan(attentionColor[1])

    const failureMark = primaryRow.locator('.session-status-mark--failed')
    const activeFailureColor = await failureMark.locator('> span').evaluate((node) => getComputedStyle(node).backgroundColor)

    await primaryRow.locator('.session-row').click()
    await expect(primaryRow).not.toHaveClass(/has-attention/)
    await expect(primaryRow).toHaveClass(/session-row-wrap--failed/)
    await expect(failureMark).toHaveAttribute('title', 'Failed — notification cleared')
    await expect.poll(() => failureMark.locator('> span').evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(activeFailureColor)
    await expect(activityCount).toHaveCount(0)
    appendFileSync(primaryFile, `${JSON.stringify({
      type: 'message', id: 'primary-new-user', parentId: 'primary-background-assistant', timestamp: '2028-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Move this thread now.' },
    })}\n`)
    await expect(titles.nth(0)).toHaveText('Primary workspace fixture')
  })

  test('clears individual and all Activity notifications persistently', async () => {
    await page.getByRole('button', { name: 'Activity', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
    const primaryActivity = page.locator('.activity-row').filter({ hasText: 'Primary workspace fixture' })
    const fixtureActivity = page.locator('.activity-row').filter({ hasText: 'Hermetic desktop fixture' })
    await expect(primaryActivity).toBeVisible()
    await expect(fixtureActivity).toBeVisible()

    const clearPrimary = primaryActivity.getByRole('button', { name: 'Clear Primary workspace fixture activity' })
    await primaryActivity.hover()
    await expect(clearPrimary).toHaveCSS('opacity', '1')
    await clearPrimary.click()
    await expect(primaryActivity).toHaveCount(0)
    await expect(fixtureActivity).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const cleared = JSON.parse(window.localStorage.getItem('omp-desktop.cleared-activity') ?? '{}') as Record<string, string>
      return cleared['primary-session']
    })).toBeTruthy()

    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
    await page.getByRole('button', { name: 'Activity', exact: true }).click()
    await expect(page.locator('.activity-row').filter({ hasText: 'Primary workspace fixture' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear all' }).click()
    await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible()
  })

  test('deletes conversations from disk and Activity and clears notifications', async () => {
    const primaryFile = fixturePrimarySessionFile
    appendFileSync(primaryFile, `${JSON.stringify({
      type: 'message', id: 'primary-archive-failure', parentId: 'primary-message', timestamp: '2027-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: 'Archive this failed work.', stopReason: 'error' },
    })}\n`)

    const primaryRow = page.locator('.session-row-wrap').filter({ hasText: 'Primary workspace fixture' })
    await expect(primaryRow).toHaveClass(/has-attention/)
    const activityCount = page.locator('.sidebar__primary button[title="Activity"] .nav-count')
    await expect(activityCount).toHaveText('1')

    await primaryRow.getByTitle('Delete Primary workspace fixture').click()
    await page.getByRole('button', { name: 'Delete permanently', exact: true }).click()
    expect(existsSync(primaryFile)).toBe(false)
    await expect(primaryRow).toHaveCount(0)
    await expect(activityCount).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => {
      const cleared = JSON.parse(window.localStorage.getItem('omp-desktop.cleared-session-attention') ?? '{}') as Record<string, string>
      return cleared['primary-session']
    })).toBeTruthy()

    await page.getByRole('button', { name: 'Activity', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
    await expect(page.getByText('Primary workspace fixture', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Archived', exact: true })).toHaveCount(0)
  })

  test('destroys an open session browser guest when its thread is deleted', async () => {
    const sessionRow = page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' })
    await sessionRow.locator('.session-row').click()
    await page.getByRole('tab', { name: 'Browser' }).click()
    const preview = page.locator('.browser-preview webview[partition="persist:omp-desktop-browser"]')
    await expect(preview).toHaveCount(1)
    await expect.poll(() => preview.evaluate(async (node) => {
      const webview = node as HTMLElement & {
        executeJavaScript(script: string): Promise<unknown>
        getWebContentsId(): number
      }
      await webview.executeJavaScript('window.__fixtureGameTimer = setInterval(() => {}, 10)')
      return webview.getWebContentsId()
    })).toBeGreaterThan(0)
    const guestId = await preview.evaluate((node) => (node as HTMLElement & { getWebContentsId(): number }).getWebContentsId())
    expect(await app!.evaluate(({ webContents }, id) => Boolean(webContents.fromId(id)), guestId)).toBe(true)

    await sessionRow.getByTitle('Delete Hermetic desktop fixture').click()
    await page.getByRole('button', { name: 'Delete permanently', exact: true }).click()

    await expect(sessionRow).toHaveCount(0)
    await expect.poll(() => app!.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id)
      return guest === undefined || guest.isDestroyed()
    }, guestId)).toBe(true)
    await expect.poll(() => preview.evaluate((node) => (node as HTMLElement & { getWebContentsId(): number }).getWebContentsId())).not.toBe(guestId)
  })

  test('stops a dev server launched from the thread terminal when deleted', async () => {
    const sessionRow = page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' })
    await sessionRow.locator('.session-row').click()
    await page.getByLabel(/Toggle terminal/).click()
    const terminal = page.locator('.terminal-drawer:not([hidden])')
    const input = terminal.locator('.xterm-helper-textarea')
    await expect(input).toBeVisible()
    const pidFile = join(fixtureRoot, 'archived-dev-server.pid')
    await input.click()
    await page.keyboard.type(`/bin/sh -c 'echo $$ > ${pidFile}; while true; do /bin/sleep 1; done'`)
    await page.keyboard.press('Enter')
    await expect.poll(() => existsSync(pidFile)).toBe(true)
    const serverPid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(serverPid).toBeGreaterThan(0)

    try {
      await sessionRow.getByTitle('Delete Hermetic desktop fixture').click()
      await page.getByRole('button', { name: 'Delete permanently', exact: true }).click()

      await expect(sessionRow).toHaveCount(0)
      await expect(page.locator('.terminal-drawer')).toHaveCount(0)
      await expect.poll(() => {
        try { process.kill(serverPid, 0); return false } catch { return true }
      }).toBe(true)
    } finally {
      try { process.kill(serverPid, 'SIGKILL') } catch { /* archive cleanup succeeded */ }
    }
  })

  test('enforces the live preload and IPC frame boundaries', async () => {
    const initialMeta = await page.evaluate(() => window.desktop.app.getMeta())
    expect(initialMeta.version).toBeTruthy()

    await page.evaluate(() => { window.location.hash = 'cfr-11-safe-fragment' })
    await expect(page).toHaveURL(/#cfr-11-safe-fragment$/)
    const fragmentMeta = await page.evaluate(() => window.desktop.app.getMeta())
    expect(fragmentMeta).toEqual(initialMeta)

    await page.evaluate(() => {
      const iframe = document.createElement('iframe')
      iframe.name = 'untrusted-subframe'
      iframe.srcdoc = '<!doctype html><title>Untrusted subframe</title>'
      document.body.append(iframe)
    })
    await expect.poll(() => Boolean(page.frame({ name: 'untrusted-subframe' }))).toBe(true)
    const subframe = page.frame({ name: 'untrusted-subframe' })
    expect(subframe).not.toBeNull()
    await subframe!.waitForLoadState()
    expect(await subframe!.evaluate(() => typeof (window as Window & { desktop?: unknown }).desktop)).toBe('undefined')

    const deniedUrl = 'data:text/html,<title>Untrusted renderer</title><main>untrusted</main>'
    await app!.evaluate(async ({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Expected the OMP Desktop window')
      await window.loadURL(url)
    }, deniedUrl)
    await expect(page).toHaveURL(/^data:text\/html,/)
    const deniedAccess = await page.evaluate(async () => {
      const bridge = (window as Window & { desktop?: typeof window.desktop }).desktop
      if (!bridge) return { bridge: 'undefined', result: 'unavailable' }
      try {
        await bridge.app.getMeta()
        return { bridge: 'object', result: 'resolved' }
      } catch (error) {
        return { bridge: 'object', result: error instanceof Error ? error.message : String(error) }
      }
    })
    expect(deniedAccess.bridge).toBe('object')
    expect(deniedAccess.result).toMatch(/IPC sender is not authorized/i)
  })

  test('reflects an external JSONL append without reselecting the live session', async () => {
    await expect(page.locator('.transcript').getByText('Hermetic desktop fixture', { exact: true })).toBeVisible()
    const selectedSession = page.locator('.session-row-wrap.is-selected')
    await expect(selectedSession).toHaveCount(1)

    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const reasoning = `External live reasoning ${nonce}`
    const answer = `External live answer ${nonce}`
    const timestamp = new Date().toISOString()
    appendFileSync(fixtureSessionFile, `${JSON.stringify({
      type: 'message',
      id: `fixture-external-${nonce}`,
      parentId: 'fixture-goal-summary',
      timestamp,
      message: {
        role: 'assistant',
        timestamp,
        content: [
          { type: 'thinking', thinking: reasoning },
          { type: 'toolCall', id: `fixture-tool-${nonce}`, name: 'fixture_external_tool', arguments: { nonce } },
          { type: 'text', text: answer },
        ],
      },
    })}
`)

    await expect(page.locator('.transcript').getByText(answer, { exact: true })).toHaveCount(1)
    const disclosure = page.locator('.work-disclosure__button')
    await expect(disclosure).toHaveCount(1)
    await disclosure.click()
    await expect(page.locator('.transcript .reasoning-disclosure .prose').getByText(reasoning, { exact: true })).toHaveCount(1)
    await expect(page.locator('.activity-line--tool')).toContainText('fixture_external_tool')
    await expect(selectedSession).toHaveCount(1)
  })

  test('keeps session options visible and starts a new session from a hovered project', async () => {
    const sessionOptions = page.locator('.session-row__more').first()
    await expect(sessionOptions).toBeVisible()
    await expect.poll(() => sessionOptions.evaluate((node) => getComputedStyle(node).opacity)).toBe('1')

    const projectRow = page.locator('.project-row').first()
    const projectSession = projectRow.getByRole('button', { name: /^New session in / })
    await expect.poll(() => projectSession.evaluate((node) => getComputedStyle(node).opacity)).toBe('0')
    await expect.poll(async () => {
      await projectRow.hover()
      return projectSession.evaluate((node) => getComputedStyle(node).opacity)
    }).toBe('1')
    await projectSession.click()

    await expect(projectRow).toHaveClass(/is-selected/)
    await expect(page.locator('.session-row-wrap.is-selected')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Message OMP' })).toHaveValue('')
  })

  test('keeps wrapped editing native and aligned through classic scrollbar overflow', async () => {
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await page.addStyleTag({ content: `
      .composer-input > textarea { overflow-y: scroll !important; }
      .composer-input > textarea::-webkit-scrollbar { width: 28px; }
    ` })

    await composer.fill('@Ownership')
    const reference = page.getByRole('option', { name: /@Ownership peer fixture/ })
    await expect(reference).toBeVisible()
    await expect(composer).toHaveAttribute('aria-autocomplete', 'list')
    await reference.click()

    const longToken = 'unbroken-token-'.repeat(18)
    const draft = `@Ownership peer fixture\nFirst wrapped line ${'with words '.repeat(22)}\nEDITME ${longToken}\n${'final line '.repeat(30)}`
    await composer.fill(draft)
    const editStart = draft.indexOf('EDITME')
    await composer.evaluate((element, start) => {
      const textarea = element as HTMLTextAreaElement
      textarea.focus()
      textarea.setSelectionRange(start, start + 'EDITME'.length)
    }, editStart)
    await composer.pressSequentially('replacement')
    await expect(composer).toHaveValue(draft.replace('EDITME', 'replacement'))

    const layout = await composer.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement
      textarea.scrollTop = textarea.scrollHeight
      textarea.dispatchEvent(new Event('scroll'))
      const style = getComputedStyle(textarea)
      return {
        hasVerticalOverflow: textarea.scrollHeight > textarea.clientHeight,
        scrollbarWidth: textarea.offsetWidth - textarea.clientWidth,
        scrollTop: textarea.scrollTop,
        color: style.color,
        textFillColor: style.webkitTextFillColor,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
        mirrorCount: textarea.parentElement?.querySelectorAll('.composer-input__highlight').length ?? -1,
      }
    })
    expect(layout.hasVerticalOverflow).toBe(true)
    expect(layout.scrollbarWidth).toBeGreaterThanOrEqual(24)
    expect(layout.scrollTop).toBeGreaterThan(0)
    expect(layout.selectionStart).toBe(layout.selectionEnd)
    expect(layout.color).not.toBe('rgba(0, 0, 0, 0)')
    expect(layout.textFillColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(layout.mirrorCount).toBe(0)

    await page.emulateMedia({ forcedColors: 'active' })
    const forcedColorText = await composer.evaluate((element) => {
      const style = getComputedStyle(element)
      return { color: style.color, textFillColor: style.webkitTextFillColor }
    })
    expect(forcedColorText.color).not.toBe('rgba(0, 0, 0, 0)')
    expect(forcedColorText.textFillColor).not.toBe('rgba(0, 0, 0, 0)')
  })

  test('copies a session id and routes an @session mention without exposing its UUID block', async () => {
    await page.evaluate(() => {
      const target = window as Window & { __copiedSessionId?: string }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { target.__copiedSessionId = text } },
      })
    })
    const selected = page.locator('.session-row-wrap.is-selected .session-row')
    await selected.click({ button: 'right' })
    const sessionMenu = page.getByLabel('Session options')
    await sessionMenu.getByRole('button', { name: 'Copy session UUID' }).click()
    await expect.poll(() => page.evaluate(() => (window as Window & { __copiedSessionId?: string }).__copiedSessionId)).toBe('fixture-session')

    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('Coordinate with @Ownership')
    const reference = page.getByRole('option', { name: /@Ownership peer fixture/ })
    await expect(reference).toBeVisible()
    await reference.click()
    const caret = await composer.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement
      return { start: textarea.selectionStart, end: textarea.selectionEnd, length: textarea.value.length }
    })
    expect(caret).toEqual({ start: caret.length, end: caret.length, length: caret.length })
    await expect(composer).toHaveAttribute('aria-expanded', 'false')
    await composer.pressSequentially('about ownership')
    await expect(composer).toHaveValue('Coordinate with @Ownership peer fixture about ownership')
    await composer.press('Enter')

    const marker = join(fixtureRoot, 'prompt-args.json')
    await expect.poll(() => existsSync(marker)).toBe(true)
    const sent = JSON.parse(readFileSync(marker, 'utf8')) as { message: string }
    expect(sent.message).toContain('Coordinate with @Ownership peer fixture about ownership')
    expect(sent.message).toContain('omp session UUID 019fdf24-cccc-7000-8000-000000000003')
    expect(sent.message).toContain('===== BEGIN GOOEYPI SESSION REFERENCES =====')
    appendFileSync(fixtureSessionFile, `${JSON.stringify({
      type: 'message', id: 'fixture-session-reference', parentId: 'fixture-goal-summary', timestamp: new Date().toISOString(),
      message: { role: 'user', content: sent.message, timestamp: new Date().toISOString() },
    })}\n`)
    await page.locator('.session-row-wrap').filter({ hasText: 'Ownership peer fixture' }).locator('.session-row').click()
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const userMessage = page.locator('.message--user').filter({ hasText: 'Coordinate with @Ownership peer fixture about ownership' })
    await expect(userMessage).toBeVisible()
    await expect(userMessage).not.toContainText('019fdf24-cccc-7000-8000-000000000003')
    await expect(userMessage).not.toContainText('GOOEYPI SESSION REFERENCES')
    const linkedMention = userMessage.getByRole('button', { name: 'Open session Ownership peer fixture' })
    await expect(linkedMention).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(linkedMention).toHaveCSS('border-top-width', '0px')
    await linkedMention.click()
    await expect(page.locator('.session-row-wrap').filter({ hasText: 'Ownership peer fixture' })).toHaveClass(/is-selected/)
  })

  test('removes a project from the sidebar through its context menu', async () => {
    const projectRow = page.locator('.project-row').first()
    await expect(projectRow).toBeVisible()
    await expect(page.locator('.sidebar__primary .lucide-notebook-pen')).toHaveCount(1)
    await expect(page.locator('.project-row__new-session .lucide-notebook-pen')).toHaveCount(1)
    await expect(page.locator('.sidebar__section-heading .lucide-folder-plus')).toHaveCount(1)
    await expect(page.getByTitle('New session (⌘N)')).toHaveCount(2)
    await expect(page.getByTitle('Add project')).toHaveCount(1)
    await expect(projectRow.getByTitle('New session in Multi-folder fixture')).toHaveCount(1)
    await expect(page.getByTitle('Delete Hermetic desktop fixture')).toHaveCount(1)

    await projectRow.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Project options for Multi-folder fixture' })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Remove project' }).click()

    const dialog = page.getByRole('dialog', { name: 'Remove project' })
    await expect(dialog).toContainText('The folder and saved sessions will not be deleted.')
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.locator('.project-row')).toHaveCount(0)
    expect(existsSync(join(fixtureRoot, 'project'))).toBe(true)
  })

  test('renders agent handoffs and goal summaries as collapsed readable disclosures', async () => {
    const agentDisclosure = page.getByRole('button', { name: 'Message from agent: fixture-reviewer' })
    const goalDisclosure = page.getByRole('button', { name: 'Goal summary' })
    await expect(agentDisclosure).toHaveAttribute('aria-expanded', 'false')
    await expect(goalDisclosure).toHaveAttribute('aria-expanded', 'false')

    await agentDisclosure.click()
    await goalDisclosure.click()
    await expect(page.locator('.agent-message__content')).toContainText('Fixture review complete.')
    await expect(page.locator('.goal-message__content')).toContainText('Verify the readable blue goal summary.')
    await expect(page.getByText(/Envelope metadata|Fixture control envelope/)).toHaveCount(0)
  })

  test('copies a specific user or agent message from the action directly below it', async () => {
    await page.evaluate(() => {
      const target = window as Window & { __copiedMessage?: string }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { target.__copiedMessage = text } },
      })
    })

    const userMessage = page.locator('.message--user').filter({ hasText: 'Hermetic desktop fixture' })
    await userMessage.hover()
    const userCopy = userMessage.locator('.message-actions button')
    await expect(userCopy).toHaveAccessibleName('Copy user message')
    await expect(userCopy).toBeVisible()
    await userCopy.click()
    await expect(userCopy).toHaveAccessibleName('Copied user message')
    await expect.poll(() => page.evaluate(() => (window as Window & { __copiedMessage?: string }).__copiedMessage)).toBe('Hermetic desktop fixture')

    const agentMessage = page.locator('.message--agent')
    await expect(agentMessage.getByRole('button', { name: 'Copy agent message' })).toHaveCount(0)
    await agentMessage.getByRole('button', { name: 'Message from agent: fixture-reviewer' }).click()
    await agentMessage.hover()
    const agentCopy = agentMessage.locator('.message-actions button')
    await expect(agentCopy).toHaveAccessibleName('Copy agent message')
    await expect(agentCopy).toBeVisible()
    await agentCopy.click()
    await expect(agentCopy).toHaveAccessibleName('Copied agent message')
    await expect.poll(() => page.evaluate(() => (window as Window & { __copiedMessage?: string }).__copiedMessage)).toBe('Fixture review complete. The readable agent response is available here.')
  })

  test('navigates all primary workspace pages and command palette', async () => {
    for (const destination of ['Projects', 'Activity', 'Scheduled', 'Capabilities']) {
      await page.getByRole('button', { name: destination, exact: true }).click()
      await expect(page.locator('.page')).toBeVisible()
      if (destination === 'Capabilities') {
        await expect(page.locator('.feature-strip')).toHaveCount(0)
        await expect(page.locator('.directory-tools')).toBeVisible()
        const askUserToggle = page.getByRole('button', { name: 'Enable Ask user' })
        await expect(askUserToggle).toHaveAttribute('aria-pressed', 'false')
        await askUserToggle.click()
        await expect(page.getByRole('button', { name: 'Disable Ask user' })).toHaveAttribute('aria-pressed', 'true')
        await page.getByRole('button', { name: 'Disable Ask user' }).click()
        const askUserConfirmation = page.getByRole('dialog', { name: 'Disable Ask user?' })
        await expect(askUserConfirmation).toContainText('Are you sure?')
        await askUserConfirmation.getByRole('button', { name: 'Yes, disable' }).click()
        await expect(page.getByRole('button', { name: 'Enable Ask user' })).toHaveAttribute('aria-pressed', 'false')
        await page.getByRole('button', { name: 'Enable Ask user' }).click()
        await expect(page.getByRole('button', { name: 'Disable Ask user' })).toHaveAttribute('aria-pressed', 'true')
        const browserToggle = page.getByRole('button', { name: 'Disable Browser' })
        await browserToggle.click()
        const browserConfirmation = page.getByRole('dialog', { name: 'Disable Browser?' })
        await browserConfirmation.getByRole('button', { name: 'Cancel' }).click()
        await expect(page.getByRole('button', { name: 'Disable Browser' })).toHaveAttribute('aria-pressed', 'true')
        const computerUseToggle = page.getByRole('button', { name: 'Enable Computer Use | TryCUA' })
        await expect(computerUseToggle).toHaveAttribute('aria-pressed', 'false')
        await computerUseToggle.click()
        await expect(page.getByRole('button', { name: 'Disable Computer Use | TryCUA' })).toHaveAttribute('aria-pressed', 'true')
        await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.computerUseEnabled).toBe(true)
        await page.getByRole('button', { name: 'Add', exact: true }).click()
        const addDialog = page.getByRole('dialog', { name: 'Add a OMP capability' })
        await expect(addDialog.getByText('Add MCP', { exact: true })).toBeVisible()
        await expect(addDialog.getByText('Add Plugin', { exact: true })).toBeVisible()
        await expect(addDialog.getByText('Add Extension', { exact: true })).toBeVisible()
        await expect(addDialog.getByText(/Not every third-party package, plugin, or extension will work in OMP Desktop/)).toBeVisible()
        await addDialog.getByRole('button', { name: /Add MCP/ }).click()
        const mcpForm = page.getByRole('dialog', { name: 'Add MCP server' })
        await expect(mcpForm.getByLabel('Server name')).toBeVisible()
        await expect(mcpForm.getByText('Authentication', { exact: true })).toHaveCount(0)
        await mcpForm.getByRole('button', { name: 'Close' }).click()
      }
    }
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    await expect(page.getByLabel('Search providers')).toBeVisible()
    await expect(page.locator('.provider-row')).not.toHaveCount(0)
    await page.getByRole('button', { name: /Hide all/, exact: true }).click()
    await expect(page.getByRole('button', { name: /Show all/, exact: true })).toBeVisible()
    await expect(page.locator('.provider-row input[type="checkbox"]:checked')).toHaveCount(0)
    await page.getByRole('tab', { name: /Models/ }).click()
    await expect(page.getByLabel('Search models')).toBeVisible()
    await expect(page.locator('.provider-model-row')).not.toHaveCount(0)
    await page.getByRole('button', { name: 'Harness', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: /Show reasoning summaries/ })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: /Show tool calls/ })).toBeChecked()
    await page.keyboard.press('Meta+K')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('shows externally managed OMP MCP servers without inspecting authorization', async () => {
    await page.getByRole('button', { name: 'Capabilities', exact: true }).click()
    const notion = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Notion', exact: true }) })
    await expect(notion).toBeVisible()
    await expect(notion).toContainText('Managed outside OMP Desktop')
    await expect(notion.getByLabel('Externally managed Notion')).toBeVisible()
    await expect(notion.getByRole('button', { name: 'Disable Notion' })).toHaveCount(0)
    const notionBox = await notion.boundingBox()
    const controlBox = await notion.getByLabel('Externally managed Notion').boundingBox()
    if (!notionBox || !controlBox) throw new Error('Notion capability controls did not render')
    expect(Math.abs(notionBox.x + notionBox.width - controlBox.x - controlBox.width)).toBeLessThanOrEqual(6)
    expect(JSON.parse(readFileSync(join(fixtureRoot, 'home', '.omp', 'agent', 'mcp.json'), 'utf8')).mcpServers.Notion.url).toBe('https://mcp.notion.test/mcp')
  })

  test('adds, disables, and removes local OMP MCP servers in the native mcp.json layout', async () => {
    await page.getByRole('button', { name: 'Capabilities', exact: true }).click()
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const chooser = page.getByRole('dialog', { name: 'Add a OMP capability' })
    await chooser.getByRole('button', { name: /Add MCP/ }).click()
    const addDialog = page.getByRole('dialog', { name: 'Add MCP server' })
    await addDialog.getByLabel('Server name').fill('docs')
    await addDialog.getByLabel('Executable').fill('mcp-docs')
    await addDialog.getByLabel(/Arguments/).fill('--local')
    await addDialog.getByRole('button', { name: 'Save local server' }).click()
    const mcpPath = join(fixtureRoot, 'home', '.omp', 'agent', 'mcp.json')
    await expect.poll(() => existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.docs : null).toEqual({ type: 'stdio', command: 'mcp-docs', args: ['--local'], enabled: true })
    await addDialog.getByRole('button', { name: 'Close' }).click()

    const docs = page.locator('article').filter({ has: page.getByRole('heading', { name: 'docs', exact: true }) })
    await expect(docs).toBeVisible()
    await docs.getByRole('button', { name: 'Disable docs' }).click()
    const confirmation = page.getByRole('dialog', { name: 'Disable docs?' })
    await expect(confirmation).toContainText('Are you sure?')
    await confirmation.getByRole('button', { name: 'Yes, disable' }).click()
    await expect.poll(() => JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.docs.enabled).toBe(false)
    await docs.getByRole('button', { name: 'Enable docs' }).click()
    await expect.poll(() => JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.docs.enabled).toBe(true)
    await docs.getByRole('button', { name: 'Remove docs' }).click()
    const removal = page.getByRole('dialog', { name: 'Remove docs?' })
    await removal.getByRole('button', { name: 'Yes, remove completely' }).click()
    await expect.poll(() => JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.docs).toBeUndefined()
  })

  test('installs and disables an OMP plugin package through the omp CLI', async () => {
    await page.getByRole('button', { name: 'Capabilities', exact: true }).click()
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const chooser = page.getByRole('dialog', { name: 'Add a OMP capability' })
    await chooser.getByRole('button', { name: /Add Plugin/ }).click()
    const pluginDialog = page.getByRole('dialog', { name: 'Add omp plugin' })
    await pluginDialog.getByLabel(/plugin source/).fill('fixture-tools@marketplace')
    await pluginDialog.getByRole('button', { name: 'Install plugin' }).click()
    await expect(pluginDialog.getByRole('status')).toContainText(/ok|installed|fixture/i)
    await pluginDialog.getByRole('button', { name: 'Close' }).click()

    const pluginRow = page.locator('article').filter({ has: page.getByRole('heading', { name: 'fixture-tools', exact: true }) })
    await expect(pluginRow).toBeVisible()
    await expect(pluginRow).toContainText('Fixture OMP plugin package.')
    const lockPath = join(fixtureRoot, 'home', '.omp', 'plugins', 'omp-plugins.lock.json')
    await pluginRow.getByRole('button', { name: 'Disable fixture-tools' }).click()
    const confirmation = page.getByRole('dialog', { name: 'Disable fixture-tools?' })
    await confirmation.getByRole('button', { name: 'Yes, disable' }).click()
    await expect.poll(() => existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')).plugins['fixture-tools'] : null).toMatchObject({ enabled: false })
    await expect(pluginRow.getByRole('button', { name: 'Enable fixture-tools' })).toBeVisible()
  })

  test('round-trips a grouped OMP ask_user questionnaire', async () => {
    await page.evaluate(() => window.desktop.settings.update({ askUserEnabled: true }))
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')

    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('Ask me two questions')
    await composer.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Answer 2 questions' })
    await expect(dialog).toBeVisible()
    await expect(page.locator('.subagents__toolbar > .execution-status .execution-status__phase')).toHaveText('Waiting for input')
    const workStatus = page.locator('.work-disclosure__button [role="status"]')
    await expect(workStatus).toHaveAttribute('role', 'status')
    await expect(workStatus).toContainText('Working')
    // While the turn streams, the work disclosure stays open at top level.
    await expect(page.locator('.work-disclosure__button')).toHaveAttribute('aria-expanded', 'true')
    // The thinking row is visible but its content stays in the collapsed dropdown.
    await expect(page.locator('.activity-line--reasoning')).toHaveCount(1)
    await expect(page.locator('.work-disclosure__button')).toHaveCount(1)
    await expect(dialog).toContainText('Question 1 of 2')
    await expect(dialog).toContainText('Which OMP release channel?')
    const context = dialog.getByRole('textbox', { name: 'Additional context' })
    await context.fill('For the pilot')
    await dialog.getByRole('option', { name: 'Beta' }).click()
    await expect(dialog).toContainText('Question 2 of 2')

    await dialog.getByRole('option', { name: 'Safety' }).click()
    await expect(dialog).toContainText('Submit answers')
    const submitStep = dialog.locator('.extension-questionnaire__progress button').last()
    await expect(submitStep).toHaveAttribute('aria-current', 'step')
    await expect(submitStep).toBeFocused()
    await page.keyboard.press('Control+ArrowLeft')
    await expect(dialog).toContainText('Question 2 of 2')
    await expect(dialog.getByRole('option', { name: 'Safety' })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Control+ArrowLeft')
    await expect(dialog).toContainText('Question 1 of 2')
    await expect(dialog.getByRole('textbox', { name: 'Additional context' })).toHaveValue('For the pilot')
    await page.keyboard.press('Control+ArrowRight')
    await expect(dialog).toContainText('Question 2 of 2')

    await dialog.getByRole('option', { name: 'Other (type your own answer)' }).click()
    await dialog.getByRole('textbox', { name: 'Additional context' }).fill('A custom priority')
    await page.keyboard.press('Enter')
    await expect(dialog).toContainText('Submit answers')
    await dialog.getByRole('button', { name: 'Submit answers', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    expect(JSON.parse(readFileSync(join(fixtureRoot, 'prompt-args.json'), 'utf8'))).toMatchObject({
      type: 'prompt',
      message: 'Ask me two questions',
    })
    const valuesPath = join(fixtureRoot, 'omp-questionnaire-values.json')
    await expect.poll(() => existsSync(valuesPath)).toBe(true)
    expect(JSON.parse(readFileSync(valuesPath, 'utf8'))).toEqual({
      'omp-fixture-question-1': JSON.stringify({ answer: 'Beta', answerSource: 'option', context: 'For the pilot' }),
      'omp-fixture-question-2': JSON.stringify({ answer: 'A custom priority', answerSource: 'freeform' }),
    })
    const runtimeArgs = JSON.parse(readFileSync(join(fixtureRoot, 'omp-runtime-args.json'), 'utf8')) as string[]
    const injectedExtensions = runtimeArgs.flatMap((value, index) => value === '--extension' ? [runtimeArgs[index + 1]] : [])
    expect(injectedExtensions).toContain(join(process.cwd(), 'assets', 'extensions', 'omp-work-ask-user.ts'))
    const worked = page.locator('.work-disclosure__button')
    await expect(worked).toContainText(/^Worked for /)
    await expect(worked).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.activity-line--reasoning')).toHaveCount(0)
    await worked.click()
    await expect(page.locator('.activity-line--question')).toContainText('What should OMP optimize for?')

    const completedRow = page.locator('.session-row-wrap').filter({ hasText: 'Post-completion catalog refresh' })
    await expect(completedRow).toHaveCount(1)
    await expect(completedRow).toHaveClass(/session-row-wrap--complete/)
    await expect(completedRow).toHaveClass(/is-selected/)
    await expect(completedRow).not.toHaveClass(/has-attention/)
    await expect(page.getByRole('status', { name: 'A session turn ended or needs attention' })).toHaveCount(0)
    await completedRow.locator('.session-row').click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
    await expect(page.getByText(/OMP RPC exited|Request failed/)).toHaveCount(0)
  })

  test('keeps transcript text from showing through the composer disclaimer', async () => {
    await page.getByRole('button', { name: 'Toggle inspector' }).click()
    await expect(page.locator('.composer-note')).toBeVisible()
    const colors = await page.locator('.composer-note').evaluate((node) => {
      const probe = document.createElement('div')
      probe.style.background = 'var(--canvas)'
      document.body.append(probe)
      const canvas = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { note: getComputedStyle(node).backgroundColor, canvas }
    })
    expect(colors.note).toBe(colors.canvas)
    expect(colors.note).not.toContain('rgba')
  })

  test('applies themed native select colors and restores system appearance', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    const nativeSelectTheme = () => page.evaluate(() => {
      const select = document.createElement('select')
      const option = document.createElement('option')
      option.textContent = 'Theme probe'
      select.append(option)
      document.body.append(select)
      const root = getComputedStyle(document.documentElement)
      const selectStyle = getComputedStyle(select)
      const optionStyle = getComputedStyle(option)
      const result = {
        scheme: selectStyle.colorScheme,
        optionColor: optionStyle.color,
        optionBackground: optionStyle.backgroundColor,
        themeColor: root.getPropertyValue('--text').trim(),
        themeBackground: root.getPropertyValue('--surface-raised').trim(),
      }
      select.remove()
      return result
    })
    await page.getByRole('button', { name: /Light/ }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(await nativeSelectTheme()).toMatchObject({
      scheme: 'light',
      optionColor: 'rgb(32, 32, 30)',
      optionBackground: 'rgb(255, 255, 255)',
      themeColor: '#20201e',
      themeBackground: '#ffffff',
    })
    await page.getByRole('button', { name: /Dark/ }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(await nativeSelectTheme()).toMatchObject({
      scheme: 'dark',
      optionColor: 'rgb(245, 245, 242)',
      optionBackground: 'rgb(34, 34, 32)',
      themeColor: '#f5f5f2',
      themeBackground: '#222220',
    })
    await page.getByRole('button', { name: /System/ }).click()
  })

  test('increases interface text within the bounded appearance choices', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.getByRole('radio', { name: 'Larger', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Larger', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect.poll(async () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBeCloseTo(1.15, 2)

    await page.setViewportSize({ width: 480, height: 700 })
    const fits = await page.locator('.settings-row--text-size').evaluate((row) => row.scrollWidth <= row.clientWidth)
    expect(fits).toBe(true)
    await page.setViewportSize({ width: 1440, height: 920 })
    await page.getByRole('radio', { name: 'Default', exact: true }).click()
    await expect.poll(async () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBeCloseTo(1.1, 2)
  })

  test('traps modal focus, closes on Escape, and restores the trigger', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Browser', exact: true }).first().click()
    const trigger = page.getByRole('button', { name: 'Clear data' })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Clear browser data?' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close' })).toBeFocused()
    await expect(page.locator('.app-shell')).toHaveAttribute('inert')
    await page.keyboard.press('Meta+K')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.locator('.app-shell')).not.toHaveAttribute('inert')
  })

  test('supports keyboard navigation for composer suggestions', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('/')
    const options = page.locator('.composer-menu').getByRole('option')
    await expect.poll(() => options.count()).toBeGreaterThan(4)
    const nextCommand = await options.nth(1).locator('strong').innerText()
    expect(nextCommand).toMatch(/^\/\S+$/)
    await expect(composer).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(composer).toHaveValue(`${nextCommand} `)
    await expect(composer).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await expect(page.getByRole('combobox', { name: 'Message OMP' })).toHaveValue('')
  })

  test('preserves a rejected shell draft while rolling back the committed setting', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
    const shell = page.getByLabel('Shell executable')
    const rejectedDraft = '/definitely/not-an-executable'
    await expect(shell).toHaveValue('/bin/zsh')
    await shell.fill(rejectedDraft)
    await expect(shell).toHaveValue(rejectedDraft)
    await expect(page.getByRole('alert')).toHaveCount(0)

    await shell.press('Enter')

    const inlineError = page.getByRole('alert').filter({ hasText: /setting could not be saved/i })
    await expect(inlineError).toBeVisible()
    await expect(shell).toHaveAttribute('aria-invalid', 'true')
    await expect(shell).toHaveAttribute('aria-describedby', await inlineError.getAttribute('id') ?? '')
    await expect(page.locator('.toast')).toContainText(/shell is not executable/i)
    await expect(shell).toHaveValue(rejectedDraft)
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await expect.poll(() => page.evaluate(() => window.desktop.settings.get().then((settings) => settings.terminalShell))).toBe('/bin/zsh')

    await page.getByRole('button', { name: 'General', exact: true }).click()
    await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
    await expect(page.locator('.settings-content input.mono')).toHaveValue('/bin/zsh')
  })

  test('uses overlay panels at the compact desktop breakpoint', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.setViewportSize({ width: 960, height: 700 })
    await expect.poll(() => page.locator('.sidebar').evaluate((node) => getComputedStyle(node).position)).toBe('fixed')
    await expect(page.locator('.inspector')).toHaveCount(0)
    const sidebarScrim = page.getByRole('button', { name: 'Close sidebar' })
    await expect(page.locator('.panel-scrim--sidebar')).toBeVisible()
    await expect(sidebarScrim).toBeVisible()
    await sidebarScrim.click({ position: { x: 400, y: 300 } })
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.desktop.settings.get()).sidebarOpen)).toBe(false)
    // Panel reconciliation may restore a confirmed inspector preference after
    // the sidebar closes. Normalize either valid state before testing the toggle.
    await page.waitForTimeout(250)
    if (await page.locator('.inspector').count()) {
      await page.locator('.inspector').getByRole('button', { name: 'Close inspector' }).click()
      await expect(page.locator('.inspector')).toHaveCount(0)
    }
    await expect(page.locator('.workbench')).not.toHaveAttribute('inert')
    await expect(page.locator('.title-toolbar')).not.toHaveAttribute('inert')
    const inspectorToggle = page.getByRole('button', { name: 'Toggle inspector' })
    await inspectorToggle.focus()
    await inspectorToggle.press('Enter')
    await expect.poll(() => page.locator('.inspector').evaluate((node) => getComputedStyle(node).position)).toBe('fixed')
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect(page.locator('.panel-scrim--inspector')).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 920 })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(980)
    await page.getByRole('button', { name: /Show sidebar/ }).click()
    await expect(page.locator('.workbench')).not.toHaveAttribute('inert')
  })

  test('keeps the reading column comfortable on a wide pane and the docked surfaces aligned', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.setViewportSize({ width: 1800, height: 900 })
    if (await page.locator('.inspector').count()) {
      await page.locator('.inspector').getByRole('button', { name: 'Close inspector' }).click()
      await expect(page.locator('.inspector')).toHaveCount(0)
    }
    const measure = () => page.evaluate(() => {
      const width = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().width ?? 0
      return { pane: width('.conversation-pane'), column: width('.transcript__inner'), dock: width('.conversation-bottom-dock'), scroller: document.querySelector('.transcript')?.clientWidth ?? 0 }
    })

    // The window manager may hand back less than the requested viewport, so the
    // expected column is derived from the pane the app actually got.
    await expect.poll(async () => (await measure()).pane).toBeGreaterThan(894)
    const wide = await measure()
    expect(wide.column).toBeCloseTo(Math.min(960, Math.max(720, wide.pane * 0.78)), 0)
    expect(wide.column).toBeGreaterThan(760)
    expect(wide.column).toBeLessThanOrEqual(960)
    // The scrolled column and the absolutely positioned dock share one measure,
    // so they must stay the same width even when a scrollbar takes up space.
    expect(wide.column).toBeCloseTo(wide.dock, 1)

    await page.setViewportSize({ width: 720, height: 700 })
    await expect.poll(async () => (await measure()).pane).toBeLessThan(760)
    const compact = await measure()
    // Below the reading minimum the column fills the scroll area, which is the
    // pane minus whatever a non-overlay scrollbar takes.
    // clientWidth is integer rounded, so allow a pixel of slack.
    expect(Math.abs(compact.column - compact.scroller)).toBeLessThanOrEqual(1)
    expect(compact.column).toBeLessThanOrEqual(compact.pane)
  })

  test('presents conversation prose and activity across themes and compact layouts', async () => {
    const timestamp = new Date().toISOString()
    appendFileSync(fixtureSessionFile, `${JSON.stringify({ type: 'message', id: 'design-user', parentId: 'fixture-goal-summary', timestamp, message: {
      role: 'user', timestamp, content: [{ type: 'text', text: '幫我整理這個專案，並說明接下來可以改善的地方。' }],
    } })}\n${JSON.stringify({ type: 'message', id: 'design-assistant', parentId: 'design-user', timestamp, message: {
      role: 'assistant', timestamp, content: [
        { type: 'thinking', thinking: '先閱讀專案結構，再確認現有的測試與建置流程。' },
        { type: 'text', text: '先檢查專案設定，再確認測試涵蓋的範圍。' },
        { type: 'toolCall', id: 'design-tool', name: 'read', arguments: { path: 'package.json' } },
        { type: 'thinking', thinking: '設定已讀取，接著整理驗證步驟。' },
        { type: 'text', text: '## 專案已整理完成\n\n這個專案將桌面介面與代理執行流程分開，方便持續調整對話體驗。\n\n- **對話介面**：呈現訊息、思考與工具活動。\n- **執行流程**：管理模型連線、工作階段與事件。\n\n### 建議的下一步\n\n先確認建置，再執行測試：\n\n```sh\nnpm run build\nnpm test\n```\n\n完成後就可以繼續驗證實際操作流程。' },
      ],
    } })}\n`)
    await expect(page.locator('.transcript').getByText('專案已整理完成', { exact: true })).toBeVisible()
    if (await page.locator('.inspector').count()) await page.locator('.inspector').getByRole('button', { name: 'Close inspector' }).click()
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(async (theme) => window.desktop.settings.update({ theme, reasoningExpandedByDefault: true }), theme)
      await page.reload()
      await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      if (await page.locator('.inspector').count()) await page.locator('.inspector').getByRole('button', { name: 'Close inspector' }).click()
      for (const width of [1440, 680]) {
        await page.setViewportSize({ width, height: 950 })
        const alignment = await page.locator('.transcript .work-timeline').last().evaluate((element) => {
          const left = (selector: string) => element.querySelector(selector)!.getBoundingClientRect().left
          return { thinking: left('.activity-reasoning .prose'), body: left('.activity-reasoning .prose'), note: left('.activity-line--note .prose'), tool: left('.activity-line--tool .activity-line__kind') }
        })
        expect(alignment.body).toBeCloseTo(alignment.thinking, 0)
        expect(alignment.note).toBeCloseTo(alignment.thinking, 0)
        expect(alignment.tool).toBeCloseTo(alignment.thinking, 0)
        // Model text keeps the bright body color; thinking is the dim layer.
        const emphasis = await page.locator('.transcript .work-timeline').last().evaluate((element) => {
          const note = element.querySelector<HTMLElement>('.activity-line--note .prose')
          const thinking = element.querySelector<HTMLElement>('.activity-reasoning .prose')
          const finalBody = document.querySelector<HTMLElement>('.message--assistant .message__content')
          if (!note || !thinking || !finalBody) return null
          return { note: getComputedStyle(note).color, thinking: getComputedStyle(thinking).color, body: getComputedStyle(document.body).color, final: getComputedStyle(finalBody).color, weight: getComputedStyle(note).fontWeight }
        })
        expect(emphasis).not.toBeNull()
        // The subagents shell must not dim the main conversation.
        expect(emphasis!.final).toBe(emphasis!.body)
        expect(emphasis!.note).toBe(emphasis!.body)
        // Non-standard intermediate weights thin CJK strokes; keep body text at 400.
        expect(emphasis!.weight).toBe('400')
        expect(emphasis!.thinking).not.toBe(emphasis!.body)
        // Tool rows separate the tool name from its preview with a dsh-style dot.
        const toolDot = await page.locator('.transcript .activity-line--tool .activity-tool__preview').first().evaluate((el) => getComputedStyle(el, '::before').content)
        expect(toolDot).toBe('"·"')
        await page.locator('.transcript .work-disclosure').last().scrollIntoViewIfNeeded()
        await page.screenshot({ path: test.info().outputPath(`activity-${theme}-${width}.png`) })
        await page.locator('.transcript').evaluate((element) => { element.scrollTop = element.scrollHeight })
        const layout = await page.locator('.transcript .message--assistant').last().evaluate((element) => {
          const content = element.querySelector('.message__content')!
          return { width: element.clientWidth, overflow: element.scrollWidth, contentWidth: content.clientWidth }
        })
        expect(layout.overflow).toBeLessThanOrEqual(layout.width + 1)
        expect(layout.contentWidth).toBeGreaterThan(300)
        await page.screenshot({ path: test.info().outputPath(`conversation-${theme}-${width}.png`) })
      }
    }
  })

  test('shows a new conversation immediately while the harness starts', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await expect(page.locator('.session-welcome')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Model: Claude Fixture', exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: 'Message OMP' }).fill('Start this new conversation')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.locator('.session-welcome')).toHaveCount(0, { timeout: 1000 })
    await expect(page.locator('.transcript .user-bubble')).toContainText('Start this new conversation', { timeout: 1000 })
    await expect(page.locator('.transcript .thinking-dots')).toBeVisible({ timeout: 1000 })
    await expect(page.locator('.subagents__toolbar > .execution-status .execution-status__phase')).toHaveText('Starting', { timeout: 1000 })
    await page.screenshot({ path: test.info().outputPath('new-session-starting.png') })
    await expect(page.locator('.transcript .thinking-dots')).toHaveCount(0, { timeout: 15000 })
    await expect(page.locator('.composer-attachment-error')).toHaveCount(0)
  })

  test('persists density and reserves space for the actual composer and command result', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'General', exact: true }).click()
    const density = page.getByRole('combobox', { name: 'Conversation density', exact: true })
    await expect(density).toHaveValue('comfortable')
    await density.selectOption('compact')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-density', 'compact')
    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-density', 'compact')
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const measured = () => page.locator('.conversation-pane').evaluate((pane) => {
      const dock = pane.querySelector('.conversation-bottom-dock')!
      const transcript = pane.querySelector('.transcript')!
      return { reserved: Number.parseFloat(getComputedStyle(transcript).paddingBottom), actual: (dock as HTMLElement).offsetHeight }
    })
    const before = await measured()
    await page.getByRole('combobox', { name: 'Message OMP' }).fill('/context')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Command result', exact: true })).toBeVisible()
    await expect.poll(async () => (await measured()).reserved).toBeGreaterThan(before.reserved)
    const withOutput = await measured()
    expect(withOutput.reserved).toBeGreaterThan(withOutput.actual)
    expect(withOutput.reserved - withOutput.actual).toBeLessThan(80)
    await page.getByRole('button', { name: 'Close command result', exact: true }).click()
    await expect.poll(async () => (await measured()).reserved).toBeLessThan(withOutput.reserved)
  })

  test('auto-closes both drawers at the smallest breakpoint while keeping them user-toggleable', async () => {
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.setViewportSize({ width: 720, height: 700 })
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Show sidebar/ })).toBeVisible()
    await expect(page.locator('.workbench')).not.toHaveAttribute('inert')
    await expect.poll(() => page.evaluate(async () => (await window.desktop.settings.get()).sidebarOpen)).toBe(false)

    await page.getByRole('button', { name: /Show sidebar/ }).click()
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.locator('.sidebar').getByRole('button', { name: /Hide sidebar/ }).click()
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.desktop.settings.get()).sidebarOpen)).toBe(false)

    await page.setViewportSize({ width: 721, height: 700 })
    await page.getByRole('button', { name: /Show sidebar/ }).click()
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.setViewportSize({ width: 720, height: 700 })
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.desktop.settings.get()).sidebarOpen)).toBe(false)

    const inspectorToggle = page.getByRole('button', { name: 'Toggle inspector' })
    await inspectorToggle.click()
    await expect(page.locator('.inspector')).toBeVisible()
    await expect(page.locator('.title-toolbar')).not.toHaveAttribute('inert')
    await inspectorToggle.click()
    await expect(page.locator('.inspector')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.desktop.settings.get()).inspectorOpen)).toBe(false)

    await page.setViewportSize({ width: 721, height: 700 })
    await inspectorToggle.click()
    await expect(page.locator('.inspector')).toBeVisible()
    await page.setViewportSize({ width: 720, height: 700 })
    await expect(page.locator('.inspector')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.desktop.settings.get()).inspectorOpen)).toBe(false)
  })

  test('attaches an isolated browser guest without navigation errors', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.getByRole('tab', { name: 'Browser' }).click()
    const guest = page.locator('webview[partition="persist:omp-desktop-browser"]')
    await expect(guest).toHaveCount(1)
    await expect.poll(() => guest.evaluate(async (node) => {
      const webview = node as HTMLElement & { executeJavaScript(script: string): Promise<unknown> }
      return webview.executeJavaScript('typeof window.desktop')
    })).toBe('undefined')
    await page.waitForTimeout(2_500)
    expect(actionableErrors.filter((error) => /ERR_ABORTED|GUEST_VIEW_MANAGER_CALL/i.test(error))).toEqual([])
    await page.getByRole('tab', { name: 'Browser' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
  })

  test('binds Git to a secondary workspace and clears stale paths during a folder switch', async () => {
    await page.getByRole('tab', { name: 'Changes' }).click()
    await expect(page.locator('.file-changes')).toContainText('secondary-change.txt')
    await expect(page.getByRole('button', { name: /Stage$/ }).last()).toBeVisible()

    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.file-changes')).not.toContainText('secondary-change.txt')
    await expect(page.locator('.file-changes')).toContainText('README.md')

    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await expect(page.locator('.file-changes')).toContainText('secondary-change.txt')
    await page.getByRole('button', { name: /Stage$/ }).last().click()
    await page.getByRole('button', { name: 'Staged', exact: true }).click()
    await expect(page.locator('.file-changes')).toContainText('secondary-change.txt')
    await page.getByRole('button', { name: /Unstage$/ }).last().click()
  })
  test('dismisses the file changes popup, disables it in settings, and undoes a file', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')
    const changesCard = page.locator('.changes-card')
    await expect(changesCard).toHaveCount(0)
    await page.getByRole('combobox', { name: 'Message OMP' }).fill('barrier turn')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop OMP', exact: true })).toBeVisible()
    writeFileSync(join(fixtureRoot, 'secondary-project', 'secondary-change.txt'), 'base\nsecondary workspace change\nturn-specific edit\n')
    writeFileSync(join(fixtureRoot, 'prompt-admission-barrier-release'), 'release')
    await expect(changesCard).toBeVisible()
    await changesCard.getByRole('button', { name: 'Dismiss file changes' }).click()
    await expect(changesCard).toHaveCount(0)

    await page.keyboard.press('Meta+,')
    const popupToggle = page.getByRole('checkbox', { name: 'Show file changes popup' })
    await expect(popupToggle).toBeChecked()
    await popupToggle.focus()
    await popupToggle.press('Space')
    await expect(popupToggle).not.toBeChecked()
    await expect.poll(() => page.evaluate(async () => (await window.desktop.settings.get()).showFileChangesPopup)).toBe(false)
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.locator('.changes-card')).toHaveCount(0)

    await page.getByRole('tab', { name: 'Changes' }).click()
    await page.locator('.file-changes > button').first().click()
    await page.getByRole('button', { name: 'Undo changes', exact: true }).click()
    const undoDialog = page.getByRole('dialog', { name: 'Undo file changes?' })
    await expect(undoDialog).toContainText('staged and unstaged changes')
    await undoDialog.getByRole('button', { name: 'Undo changes', exact: true }).click()
    await expect.poll(() => readFileSync(join(fixtureRoot, 'secondary-project', 'secondary-change.txt'), 'utf8')).toBe('base\n')
    await expect(page.locator('.file-changes')).toContainText('No unstaged changes.')
  })

  test('resizes the inspector horizontally and terminal vertically', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.getByRole('tab', { name: 'Summary' }).click()

    const inspector = page.locator('.inspector')
    const inspectorHandle = page.getByRole('separator', { name: 'Resize inspector' })
    await expect(inspectorHandle).toBeVisible()
    const inspectorBefore = await inspector.boundingBox()
    const inspectorHandleBox = await inspectorHandle.boundingBox()
    expect(inspectorBefore).not.toBeNull()
    expect(inspectorHandleBox).not.toBeNull()
    await page.mouse.move(inspectorHandleBox!.x + inspectorHandleBox!.width / 2, inspectorHandleBox!.y + 80)
    await page.mouse.down()
    await page.mouse.move(inspectorHandleBox!.x - 72, inspectorHandleBox!.y + 80, { steps: 5 })
    await page.mouse.up()
    const inspectorAfter = await inspector.boundingBox()
    expect(inspectorAfter!.width).toBeGreaterThan(inspectorBefore!.width + 50)
    await inspectorHandle.focus()
    await page.keyboard.press('ArrowRight')
    expect((await inspector.boundingBox())!.width).toBeLessThan(inspectorAfter!.width)

    await page.getByLabel(/Toggle terminal/).click()
    const drawer = page.locator('.terminal-drawer')
    const terminalHandle = page.getByRole('separator', { name: 'Resize terminal' })
    await expect(terminalHandle).toBeVisible()
    const terminalBefore = await drawer.boundingBox()
    expect(terminalBefore).not.toBeNull()
    await expect.poll(async () => Number(await terminalHandle.getAttribute('aria-valuemax'))).toBeGreaterThan(terminalBefore!.height + 44)
    await terminalHandle.hover()
    const terminalHandleBox = await terminalHandle.boundingBox()
    expect(terminalHandleBox).not.toBeNull()
    const terminalHandleCenter = {
      x: terminalHandleBox!.x + terminalHandleBox!.width / 2,
      y: terminalHandleBox!.y + terminalHandleBox!.height / 2,
    }
    await page.mouse.move(terminalHandleCenter.x, terminalHandleCenter.y)
    await page.mouse.down()
    await expect(terminalHandle).toHaveAttribute('data-resizing', 'true')
    await page.mouse.move(terminalHandleCenter.x, terminalHandleCenter.y - 64, { steps: 5 })
    await page.mouse.up()
    const terminalAfter = await drawer.boundingBox()
    expect(terminalAfter!.height).toBeGreaterThan(terminalBefore!.height + 44)
    await terminalHandle.focus()
    await page.keyboard.press('ArrowDown')
    expect((await drawer.boundingBox())!.height).toBeLessThan(terminalAfter!.height)
    await page.getByLabel('Close terminal', { exact: true }).click()
  })

  test('shuts down cleanly with an active terminal', async () => {
    await page.getByLabel(/Toggle terminal/).click()
    const drawer = page.locator('.terminal-drawer:not([hidden])')
    const input = drawer.locator('.xterm-helper-textarea')
    await expect(input).toBeVisible()
    await input.click()
    await page.keyboard.type('while true; do sleep 1; done')
    await page.keyboard.press('Enter')
    // Intentionally leave the PTY open. The shared teardown closes the
    // Electron app and exercises the native node-pty shutdown path.
  })

  test('restores each session terminal without leaking it into another session', async () => {
    await page.getByLabel(/Toggle terminal/).click()
    const visibleDrawer = page.locator('.terminal-drawer:not([hidden])')
    const input = visibleDrawer.locator('.xterm-helper-textarea')
    await expect(input).toBeVisible()
    await input.click()
    await page.keyboard.type('echo secondary-session-state')
    await page.keyboard.press('Enter')
    await expect(visibleDrawer.locator('.xterm-rows')).toContainText('secondary-session-state', { timeout: 8_000 })

    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden])')).toHaveCount(0)
    await page.getByLabel(/Toggle terminal/).click()
    const primaryDrawer = page.locator('.terminal-drawer:not([hidden])')
    const primaryInput = primaryDrawer.locator('.xterm-helper-textarea')
    await expect(primaryInput).toBeVisible()
    await primaryInput.click()
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await expect(primaryDrawer.locator('.xterm-rows')).toContainText(/omp-desktop-e2e-[^/]+\/project/, { timeout: 8_000 })
    await expect(primaryDrawer.locator('.xterm-rows')).not.toContainText('secondary-session-state')

    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden]) .xterm-rows')).toContainText('secondary-session-state')
    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden]) .xterm-rows')).toContainText(/omp-desktop-e2e-[^/]+\/project/)
    await page.locator('.terminal-drawer:not([hidden])').getByLabel('Close terminal', { exact: true }).click()
    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await page.locator('.terminal-drawer:not([hidden])').getByLabel('Close terminal', { exact: true }).click()
  })

  test('opens independent terminal tabs inside the conversation column', async () => {
    const project = await page.evaluate(async () => {
      const projects = await window.desktop.projects.list('omp')
      const selected = projects[0]
      if (!selected) return null
      return selected.inferred ? window.desktop.projects.grantInferred(selected.primaryFolder, 'omp') : selected
    })
    expect(project).not.toBeNull()
    await page.getByRole('tab', { name: 'Summary' }).click()
    await page.getByLabel(/Toggle terminal/).click()
    await expect(page.locator('.terminal-drawer .xterm')).toBeVisible()
    await expect(page.locator('.terminal-live-dot.is-connected')).toBeVisible()
    const firstTerminalLine = () => page.locator('.terminal-surface:not([hidden]) .xterm-rows').evaluate((rows) =>
      [...rows.children].map((row) => row.textContent?.trim() ?? '').find(Boolean) ?? '',
    )
    await expect.poll(firstTerminalLine).toMatch(/\S/)
    expect(await firstTerminalLine()).not.toBe('%')
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(1)
    const activeTerminal = page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea')
    await activeTerminal.click()
    await page.keyboard.type('echo first-terminal')
    await page.keyboard.press('Enter')
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('first-terminal')

    await page.getByLabel('New terminal').click()
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(2)
    await activeTerminal.click()
    await page.keyboard.type('echo second-terminal')
    await page.keyboard.press('Enter')
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('second-terminal')

    await page.getByRole('tab', { name: /zsh 1/ }).click()
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('first-terminal')
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).not.toContainText('second-terminal')

    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden])')).toHaveCount(0)
    await page.getByLabel(/Toggle terminal/).click()
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(1)
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).not.toContainText(/first-terminal|second-terminal/)

    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(2)
    await page.getByRole('tab', { name: /zsh 1/ }).click()
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('first-terminal')

    const geometry = await page.evaluate(() => {
      const session = document.querySelector('.session-workspace')!.getBoundingClientRect()
      const conversation = document.querySelector('.conversation-column')!.getBoundingClientRect()
      const terminal = document.querySelector('.terminal-drawer')!.getBoundingClientRect()
      const inspector = document.querySelector('.inspector')!.getBoundingClientRect()
      return {
        terminalRight: terminal.right,
        conversationRight: conversation.right,
        sessionTop: session.top,
        sessionBottom: session.bottom,
        inspectorTop: inspector.top,
        inspectorBottom: inspector.bottom,
      }
    })
    expect(Math.abs(geometry.terminalRight - geometry.conversationRight)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.inspectorTop - geometry.sessionTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.inspectorBottom - geometry.sessionBottom)).toBeLessThanOrEqual(1)

    const drawer = page.locator('.terminal-drawer:not([hidden])')
    const before = await drawer.evaluate((node) => node.getBoundingClientRect().height)
    await drawer.getByLabel('Maximize terminal').click()
    await expect(drawer).toHaveClass(/is-maximized/)
    expect(await drawer.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(before)
    await drawer.getByLabel('Restore terminal').click()
    await drawer.getByLabel('Close terminal', { exact: true }).click()
  })

  test('attaches and removes active terminal selection context', async () => {
    await page.getByRole('tab', { name: 'Summary' }).click()
    await page.getByLabel(/Toggle terminal/).click()
    const input = page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea')
    await input.click()
    await page.keyboard.type("printf 'terminal-selection-marker\\n'")
    await page.keyboard.press('Enter')
    const outputLine = page.locator('.terminal-surface:not([hidden]) .xterm-rows > div').filter({ hasText: 'terminal-selection-marker' }).last()
    await expect(outputLine).toBeVisible()
    await expect(page.locator('.composer-attachment--terminal')).toHaveCount(0)

    const selectOutput = async () => {
      const box = await outputLine.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(Math.min(box!.x + box!.width - 2, box!.x + 190), box!.y + box!.height / 2, { steps: 5 })
      await page.mouse.up()
      await expect(page.getByLabel(/Inspect selected text from/)).toBeVisible()
    }

    await selectOutput()
    const clearBox = await outputLine.boundingBox()
    expect(clearBox).not.toBeNull()
    await page.mouse.click(clearBox!.x + 2, clearBox!.y + clearBox!.height / 2)
    await expect(page.getByLabel(/Inspect selected text from/)).toHaveCount(0)
    await selectOutput()

    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('Explain the terminal output')
    await composer.press('Enter')
    await expect.poll(() => existsSync(join(fixtureRoot, 'prompt-args.json'))).toBe(true)
    const prompt = JSON.parse(readFileSync(join(fixtureRoot, 'prompt-args.json'), 'utf8')) as { message: string }
    expect(prompt.message).toContain('Explain the terminal output\n\n===== BEGIN TERMINAL SELECTION CONTEXT =====')
    expect(prompt.message).toContain('--- Selected text ---')
    expect(prompt.message).toContain('terminal-selection-marker')
    expect(prompt.message).not.toContain('Terminal buffer')
  })

  test('closes immediately when no agent or schedule is active', async () => {
    const closed = app!.waitForEvent('close', { timeout: 45_000 })
    const dialogCalls = await app!.evaluate(({ BrowserWindow, dialog }) => {
      let calls = 0
      const closeDialog = dialog as unknown as { showMessageBox: (...args: unknown[]) => Promise<unknown> }
      closeDialog.showMessageBox = () => {
        calls += 1
        return Promise.resolve({ response: 0 })
      }
      BrowserWindow.getAllWindows()[0]?.close()
      return calls
    })
    expect(dialogCalls).toBe(0)
    await closed
    app = undefined
  })

  test('Command-Q backgrounds the window and menu-bar Open restores it', async () => {
    test.skip(process.platform !== 'darwin', 'macOS menu-bar lifecycle')
    await app!.evaluate(({ Menu }) => {
      const scope = globalThis as { __trayOpen?: () => void }
      const originalBuildFromTemplate = Menu.buildFromTemplate.bind(Menu)
      Menu.buildFromTemplate = ((template) => {
        const items = template as Array<{ label?: string; type?: string; click?: () => void }>
        if (items.map((item) => item.label ?? item.type).join('|') === 'Open OMP Desktop|separator|Settings...|Quit') {
          scope.__trayOpen = items.find((item) => item.label === 'Open OMP Desktop')?.click
        }
        return originalBuildFromTemplate(template)
      }) as typeof Menu.buildFromTemplate
    })
    await page.evaluate(() => window.desktop.settings.update({ keepRunningInBackground: true }))
    await expect.poll(() => app!.evaluate(() => typeof (globalThis as { __trayOpen?: unknown }).__trayOpen)).toBe('function')
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true)

    await app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Main window is missing')
      window.focus()
      window.webContents.focus()
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Q', modifiers: ['meta'] })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Q', modifiers: ['meta'] })
    })
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { count: BrowserWindow.getAllWindows().length, visible: window?.isVisible(), destroyed: window?.isDestroyed() }
    })).toEqual({ count: 1, visible: false, destroyed: false })
    expect(app!.process().exitCode).toBeNull()

    await app!.evaluate(() => {
      const open = (globalThis as { __trayOpen?: () => void }).__trayOpen
      if (!open) throw new Error('Menu-bar Open was not captured')
      open()
    })
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true)
    await expect(page.locator('.app-shell')).toBeVisible()
  })

  test('does not recreate the menu-bar item while Quit is shutting down', async () => {
    test.skip(process.platform !== 'darwin', 'macOS menu-bar lifecycle')
    const trayBuildsPath = join(fixtureRoot, 'tray-menu-builds.log')
    await app!.evaluate(({ Menu }, markerPath) => {
      const originalBuildFromTemplate = Menu.buildFromTemplate.bind(Menu)
      Menu.buildFromTemplate = ((template) => {
        const items = template as Array<{ label?: string; type?: string }>
        if (items.map((item) => item.label ?? item.type).join('|') === 'Open OMP Desktop|separator|Settings...|Quit') {
          process.getBuiltinModule('node:fs').appendFileSync(markerPath, 'tray\n')
        }
        return originalBuildFromTemplate(template)
      }) as typeof Menu.buildFromTemplate
    }, trayBuildsPath)
    await page.evaluate(() => window.desktop.settings.update({ keepRunningInBackground: true }))
    await expect.poll(() => existsSync(trayBuildsPath) ? readFileSync(trayBuildsPath, 'utf8').trim().split('\n').length : 0).toBe(1)

    const closed = app!.waitForEvent('close', { timeout: 45_000 })
    await app!.evaluate(({ app: electronApp }) => { electronApp.quit() })
    await closed

    expect(readFileSync(trayBuildsPath, 'utf8').trim().split('\n')).toHaveLength(1)
    app = undefined
  })

  test('asks before closing and quits after confirmation while an agent runs', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.locator('.model-picker__trigger')).toHaveAccessibleName('Model: Claude Fixture')
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('stay busy while I close the window')
    await composer.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop OMP' })).toBeVisible()
    await stubCloseDialog(app!)

    const runningPrompt = {
      message: 'Close OMP Desktop while an agent is running?',
      detail: 'An agent run is still in progress and will be stopped.',
      buttons: ['Cancel', 'Close OMP Desktop'],
    }
    await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() })
    await expect.poll(() => closePrompts(app!)).toEqual([runningPrompt])
    await expect(page.locator('.app-shell')).toBeVisible()

    // Quit routes through the same confirmation instead of bypassing it.
    await app!.evaluate(({ app: electronApp }) => { electronApp.quit() })
    await expect.poll(() => closePrompts(app!)).toEqual([runningPrompt, runningPrompt])
    await expect(page.locator('.app-shell')).toBeVisible()

    const closed = app!.waitForEvent('close', { timeout: 45_000 })
    await app!.evaluate(({ app: electronApp }) => {
      (globalThis as { __closeResponse?: number }).__closeResponse = 1
      electronApp.quit()
    })
    await closed
    app = undefined
  })

  test('backgrounds active work and routes tray Quit through confirmation and cleanup', async () => {
    test.skip(process.platform !== 'darwin', 'macOS menu-bar lifecycle')

    // Capture the real Quit closure when enabling the setting creates the tray.
    await app!.evaluate(({ Menu }) => {
      const scope = globalThis as { __trayQuit?: () => void }
      const originalBuildFromTemplate = Menu.buildFromTemplate.bind(Menu)
      Menu.buildFromTemplate = ((template) => {
        const items = template as Array<{ label?: string; type?: string; click?: () => void }>
        if (items.map((item) => item.label ?? item.type).join('|') === 'Open OMP Desktop|separator|Settings...|Quit') {
          scope.__trayQuit = items.find((item) => item.label === 'Quit')?.click
        }
        return originalBuildFromTemplate(template)
      }) as typeof Menu.buildFromTemplate
    })
    await page.evaluate(() => window.desktop.settings.update({ keepRunningInBackground: true }))
    await expect.poll(() => app!.evaluate(() => typeof (globalThis as { __trayQuit?: unknown }).__trayQuit)).toBe('function')

    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('stay busy while I background the window')
    await composer.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop OMP' })).toBeVisible()
    const runtimePidPath = join(fixtureRoot, 'omp-runtime.pid')
    await expect.poll(() => existsSync(runtimePidPath)).toBe(true)
    const runtimePid = Number(readFileSync(runtimePidPath, 'utf8'))
    expect(runtimePid).toBeGreaterThan(0)
    expect(processIsAlive(runtimePid)).toBe(true)
    await stubCloseDialog(app!)

    await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.show() })
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true)
    await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() })
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { count: BrowserWindow.getAllWindows().length, visible: window?.isVisible(), destroyed: window?.isDestroyed() }
    })).toEqual({ count: 1, visible: false, destroyed: false })
    expect(await closePrompts(app!)).toEqual([])
    expect(app!.process().exitCode).toBeNull()
    expect(processIsAlive(runtimePid)).toBe(true)

    const runningPrompt = {
      message: 'Close OMP Desktop while an agent is running?',
      detail: 'An agent run is still in progress and will be stopped.',
      buttons: ['Cancel', 'Close OMP Desktop'],
    }
    await app!.evaluate(() => {
      const quit = (globalThis as { __trayQuit?: () => void }).__trayQuit
      if (!quit) throw new Error('Tray Quit was not captured')
      quit()
    })
    await expect.poll(() => closePrompts(app!)).toEqual([runningPrompt])
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false)
    expect(app!.process().exitCode).toBeNull()
    expect(processIsAlive(runtimePid)).toBe(true)

    const closed = app!.waitForEvent('close', { timeout: 45_000 })
    await app!.evaluate(() => {
      const scope = globalThis as { __closeResponse?: number; __trayQuit?: () => void }
      scope.__closeResponse = 1
      if (!scope.__trayQuit) throw new Error('Tray Quit was not captured')
      scope.__trayQuit()
    })
    await closed
    await expect.poll(() => processIsAlive(runtimePid)).toBe(false)
    app = undefined
  })
})
