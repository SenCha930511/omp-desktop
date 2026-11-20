import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const canonicalCache = new Map<string, string>()
const MAX_CANONICAL_CACHE = 1_024

/**
 * Canonicalizes a session file path once at the boundary so paths reported by
 * agent runtimes and paths produced by the session catalog and validators
 * (which realpath) compare equal even when the session root is reached
 * through a symlink (for example a symlinked ~/.omp). Falls back to
 * canonicalizing the parent directory when the file does not exist yet, and
 * to the resolved lexical path when nothing exists.
 */
export function canonicalSessionPath(pathValue: string): string {
  const resolved = resolve(pathValue)
  const cached = canonicalCache.get(resolved)
  if (cached !== undefined) {
    // Refresh recency so eviction drops the coldest entry instead of the whole
    // map: a burst of distinct paths must not cost a re-stat avalanche.
    canonicalCache.delete(resolved)
    canonicalCache.set(resolved, cached)
    return cached
  }
  let canonical: string
  try {
    canonical = realpathSync(resolved)
  } catch {
    try { return join(realpathSync(dirname(resolved)), basename(resolved)) } catch { return resolved }
  }
  canonicalCache.delete(resolved)
  canonicalCache.set(resolved, canonical)
  while (canonicalCache.size > MAX_CANONICAL_CACHE) {
    const oldest = canonicalCache.keys().next().value
    if (oldest === undefined) break
    canonicalCache.delete(oldest)
  }
  return canonical
}
