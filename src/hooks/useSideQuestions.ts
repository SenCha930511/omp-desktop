import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import { record, string } from '@/lib/events/parse'
import type { DesktopApi, PrimeEventEnvelope, SideQuestionStatus, SideQuestionTopic, SideQuestionTurn } from '@/types/api'

export interface SideQuestionSessionState {
  /** undefined while the first history probe is in flight; false hides the UI on older harnesses. */
  supported?: boolean
  topics: SideQuestionTopic[]
  /** Answer text streamed so far for each topic's running latest turn (appended to the turn answer on render). */
  live: Record<string, string>
  /** Topic id the panel focuses on; null shows the new-question draft view. */
  activeTopicId: string | null
  /** True while an ask call is in flight (before the running record event arrives). */
  sending: boolean
}

export interface SideQuestionsController {
  session(sessionId: string): SideQuestionSessionState
  setActiveTopic(sessionId: string, topicId: string | null): void
  /** Drops the visible topics for a session (side chats are transient: closing the panel clears them). Harness history is untouched. */
  clear(sessionId: string): void
  /** Resolves true after the running record arrived; throws with the harness message on rejection. */
  ask(sessionId: string, question: string, topicId?: string): Promise<boolean>
  cancel(sessionId: string, topicId?: string): Promise<void>
}

const EMPTY_SESSION: SideQuestionSessionState = {
  supported: undefined,
  topics: [],
  live: {},
  activeTopicId: null,
  sending: false,
}

const SIDE_QUESTION_STATUSES: ReadonlySet<string> = new Set(['running', 'complete', 'cancelled', 'error', 'interrupted'])

function parseTurn(raw: unknown): SideQuestionTurn | null {
  const turn = record(raw)
  if (!turn) return null
  const question = string(turn.question)
  const status = string(turn.status)
  if (!question?.trim() || !status || !SIDE_QUESTION_STATUSES.has(status)) return null
  if (typeof turn.answer !== 'string' || typeof turn.createdAt !== 'number' || typeof turn.updatedAt !== 'number') return null
  return { question, answer: turn.answer, status: status as SideQuestionStatus, createdAt: turn.createdAt, updatedAt: turn.updatedAt }
}

export function parseSideQuestionTopic(raw: unknown): SideQuestionTopic | null {
  const topic = record(raw)
  const id = string(topic?.id)
  if (!topic || !id) return null
  const base = parseTurn(topic)
  if (!base) return null
  const followUps = Array.isArray(topic.followUps) ? topic.followUps.map(parseTurn).filter((turn): turn is SideQuestionTurn => turn !== null) : []
  return { ...base, id, followUps }
}

/** Sets hold answer deltas: the last follow-up when present, else the opening turn. */
export function latestTurnOf(topic: SideQuestionTopic): SideQuestionTurn {
  return topic.followUps.length > 0 ? topic.followUps[topic.followUps.length - 1]! : topic
}

export function isTopicRunning(topic: SideQuestionTopic): boolean {
  return latestTurnOf(topic).status === 'running'
}

function pushTopic(topics: SideQuestionTopic[], topic: SideQuestionTopic): SideQuestionTopic[] {
  const index = topics.findIndex((existing) => existing.id === topic.id)
  if (index === -1) return [...topics, topic].slice(-50)
  const next = topics.slice()
  next[index] = topic
  return next
}

/**
 * Owns the side-question (/btw) state of live sessions: stores full topic
 * records (last record event per id wins), accumulates answer deltas for
 * running turns, and hydrates each session's history the first time it is
 * seen. A failed history probe marks the session unsupported — the panel
 * hides itself instead of failing against older harnesses that lack /btw.
 */
export function useSideQuestions(bridge: DesktopApi | null, activeSessionId: string | null, activeRuntimeId: string | null): SideQuestionsController {
  const [states, setStates] = useState<Readonly<Record<string, SideQuestionSessionState>>>({})
  const probedRef = useRef(new Set<string>())
  const targetRef = useRef<{ sessionId: string | null; runtimeId: string | null }>({ sessionId: null, runtimeId: null })
  targetRef.current = { sessionId: activeSessionId, runtimeId: activeRuntimeId }

  const update = useCallback((sessionId: string, apply: (session: SideQuestionSessionState) => SideQuestionSessionState) => {
    setStates((current) => ({ ...current, [sessionId]: apply(current[sessionId] ?? EMPTY_SESSION) }))
  }, [])

  // Fold side-question events into the active session's store. Records carry
  // the full topic on every lifecycle change; deltas append to the running
  // latest turn. A finished record discards the accumulated live text so the
  // persisted answer becomes the render source of truth.
  useEffect(() => {
    if (!bridge) return
    return bridge.agent.onEvent(({ runtimeId, event }: PrimeEventEnvelope) => {
      const target = targetRef.current
      if (event.type !== 'side_question_record' && event.type !== 'side_question_delta') return
      if (!target.sessionId || runtimeId !== target.runtimeId) return
      const sessionId = target.sessionId
      if (event.type === 'side_question_record') {
        const topic = parseSideQuestionTopic(event.topic)
        if (!topic) return
        update(sessionId, (session) => {
          const { [topic.id]: _dropped, ...live } = session.live
          return { ...session, topics: pushTopic(session.topics, topic), live }
        })
      } else {
        const topicId = string(event.topicId)
        const delta = string(event.delta)
        if (!topicId || delta === undefined) return
        update(sessionId, (session) => ({ ...session, live: { ...session.live, [topicId]: `${session.live[topicId] ?? ''}${delta}` } }))
      }
    })
  }, [bridge, update])

  // Support probe on first activation. Side chats are transient: the probe
  // only proves the harness answers the btw vocabulary; it deliberately does
  // NOT seed topics from history, or everything the user cleared when closing
  // the panel would resurrect on the next app start.
  useEffect(() => {
    if (!bridge || !activeSessionId || !activeRuntimeId || probedRef.current.has(activeSessionId)) return
    probedRef.current.add(activeSessionId)
    void bridge.agent.command(activeRuntimeId, { type: 'side_question_history' }).then((response) => {
      if (response?.success !== true) throw new Error(typeof response?.error === 'string' ? response.error : 'not supported')
      update(activeSessionId, (session) => ({ ...session, supported: true }))
    }).catch(() => {
      update(activeSessionId, (session) => ({ ...session, supported: false }))
    })
  }, [bridge, activeSessionId, activeRuntimeId, update])

  const setActiveTopic = useCallback((sessionId: string, topicId: string | null) => {
    update(sessionId, (session) => ({ ...session, activeTopicId: topicId }))
  }, [update])

  const clear = useCallback((sessionId: string) => {
    update(sessionId, (session) => ({ ...EMPTY_SESSION, supported: session.supported, sending: session.sending }))
  }, [update])

  const ask = useCallback(async (sessionId: string, question: string, topicId?: string): Promise<boolean> => {
    const target = targetRef.current
    if (!bridge || target.sessionId !== sessionId || !target.runtimeId) return false
    const trimmed = question.trim()
    if (!trimmed) return false
    update(sessionId, (session) => ({ ...session, sending: true }))
    try {
      const response = await bridge.agent.command(target.runtimeId, { type: 'side_question', question: trimmed, ...(topicId ? { topicId } : {}) })
      if (response?.success !== true) throw new Error(string(response?.error) ?? 'Side question failed')
      const topic = parseSideQuestionTopic(record(response.data)?.record)
      update(sessionId, (session) => ({
        ...session,
        sending: false,
        topics: topic ? pushTopic(session.topics, topic) : session.topics,
        activeTopicId: topic ? topic.id : session.activeTopicId,
      }))
      return true
    } catch (error: unknown) {
      update(sessionId, (session) => ({ ...session, sending: false }))
      throw new Error(errorMessage(error))
    }
  }, [bridge, update])

  const cancel = useCallback(async (sessionId: string, topicId?: string): Promise<void> => {
    const target = targetRef.current
    if (!bridge || target.sessionId !== sessionId || !target.runtimeId) return
    await bridge.agent.command(target.runtimeId, { type: 'side_question_cancel', ...(topicId ? { topicId } : {}) }).catch(() => undefined)
  }, [bridge])

  const session = useCallback((sessionId: string) => states[sessionId] ?? EMPTY_SESSION, [states])

  return useMemo(() => ({ session, setActiveTopic, clear, ask, cancel }), [session, setActiveTopic, clear, ask, cancel])
}
