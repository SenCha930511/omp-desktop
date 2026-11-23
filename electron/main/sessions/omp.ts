import { closeSync, openSync, readSync, writeSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isRecord } from '../validation'
import type { SessionServiceOptions } from '../sessions'
import type { SessionCatalogIo } from './catalog'
import {
  bucketedMetadataFromAccumulator,
  createBranchSummaryTranscriptReader,
  createBucketedCatalogIo,
  createBucketedMetadataParser,
  idFromBucketedFileName,
  isBucketedSessionPath,
  timestampFromBucketedSessionName,
} from './bucketed'
import {
  createIncrementalMetadataReader,
  nodeMetadataReaderIo,
  type SessionMetadata,
  type SessionMetadataReader,
  type SessionMetadataReaderIo,
} from './metadata'
import { ompWasmEnabled, scanOmpMetadataBytes } from './omp-wasm'
import { compactText, type TranscriptFileReader } from './transcript'

/**
 * OMP session JSONL v3 layout under `~/.omp/agent/sessions/<bucket>/`:
 * - Line 1 is a fixed-width 256-byte title slot (`{"type":"title",...,"pad":"..."}`)
 *   that OMP REWRITES IN PLACE, keeping the byte length constant.
 * - Line 2 is the `{"type":"session","version":3,...}` header; everything after
 *   it is append-only entries with `id`/`parentId` forming a branch tree.
 * - File names are `<ISO timestamp with dashes>_<uuid>.jsonl`; ordering derives
 *   from the name prefix, not UUIDv7 bits.
 *
 * Everything except the title slot and the display-name and `model_change`
 * record shapes lives in `./bucketed`.
 */
export const OMP_TITLE_SLOT_BYTES = 256
// The WASM path wins on the catalog's many small files. Above 4 MiB the
// streaming TS reader is at least as fast, so large sessions stay on it.
const MAX_WASM_FAST_BYTES = 4 * 1024 * 1024
const MAX_FAST_CACHE_ENTRIES = 5_000

export function ompSessionRoot(): string {
  return join(homedir(), '.omp', 'agent', 'sessions')
}

export const ompTimestampFromSessionName = timestampFromBucketedSessionName

export function createOmpCatalogIo(): SessionCatalogIo {
  return createBucketedCatalogIo()
}

export const isOmpSessionPath = isBucketedSessionPath

const ompMetadataParser = createBucketedMetadataParser((state, value) => {
  if (value.type === 'model_change' && typeof value.model === 'string') {
    // OMP records `model` as a single `provider/id` string; a `role` other
    // than the default selects a task-specific model, not the session model.
    if (value.role === undefined || value.role === 'default') {
      const separator = value.model.indexOf('/')
      state.provider = separator > 0 ? value.model.slice(0, separator) : undefined
      state.model = separator > 0 ? value.model.slice(separator + 1) : value.model
    }
  } else if ((value.type === 'title_change' || value.type === 'title') && typeof value.title === 'string') {
    state.displayName = value.title
  }
})

async function readOmpTitleSlot(io: SessionMetadataReaderIo, filePath: string): Promise<string | undefined> {
  let slot: Buffer
  if (io.readPrefix) {
    const prefix = await io.readPrefix(filePath, OMP_TITLE_SLOT_BYTES)
    if (!prefix) return undefined
    slot = prefix
  } else {
    const stream = io.openStream(filePath, 0, OMP_TITLE_SLOT_BYTES - 1)
    const chunks: Buffer[] = []
    try {
      for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk as Buffer)
    } finally {
      stream.destroy()
    }
    slot = Buffer.concat(chunks)
  }
  const newline = slot.indexOf(0x0a)
  if (newline < 0) return undefined
  let value: unknown
  try { value = JSON.parse(slot.toString('utf8', 0, newline)) } catch { return undefined }
  if (!isRecord(value) || value.type !== 'title' || typeof value.title !== 'string' || !value.title.trim()) return undefined
  return value.title
}
/**
 * Rewrite the 256-byte in-place title slot at the start of an OMP session
 * file. Used as a fallback when no live runtime is available to accept
 * `set_session_name` (e.g. the session has finished and the agent exited).
 *
 * The slot is a single JSON line padded with spaces to exactly
 * `OMP_TITLE_SLOT_BYTES` bytes, followed by `\n`. OMP rewrites this slot
 * in place without touching the rest of the file.
 */
export function writeOmpTitleSlot(filePath: string, title: string): boolean {
  try {
    const fd = openSync(filePath, 'r+')
    try {
      const slot = Buffer.alloc(OMP_TITLE_SLOT_BYTES)
      const bytesRead = readSync(fd, slot, 0, OMP_TITLE_SLOT_BYTES, 0)
      if (bytesRead !== OMP_TITLE_SLOT_BYTES || slot[OMP_TITLE_SLOT_BYTES - 1] !== 0x0a) return false
      let existing: unknown
      try { existing = JSON.parse(slot.toString('utf8', 0, OMP_TITLE_SLOT_BYTES - 1)) } catch { return false }
      if (!isRecord(existing) || existing.type !== 'title') return false

      const updatedAt = new Date().toISOString()
      const targetLen = OMP_TITLE_SLOT_BYTES - 1
      const build = (name: string, pad: string) => JSON.stringify({ ...existing, title: name, updatedAt, pad })
      let name = title
      while (name.length > 0 && Buffer.byteLength(build(name, ''), 'utf8') > targetLen) {
        const points = Array.from(name)
        points.pop()
        name = points.join('')
      }
      const unpadded = build(name, '')
      const padding = targetLen - Buffer.byteLength(unpadded, 'utf8')
      if (padding < 0) return false
      const line = build(name, ' '.repeat(padding))
      if (Buffer.byteLength(line, 'utf8') !== targetLen) return false
      writeSync(fd, `${line}\n`, 0, 'utf8')
      return true
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

/**
 * OMP metadata reader: the append-only tail (everything after the 256-byte
 * title slot) reuses the shared incremental machinery, while the slot itself
 * is re-read on every snapshot because OMP rewrites it in place without
 * changing the file size of the parsed range.
 */
export function createOmpSessionMetadataReader(io: SessionMetadataReaderIo = nodeMetadataReaderIo): SessionMetadataReader {
  const readTail = createIncrementalMetadataReader(ompMetadataParser, io, OMP_TITLE_SLOT_BYTES)
  const fastCache = new Map<string, { size: number; mtimeMs: number; metadata: SessionMetadata }>()
  const rememberFast = (filePath: string, fileStat: Stats, metadata: SessionMetadata): void => {
    fastCache.delete(filePath)
    fastCache.set(filePath, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, metadata })
    while (fastCache.size > MAX_FAST_CACHE_ENTRIES) {
      const oldest = fastCache.keys().next().value
      if (oldest === undefined) break
      fastCache.delete(oldest)
    }
  }
  const fastRead = async (filePath: string, fileStat: Stats): Promise<SessionMetadata | undefined> => {
    if (!io.readAll || !ompWasmEnabled() || fileStat.size > MAX_WASM_FAST_BYTES) return undefined
    let bytes: Buffer
    try {
      bytes = await io.readAll(filePath)
    } catch {
      return undefined
    }
    const nameTimestamp = timestampFromBucketedSessionName(filePath)
    const result = await scanOmpMetadataBytes(bytes, {
      id: idFromBucketedFileName(filePath),
      createdAt: nameTimestamp !== undefined ? new Date(nameTimestamp).toISOString() : fileStat.birthtime.toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
    }, OMP_TITLE_SLOT_BYTES)
    if (result.status === 'error') {
      if (result.reason === 'too-many-records') throw new Error('Session file has too many records')
      if (result.reason === 'record-too-large') throw new Error('JSONL record exceeded the maximum frame size')
      return undefined
    }
    if (result.status !== 'ok') return undefined
    const metadata = bucketedMetadataFromAccumulator(result.accumulator, filePath, fileStat.mtime.toISOString())
    rememberFast(filePath, fileStat, metadata)
    return metadata
  }
  return async (filePath, knownStat) => {
    let fileStat: Stats
    try {
      fileStat = knownStat ?? await io.inspect(filePath)
    } catch (error) {
      fastCache.delete(filePath)
      throw error
    }
    const cached = fastCache.get(filePath)
    if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) return cached.metadata
    if (!cached) {
      const fast = await fastRead(filePath, fileStat)
      if (fast) return fast
    }
    const [metadata, title] = await Promise.all([readTail(filePath, fileStat), readOmpTitleSlot(io, filePath)])
    if (title !== undefined) metadata.title = compactText(title, 100)
    rememberFast(filePath, fileStat, metadata)
    return metadata
  }
}

export const readOmpTranscript: TranscriptFileReader = createBranchSummaryTranscriptReader()

/**
 * Fully wired SessionService options for an OMP session root. Construct the
 * service with a null CLI path: OMP has no `omp list` live overlay.
 */
export function ompSessionServiceOptions(sessionRoot = ompSessionRoot()): SessionServiceOptions {
  return {
    harness: 'omp',
    sessionRoot,
    catalogIo: createOmpCatalogIo(),
    catalogNameTimestamp: ompTimestampFromSessionName,
    metadataReader: createOmpSessionMetadataReader(),
    transcriptReader: readOmpTranscript,
    isSessionPathAuthorized: isOmpSessionPath,
    // Session files sit one bucket directory below the root; bounded one-level
    // watchers keep catalog refresh behavior identical across platforms.
    recursiveWatch: true,
    renameFile: writeOmpTitleSlot,
  }
}
