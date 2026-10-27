import type { SessionRecord } from '@/types/api'

/**
 * Lineage collapse for session lists.
 *
 * omp's context rollover (compact) and fork write the conversation into a
 * fresh file whose session header names the file it continued
 * (`parentSession` — a session id, or an absolute path when an external
 * caller forked by path). The original file stays on disk untouched, so a
 * naive listing shows the same conversation twice under one title. Lists
 * render one row per chain — the newest continuation — and fold every
 * session that another session names as its parent.
 */
export function continuedSessionKeys(sessions: readonly SessionRecord[]): Set<string> {
  const keys = new Set<string>()
  for (const session of sessions) {
    const parent = session.parentSession
    if (typeof parent === 'string' && parent) keys.add(parent)
  }
  return keys
}
