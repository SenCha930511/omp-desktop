import type { Dispatch, SetStateAction } from 'react'
import { activityState, conversationExecution } from '@/lib/execution-state'
import type { TranscriptMessage } from '@/types/api'

function summarize(messages: TranscriptMessage[]) {
  let assistant: TranscriptMessage | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') { assistant = messages[index]; break }
  }
  const activity = activityState(assistant?.parts ?? [])
  return {
    count: messages.length,
    streaming: messages.some((message) => message.streaming),
    activity: activity.phase,
    activityDetail: activity.detail,
    ...conversationExecution({ runtime: null, messages, submitting: false, waiting: false }),
  }
}

/** Message subscribers update per frame; shell subscribers update only when execution semantics change. */
export function createTranscriptStore(initial: TranscriptMessage[]) {
  let messages = initial
  let summary = summarize(initial)
  const listeners = new Set<() => void>()
  const summaryListeners = new Set<() => void>()
  const update: Dispatch<SetStateAction<TranscriptMessage[]>> = (value) => {
    const next = typeof value === 'function' ? value(messages) : value
    if (next === messages) return
    messages = next
    const nextSummary = summarize(next)
    const changed = (Object.keys(nextSummary) as (keyof typeof nextSummary)[]).some((key) => !Object.is(summary[key], nextSummary[key]))
      || (Object.keys(summary) as (keyof typeof summary)[]).some((key) => !Object.is(summary[key], nextSummary[key]))
    if (changed) summary = nextSummary
    for (const listener of [...listeners]) listener()
    if (changed) for (const listener of [...summaryListeners]) listener()
  }
  return {
    update,
    getSnapshot: () => messages,
    getSummary: () => summary,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    subscribeSummary(listener: () => void) { summaryListeners.add(listener); return () => { summaryListeners.delete(listener) } },
  }
}

export type TranscriptStore = ReturnType<typeof createTranscriptStore>
