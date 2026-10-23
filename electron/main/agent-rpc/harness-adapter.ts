import type { HarnessId, PrimeContextUsage, SessionActionSnapshot, SessionUsage, SessionUsageTokens } from '../../../src/types/api'
import { MAX_QUEUED_ACTIONS, parseSessionActionSnapshot } from '../../../src/lib/session-actions'
import { extensionInjections } from '../extension-manifest'
import { HARNESSES } from '../harness'
import { isRecord } from '../validation'
import type { RpcObject } from './types'

/** Normalized start inputs the manager resolves before the harness turns them into argv. */
export interface HarnessStartArgsInput {
  cwd: string
  sessionPath?: string
  /** Provider from the resolved catalog descriptor; absent when no catalog resolved the model. */
  providerId?: string
  /** Catalog model id, or the raw renderer-provided model string when no catalog resolved it. */
  modelId?: string
  thinking?: string
  /** OMP-only approval override; ignored by harnesses without the flag. */
  approvalMode?: string
  environment: NodeJS.ProcessEnv
}

/** Harness-specific fields read from get_state data, normalized to Prime vocabulary. */
export interface HarnessStateReading {
  serviceTier?: 'default' | 'priority'
  contextUsage?: PrimeContextUsage
  sessionActions?: SessionActionSnapshot
}

/**
 * Per-harness strategy for the shared RPC runtime: argv construction,
 * handshake shape, command/event vocabulary translation, and fast-mode
 * mapping. Transport framing, correlation, limits, and the compaction
 * watchdog stay shared and unchanged.
 */
export interface HarnessRpcAdapter {
  readonly id: HarnessId
  /** Product-facing agent name used in error messages. */
  readonly agentName: string
  /** Protocol version to negotiate before the first get_state; undefined skips negotiation. */
  readonly negotiateProtocolVersion?: number
  /** Whether v2 base64 rpc_chunk frames may arrive and must be reassembled. */
  readonly chunkedFrames: boolean
  buildStartArgs(input: HarnessStartArgsInput): string[]
  /** Renderer command vocabulary → harness wire vocabulary. Throws for commands the harness does not support. */
  translateCommand(command: RpcObject): RpcObject
  /** Harness event → Prime event vocabulary; null swallows the event entirely. */
  normalizeEvent(event: RpcObject): RpcObject | null
  /** The wire command that applies a service-tier preference; absent when the harness has no service tier, which the runtime reports as unsupported. */
  buildServiceTierCommand?(serviceTier: 'default' | 'priority'): RpcObject
  /** Reads harness-specific state fields out of get_state data. */
  readState(data: RpcObject): HarnessStateReading
}

export function parseContextUsage(raw: unknown): PrimeContextUsage | null {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.contextWindow) || Number(raw.contextWindow) <= 0) return null
  const tokens = raw.tokens === null ? null : Number.isSafeInteger(raw.tokens) && Number(raw.tokens) >= 0 ? Number(raw.tokens) : undefined
  const percent = raw.percent === null ? null : typeof raw.percent === 'number' && Number.isFinite(raw.percent) && raw.percent >= 0 ? raw.percent : undefined
  if (tokens === undefined || percent === undefined) return null
  return { tokens, contextWindow: Number(raw.contextWindow), percent }
}

const SESSION_TOKEN_FIELDS: Array<keyof SessionUsageTokens> = ['input', 'output', 'cacheRead', 'cacheWrite', 'total']

function parseSessionUsageTokens(raw: unknown): SessionUsageTokens | undefined {
  if (!isRecord(raw)) return undefined
  const tokens: Partial<SessionUsageTokens> = {}
  for (const field of SESSION_TOKEN_FIELDS) {
    const value = raw[field]
    if (!Number.isSafeInteger(value) || Number(value) < 0) return undefined
    tokens[field] = Number(value)
  }
  return tokens as SessionUsageTokens
}

/**
 * Reads the cost/token totals out of get_session_stats data. A missing or
 * malformed cost becomes null (older harness builds omit it); malformed token
 * fields drop the breakdown. Returns null only when neither is present.
 */
export function parseSessionUsage(raw: unknown): SessionUsage | null {
  if (!isRecord(raw)) return null
  const cost = typeof raw.cost === 'number' && Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : null
  const tokens = parseSessionUsageTokens(raw.tokens)
  if (cost === null && tokens === undefined) return null
  return tokens ? { cost, tokens } : { cost }
}

const unsafeArgValue = (value: string): boolean => value.startsWith('-') || /[\r\n]/.test(value)

const stripStreamingBehavior = (command: RpcObject): RpcObject => {
  if (command.type !== 'prompt' || command.streamingBehavior === undefined) return command
  // OMP drops streamingBehavior pending compatibility verification.
  const { streamingBehavior: _, ...rest } = command
  return rest
}


const OMP_UNSUPPORTED_COMMANDS = new Set([
  'send_message', 'clone', 'set_heartbeat', 'update_heartbeat', 'manage_heartbeat', 'observe', 'unobserve',
  'list_heartbeats', 'get_heartbeat', 'agent_messages_status', 'agent_messages_pause', 'agent_messages_resume',
  'agent_messages_clear',
])

const OMP_APPROVAL_MODES = new Set(['always-ask', 'write', 'yolo'])

export const OMP_RPC_ADAPTER: HarnessRpcAdapter = {
  id: 'omp',
  agentName: HARNESSES.omp.agentName,
  negotiateProtocolVersion: 2,
  chunkedFrames: true,
  buildStartArgs: (input) => {
    const args = ['--mode', 'rpc', '--cwd', input.cwd]
    if (input.sessionPath) args.push('--resume', input.sessionPath)
    if (input.modelId !== undefined) {
      // OMP takes a single provider/id selector; a raw model string with no
      // resolved provider descriptor is passed through as-is.
      const model = input.providerId ? `${input.providerId}/${input.modelId}` : input.modelId
      if (unsafeArgValue(model)) throw new TypeError('Invalid model')
      args.push('--model', model)
    }
    if (input.thinking) args.push('--thinking', input.thinking)
    if (input.approvalMode !== undefined) {
      if (!OMP_APPROVAL_MODES.has(input.approvalMode)) throw new TypeError('Invalid approval mode')
      args.push('--approval-mode', input.approvalMode)
    }
    const computerUseSkillPath = input.environment.GOOEYPI_COMPUTER_USE_SKILL_PATH
    if (computerUseSkillPath && !unsafeArgValue(computerUseSkillPath)) args.push('--append-system-prompt', computerUseSkillPath)
    // OMP has no --skill flag: app capabilities are injected as explicit,
    // self-contained extensions while normal OMP skills remain discovery-based.
    for (const injection of extensionInjections('omp')) {
      const extensionPath = input.environment[injection.environmentVariable]
      if (extensionPath && !unsafeArgValue(extensionPath)) args.push('--extension', extensionPath)
    }
    return args
  },
  translateCommand: (command) => {
    const type = String(command.type)
    if (OMP_UNSUPPORTED_COMMANDS.has(type)) throw new Error(`RPC command ${type} is not supported by the OMP harness`)
    if (type === 'fork') return { ...command, type: 'branch' }
    if (type === 'get_fork_messages') return { ...command, type: 'get_branch_messages' }
    // Side questions ride the OMP /btw protocol; the renderer never sees harness names.
    if (type === 'side_question') {
      const { topicId, ...rest } = command
      return { ...rest, type: 'btw', ...(topicId !== undefined ? { recordId: topicId } : {}) }
    }
    if (type === 'side_question_cancel') {
      const { topicId, ...rest } = command
      return { ...rest, type: 'btw_cancel', ...(topicId !== undefined ? { recordId: topicId } : {}) }
    }
    if (type === 'side_question_history') return { ...command, type: 'get_btw_history' }
    return stripStreamingBehavior(command)
  },
  normalizeEvent: (event) => {
    if (event.type === 'auto_compaction_start') return { ...event, type: 'compaction_start' }
    if (event.type === 'auto_compaction_end') return { ...event, type: 'compaction_end' }
    // A manual /compact runs as a local harness command: it never emits the
    // compaction lifecycle events the automatic path uses, only a
    // command_output completion line. Translate that line into the
    // compaction_end shape so the live transcript renders the divider (with
    // token counts) immediately instead of after a session re-entry.
    if (event.type === 'command_output' && typeof event.text === 'string') {
      const match = /^Compaction complete\. Tokens: (\d+) -> (\d+) \(saved -?\d+\)\.$/.exec(event.text)
      if (match) {
        return {
          type: 'compaction_end',
          reason: 'manual',
          aborted: false,
          willRetry: false,
          result: { tokensBefore: Number(match[1]), tokensAfter: Number(match[2]) },
        }
      }
    }
    // A non-terminal agent_end is a turn boundary inside a continuing run; it
    // must not finalize streaming rows in the renderer.
    if (event.type === 'agent_end' && event.isTerminal === false) return null
    // Side-question frames: full topic record on every lifecycle change (last
    // per id wins) plus answer deltas that append to the topic's latest turn.
    // Malformed frames are dropped: the renderer can only fail on them.
    if (event.type === 'btw_record') return isRecord(event.record) ? { type: 'side_question_record', topic: event.record } : null
    if (event.type === 'btw_delta') {
      return typeof event.recordId === 'string' && typeof event.delta === 'string'
        ? { type: 'side_question_delta', topicId: event.recordId, delta: event.delta }
        : null
    }
    return event
  },
  buildServiceTierCommand: (serviceTier) => ({ type: 'set_fast_mode', enabled: serviceTier === 'priority' }),
  readState: (data) => {
    const reading: HarnessStateReading = {}
    if (typeof data.fastModeEnabled === 'boolean') reading.serviceTier = data.fastModeEnabled ? 'priority' : 'default'
    const usage = parseContextUsage(data.contextUsage)
    if (usage) reading.contextUsage = usage
    if (Number.isSafeInteger(data.queuedMessageCount) && Number(data.queuedMessageCount) >= 0 && Number(data.queuedMessageCount) <= MAX_QUEUED_ACTIONS) {
      // get_state also names the held messages (queuedMessages.steering /
      // followUp previews). Keep them: the queue banner shows what omp is
      // holding, and a count-only reading here would wipe previews the
      // session_action_update events already delivered.
      const held = isRecord(data.queuedMessages) ? data.queuedMessages : {}
      const steering = Array.isArray(held.steering) ? held.steering : []
      const followUps = Array.isArray(held.followUp) ? held.followUp : []
      reading.sessionActions = parseSessionActionSnapshot({
        queuedCount: Number(data.queuedMessageCount),
        steering,
        followUps,
      }) ?? {
        queuedCount: Number(data.queuedMessageCount),
        steering: [],
        followUps: [],
      }
    }
    return reading
  },
}
