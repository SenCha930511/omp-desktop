import { record } from './parse'

/**
 * Context popover 的即時回合指標:TTFT(agent_start 到第一個內容 delta 的
 * 延遲)與 TPS(本回合輸出 token 數 ÷ 首末內容 delta 的時間差)。輸出
 * token 數取自 session_usage 累計值的前後差,因此不依賴 delta 計數。
 *
 * useAgentEvents 對「每個」runtime 的事件都餵進 observeTurnEvent,快照以
 * runtimeId 查詢:切換 session 自然回到 —(新 runtime 沒有回合),背景
 * runtime 的進行中回合也能在切回後繼續顯示。
 */

/** 一個回合的對外指標;null = 尚未得知(popover 顯示 —)。 */
export interface TurnMetrics {
  ttftMs: number | null
  tokensPerSecond: number | null
}

interface TurnState {
  startedAt: number
  firstTokenAt: number | null
  lastTokenAt: number | null
  /** 回合開始時的 session 累計輸出 token;本回合輸出量 = 結束值 − 基線。 */
  baselineOutputTokens: number | null
  /** agent_end 後收到 auto_retry_start:同一回合重開,計時延續不重置。 */
  retrying: boolean
  ended: boolean
  ttftMs: number | null
  tokensPerSecond: number | null
  /** 僅在值變時替換,維持 useSyncExternalStore 的快照穩定性。 */
  snapshot: TurnMetrics
}

/** 全空指標的共用參考:值不變時 getTurnMetrics 必須回傳同一個物件。 */
const EMPTY_METRICS: TurnMetrics = { ttftMs: null, tokensPerSecond: null }

const listeners = new Set<() => void>()
const turns = new Map<string, TurnState>()
/** 各 runtime 最後一次 session_usage 的累計輸出 token;下一回合的基線來源。 */
const sessionOutputByRuntime = new Map<string, number>()

function emit(): void {
  for (const listener of listeners) listener()
}

function snapshotFor(ttftMs: number | null, tokensPerSecond: number | null): TurnMetrics {
  return ttftMs === null && tokensPerSecond === null ? EMPTY_METRICS : { ttftMs, tokensPerSecond }
}

function publish(turn: TurnState): void {
  const next = snapshotFor(turn.ttftMs, turn.tokensPerSecond)
  if (next.ttftMs === turn.snapshot.ttftMs && next.tokensPerSecond === turn.snapshot.tokensPerSecond) return
  turn.snapshot = next
  emit()
}

/** message_update 的內容 delta:與 reduce.ts 同源的解析口徑(text/thinking 且非空)。 */
function isContentDelta(event: Record<string, unknown>): boolean {
  if (event.type !== 'message_update') return false
  const delta = record(event.assistantMessageEvent) ?? record(event.delta)
  const text = typeof delta?.delta === 'string' ? delta.delta : ''
  return (delta?.type === 'text_delta' || delta?.type === 'thinking_delta') && text !== ''
}

/** session_usage 事件的累計輸出 token;形狀不符時回 null(不猜測)。 */
function sessionOutputTokens(event: Record<string, unknown>): number | null {
  const tokens = record(record(event.sessionUsage)?.tokens)
  const output = tokens?.output
  return typeof output === 'number' && Number.isSafeInteger(output) && output >= 0 ? output : null
}

/** 以最新累計值結算本回合 TPS;可重複呼叫(agent_end 後才送達的讀數會補算)。 */
function finalizeOutputRate(turn: TurnState, outputTokens: number | null): void {
  if (turn.firstTokenAt === null || turn.lastTokenAt === null) return
  if (outputTokens === null || turn.baselineOutputTokens === null) return
  const tokens = outputTokens - turn.baselineOutputTokens
  if (tokens <= 0) return
  const seconds = (turn.lastTokenAt - turn.firstTokenAt) / 1000
  if (seconds <= 0) return
  turn.tokensPerSecond = tokens / seconds
  publish(turn)
}

export function observeTurnEvent(runtimeId: string, event: Record<string, unknown>): void {
  const type = typeof event.type === 'string' ? event.type : ''
  if (type === 'session_usage') {
    const output = sessionOutputTokens(event)
    if (output === null) return
    sessionOutputByRuntime.set(runtimeId, output)
    const turn = turns.get(runtimeId)
    if (!turn) return
    if (!turn.ended) {
      // 回合內、還沒串流任何內容 delta 時到達的累計讀數就是本回合基線;
      // delta 已開始才出現的首個讀數無法回推回合前值,寧可讓 TPS 缺席。
      if (turn.baselineOutputTokens === null && turn.firstTokenAt === null) turn.baselineOutputTokens = output
      return
    }
    // agent_end 之後才送達的收尾讀數:補算或修正本回合 TPS。
    finalizeOutputRate(turn, output)
    return
  }
  if (type === 'agent_start' || type === 'turn_start') {
    const existing = turns.get(runtimeId)
    if (existing?.retrying && !existing.ended) {
      // auto_retry 重開的同一回合:延續計時,不重置 first token 與基線。
      return
    }
    turns.set(runtimeId, {
      startedAt: Date.now(),
      firstTokenAt: null,
      lastTokenAt: null,
      baselineOutputTokens: sessionOutputByRuntime.get(runtimeId) ?? null,
      retrying: false,
      ended: false,
      ttftMs: null,
      tokensPerSecond: null,
      snapshot: EMPTY_METRICS,
    })
    // 新回合先清掉上一回合的顯示值;沒有舊值可清時不需要通知訂閱者。
    if (existing && existing.snapshot !== EMPTY_METRICS) emit()
    return
  }
  if (type === 'auto_retry_start') {
    const turn = turns.get(runtimeId)
    if (!turn) return
    // 供應商自動重試:前一個 agent_end 不是回合結束,重開同一回合。
    turn.retrying = true
    turn.ended = false
    return
  }
  if (type === 'message_update') {
    if (!isContentDelta(event)) return
    const turn = turns.get(runtimeId)
    if (!turn || turn.ended) return
    const now = Date.now()
    if (turn.firstTokenAt === null) {
      turn.firstTokenAt = now
      turn.ttftMs = now - turn.startedAt
      publish(turn)
    }
    turn.lastTokenAt = now
    return
  }
  // auto_retry_end(success !== true)代表重試放棄、回合確定結束,與
  // agent_end 同樣結算;success 的重試會繼續串流,計時不動。
  if (type === 'agent_end' || (type === 'auto_retry_end' && event.success !== true)) {
    const turn = turns.get(runtimeId)
    if (!turn || turn.ended) return
    turn.ended = true
    finalizeOutputRate(turn, sessionOutputByRuntime.get(runtimeId) ?? null)
  }
}

/** runtime_exit 或明確重置:丟掉該 runtime 的回合與基線,顯示回到 —。 */
export function resetTurnMetrics(runtimeId?: string): void {
  if (runtimeId === undefined) {
    if (turns.size === 0 && sessionOutputByRuntime.size === 0) return
    turns.clear()
    sessionOutputByRuntime.clear()
    emit()
    return
  }
  const hadTurn = turns.delete(runtimeId)
  const hadUsage = sessionOutputByRuntime.delete(runtimeId)
  if (hadTurn || hadUsage) emit()
}

export function subscribeTurnMetrics(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getTurnMetrics(runtimeId?: string | null): TurnMetrics {
  return (runtimeId != null ? turns.get(runtimeId) : undefined)?.snapshot ?? EMPTY_METRICS
}
