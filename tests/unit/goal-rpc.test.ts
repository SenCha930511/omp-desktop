import { describe, expect, it } from 'vitest'
import { translate } from '../../src/lib/i18n'
import {
  agentControlOutcomeText,
  formatGoalDuration,
  formatGoalEventUpdateText,
  formatGoalResultText,
  parseGoalModeState,
  parseGoalResult,
  parseGoalSnapshot,
  type GoalTranslate,
} from '../../src/lib/goal-rpc'
import { replayPrimeEvents } from '../../src/lib/events/reduce'

const t: GoalTranslate = (key, values) => translate('en', key, values)

/**
 * Exact upstream reply shape (OMP v18.12 `rpc-goal.ts`):
 *   { goal: Goal | null, state: GoalModeState | null }
 * Goal: { id, objective, status, tokenBudget?, tokensUsed, timeUsedSeconds,
 *         createdAt, updatedAt }
 * GoalModeState: { enabled, mode: 'active' | 'exiting', reason?: 'completed', goal }
 */
const goal = {
  id: 'goal-1',
  objective: 'Fix the flaky tests',
  status: 'active',
  tokenBudget: 50_000,
  tokensUsed: 12_345,
  timeUsedSeconds: 200,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_060_000,
} as const
const state = { enabled: true, mode: 'active', goal } as const

describe('goal snapshot parsing', () => {
  it('accepts the exact upstream Goal and GoalModeState shapes', () => {
    expect(parseGoalSnapshot(goal)).toEqual(goal)
    expect(parseGoalSnapshot({ ...goal, tokenBudget: undefined })).toEqual({ ...goal, tokenBudget: undefined })
    expect(parseGoalModeState(state)).toEqual({ ...state, reason: undefined })
    expect(parseGoalModeState({ ...state, mode: 'exiting', reason: 'completed' })).toMatchObject({ mode: 'exiting', reason: 'completed' })
  })

  it('refuses malformed shapes instead of guessing fields', () => {
    for (const candidate of [null, {}, 'goal', { ...goal, status: 'done' }, { ...goal, tokensUsed: '12345' }, { ...goal, id: 7 }]) {
      expect(parseGoalSnapshot(candidate)).toBeUndefined()
    }
    expect(parseGoalModeState({ enabled: 'true' })).toBeUndefined()
  })

  it('reads the payload from data when the transport wraps it', () => {
    expect(parseGoalResult({ data: { goal, state } })).toEqual({ goal, state })
    expect(parseGoalResult({ goal, state })).toEqual({ goal, state })
    expect(parseGoalResult({ goal: null, state: null })).toEqual({ goal: undefined, state: undefined })
    expect(parseGoalResult({ goal: { broken: true }, state })).toBeUndefined()
    expect(parseGoalResult({ data: 42 })).toBeUndefined()
  })
})

describe('goal RPC result rendering', () => {
  it('renders get as structured lines instead of raw JSON', () => {
    const text = formatGoalResultText({ type: 'goal', op: 'get' }, { data: { goal, state } }, t)
    expect(text).toBe([
      'Goal',
      'Objective: Fix the flaky tests',
      'Status: active',
      'Tokens used: 12,345 / 50,000 (25%)',
      'Time used: 3m 20s',
      'Goal mode: active',
    ].join('\n'))
  })

  it('labels each lifecycle op and shows budget-less goals without a percent', () => {
    const budgetless = { ...goal, tokenBudget: undefined }
    expect(formatGoalResultText({ type: 'goal', op: 'pause' }, { data: { goal: { ...budgetless, status: 'paused' }, state } }, t)).toBe([
      'Goal paused',
      'Objective: Fix the flaky tests',
      'Status: paused',
      'Tokens used: 12,345 (no token budget set)',
      'Time used: 3m 20s',
      'Goal mode: active',
    ].join('\n'))
    expect(formatGoalResultText({ type: 'goal', op: 'drop' }, { data: { goal: { ...budgetless, status: 'dropped' }, state: null } }, t).split('\n')[0]).toBe('Goal dropped')
    expect(formatGoalResultText({ type: 'goal', op: 'create' }, { data: { goal: budgetless, state } }, t).split('\n')[0]).toBe('Goal created')
  })

  it('reports an empty goal, the exiting(completed) mode, and falls back to JSON on malformed replies', () => {
    expect(formatGoalResultText({ type: 'goal', op: 'get' }, { data: { goal: null, state: null } }, t)).toBe('No goal is set for this session.')
    const exiting = formatGoalResultText({ type: 'goal', op: 'get' }, { data: { goal: { ...goal, status: 'complete' }, state: { ...state, mode: 'exiting', reason: 'completed' } } }, t)
    expect(exiting).toContain('Goal mode: exiting (completed)')
    expect(formatGoalResultText({ type: 'goal', op: 'get' }, { data: { unexpected: true } }, t)).toBe(JSON.stringify({ unexpected: true }, null, 2))
  })

  it('routes goal commands to the goal renderer and everything else to the generic fallback', () => {
    expect(agentControlOutcomeText({ type: 'goal', op: 'get' }, { data: { goal: null, state: null } }, t)).toBe('No goal is set for this session.')
    expect(agentControlOutcomeText({ type: 'other' }, { data: { ok: 1 } }, t)).toBe(JSON.stringify({ ok: 1 }, null, 2))
  })

  it('formats durations in compact neutral units', () => {
    expect(formatGoalDuration(0)).toBe('0s')
    expect(formatGoalDuration(45)).toBe('45s')
    expect(formatGoalDuration(200)).toBe('3m 20s')
    expect(formatGoalDuration(3660)).toBe('1h 1m')
  })
})

describe('goal_updated transcript rows', () => {
  it('surfaces non-GUI-driven terminal transitions without duplicating replayed frames', () => {
    const budgetLimited = { type: 'goal_updated', goal: { ...goal, status: 'budget-limited' }, state }
    const messages = replayPrimeEvents([], [budgetLimited, budgetLimited])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: `goal-update-${goal.id}-budget-limited-${goal.updatedAt}`, role: 'system' })
    const text = messages[0]?.parts[0]?.type === 'text' ? messages[0].parts[0].text : ''
    expect(text).toContain('Goal paused (token budget exhausted)')
    expect(text).toContain('Objective: Fix the flaky tests')
    expect(text).toContain('Tokens used: 12,345 / 50,000 (25%)')
  })

  it('skips transitions already covered by goal_context rows or command result rows', () => {
    expect(replayPrimeEvents([], [{ type: 'goal_updated', goal, state }])).toHaveLength(0)
    expect(replayPrimeEvents([], [{ type: 'goal_updated', goal: { ...goal, status: 'paused' }, state }])).toHaveLength(0)
    expect(replayPrimeEvents([], [{ type: 'goal_updated', goal: null, state }])).toHaveLength(0)
  })

  it('writes an end row when goal mode exits with no goal left', () => {
    const messages = replayPrimeEvents([], [{ type: 'goal_updated', goal: null, state: null }])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'goal-update-ended', role: 'system', parts: [{ type: 'text', text: 'Goal mode ended.' }] })
    // 緊鄰的重播不再追加同一列
    const replayed = replayPrimeEvents(messages, [{ type: 'goal_updated', goal: null, state: null }])
    expect(replayed).toHaveLength(1)
  })

  it('formats event updates directly per status rules', () => {
    expect(formatGoalEventUpdateText(parseGoalSnapshot({ ...goal, status: 'budget-limited' }), parseGoalModeState(state), t)).toContain('Goal paused (token budget exhausted)')
    expect(formatGoalEventUpdateText(parseGoalSnapshot({ ...goal, status: 'complete' }), parseGoalModeState(state), t)).toContain('Goal complete')
    expect(formatGoalEventUpdateText(parseGoalSnapshot(goal), parseGoalModeState(state), t)).toBeUndefined()
    expect(formatGoalEventUpdateText(undefined, undefined, t)).toBe('Goal mode ended.')
    expect(formatGoalEventUpdateText(undefined, parseGoalModeState(state), t)).toBeUndefined()
  })
})
