import { open, stat } from 'node:fs/promises'

/**
 * The harness `compact` RPC command compacts the session and writes the
 * compaction record to the session file, but emits no lifecycle events over
 * RPC — the desktop learns about the compaction only after a session
 * re-entry reads the file. After a successful compact command the manager
 * reads the newest compaction record back and synthesizes the
 * `compaction_end` event the renderer already knows how to fold.
 */

export interface ManualCompactionRecord {
  tokensBefore?: number
  tokensAfter?: number
  summary?: string
  firstKeptEntryId?: string
}

export type ManualCompactionReader = (sessionFile: string) => Promise<ManualCompactionRecord | undefined>

/** Reads the last compaction record from a session file's tail. */
export const readLatestCompactionRecord: ManualCompactionReader = async (sessionFile) => {
  const size = await stat(sessionFile).then((info) => info.size, () => -1)
  if (size < 0) return undefined
  // Compaction records are small; the tail window is generous and only
  // bounds the read, not correctness — a miss simply means no synthesis.
  const windowBytes = Math.min(size, 262_144)
  const handle = await open(sessionFile, 'r').catch(() => undefined)
  if (!handle) return undefined
  try {
    const buffer = Buffer.alloc(windowBytes)
    await handle.read(buffer, 0, windowBytes, size - windowBytes)
    const lines = buffer.toString('utf8').split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!.trim()
      if (!line) continue
      try {
        const entry: unknown = JSON.parse(line)
        if (typeof entry !== 'object' || entry === null || (entry as { type?: unknown }).type !== 'compaction') continue
        const record = entry as { tokensBefore?: unknown; tokensAfter?: unknown; summary?: unknown; firstKeptEntryId?: unknown }
        const tokenCount = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined
        return {
          tokensBefore: tokenCount(record.tokensBefore),
          tokensAfter: tokenCount(record.tokensAfter),
          summary: typeof record.summary === 'string' ? record.summary : undefined,
          firstKeptEntryId: typeof record.firstKeptEntryId === 'string' ? record.firstKeptEntryId : undefined,
        }
      } catch {
        // A partial line at the window edge or unrelated JSON: keep scanning.
      }
    }
  } finally {
    await handle.close()
  }
  return undefined
}
