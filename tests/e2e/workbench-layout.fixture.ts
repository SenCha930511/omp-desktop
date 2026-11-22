import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEGACY_DESKTOP_STATE_FILENAME } from '../../electron/main/store'

export const LONG_SESSION_TITLE = 'A deliberately long running session title whose timestamp and spinner must remain aligned at the right edge'

export interface WorkbenchLayoutFixture {
  page: Page
  finishRun(): Promise<void>
  captureScreenshot(): Promise<Buffer>
  close(): Promise<void>
}

function titleSlot(title: string, updatedAt: string): string {
  const unpadded = JSON.stringify({ type: 'title', v: 1, title, updatedAt, pad: '' })
  return JSON.stringify({ type: 'title', v: 1, title, updatedAt, pad: ' '.repeat(255 - Buffer.byteLength(unpadded, 'utf8')) })
}

function writeFakeOmp(fixtureRoot: string, sessionFile: string): string {
  const executable = join(fixtureRoot, 'omp-layout-fixture.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('omp/17.2.15\\n'); process.exit(0) }
if (args[0] === 'models' && args.includes('--json')) {
  process.stdout.write(JSON.stringify({ models: [{ provider: 'openai-codex', id: 'gpt-fixture', name: 'GPT Fixture', contextWindow: 200000, maxTokens: 8192, reasoning: true, thinking: ['low', 'high'], input: ['text'] }] }) + '\\n')
  process.exit(0)
}
if (!args.includes('--mode') || args[args.indexOf('--mode') + 1] !== 'rpc') process.exit(2)
fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'omp-layout-fixture.pid'))}, String(process.pid))
const resumeIndex = args.indexOf('--resume')
const activeSessionFile = resumeIndex >= 0 ? args[resumeIndex + 1] : ${JSON.stringify(sessionFile)}
const releaseFile = ${JSON.stringify(join(fixtureRoot, 'finish-run'))}
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let negotiated = false
let streaming = false
let finishing = false
let activePromptId
let persistedParentId = 'layout-user'
let persistedMessageIndex = 0
const pendingToolIds = new Set()
const appendMessage = (role, content, extra = {}) => {
  const timestamp = new Date().toISOString()
  const id = 'layout-persisted-' + persistedMessageIndex
  persistedMessageIndex += 1
  fs.appendFileSync(activeSessionFile, JSON.stringify({ type: 'message', id, parentId: persistedParentId, timestamp, message: { role, content, timestamp: Date.parse(timestamp), ...extra } }) + '\\n')
  persistedParentId = id
}
send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })
const finish = () => {
  if (finishing || !streaming) return
  finishing = true
  streaming = false
  const pendingToolId = [...pendingToolIds].at(-1)
  if (pendingToolId) {
    pendingToolIds.delete(pendingToolId)
    const result = { content: [{ type: 'text', text: 'Final tool output marker\\n' }] }
    appendMessage('toolResult', result.content, { toolCallId: pendingToolId, toolName: 'bash', isError: false })
    send({ type: 'tool_execution_end', toolCallId: pendingToolId, toolName: 'bash', result })
  }
  const text = 'Layout fixture complete.'
  appendMessage('assistant', [{ type: 'text', text }])
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } })
  send({ type: 'agent_end', isTerminal: true, yielded: true })
  send({ type: 'prompt_result', id: activePromptId, agentInvoked: true, status: 'completed', sessionSettled: true })
  send({ type: 'session_settled' })
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'negotiate_protocol') {
    negotiated = true
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { protocolVersion: 2 } })
  } else if (!negotiated) {
    send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Protocol was not negotiated' })
  } else if (command.type === 'get_state') {
    if (fs.existsSync(releaseFile)) finish()
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {
      sessionId: 'layout-session', sessionFile: activeSessionFile, isStreaming: streaming, thinkingLevel: 'medium',
      model: { provider: 'openai-codex', id: 'gpt-fixture', name: 'GPT Fixture' },
      contextUsage: { tokens: 12000, contextWindow: 100000, percent: 12 },
      queuedMessageCount: 0, queuedMessages: { steering: [], followUp: [] },
    } })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { contextUsage: { tokens: 12000, contextWindow: 100000, percent: 12 } } })
  } else if (command.type === 'set_subagent_subscription') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { level: command.level } })
    send({ type: 'available_commands_update', commands: [] })
  } else if (command.type === 'get_subagents') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { subagents: [] } })
  } else if (command.type === 'prompt') {
    streaming = true
    activePromptId = command.id
    const message = String(command.message)
    const shortHud = message.includes('nonsticky hud')
    appendMessage('user', message)
    send({ type: 'agent_start' })
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
    if (message.includes('with hud') || shortHud) {
      const args = {}
      pendingToolIds.add('layout-todo')
      appendMessage('assistant', [{ type: 'toolCall', id: 'layout-todo', name: 'todo', arguments: args }])
      send({ type: 'tool_execution_start', toolCallId: 'layout-todo', toolName: 'todo', args })
      const result = { content: [{ type: 'text', text: 'Remaining items (1):\\n  - layout [in_progress]\\nOverall: 0/1 done, 1 open.\\n  Layout:\\n    - [ ] Check the sticky status boundary (in progress)' }] }
      pendingToolIds.delete('layout-todo')
      appendMessage('toolResult', result.content, { toolCallId: 'layout-todo', toolName: 'todo', isError: false })
      send({ type: 'tool_execution_end', toolCallId: 'layout-todo', toolName: 'todo', result })
    }
    if (shortHud) return
    const thinking = 'Reasoning body marker. This expanded explanation remains available below the work header. ' + 'Reasoning detail stays in its disclosure. '.repeat(24)
    appendMessage('assistant', [{ type: 'thinking', thinking }])
    send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: thinking } })
    for (let index = 0; index < 18; index += 1) {
      const id = 'layout-tool-' + index
      const args = { command: 'node fixture-step-' + index + '.cjs' }
      appendMessage('assistant', [{ type: 'toolCall', id, name: 'bash', arguments: args }])
      pendingToolIds.add(id)
      send({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args })
      if (index < 17) {
        const result = { content: [{ type: 'text', text: 'Tool output marker ' + index + '\\n' + 'Expandable output remains readable.\\n'.repeat(5) }] }
        pendingToolIds.delete(id)
        appendMessage('toolResult', result.content, { toolCallId: id, toolName: 'bash', isError: false })
        send({ type: 'tool_execution_end', toolCallId: id, toolName: 'bash', result })
      }
      if (index === 7) {
        const thinking = 'Second reasoning body marker. ' + 'More settled reasoning remains scrollable. '.repeat(18)
        appendMessage('assistant', [{ type: 'thinking', thinking }])
        send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: thinking } })
      }
    }

  } else if (command.id) {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {} })
  }
})
`)
  chmodSync(executable, 0o755)
  return executable
}

function stopFakeOmp(fixtureRoot: string): void {
  let pid: number
  try {
    pid = Number(readFileSync(join(fixtureRoot, 'omp-layout-fixture.pid'), 'utf8'))
  } catch {
    return
  }
  if (!Number.isInteger(pid) || pid <= 0) return
  try { process.kill(pid, 'SIGKILL') } catch { /* The runtime may already have exited normally. */ }
}

export async function launchWorkbenchLayout(nativeWindowSize?: { width: number; height: number }): Promise<WorkbenchLayoutFixture> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'omp-workbench-layout-'))
  let app: ElectronApplication | undefined
  try {
    const userData = join(fixtureRoot, 'user-data')
    const home = join(fixtureRoot, 'home')
    const project = join(fixtureRoot, 'project')
    const sessions = join(home, '.omp', 'agent', 'sessions', 'layout')
    for (const directory of [userData, project, sessions]) mkdirSync(directory, { recursive: true })
    const canonicalProject = realpathSync(project)
    const timestamp = new Date().toISOString()
    const sessionFile = join(sessions, '2026-04-01T00-00-00-000Z_019fdf24-aaaa-7000-8000-00000000a11.jsonl')
    writeFileSync(sessionFile, [
      titleSlot(LONG_SESSION_TITLE, timestamp),
      JSON.stringify({ type: 'session', version: 3, id: 'layout-session', timestamp, cwd: canonicalProject }),
      JSON.stringify({ type: 'message', id: 'layout-user', parentId: null, timestamp, message: { role: 'user', content: LONG_SESSION_TITLE, timestamp: Date.parse(timestamp) } }),
      '',
    ].join('\n'))
    writeFileSync(join(userData, LEGACY_DESKTOP_STATE_FILENAME), JSON.stringify({
      version: 1,
      projects: [{ id: 'layout-project', name: 'Layout fixture', path: canonicalProject, folders: [canonicalProject], primaryFolder: canonicalProject, pinned: false, createdAt: timestamp, lastOpenedAt: timestamp }],
      settings: { activeHarness: 'prime', browserHome: 'about:blank', telemetry: false, locale: 'en', showReasoningSummaries: true, showToolCalls: true, reasoningExpandedByDefault: false },
      archivedSessions: [], pinnedSessions: [realpathSync(sessionFile)], dismissedProjectPaths: [],
    }))
    const ompExecutable = writeFakeOmp(fixtureRoot, sessionFile)
    const cuaExecutable = join(fixtureRoot, 'cua-layout-fixture.cjs')
    writeFileSync(cuaExecutable, '#!/usr/bin/env node\nif (process.argv.includes(\'--version\')) process.stdout.write(\'cua-driver 0.19.0\\n\')\n')
    chmodSync(cuaExecutable, 0o755)
    const environment: NodeJS.ProcessEnv = {
      HOME: home,
      PATH: process.env.PATH,
      TMPDIR: fixtureRoot,
      SHELL: '/bin/zsh',
      LANG: 'C', LC_ALL: 'C', NO_COLOR: '1',
      OMP_DESKTOP_E2E_HIDE_WINDOWS: '1',
      OMP_BINARY: ompExecutable,
      CUA_DRIVER_PATH: cuaExecutable,
    }
    for (const key of ['USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING', 'DISPLAY', 'XAUTHORITY']) if (process.env[key]) environment[key] = process.env[key]
    app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: process.cwd(), env: environment as Record<string, string>, timeout: 20_000 })
    const page = await app.firstWindow({ timeout: 15_000 })
    if (nativeWindowSize) {
      const nativeWindow = await app.browserWindow(page)
      await nativeWindow.evaluate((browserWindow, size) => browserWindow.setSize(size.width, size.height), nativeWindowSize)
    }
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
    return {
      page,
      captureScreenshot: async () => {
        const nativeWindow = await app?.browserWindow(page)
        if (!nativeWindow) throw new Error('The layout fixture Electron window is already closed')
        const base64 = await nativeWindow.evaluate(async (browserWindow) => (await browserWindow.webContents.capturePage()).toPNG().toString('base64'))
        return Buffer.from(base64, 'base64')
      },
      finishRun: async () => {
        writeFileSync(join(fixtureRoot, 'finish-run'), 'finish')
        const completed = await page.evaluate(async () => {
          const runtimes = await window.desktop.agent.list()
          for (const runtime of runtimes) {
            if (!runtime.isStreaming) continue
            await window.desktop.agent.command(runtime.runtimeId, { type: 'get_state' })
            return true
          }
          return false
        })
        if (!completed) throw new Error('No streaming runtime was available for the layout finish handshake')
      },
      close: async () => {
        const target = app
        app = undefined
        stopFakeOmp(fixtureRoot)
        try {
          const closing = target?.close()
          target?.process().kill('SIGKILL')
          await closing
        } catch {
          // Forced Electron teardown is expected after the isolated assertions.
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    stopFakeOmp(fixtureRoot)
    try {
      const closing = app?.close()
      app?.process().kill('SIGKILL')
      await closing
    } catch {
      // Preserve the launch failure while still reaping the isolated app.
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
    throw error
  }
}
