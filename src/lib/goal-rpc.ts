import type { MessageKey } from '@/lib/i18n'
import { agentControlResultText } from './slash-command-ui'

// --- goal RPC(v18.12.6 rpc-goal)的結果解析與呈現 ---
//
// 上游回覆 { goal: Goal | null, state: GoalModeState | null }:
// - Goal: id / objective / status / tokenBudget? / tokensUsed / timeUsedSeconds /
//   createdAt / updatedAt;status ∈ active|paused|budget-limited|complete|dropped。
// - GoalModeState: enabled / mode(active|exiting) / reason?('completed') / goal。
// 這裡做防禦解析(renderer 面對任何上游版本都要降級失敗而不猜造型),
// 以及 i18n 的正式文字呈現——不直接把 JSON 倒進 transcript。

export type GoalStatus = 'active' | 'paused' | 'budget-limited' | 'complete' | 'dropped'

export interface GoalSnapshot {
  id: string
  objective: string
  status: GoalStatus
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

export interface GoalModeSnapshot {
  enabled: boolean
  mode?: 'active' | 'exiting'
  reason?: 'completed'
  goal?: GoalSnapshot
}

export type GoalTranslate = (key: MessageKey, values?: Record<string, string | number>) => string

const GOAL_STATUSES: ReadonlySet<string> = new Set(['active', 'paused', 'budget-limited', 'complete', 'dropped'])

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 造型不符時回 undefined,呼叫端降級為通用 JSON 呈現而不猜欄位。 */
export function parseGoalSnapshot(value: unknown): GoalSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.objective !== 'string' || !GOAL_STATUSES.has(String(raw.status))) return undefined
  const tokensUsed = numberField(raw.tokensUsed)
  const timeUsedSeconds = numberField(raw.timeUsedSeconds)
  const createdAt = numberField(raw.createdAt)
  const updatedAt = numberField(raw.updatedAt)
  if (tokensUsed === undefined || timeUsedSeconds === undefined || createdAt === undefined || updatedAt === undefined) return undefined
  const tokenBudget = typeof raw.tokenBudget === 'number' && Number.isFinite(raw.tokenBudget) ? raw.tokenBudget : undefined
  return { id: raw.id, objective: raw.objective, status: raw.status as GoalStatus, tokenBudget, tokensUsed, timeUsedSeconds, createdAt, updatedAt }
}

export function parseGoalModeState(value: unknown): GoalModeSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.enabled !== 'boolean') return undefined
  const mode = raw.mode === 'active' || raw.mode === 'exiting' ? raw.mode : undefined
  const reason = raw.reason === 'completed' ? 'completed' : undefined
  return { enabled: raw.enabled, mode, reason, goal: parseGoalSnapshot(raw.goal) }
}

/** RPC 回覆可能把 payload 放在 data 欄位(與 agentControlResultText 同規則)。 */
export function parseGoalResult(response: Record<string, unknown>): { goal?: GoalSnapshot; state?: GoalModeSnapshot } | undefined {
  const payload = response.data !== undefined ? response.data : response
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const raw = payload as Record<string, unknown>
  // get 無目標時上游回 { goal: null, state: null };null 是合法值,只拒絶非 null 的異形。
  if (raw.goal === undefined && raw.state === undefined) return undefined
  const goal = raw.goal === null ? undefined : parseGoalSnapshot(raw.goal)
  const state = raw.state === null ? undefined : parseGoalModeState(raw.state)
  if (raw.goal != null && !goal) return undefined
  if (raw.state != null && !state) return undefined
  return { goal, state }
}

const GOAL_STATUS_KEYS: Record<GoalStatus, MessageKey> = {
  active: 'goal.status.active',
  paused: 'goal.status.paused',
  'budget-limited': 'goal.status.budgetLimited',
  complete: 'goal.status.complete',
  dropped: 'goal.status.dropped',
}

export function goalStatusText(status: GoalStatus, t: GoalTranslate): string {
  return t(GOAL_STATUS_KEYS[status])
}

/** 用時以中立單位呈現(1h 2m / 3m 12s / 45s),跨語言皆可讀。 */
export function formatGoalDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${rest}s`
  return `${rest}s`
}

function tokensLine(goal: GoalSnapshot, t: GoalTranslate): string {
  const used = new Intl.NumberFormat().format(Math.round(goal.tokensUsed))
  if (goal.tokenBudget === undefined) return t('goal.tokensNoBudget', { used })
  const budget = new Intl.NumberFormat().format(Math.round(goal.tokenBudget))
  const percent = Math.round((goal.tokensUsed / goal.tokenBudget) * 100)
  return t('goal.tokens', { used, budget, percent })
}

const GOAL_OP_KEYS: Record<string, MessageKey> = {
  get: 'goal.op.get',
  create: 'goal.op.created',
  resume: 'goal.op.resumed',
  pause: 'goal.op.paused',
  drop: 'goal.op.dropped',
}

/** goal RPC 各 op 的正式結果文字(多行,貼作 transcript system 列)。 */
export function formatGoalResultText(command: Record<string, unknown>, response: Record<string, unknown>, t: GoalTranslate): string {
  const parsed = parseGoalResult(response)
  if (!parsed) return agentControlResultText(response)
  const goal = parsed.goal ?? parsed.state?.goal
  if (!goal) return t('goal.none')
  const opKey = typeof command.op === 'string' ? GOAL_OP_KEYS[command.op] : undefined
  const lines = [t(opKey ?? 'goal.op.get')]
  lines.push(t('goal.objective', { objective: goal.objective }))
  lines.push(t('goal.status', { status: goalStatusText(goal.status, t) }))
  lines.push(tokensLine(goal, t))
  lines.push(t('goal.timeUsed', { duration: formatGoalDuration(goal.timeUsedSeconds) }))
  const mode = parsed.state
  if (mode) {
    const modeText = mode.mode === 'exiting' ? t('goal.modeExiting') : t('goal.modeActive')
    lines.push(mode.reason === 'completed'
      ? t('goal.modeCompleted', { mode: modeText })
      : t('goal.mode', { mode: modeText }))
  }
  return lines.join('\n')
}

/**
 * agent-control 命令的回覆文字:goal 走正式呈現,其餘命令維持通用
 * fallback(精簡 JSON),待各自正式 formatter 就緒再逐一替換。
 */
export function agentControlOutcomeText(command: Record<string, unknown>, response: Record<string, unknown>, t: GoalTranslate): string {
  if (command.type === 'goal') return formatGoalResultText(command, response, t)
  return agentControlResultText(response)
}

/**
 * 上游 goal_updated 事件(GoalRuntime → AgentSession)的 transcript 列文字。
 * GUI 主動下的 create/resume/pause/drop 已由命令結果列呈現;這裡承接
 * 「非 GUI 發起」的終態與模式退出:token 預算耗盡、目標完成、被丟棄,
 * 以及 journal 結束後 Goal/State 皆空的模式退出。其餘轉移回 undefined。
 */
export function formatGoalEventUpdateText(goal: GoalSnapshot | undefined, state: GoalModeSnapshot | undefined, t: GoalTranslate): string | undefined {
  if (!goal) return state ? undefined : t('goal.event.ended')
  if (goal.status !== 'budget-limited' && goal.status !== 'complete' && goal.status !== 'dropped') return undefined
  const lines = [t('goal.event.status', { status: goalStatusText(goal.status, t) })]
  lines.push(t('goal.objective', { objective: goal.objective }))
  lines.push(tokensLine(goal, t))
  lines.push(t('goal.timeUsed', { duration: formatGoalDuration(goal.timeUsedSeconds) }))
  return lines.join('\n')
}
