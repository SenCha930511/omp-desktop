import type { TranscriptMessage, TranscriptOlder, TranscriptReadPageResult } from '@/types/api'

export type TranscriptStaleReason = 'unknown-cursor' | 'file-changed' | 'branch-changed' | 'missing-anchor'

export interface HistoryPaginationState {
  snapshotId: string | null
  older: TranscriptOlder
  loadingOlder: boolean
  hasLoadedOlder: boolean
  staleReason?: TranscriptStaleReason
  error?: string
}

export const INITIAL_HISTORY_PAGINATION: HistoryPaginationState = {
  snapshotId: null,
  older: { state: 'end' },
  loadingOlder: false,
  hasLoadedOlder: false,
}

export function prependOlderPage(
  current: TranscriptMessage[],
  olderMessages: TranscriptMessage[],
  endExclusiveMessageId: string | null,
): TranscriptMessage[] {
  if (olderMessages.length === 0) return current
  const seen = new Set(current.map((message) => message.id))
  const uniqueOlder = olderMessages.filter((message) => {
    if (seen.has(message.id)) return false
    seen.add(message.id)
    return true
  })
  if (uniqueOlder.length === 0) return current
  if (endExclusiveMessageId) {
    const anchorIndex = current.findIndex((message) => message.id === endExclusiveMessageId)
    if (anchorIndex > 0) {
      return [...current.slice(0, anchorIndex), ...uniqueOlder, ...current.slice(anchorIndex)]
    }
  }
  return [...uniqueOlder, ...current]
}

export function applyPageResultToPagination(
  previous: HistoryPaginationState,
  result: TranscriptReadPageResult,
  isOlderLoad: boolean,
): HistoryPaginationState {
  if (result.status === 'ok') {
    return {
      snapshotId: result.snapshotId,
      older: result.older,
      loadingOlder: false,
      hasLoadedOlder: previous.hasLoadedOlder || (isOlderLoad && result.messages.length > 0),
    }
  }
  if (result.status === 'stale') {
    return {
      snapshotId: null,
      older: { state: 'end' },
      loadingOlder: false,
      hasLoadedOlder: previous.hasLoadedOlder,
      staleReason: result.reason,
    }
  }
  return {
    snapshotId: previous.snapshotId,
    older: { state: 'unavailable', reason: result.reason },
    loadingOlder: false,
    hasLoadedOlder: previous.hasLoadedOlder,
  }
}

export function mergeNewestTranscriptTail(
  current: TranscriptMessage[],
  incoming: TranscriptMessage[],
  hasLoadedOlder: boolean,
  mergeTail: (currentTail: TranscriptMessage[], nextTail: TranscriptMessage[]) => TranscriptMessage[],
): TranscriptMessage[] {
  if (!hasLoadedOlder || current.length === 0 || incoming.length === 0) {
    return mergeTail(current, incoming)
  }
  const anchorIndex = current.findIndex((message) => message.id === incoming[0].id)
  if (anchorIndex <= 0) {
    return mergeTail(current, incoming)
  }
  const prefix = current.slice(0, anchorIndex)
  const mergedTail = mergeTail(current.slice(anchorIndex), incoming)
  return [...prefix, ...mergedTail]
}
