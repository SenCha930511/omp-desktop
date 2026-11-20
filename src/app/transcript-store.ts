import type { Dispatch, SetStateAction } from 'react'
import { activityState, conversationExecution } from '@/lib/execution-state'
import type { TranscriptMessage } from '@/types/api'

/**
 * One reverse walk settles everything a reader needs from the transcript: the
 * newest assistant message, the newest assistant text, whether anything streams
 * and how many tool calls ran. Streaming frames therefore never rescan the
 * transcript outside this store.
 */
function summarize(messages: TranscriptMessage[]) {
  let assistant: TranscriptMessage | undefined
  let lastText: string | undefined
  let streaming = false
  let toolCount = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.streaming) streaming = true
    const parts = message.parts
    for (const part of parts) if (part.type === 'toolCall') toolCount += 1
    if (message.role !== 'assistant') continue
    assistant ??= message
    if (lastText !== undefined) continue
    for (let cursor = parts.length - 1; cursor >= 0; cursor -= 1) {
      const part = parts[cursor]
      if (part.type === 'text') { lastText = part.text; break }
    }
  }
  const activity = activityState(assistant?.parts ?? [])
  return {
    count: messages.length,
    streaming,
    activity: activity.phase,
    activityDetail: activity.detail,
    ...conversationExecution({ runtime: null, messages, submitting: false, waiting: false }),
    toolCount,
    lastText,
  }
}

/** Everything the Summary tab renders from the transcript, computed once per store update. */
export type TranscriptSummary = ReturnType<typeof summarize>
/** The execution half of the summary: the shell only cares when this changes. */
export type TranscriptExecutionSummary = Omit<TranscriptSummary, 'toolCount' | 'lastText'>

export const EMPTY_TRANSCRIPT_SUMMARY: TranscriptSummary = summarize([])

function executionSummaryOf(summary: TranscriptSummary): TranscriptExecutionSummary {
  const { toolCount: _toolCount, lastText: _lastText, ...execution } = summary
  return execution
}

function sameFields(a: object, b: object): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/** Summary subscribers see every new latest reply; execution subscribers update only when execution semantics change. */
export function createTranscriptStore(initial: TranscriptMessage[]) {
  let messages = initial
  let summary = summarize(initial)
  let execution = executionSummaryOf(summary)
  const listeners = new Set<() => void>()
  const summaryListeners = new Set<() => void>()
  const executionListeners = new Set<() => void>()
  const update: Dispatch<SetStateAction<TranscriptMessage[]>> = (value) => {
    const next = typeof value === 'function' ? value(messages) : value
    if (next === messages) return
    messages = next
    const nextSummary = summarize(next)
    const nextExecution = executionSummaryOf(nextSummary)
    const summaryChanged = !sameFields(summary, nextSummary)
    const executionChanged = !sameFields(execution, nextExecution)
    if (summaryChanged) summary = nextSummary
    if (executionChanged) execution = nextExecution
    for (const listener of [...listeners]) listener()
    if (summaryChanged) for (const listener of [...summaryListeners]) listener()
    if (executionChanged) for (const listener of [...executionListeners]) listener()
  }
  return {
    update,
    getSnapshot: () => messages,
    getSummary: () => summary,
    getExecutionSummary: () => execution,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    subscribeSummary(listener: () => void) { summaryListeners.add(listener); return () => { summaryListeners.delete(listener) } },
    subscribeExecutionSummary(listener: () => void) { executionListeners.add(listener); return () => { executionListeners.delete(listener) } },
  }
}

export type TranscriptStore = ReturnType<typeof createTranscriptStore>
