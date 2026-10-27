import type { PromptImage, QueuedPrompt } from '@/types/api'

/** One queued user input omp withdrew before an abort, as the editor would restore it. */
export interface WithdrawnQueuedMessage {
  text: string
  images?: PromptImage[]
}

/**
 * The `abort_and_restore_queue` result (upstream `AbortAndRestoreQueueResult`):
 * withdrawn steering and follow-up input, oldest first, plus the transport-loss
 * flags omp only ever sets to true. `skipped` counts entries whose shape did
 * not match the wire contract; they are never restored (an image-carrying
 * command must not come back as plain text).
 */
export interface WithdrawnQueue {
  steering: WithdrawnQueuedMessage[]
  followUp: WithdrawnQueuedMessage[]
  imagesDropped?: boolean
  truncated?: boolean
  skipped: number
}

const key = 'omp-desktop.pending-queue.v1'

function restoredImagePart(value: unknown): PromptImage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.type !== 'image' || typeof raw.data !== 'string' || typeof raw.mimeType !== 'string') return null
  return { type: 'image', data: raw.data, mimeType: raw.mimeType }
}

/** Reads persisted parts back faithfully, or not at all: an image-carrying
 * command restored as plain text would silently send a different message
 * than the user wrote. */
function restoredParts(value: unknown): NonNullable<QueuedPrompt['parts']> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const parts: NonNullable<QueuedPrompt['parts']> = []
  for (const part of value) {
    if (!part || typeof part !== 'object') return undefined
    const raw = part as Record<string, unknown>
    if (raw.type === 'text' && typeof raw.text === 'string') {
      parts.push({ type: 'text', text: raw.text })
      continue
    }
    const image = restoredImagePart(part)
    if (image) {
      parts.push(image)
      continue
    }
    return undefined
  }
  return parts
}

export function readPendingQueues(): Map<string, QueuedPrompt[]> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    const result = new Map<string, QueuedPrompt[]>()
    if (!Array.isArray(raw)) return result
    for (const entry of raw) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) continue
      const prompts: QueuedPrompt[] = []
      for (const item of entry[1]) {
        if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || typeof item.timestamp !== 'number' || item.intent !== 'queue') continue
        if (item.parts !== undefined) {
          const parts = restoredParts(item.parts)
          if (!parts) continue
          prompts.push({ id: item.id, text: item.text, timestamp: item.timestamp, intent: 'queue', flushAttemptFailed: true, recovered: true, parts })
          continue
        }
        // Explicit retry avoids redelivery after an interrupted acknowledgement.
        prompts.push({ id: item.id, text: item.text, timestamp: item.timestamp, intent: 'queue', flushAttemptFailed: true, recovered: true })
      }
      if (prompts.length) result.set(entry[0], prompts)
    }
    return result
  } catch { return new Map() }
}

export function savePendingQueues(queues: ReadonlyMap<string, QueuedPrompt[]>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...queues].map(([owner, prompts]) => [owner, prompts.filter((prompt) => prompt.intent === 'queue')])))
  } catch { /* Keep the in-memory queue when storage is unavailable. */ }
}
