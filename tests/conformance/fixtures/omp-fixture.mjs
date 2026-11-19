#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)

if (args.includes('--version')) {
  process.stdout.write('omp/17.2.15\n')
  process.exit(0)
}

if (args[0] === 'update' && args.includes('--check')) {
  if (process.env.OMP_FIXTURE_UPDATE_AVAILABLE) {
    process.stdout.write(`Current version: 17.2.15\nNew version available: ${process.env.OMP_FIXTURE_UPDATE_AVAILABLE}\n`)
  } else {
    process.stdout.write('Current version: 17.2.15\n✔ Already up to date\n')
  }
  process.exit(0)
}

if (args[0] === 'update') {
  process.stdout.write('Installing update...\nRestart omp to use the new version\n')
  process.exit(0)
}

if (args[0] === 'config' && args[1] === 'get' && args[2] === 'modelRoles') {
  if (process.env.OMP_FIXTURE_VISION_ROLE === '1') {
    process.stdout.write('{"vision":"anthropic/claude-fixture"}\n')
  } else {
    process.stdout.write('{}\n')
  }
  process.exit(0)
}

if (args[0] === 'plugin' && ['install', 'enable', 'disable', 'uninstall'].includes(args[1] ?? '')) {
  const action = args[1]
  const target = args[2] ?? ''
  const isProject = args.includes('--scope') && args[args.indexOf('--scope') + 1] === 'project'
  const home = process.env.OMP_FIXTURE_HOME || process.env.HOME || process.env.USERPROFILE || homedir()
  const pluginsRoot = isProject ? join(process.cwd(), '.omp', 'plugins') : join(home, '.omp', 'plugins')
  const packageName = target.startsWith('@') ? target.replace(/^(@[^/]+\/[^@]+)@.+$/, '$1') : target.replace(/^([^@]+)@.+$/, '$1')

  if (action === 'install') {
    const packageDir = join(pluginsRoot, 'node_modules', ...packageName.split('/'))
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({ name: packageName, description: 'Fixture OMP plugin package.', omp: {} }, null, 2)}\n`, 'utf8')
  } else {
    const lockPath = join(pluginsRoot, 'omp-plugins.lock.json')
    let lock = {}
    try {
      lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    } catch {
      lock = {}
    }
    const plugins = lock && typeof lock === 'object' && lock.plugins && typeof lock.plugins === 'object' ? lock.plugins : {}
    if (action === 'uninstall') {
      delete plugins[packageName]
    } else {
      plugins[packageName] = { ...(plugins[packageName] ?? {}), enabled: action !== 'disable' }
    }
    mkdirSync(pluginsRoot, { recursive: true })
    writeFileSync(lockPath, `${JSON.stringify({ plugins }, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`)
  process.exit(0)
}

if (args[0] === 'models' && args.includes('--json')) {
  process.stdout.write(
    `${JSON.stringify({
      models: [
        {
          provider: 'anthropic',
          id: 'claude-fixture',
          name: 'Claude Fixture',
          contextWindow: 100_000,
          maxTokens: 8_192,
          reasoning: true,
          thinking: ['low', 'high'],
          input: ['text', 'image'],
        },
        {
          provider: 'openai-codex',
          id: 'gpt-5.4',
          name: 'GPT-5.4 Fixture',
          contextWindow: 200_000,
          maxTokens: 16_384,
          reasoning: true,
          thinking: ['low', 'medium', 'high'],
          input: ['text'],
        },
        {
          provider: 'local',
          id: 'plain-model',
          name: 'Plain Model',
          contextWindow: 32_768,
          maxTokens: 4_096,
          reasoning: false,
          thinking: null,
          input: ['text'],
        },
        // Malformed entry to assert untrusted catalog entry filtering.
        { provider: '', id: 123 },
      ],
    })}\n`,
  )
  process.exit(0)
}

const modeIndex = args.indexOf('--mode')
if (modeIndex === -1 || args[modeIndex + 1] !== 'rpc') {
  process.exit(2)
}

const stateDir = process.env.OMP_FIXTURE_STATE_DIR || ''
const recordState = (filename, content) => {
  if (!stateDir) return
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, filename), content, 'utf8')
}

const appendCommandLog = (command) => {
  if (!stateDir) return
  mkdirSync(stateDir, { recursive: true })
  appendFileSync(join(stateDir, 'omp-commands.jsonl'), `${JSON.stringify(command)}\n`, 'utf8')
}

if (stateDir) {
  recordState('omp-argv.json', `${JSON.stringify(args)}\n`)
  recordState('omp-pid.txt', String(process.pid))
  recordState(
    'omp-env.json',
    `${JSON.stringify({
      NO_COLOR: process.env.NO_COLOR ?? null,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
      LD_PRELOAD: process.env.LD_PRELOAD ?? null,
      DYLD_INSERT_LIBRARIES: process.env.DYLD_INSERT_LIBRARIES ?? null,
      OMP_DESKTOP_SCHEDULE_URL: process.env.OMP_DESKTOP_SCHEDULE_URL ?? null,
      OMP_DESKTOP_SCHEDULE_TOKEN: process.env.OMP_DESKTOP_SCHEDULE_TOKEN ?? null,
      GOOEYPI_COLLABORATION_URL: process.env.GOOEYPI_COLLABORATION_URL ?? null,
      GOOEYPI_COLLABORATION_TOKEN: process.env.GOOEYPI_COLLABORATION_TOKEN ?? null,
    })}\n`,
  )
}

const resumeIndex = args.indexOf('--resume')
const sessionFile = (resumeIndex >= 0 ? args[resumeIndex + 1] : undefined) || process.env.OMP_FIXTURE_SESSION_FILE || (stateDir ? join(stateDir, 'default-session.jsonl') : '')

const modelIndex = args.indexOf('--model')
const initialModelSelector = modelIndex >= 0 ? args[modelIndex + 1] : 'anthropic/claude-fixture'
const slashIdx = initialModelSelector.indexOf('/')
let currentModel =
  slashIdx > 0
    ? {
        provider: initialModelSelector.slice(0, slashIdx),
        id: initialModelSelector.slice(slashIdx + 1),
        name: initialModelSelector.slice(slashIdx + 1),
      }
    : { provider: 'anthropic', id: 'claude-fixture', name: 'Claude Fixture' }

const thinkingIndex = args.indexOf('--thinking')
let thinkingLevel = thinkingIndex >= 0 ? args[thinkingIndex + 1] : 'medium'
let fastModeEnabled = false
let streaming = false
const steeringQueue = []
const followUpQueue = []
let negotiated = false
let dictationCaptureId = ''

const send = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const sessionActionsSnapshot = () => ({
  queuedCount: steeringQueue.length + followUpQueue.length,
  steering: [...steeringQueue],
  followUps: [...followUpQueue],
})

const replySuccess = (command, data = {}) => {
  send({ id: command.id, type: 'response', command: command.type, success: true, data })
}

const replyError = (command, error) => {
  send({ id: command.id, type: 'response', command: command.type, success: false, error })
}

send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })

rl.on('line', (line) => {
  if (!line.trim()) return
  let command
  try {
    command = JSON.parse(line)
  } catch {
    return
  }

  if (command.type === 'negotiate_protocol') {
    negotiated = true
    replySuccess(command, { protocolVersion: 2 })
    return
  }

  if (!negotiated) {
    replyError(command, 'Protocol was not negotiated')
    return
  }

  appendCommandLog(command)

  switch (command.type) {
    case 'get_state': {
      replySuccess(command, {
        sessionId: 'fixture-session',
        sessionFile: sessionFile || undefined,
        isStreaming: streaming,
        thinkingLevel,
        model: currentModel,
        contextUsage: { tokens: 12_000, contextWindow: 100_000, percent: 12 },
        fastModeEnabled,
        queuedMessageCount: steeringQueue.length + followUpQueue.length,
        queuedMessages: { steering: [...steeringQueue], followUp: [...followUpQueue] },
        sessionActions: sessionActionsSnapshot(),
      })
      break
    }
    case 'get_session_stats': {
      replySuccess(command, {
        contextUsage: { tokens: 12_000, contextWindow: 100_000, percent: 12 },
        cost: 0.42,
        tokens: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1_200 },
      })
      break
    }
    case 'set_subagent_subscription': {
      replySuccess(command, { level: command.level })
      break
    }
    case 'set_ask_dialog': {
      replySuccess(command, { enabled: Boolean(command.enabled) })
      break
    }
    case 'get_subagents': {
      replySuccess(command, { subagents: [] })
      break
    }
    case 'get_login_providers': {
      replySuccess(command, {
        providers: [{ id: 'anthropic', name: 'Anthropic', available: true, authenticated: false }],
      })
      break
    }
    case 'set_model': {
      currentModel = { provider: command.provider, id: command.modelId, name: command.modelId }
      replySuccess(command, { model: currentModel })
      break
    }
    case 'set_thinking_level': {
      thinkingLevel = command.level
      replySuccess(command, { level: thinkingLevel })
      break
    }
    case 'set_fast_mode': {
      fastModeEnabled = Boolean(command.enabled)
      replySuccess(command, { enabled: fastModeEnabled })
      break
    }
    case 'set_session_name': {
      replySuccess(command, { name: command.name })
      break
    }
    case 'branch':
    case 'fork': {
      replySuccess(command, { cancelled: false, entryId: command.entryId })
      break
    }
    case 'get_branch_messages': {
      replySuccess(command, { messages: [] })
      break
    }
    case 'steer': {
      steeringQueue.push(String(command.message ?? ''))
      send({ type: 'session_action_update', actions: sessionActionsSnapshot() })
      replySuccess(command, { queued: true })
      break
    }
    case 'follow_up': {
      followUpQueue.push(String(command.message ?? ''))
      send({ type: 'session_action_update', actions: sessionActionsSnapshot() })
      replySuccess(command, { queued: true })
      break
    }
    case 'abort': {
      streaming = false
      replySuccess(command, { aborted: true })
      send({ type: 'agent_end', isTerminal: true })
      break
    }
    case 'compact': {
      if (sessionFile) {
        mkdirSync(dirname(sessionFile), { recursive: true })
        appendFileSync(
          sessionFile,
          `${JSON.stringify({
            type: 'compaction',
            id: 'fixture-compact-1',
            parentId: null,
            timestamp: new Date().toISOString(),
            tokensBefore: 12_000,
            tokensAfter: 3_000,
            summary: 'Fixture manual compaction',
          })}\n`,
          'utf8',
        )
      }
      replySuccess(command, { agentInvoked: false })
      break
    }
    case 'bash': {
      replySuccess(command, {
        output: `bash-ok: ${String(command.command ?? '')}`,
        cancelled: false,
        truncated: false,
        exitCode: 0,
      })
      break
    }
    case 'abort_bash': {
      replySuccess(command, { cancelled: true })
      break
    }
    case 'btw': {
      const recordId = command.recordId ?? 'topic-1'
      replySuccess(command, { recordId })
      send({
        type: 'btw_record',
        record: {
          id: recordId,
          question: command.question,
          answer: 'Side answer',
          status: 'complete',
          createdAt: 1,
          updatedAt: 2,
        },
      })
      break
    }
    case 'btw_cancel': {
      replySuccess(command, { cancelled: true })
      break
    }
    case 'get_btw_history': {
      replySuccess(command, { topics: [] })
      break
    }
    case 'live_start': {
      replySuccess(command, { voice: command.voice ?? 'sol' })
      send({ type: 'live_phase', phase: 'connecting' })
      send({ type: 'live_phase', phase: 'listening' })
      send({ type: 'live_levels', input: 0.25, output: 0.1 })
      send({ type: 'live_transcript', role: 'assistant', turn: 1, text: 'Hello live', final: true })
      break
    }
    case 'live_mute': {
      replySuccess(command, { muted: typeof command.muted === 'boolean' ? command.muted : true })
      break
    }
    case 'live_stop': {
      replySuccess(command, { stopped: true })
      send({ type: 'live_end' })
      break
    }
    case 'dictation_start': {
      dictationCaptureId = String(command.captureId ?? 'dictation-capture')
      replySuccess(command, { captureId: dictationCaptureId })
      send({ type: 'dictation_state', captureId: dictationCaptureId, state: 'starting' })
      send({ type: 'dictation_state', captureId: dictationCaptureId, state: 'recording' })
      send({ type: 'dictation_transcript', captureId: dictationCaptureId, text: 'Hello dictated' })
      break
    }
    case 'dictation_stop': {
      // The stop response may carry the text; `dictation_end` is the single
      // terminal result the host applies.
      replySuccess(command, { text: 'Hello dictated world' })
      send({ type: 'dictation_state', captureId: dictationCaptureId, state: 'transcribing' })
      send({ type: 'dictation_end', captureId: dictationCaptureId, text: 'Hello dictated world' })
      break
    }
    case 'prompt': {
      const message = String(command.message ?? '')
      replySuccess(command, { accepted: true })
      if (message.includes('[hold-busy]')) {
        streaming = true
        send({ type: 'agent_start' })
        break
      }
      if (message.includes('[chunked]')) {
        const payload = Buffer.from(
          JSON.stringify({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'chunked-hello' },
          }),
          'utf8',
        )
        const mid = Math.ceil(payload.length / 2)
        const part0 = payload.subarray(0, mid)
        const part1 = payload.subarray(mid)
        send({ type: 'rpc_chunk', chunkId: 'c1', index: 0, count: 2, byteLength: part0.length, data: part0.toString('base64') })
        send({ type: 'rpc_chunk', chunkId: 'c1', index: 1, count: 2, byteLength: part1.length, data: part1.toString('base64') })
        send({ type: 'agent_end', isTerminal: true })
        break
      }
      if (message.includes('[auto-compact]')) {
        send({ type: 'auto_compaction_start', reason: 'threshold' })
        send({
          type: 'auto_compaction_end',
          reason: 'threshold',
          aborted: false,
          willRetry: false,
          tokensBefore: 10_000,
          tokensAfter: 2_500,
          summary: 'Fixture auto compaction',
        })
        send({ type: 'agent_end', isTerminal: true })
        break
      }
      if (message.includes('[non-terminal]')) {
        send({ type: 'agent_start' })
        send({ type: 'agent_end', isTerminal: false })
        send({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'after-non-terminal' },
        })
        send({ type: 'agent_end', isTerminal: true })
        break
      }
      if (message.includes('[fallback]')) {
        send({ type: 'retry_fallback_applied', provider: 'anthropic', modelId: 'claude-fixture', reason: 'rate_limit' })
        send({ type: 'agent_end', isTerminal: true })
        break
      }
      if (message.includes('[live-events]')) {
        send({ type: 'live_phase', phase: 'listening' })
        send({ type: 'live_phase', phase: 'bogus_phase' })
        send({ type: 'live_levels', input: 1.5, output: -0.2 })
        send({ type: 'live_transcript', role: 'assistant', turn: 1, text: 'Hello live', final: true })
        send({ type: 'live_end' })
        send({ type: 'agent_end', isTerminal: true })
        break
      }
      send({ type: 'agent_start' })
      send({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `echo:${message}` } })
      send({ type: 'message_end', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: `echo:${message}` }] } })
      send({ type: 'agent_end', isTerminal: true })
      break
    }
    default: {
      replySuccess(command, {})
      break
    }
  }
})

rl.on('close', () => {
  process.exit(0)
})

process.on('SIGTERM', () => {
  process.exit(0)
})
