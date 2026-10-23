import type { QueuedPrompt } from '@/types/api'

const key = 'omp-desktop.pending-queue.v1'
export function readPendingQueues(): Map<string, QueuedPrompt[]> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    const result = new Map<string, QueuedPrompt[]>()
    if (!Array.isArray(raw)) return result
    for (const entry of raw) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) continue
      const prompts: QueuedPrompt[] = []
      for (const item of entry[1]) {
        if (item && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.timestamp === 'number' && item.intent === 'queue') {
          // Explicit retry avoids redelivery after an interrupted acknowledgement.
          prompts.push({ id: item.id, text: item.text, timestamp: item.timestamp, intent: 'queue', flushAttemptFailed: true, recovered: true })
        }
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
