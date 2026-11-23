import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'

/**
 * Digest cache for repeated status refreshes. The key is the file identity a
 * rewrite must change (path, device, inode, size, mtime, ctime), so an edited
 * or replaced file is always re-read; the LRU bound keeps memory flat for
 * large worktrees. Only successful reads are cached.
 */
const CONTENT_HASH_CACHE_LIMIT = 2_000
const contentHashCache = new Map<string, string>()

interface FileIdentity {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

function identityKey(path: string, stat: FileIdentity): string {
  return `${path}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}`
}

function rememberDigest(key: string, digest: string): void {
  contentHashCache.delete(key)
  contentHashCache.set(key, digest)
  while (contentHashCache.size > CONTENT_HASH_CACHE_LIMIT) {
    const oldest = contentHashCache.keys().next()
    if (oldest.done) return
    contentHashCache.delete(oldest.value)
  }
}

/** Hash bytes without invoking Git filters; links describe their target, not its contents. */
export async function gitWorktreeContentHash(path: string): Promise<string> {
  try {
    const stat = await lstat(path, { bigint: true })
    if (stat.isSymbolicLink()) return `link:${await readlink(path)}`
    if (!stat.isFile()) return `other:${stat.mode}:${stat.mtimeMs}`
    const key = identityKey(path, stat)
    const cached = contentHashCache.get(key)
    if (cached !== undefined) {
      // Re-insert so the map's iteration order stays least-recently-used first.
      contentHashCache.delete(key)
      contentHashCache.set(key, cached)
      return cached
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    const digest = `${stat.mode}:${hash.digest('hex')}`
    // Cache only when the file did not change while it was read, so a racing
    // writer cannot pin a digest to an identity the bytes no longer match.
    const after = await lstat(path, { bigint: true }).catch(() => undefined)
    if (after && identityKey(path, after) === key) rememberDigest(key, digest)
    return digest
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'deleted'
    throw error
  }
}
