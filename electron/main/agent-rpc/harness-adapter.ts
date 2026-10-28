import type { HarnessId, PrimeContextUsage, SessionActionSnapshot, SessionUsage, SessionUsageTokens, UsageLimitState } from '../../../src/types/api'
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
  /** 回報表示帳號進入限流;state dump 缺席該欄代表未限流(讀取方清除)。 */
  usageLimit?: UsageLimitState
  contextUsage?: PrimeContextUsage
  /** 上游回報的末回合輸出速度;null 表示尚未有回合(讀取方清除顯示)。 */
  tokensPerSecond?: number | null
  sessionActions?: SessionActionSnapshot
}

/** 上游 UsageLimitState(stage 判別聯集);形狀不符時回傳 null,絕不部分放行。 */
export function parseUsageLimitState(raw: unknown): UsageLimitState | null {
  if (!isRecord(raw)) return null
  if (raw.stage === 'low_priority') {
    if (typeof raw.resetsAtSec !== 'number' || !Number.isFinite(raw.resetsAtSec)) return null
    const allowanceLeftPercent = raw.allowanceLeftPercent
    if (allowanceLeftPercent !== undefined && (!Number.isSafeInteger(allowanceLeftPercent) || Number(allowanceLeftPercent) < 0 || Number(allowanceLeftPercent) > 100)) return null
    return {
      stage: 'low_priority',
      resetsAtSec: raw.resetsAtSec,
      ...(allowanceLeftPercent !== undefined ? { allowanceLeftPercent: Number(allowanceLeftPercent) } : {}),
    }
  }
  if (raw.stage === 'wrap_up') {
    if (typeof raw.extraUsage !== 'boolean') return null
    if (raw.resetsAtSec !== undefined && (typeof raw.resetsAtSec !== 'number' || !Number.isFinite(raw.resetsAtSec))) return null
    return {
      stage: 'wrap_up',
      extraUsage: raw.extraUsage,
      ...(raw.resetsAtSec !== undefined ? { resetsAtSec: Number(raw.resetsAtSec) } : {}),
    }
  }
  return null
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



const OMP_UNSUPPORTED_COMMANDS = new Set([
  'send_message', 'clone', 'set_heartbeat', 'update_heartbeat', 'manage_heartbeat', 'observe', 'unobserve',
  'list_heartbeats', 'get_heartbeat', 'agent_messages_status', 'agent_messages_pause', 'agent_messages_resume',
  'agent_messages_clear',
])

const OMP_APPROVAL_MODES = new Set(['always-ask', 'write', 'yolo'])

// 上游 LivePhase(v18.12.6 packages/tui/src/apps/live-visualizer.ts:15)。
const LIVE_PHASES: ReadonlySet<string> = new Set(['connecting', 'listening', 'working', 'speaking', 'muted', 'error'])
const MAX_LIVE_TRANSCRIPT_TEXT_CHARS = 64 * 1024
const clampLiveLevel = (value: number): number => (value <= 0 ? 0 : Math.min(1, value))

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
    return command
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
    // Live voice frames(上游 v18.12.6 rpc-types.ts Live Voice Frames;非
    // session event,set_event_filter 不攔截,上游保證送達)。白名單驗證後
    // 轉發;形狀不符整幀丟棄,renderer 只能在此類幀上出錯。live_levels 上游
    // 已限流到最多每 100ms 一幀且只攜最新值(rpc-live.ts
    // RPC_LIVE_LEVELS_INTERVAL_MS + #queueLevels),此處不再聚合;renderer
    // 以獨立 hook 訂閱,不進 transcript store。
    if (event.type === 'live_phase') {
      return typeof event.phase === 'string' && LIVE_PHASES.has(event.phase) ? { type: 'live_phase', phase: event.phase } : null
    }
    if (event.type === 'live_levels') {
      const { input, output } = event
      if (typeof input !== 'number' || !Number.isFinite(input) || typeof output !== 'number' || !Number.isFinite(output)) return null
      return { type: 'live_levels', input: clampLiveLevel(input), output: clampLiveLevel(output) }
    }
    if (event.type === 'live_transcript') {
      // role+turn 是合併鍵(上游 LiveTranscript 語意,controller.ts);final
      // 標記該輪定稿。超長或形狀不符的幀丟棄,不送部分資料。
      if ((event.role !== 'user' && event.role !== 'assistant')) return null
      if (!Number.isSafeInteger(event.turn) || (event.turn as number) < 0) return null
      if (typeof event.text !== 'string' || event.text.length > MAX_LIVE_TRANSCRIPT_TEXT_CHARS) return null
      if (event.final !== true && event.final !== false) return null
      return { type: 'live_transcript', role: event.role, turn: event.turn as number, text: event.text, final: event.final }
    }
    if (event.type === 'live_end') {
      // 每個 live session 恰送一次(rpc-live.ts onTerminal);error 是失敗
      // 原因,成功結束時缺席。
      if (event.error !== undefined && typeof event.error !== 'string') return null
      return event.error === undefined ? { type: 'live_end' } : { type: 'live_end', error: event.error.slice(0, 4_000) }
    }
    return event
  },
  buildServiceTierCommand: (serviceTier) => ({ type: 'set_fast_mode', enabled: serviceTier === 'priority' }),
  readState: (data) => {
    const reading: HarnessStateReading = {}
    if (typeof data.fastModeEnabled === 'boolean') reading.serviceTier = data.fastModeEnabled ? 'priority' : 'default'
    // state dump 以欄位缺席表達「未限流」;讀取方據此清除。
    const usageLimit = parseUsageLimitState(data.usageLimit)
    if (usageLimit) reading.usageLimit = usageLimit
    const usage = parseContextUsage(data.contextUsage)
    if (usage) reading.contextUsage = usage
    if (typeof data.tokensPerSecond === 'number' && Number.isFinite(data.tokensPerSecond) && data.tokensPerSecond >= 0) {
      reading.tokensPerSecond = data.tokensPerSecond
    } else if (data.tokensPerSecond === null) {
      reading.tokensPerSecond = null
    }
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
