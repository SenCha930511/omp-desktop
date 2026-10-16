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
  if (cached !== undefined) return cached
  let canonical: string
  try {
    canonical = realpathSync(resolved)
  } catch {
    try { return join(realpathSync(dirname(resolved)), basename(resolved)) } catch { return resolved }
  }
  if (canonicalCache.size >= MAX_CANONICAL_CACHE) canonicalCache.clear()
  canonicalCache.set(resolved, canonical)
  return canonical
}
