import type { Dispatch, SetStateAction } from 'react'
import { activityState, conversationExecution } from '@/lib/execution-state'
import type { TranscriptMessage } from '@/types/api'

const MAX_SUMMARY_PREVIEW_CHARS = 220

function truncateSummaryText(text: string): string {
  return text.length > MAX_SUMMARY_PREVIEW_CHARS ? `${text.slice(0, MAX_SUMMARY_PREVIEW_CHARS)}…` : text
}

function messageToolCount(message: TranscriptMessage): number {
  let count = 0
  for (const part of message.parts) if (part.type === 'toolCall') count += 1
  return count
}

function messageLastText(message: TranscriptMessage): string | undefined {
  if (message.role !== 'assistant') return undefined
  const parts = message.parts
  for (let cursor = parts.length - 1; cursor >= 0; cursor -= 1) {
    const part = parts[cursor]
    if (part.type === 'text') return truncateSummaryText(part.text)
  }
  return undefined
}

interface PrefixSummaryCache {
  messages: TranscriptMessage[]
  prefixLength: number
  toolCount: number
  streaming: boolean
  assistant: TranscriptMessage | undefined
  lastText: string | undefined
}

function computePrefixSummary(messages: TranscriptMessage[], prefixLength: number): PrefixSummaryCache {
  let assistant: TranscriptMessage | undefined
  let lastText: string | undefined
  let streaming = false
  let toolCount = 0
  for (let index = prefixLength - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.streaming) streaming = true
    toolCount += messageToolCount(message)
    if (message.role !== 'assistant') continue
    assistant ??= message
    lastText ??= messageLastText(message)
  }
  return { messages, prefixLength, toolCount, streaming, assistant, lastText }
}

/**
 * Summarizes the transcript with an O(1) tail fast path when only the newest
 * message changes (streaming deltas), while keeping prefix totals and preview
 * truncation exact. Streaming frames therefore never rescan earlier history.
 */
function summarize(messages: TranscriptMessage[], cache?: { current: PrefixSummaryCache | null }) {
  let assistant: TranscriptMessage | undefined
  let lastText: string | undefined
  let streaming = false
  let toolCount = 0
  if (messages.length === 0) {
    if (cache) cache.current = null
  } else {
    const prefixLength = messages.length - 1
    const tail = messages[prefixLength]
    let prefix = cache?.current ?? null
    const cacheMatches = prefix !== null
      && prefix.prefixLength === prefixLength
      && (prefixLength === 0 || (messages[0] === prefix.messages[0] && messages[prefixLength - 1] === prefix.messages[prefixLength - 1]))
    if (cacheMatches && prefix !== null) {
      prefix.messages = messages
    } else {
      prefix = computePrefixSummary(messages, prefixLength)
      if (cache) cache.current = prefix
    }
    streaming = prefix.streaming || Boolean(tail.streaming)
    toolCount = prefix.toolCount + messageToolCount(tail)
    assistant = tail.role === 'assistant' ? tail : prefix.assistant
    lastText = messageLastText(tail) ?? prefix.lastText
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
  const prefixCache: { current: PrefixSummaryCache | null } = { current: null }
  let summary = summarize(initial, prefixCache)
  let execution = executionSummaryOf(summary)
  const listeners = new Set<() => void>()
  const summaryListeners = new Set<() => void>()
  const executionListeners = new Set<() => void>()
  const update: Dispatch<SetStateAction<TranscriptMessage[]>> = (value) => {
    const next = typeof value === 'function' ? value(messages) : value
    if (next === messages) return
    messages = next
    const nextSummary = summarize(next, prefixCache)
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
