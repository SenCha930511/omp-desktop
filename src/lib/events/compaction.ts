import type { MessagePart, TranscriptMessage } from '@/types/api'
import { nextTranscriptId, withPartId } from './ids'
import { record, string } from './parse'

/** Compaction policy: parsing, dedupe, and transcript application. */

type CompactionPart = Extract<MessagePart, { type: 'compaction' }>

function compactionReason(value: unknown): CompactionPart['reason'] {
  return value === 'manual' || value === 'threshold' || value === 'overflow' || value === 'requested' ? value : undefined
}

function compactionOutcome(value: unknown): CompactionPart['outcome'] {
  return value === 'failed' || value === 'cancelled' || value === 'skipped' ? value : undefined
}

function compactionResult(value: unknown): Pick<CompactionPart, 'summary' | 'tokensBefore' | 'tokensAfter' | 'firstKeptEntryId'> {
  const result = record(value)
  const tokenCount = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined
  return {
    summary: string(result?.summary),
    tokensBefore: tokenCount(result?.tokensBefore),
    tokensAfter: tokenCount(result?.tokensAfter),
    firstKeptEntryId: string(result?.firstKeptEntryId),
  }
}

function compactionPartFromStart(raw: Record<string, unknown>): CompactionPart {
  return {
    type: 'compaction',
    status: 'running',
    reason: compactionReason(raw.reason),
    customInstructions: string(raw.customInstructions),
  }
}

function compactionPartFromEnd(raw: Record<string, unknown>): CompactionPart {
  const result = compactionResult(raw.result)
  const aborted = raw.aborted === true
  const hasResult = Boolean(result.summary || result.tokensBefore !== undefined || result.firstKeptEntryId)
  const status = aborted ? 'cancelled' : hasResult ? 'done' : 'failed'
  const outcome = aborted ? 'cancelled' : raw.errorSeverity === 'warning' ? 'skipped' : status === 'failed' ? 'failed' : undefined
  return {
    type: 'compaction',
    status,
    reason: compactionReason(raw.reason),
    outcome,
    ...result,
    error: string(raw.errorMessage),
    customInstructions: string(raw.customInstructions),
    willRetry: raw.willRetry === true,
  }
}

function compactionOutcomePart(message: Record<string, unknown>): CompactionPart | undefined {
  if (message.customType !== 'compaction_outcome') return undefined
  const details = record(message.details)
  const outcome = compactionOutcome(details?.outcome) ?? 'failed'
  return {
    type: 'compaction',
    status: outcome === 'cancelled' ? 'cancelled' : 'failed',
    reason: compactionReason(details?.reason),
    outcome,
    error: string(message.content) ?? 'Context compaction did not complete.',
  }
}

function compactionOutcomeFromEvent(raw: Record<string, unknown>): CompactionPart | undefined {
  if (raw.type === 'custom_message') return compactionOutcomePart(raw)
  if (raw.type !== 'message_end') return undefined
  const message = record(raw.message)
  return message ? compactionOutcomePart(message) : undefined
}

export function isCompactionEvent(raw: Record<string, unknown>): boolean {
  const type = string(raw.type) ?? string(raw.event)
  return type === 'compaction_start' || type === 'compaction_end' || type === 'compaction_sync_pending' || Boolean(compactionOutcomeFromEvent(raw))
}

function sameCompactionResult(left: CompactionPart, right: CompactionPart): boolean {
  if (left.reason && right.reason && left.reason !== right.reason) return false
  if (left.firstKeptEntryId && right.firstKeptEntryId) return left.firstKeptEntryId === right.firstKeptEntryId
  if (left.status !== 'done' && right.status !== 'done') {
    return Boolean(left.reason && right.reason && left.reason === right.reason && (!left.error || !right.error || left.error === right.error))
  }
  return Boolean(left.summary && right.summary && left.summary === right.summary && left.tokensBefore === right.tokensBefore)
}

function compactionIndex(messages: TranscriptMessage[], status?: CompactionPart['status']): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const part = messages[index].parts.find((candidate): candidate is CompactionPart => candidate.type === 'compaction')
    if (part && (status === undefined || part.status === status)) return index
  }
  return -1
}

function appendCompaction(messages: TranscriptMessage[], part: CompactionPart, now: number): TranscriptMessage[] {
  return [...messages, {
    id: nextTranscriptId('compaction'),
    role: 'system',
    timestamp: now,
    startedAt: now,
    completedAt: part.status === 'running' ? undefined : now,
    streaming: part.status === 'running',
    parts: [withPartId(part)],
  }]
}

/**
 * Applies one compaction event to a materialized transcript. Returns undefined
 * when the event carries no compaction semantics; returns the input array
 * unchanged when the event is a duplicate of already-recorded state.
 */
export function applyCompactionEvent(messages: TranscriptMessage[], raw: Record<string, unknown>): TranscriptMessage[] | undefined {
  const type = string(raw.type) ?? string(raw.event)
  if (type === 'compaction_start') {
    const running = compactionIndex(messages, 'running')
    if (running >= 0) return messages
    const completedAt = Date.now()
    const finalized = messages.map((message) => message.role === 'assistant' && message.streaming
      ? { ...message, streaming: false, completedAt }
      : message)
    return appendCompaction(finalized, compactionPartFromStart(raw), completedAt)
  }
  if (type === 'compaction_sync_pending') {
    const running = compactionIndex(messages, 'running')
    if (running < 0) return messages
    return messages.map((message, index) => index === running
      ? { ...message, streaming: false, parts: message.parts.map((candidate) => candidate.type === 'compaction' ? { ...candidate, status: 'sync_pending' } : candidate) }
      : message)
  }
  let part: CompactionPart | undefined
  if (type === 'compaction_end') part = compactionPartFromEnd(raw)
  else part = compactionOutcomeFromEvent(raw)
  if (!part) return undefined

  const runningIndex = compactionIndex(messages, 'running')
  const running = runningIndex >= 0 ? runningIndex : compactionIndex(messages, 'sync_pending')
  if (running >= 0) {
    const alreadyPersisted = part.status !== 'running' && messages.some((message, index) => index !== running
      && message.parts.some((candidate) => candidate.type === 'compaction' && candidate.status !== 'running' && candidate.status !== 'sync_pending' && sameCompactionResult(candidate, part!)))
    if (alreadyPersisted) return messages.filter((_, index) => index !== running)
    const completedAt = Date.now()
    return messages.map((message, index) => index === running
      ? { ...message, completedAt, streaming: false, parts: message.parts.map((candidate) => candidate.type === 'compaction' ? { ...candidate, ...part } : candidate) }
      : message)
  }
  if (part.status !== 'running') {
    const duplicate = messages.some((message) => message.parts.some((candidate) => candidate.type === 'compaction' && candidate.status !== 'running' && candidate.status !== 'sync_pending' && sameCompactionResult(candidate, part!)))
    if (duplicate) return messages
  }
  return appendCompaction(messages, part, Date.now())
}
