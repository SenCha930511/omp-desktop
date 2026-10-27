import { describe, expect, it } from 'vitest'
import { agentNoticeBody, agentNoticeFromEvent, isConfigWarningsChangedEvent, replayPrimeEvents } from '../../src/lib/events/reduce'

/**
 * Exact upstream notice shape (OMP v18.12 `agent-session-events.ts` /
 * `rpc/wire/events.ts`):
 *   { type: 'notice', level: 'info' | 'warning' | 'error', message: string, source?: string }
 * Severity rides `level`; origin rides `source`. There is no `severity` field.
 */
const compactionSyncNotice = {
  type: 'notice',
  level: 'warning',
  message: 'Compaction completed, but session state could not be synchronized. Refresh the session before continuing; do not repeat compaction.',
  source: 'desktop.compaction-sync',
} as const

const persistenceError = {
  type: 'notice',
  level: 'error',
  message: 'Failed to append entries to the session history file.',
  source: 'session-persistence',
} as const

describe('agent notice parsing', () => {
  it('accepts the exact upstream notice shape with and without a source', () => {
    expect(agentNoticeFromEvent(compactionSyncNotice)).toEqual({
      level: 'warning',
      message: compactionSyncNotice.message,
      source: 'desktop.compaction-sync',
    })
    expect(agentNoticeFromEvent({ type: 'notice', level: 'info', message: 'Cache warmed.' })).toEqual({
      level: 'info',
      message: 'Cache warmed.',
    })
    expect(agentNoticeFromEvent(persistenceError)).toEqual({
      level: 'error',
      message: persistenceError.message,
      source: 'session-persistence',
    })
  })

  it('rejects malformed notices and unrelated events instead of guessing a severity', () => {
    expect(agentNoticeFromEvent({ type: 'notice', message: 'missing level' })).toBeUndefined()
    expect(agentNoticeFromEvent({ type: 'notice', level: 'severe', message: 'unknown level' })).toBeUndefined()
    expect(agentNoticeFromEvent({ type: 'notice', level: 'warning' })).toBeUndefined()
    expect(agentNoticeFromEvent({ type: 'notice', level: 'warning', message: '', source: 'desktop.compaction-sync' })).toBeUndefined()
    expect(agentNoticeFromEvent({ type: 'error', level: 'warning', message: 'different event type' })).toBeUndefined()
    // `severity` is not the protocol field; no fake compatibility.
    expect(agentNoticeFromEvent({ type: 'notice', severity: 'warning', message: 'wrong severity field' })).toBeUndefined()
  })
})

describe('config_warnings_changed recognition (錯誤呈現接點)', () => {
  it('matches the exact upstream event name and nothing else', () => {
    // 上游 OMP(≥18.9}:{ type: 'config_warnings_changed' }——無 payload。
    expect(isConfigWarningsChangedEvent({ type: 'config_warnings_changed' })).toBe(true)
    expect(isConfigWarningsChangedEvent({ type: 'config_warnings_changed', warnings: [] })).toBe(true)
    expect(isConfigWarningsChangedEvent({ type: 'available_commands_update' })).toBe(false)
    expect(isConfigWarningsChangedEvent({ type: 'notice', level: 'warning', message: 'm' })).toBe(false)
    expect(isConfigWarningsChangedEvent({ type: 'config_warnings_changed ' })).toBe(false)
  })
})

describe('agent notice display body', () => {
  it('keeps source and message as raw agent data, chrome stays i18n-side', () => {
    expect(agentNoticeBody({ level: 'warning', message: 'm', source: 's' })).toBe('s: m')
    expect(agentNoticeBody({ level: 'error', message: 'm', source: 's' })).toBe('s: m')
    expect(agentNoticeBody({ level: 'info', message: 'm' })).toBe('m')
  })
})

describe('agent notice transcript rows', () => {
  it('renders each severity as a kind-tagged system row carrying source and message', () => {
    const [warning] = replayPrimeEvents([], [compactionSyncNotice])
    expect(warning).toMatchObject({
      role: 'system',
      kind: 'agent-notice-warning',
      parts: [{ type: 'text', text: `desktop.compaction-sync: ${compactionSyncNotice.message}`, partId: expect.any(String) }],
    })
    expect(warning?.id).toMatch(/^notice-/)

    const [error] = replayPrimeEvents([], [persistenceError])
    expect(error).toMatchObject({
      role: 'system',
      kind: 'agent-notice-error',
      parts: [{ type: 'text', text: `session-persistence: ${persistenceError.message}`, partId: expect.any(String) }],
    })

    const [info] = replayPrimeEvents([], [{ type: 'notice', level: 'info', message: 'Cache warmed.' }])
    expect(info).toMatchObject({
      role: 'system',
      kind: 'agent-notice',
      parts: [{ type: 'text', text: 'Cache warmed.', partId: expect.any(String) }],
    })
  })

  it('deduplicates identical consecutive notices but keeps distinct messages', () => {
    const messages = replayPrimeEvents([], [compactionSyncNotice, compactionSyncNotice])
    expect(messages).toHaveLength(1)

    const distinct = replayPrimeEvents([], [compactionSyncNotice, persistenceError])
    expect(distinct).toHaveLength(2)
    expect(distinct[0]?.parts[0]).toMatchObject({ type: 'text', text: `desktop.compaction-sync: ${compactionSyncNotice.message}` })
    expect(distinct[1]?.parts[0]).toMatchObject({ type: 'text', text: `session-persistence: ${persistenceError.message}` })
  })

  it('inserts the notice between streamed segments without faking a terminal', () => {
    const messages = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before' } },
      compactionSyncNotice,
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } },
      { type: 'agent_end' },
    ])

    expect(messages).toHaveLength(3)
    expect(messages[0]).toMatchObject({ role: 'assistant', streaming: false })
    expect(messages[0]?.parts).toEqual([{ type: 'text', text: 'before', partId: expect.any(String) }])
    expect(messages[1]).toMatchObject({ role: 'system', kind: 'agent-notice-warning' })
    expect(messages[2]).toMatchObject({ role: 'assistant', streaming: false })
    expect(messages[2]?.parts).toEqual([{ type: 'text', text: 'after', partId: expect.any(String) }])
  })

  it('adds no row for malformed notice events', () => {
    expect(replayPrimeEvents([], [{ type: 'notice', message: 'missing level' }])).toEqual([])
    expect(replayPrimeEvents([], [{ type: 'notice', level: 'severe', message: 'unknown level' }])).toEqual([])
    expect(replayPrimeEvents([], [{ type: 'notice', severity: 'warning', message: 'wrong severity field' }])).toEqual([])
  })
})
