import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEGACY_DESKTOP_STATE_FILENAME } from '../../electron/main/store'

export interface NativeFormProbe {
  app: ElectronApplication
  page: Page
  wireFile: string
  close(): Promise<void>
}

export interface NativeFormProbeOptions {
  /** Opt-in deterministic native prediction responses; no provider is contacted. */
  wordPrediction?: boolean
  /** Opt-in sticky-fast state; the ordinary form probe remains unchanged. */
  fastFallback?: boolean
  /** Opt-in session-scoped native slow state; all default/fast wire fields remain unchanged. */
  slowMode?: boolean
}

function titleSlot(timestamp: string): string {
  const unpadded = JSON.stringify({ type: 'title', v: 1, title: 'Native form fixture', updatedAt: timestamp, pad: '' })
  return JSON.stringify({ type: 'title', v: 1, title: 'Native form fixture', updatedAt: timestamp, pad: ' '.repeat(255 - Buffer.byteLength(unpadded, 'utf8')) })
}

/** An interactive rpc-ui wire fake; ordinary `--mode rpc` is proved separately against the real CLI. */
function writeFakeOmp(fixtureRoot: string, sessionFile: string, wireFile: string, options: NativeFormProbeOptions = {}): string {
  const executable = join(fixtureRoot, 'omp-native-form-fake.cjs')
  const fastFallback = options.fastFallback === true
  const slowMode = options.slowMode === true
  const wordPrediction = options.wordPrediction === true
  const modelId = fastFallback ? 'gpt-5.6' : 'gpt-fixture'
  const html = `<form action="https://invalid.example/ignored" onsubmit="throw new Error('must not execute')">
    <h1>Native wire probe</h1>
    <label for="nativeProject">Native project</label><input id="nativeProject" name="project" required>
    <label>Probe token<input name="token" type="password" autocomplete="on" required></label>
    <label>Threads<input name="threads" type="number" min="0" max="10" step="2" required></label>
    <fieldset><legend>Mode</legend><label>Fast<input type="radio" name="mode" value="fast" checked></label><label>Slow<input type="radio" name="mode" value="slow"></label></fieldset>
    <fieldset><legend>Channels</legend><label>Alpha<input type="checkbox" name="features" value="alpha"></label><label>Beta<input type="checkbox" name="features" value="beta" disabled></label></fieldset>
    <input type="hidden" name="origin" value="from-native-frame">
    <script>throw new Error('must not execute')</script>
  </form>`
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('omp/19.1.0\\n'); process.exit(0) }
if (args[0] === 'models' && args.includes('--json')) {
  process.stdout.write(JSON.stringify({ models: [{ provider: 'openai-codex', id: ${JSON.stringify(modelId)}, name: 'GPT Fixture', contextWindow: 200000, maxTokens: 8192, reasoning: true, thinking: ['low', 'high'], input: ['text'] }] }) + '\\n')
  process.exit(0)
}
if (!args.includes('--mode') || args[args.indexOf('--mode') + 1] !== 'rpc-ui') process.exit(2)
const activeSessionFile = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : ${JSON.stringify(sessionFile)}
const formHtml = ${JSON.stringify(html)}
const wireFile = ${JSON.stringify(wireFile)}
const fastFallback = ${JSON.stringify(fastFallback)}
const slowMode = ${JSON.stringify(slowMode)}
const wordPrediction = ${JSON.stringify(wordPrediction)}
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let fastModeEnabled = true
const fastModeActive = false
let slowModeEnabled = false
let negotiated = false
let streaming = false
let activePromptId
let answered = false
send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'negotiate_protocol') {
    negotiated = true
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { protocolVersion: 2 } })
  } else if (!negotiated) {
    send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Protocol was not negotiated' })
  } else if (command.type === 'get_state') {
    if (fastFallback) fs.appendFileSync(wireFile, JSON.stringify(command) + '\\n')
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {
      sessionId: 'native-form-session', sessionFile: activeSessionFile, isStreaming: streaming, thinkingLevel: 'medium',
      model: { provider: 'openai-codex', id: ${JSON.stringify(modelId)}, name: 'GPT Fixture' },
      contextUsage: { tokens: 1200, contextWindow: 200000, percent: 1 },
      ...(fastFallback ? { fastModeEnabled, fastModeActive } : {}),
      ...(slowMode ? { slowModeSupported: true, slowModeEnabled, slowModeScope: 'session' } : {}),
      queuedMessageCount: 0, queuedMessages: { steering: [], followUp: [] },
    } })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { contextUsage: { tokens: 1200, contextWindow: 200000, percent: 1 } } })
  } else if (fastFallback && command.type === 'set_fast_mode') {
    fs.appendFileSync(wireFile, JSON.stringify(command) + '\\n')
    fastModeEnabled = command.enabled
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { enabled: fastModeEnabled, active: fastModeActive } })
  } else if (slowMode && command.type === 'set_slow_mode') {
    fs.appendFileSync(wireFile, JSON.stringify(command) + '\\n')
    slowModeEnabled = command.enabled
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { enabled: command.enabled } })
  } else if (slowMode && ['prompt', 'login'].includes(command.type)) {
    fs.appendFileSync(wireFile, JSON.stringify(command) + '\\n')
    send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unexpected interaction in Slow fixture' })
  } else if (command.type === 'set_subagent_subscription') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { level: command.level } })
    send({ type: 'available_commands_update', commands: [] })
  } else if (command.type === 'get_subagents') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { subagents: [] } })
  } else if (wordPrediction && command.type === 'predict_word') {
    fs.appendFileSync(wireFile, JSON.stringify(command) + '\\n')
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { suffix: command.text.includes('silent') ? null : ' world' } })
  } else if (wordPrediction && command.type === 'predict_word_feedback') {
    fs.appendFileSync(wireFile, JSON.stringify(command) + '\\n')
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {} })
  } else if (command.type === 'prompt') {
    streaming = true
    activePromptId = command.id
    answered = false
    send({ type: 'agent_start' })
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
    send({ type: 'extension_ui_request', id: 'native-form-rpc-1', method: 'form', html: formHtml })
  } else if (command.type === 'extension_ui_response' && command.id === 'native-form-rpc-1') {
    if (answered) return
    answered = true
    try {
      // Durable exact-wire evidence is completed before terminal events.
      fs.appendFileSync(wireFile, JSON.stringify(command) + '\\n')
      streaming = false
      send({ type: 'agent_end', isTerminal: true, yielded: true })
      send({ type: 'prompt_result', id: activePromptId, agentInvoked: true, status: 'completed', sessionSettled: true })
      send({ type: 'session_settled' })
    } catch (error) {
      send({ type: 'agent_end', isTerminal: true, yielded: true })
      send({ type: 'prompt_result', id: activePromptId, agentInvoked: true, status: 'error', error: { message: String(error), retryable: false }, sessionSettled: true })
      send({ type: 'session_settled' })
    }
  } else if (command.type === 'abort') {
    streaming = false
    send({ type: 'extension_ui_request', id: 'native-form-cancel-event', method: 'cancel', targetId: 'native-form-rpc-1' })
    send({ type: 'agent_end', isTerminal: true, yielded: true })
    send({ type: 'session_settled' })
  } else if (command.id) {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {} })
  }
})
`)
  chmodSync(executable, 0o755)
  return executable
}

export async function launchNativeFormProbe(options: NativeFormProbeOptions = {}): Promise<NativeFormProbe> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'omp-native-form-renderer-'))
  let app: ElectronApplication | undefined
  let page: Page | undefined
  try {
    const userData = join(fixtureRoot, 'user-data')
    const home = join(fixtureRoot, 'home')
    const project = join(fixtureRoot, 'project')
    const sessions = join(home, '.omp', 'agent', 'sessions', 'native-form')
    for (const directory of [userData, project, sessions]) mkdirSync(directory, { recursive: true })
    const canonicalProject = realpathSync(project)
    const timestamp = new Date().toISOString()
    const sessionFile = join(sessions, '2026-04-01T00-00-00-000Z_019fdf24-aaaa-7000-8000-00000000f019.jsonl')
    writeFileSync(sessionFile, [
      titleSlot(timestamp),
      JSON.stringify({ type: 'session', version: 3, id: 'native-form-session', timestamp, cwd: canonicalProject }),
      JSON.stringify({ type: 'message', id: 'native-form-user', parentId: null, timestamp, message: { role: 'user', content: 'Native form fixture', timestamp: Date.parse(timestamp) } }),
      '',
    ].join('\n'))
    writeFileSync(join(userData, LEGACY_DESKTOP_STATE_FILENAME), JSON.stringify({
      version: 1,
      projects: [{ id: 'native-form-project', name: 'Native form fixture', path: canonicalProject, folders: [canonicalProject], primaryFolder: canonicalProject, pinned: false, createdAt: timestamp, lastOpenedAt: timestamp }],
      settings: { activeHarness: 'prime', browserHome: 'about:blank', telemetry: false, locale: 'en' },
      archivedSessions: [], pinnedSessions: [realpathSync(sessionFile)], dismissedProjectPaths: [],
    }))
    const wireFile = join(fixtureRoot, 'native-form-wire.jsonl')
    writeFileSync(wireFile, '')
    const ompExecutable = writeFakeOmp(fixtureRoot, sessionFile, wireFile, options)
    const cuaExecutable = join(fixtureRoot, 'cua-native-form-fake.cjs')
    writeFileSync(cuaExecutable, '#!/usr/bin/env node\nif (process.argv.includes(\'--version\')) process.stdout.write(\'cua-driver 0.19.0\\n\')\n')
    chmodSync(cuaExecutable, 0o755)
    const environment: NodeJS.ProcessEnv = {
      HOME: home, PATH: process.env.PATH, TMPDIR: fixtureRoot, SHELL: '/bin/zsh', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1',
      OMP_DESKTOP_E2E_HIDE_WINDOWS: '1', OMP_BINARY: ompExecutable, CUA_DRIVER_PATH: cuaExecutable,
    }
    for (const key of ['USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING', 'DISPLAY', 'XAUTHORITY']) if (process.env[key]) environment[key] = process.env[key]
    app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: process.cwd(), env: environment as Record<string, string>, timeout: 20_000 })
    page = await app.firstWindow({ timeout: 15_000 })
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
    if (options.fastFallback || options.slowMode || options.wordPrediction) {
      // Start only the local RPC runtime; state-control probes never prompt the
      // model or emit an agent_start/provider interaction.
      await page.evaluate(async ({ cwd, sessionPath, fastFallback }) => {
        await window.desktop.agent.start({ cwd, sessionPath, model: fastFallback ? 'openai-codex/gpt-5.6' : 'openai-codex/gpt-fixture' })
      }, { cwd: canonicalProject, sessionPath: sessionFile, fastFallback: options.fastFallback === true })
    }
    const target = app
    const targetPage = page
    return {
      app: target,
      page: targetPage,
      wireFile,
      close: async () => {
        app = undefined
        try {
          const runtimes = await targetPage.evaluate(() => window.desktop.agent.list())
          for (const runtime of runtimes) await targetPage.evaluate(async (runtimeId) => { await window.desktop.agent.stop(runtimeId) }, runtime.runtimeId)
          await target.close()
        } catch {
          target.process().kill('SIGKILL')
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
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

export function readNativeWire(wireFile: string): Array<Record<string, unknown>> {
  return readFileSync(wireFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}
