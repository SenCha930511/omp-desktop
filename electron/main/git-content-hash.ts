import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'

/** Hash bytes without invoking Git filters; links describe their target, not its contents. */
export async function gitWorktreeContentHash(path: string): Promise<string> {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) return `link:${await readlink(path)}`
    if (!stat.isFile()) return `other:${stat.mode}:${stat.mtimeMs}`
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return `${stat.mode}:${hash.digest('hex')}`
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'deleted'
    throw error
  }
}
