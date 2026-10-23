import { randomUUID } from 'node:crypto'
import { watch, type Dirent, type Stats } from 'node:fs'
import { open, readdir, realpath, stat, unlink, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { HarnessId, SessionCatalogUpdate, SessionChangeEvent, SessionRecord, TranscriptMessage } from '../../src/types/api'
import { SessionCatalogSync } from './sessions/sync'

import { comparePaths, createAdmissionQueue, createSingleFlight, type AdmissionQueue } from './lib/async'
import { SESSION_FILE_RECORD_LIMIT_BYTES } from './jsonl-limits'
import { resolveExecutable, runProcess, type ExecutableSource } from './process-utils'
import { SessionMetadataCatalog, type SessionCatalogIo, type SessionNameTimestamp } from './sessions/catalog'
import { createSessionMetadataReader, MAX_SESSION_FILE_BYTES, type SessionMetadata, type SessionMetadataReader } from './sessions/metadata'
import { readTranscript } from './sessions/transcript'
import type { JsonStateStore } from './store'
import { isRecord, isPathWithin, requireBoolean, requireExistingDirectory, requireString } from './validation'

interface RuntimeSessionState { isStreaming: boolean; isCompacting?: boolean }

interface RuntimeSessionSnapshot extends RuntimeSessionState { sessionFile?: string }

const MAX_SESSION_FILES = 5_000
const MAX_SESSION_WATCH_DIRECTORIES = 512
const MAX_CONCURRENT_TRANSCRIPT_READS = 2
const MAX_PENDING_TRANSCRIPT_READS = 32
const BRANCH_COPY_CHUNK_BYTES = 256 * 1024
/** Byte budget scanned from a session head for the identity header before a fork falls back to a verbatim copy. */
const MAX_BRANCH_HEADER_SCAN_BYTES = 64 * 1024

type TranscriptReader = (filePath: string, isStreaming: boolean) => Promise<TranscriptMessage[]>

type SessionPathAuthorizer = (sessionRootRealPath: string, sessionRealPath: string) => boolean

export interface SessionWatcher {
  close(): void
  on(event: 'error', listener: (error: Error) => void): SessionWatcher
}

export type SessionWatchFactory = (
  path: string,
  options: { persistent: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => SessionWatcher

const watchSessionDirectory: SessionWatchFactory = (path, options, listener) => watch(
  path,
  options,
  (eventType, filename) => listener(eventType, filename),
)

const authorizeOmpSessionPath: SessionPathAuthorizer = (root, path) => isPathWithin(root, path) && path.endsWith('.jsonl')

/** Bucketed branch file name: `<now with dashes>_<fresh uuid>.jsonl`, matching BUCKETED_SESSION_FILE_NAME. */
function branchSessionFileName(id: string): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`
}

/**
 * Rewrites a session identity header line (`{"type":"session",...}`) to the
 * branched session id. Returns null for every other line so a fork copies the
 * source byte-for-byte except for its session identity.
 */
const SESSION_HEADER_NEWLINE = Buffer.from('\n')
function rewrittenSessionHeader(line: Buffer, sessionId: string): string | null {
  if (line.length === 0 || line.length > SESSION_FILE_RECORD_LIMIT_BYTES) return null
  let value: unknown
  try { value = JSON.parse(line.toString('utf8')) } catch { return null }
  if (!isRecord(value) || value.type !== 'session' || typeof value.id !== 'string') return null
  return JSON.stringify({ ...value, id: sessionId })
}

export interface SessionServiceOptions {
  /** Harness stamped on every record and change event this service emits; defaults to 'omp'. */
  harness?: HarnessId
  /** Canonical-or-lexical session root; defaults to the OMP session directory. */
  sessionRoot?: string
  catalogIo?: SessionCatalogIo
  /** Pre-I/O discovery ordering for a harness's file-name scheme; defaults to OMP bucketed names. */
  catalogNameTimestamp?: SessionNameTimestamp
  metadataReader?: SessionMetadataReader
  transcriptReader?: TranscriptReader
  /** Containment rule applied to realpathed candidates; defaults to root containment plus a `.jsonl` suffix. */
  isSessionPathAuthorized?: SessionPathAuthorizer
  /**
   * Also watch a bounded set of session directories exactly one level below
   * the root (for harnesses that bucket sessions).
   */
  recursiveWatch?: boolean
  /** Injectable watch seam for deterministic filesystem-event tests. */
  watchDirectory?: SessionWatchFactory
  /**
   * File-level rename fallback for a harness whose CLI exposes no rename
   * subcommand. Called when no live runtime is available to accept
   * `set_session_name` and no CLI fallback exists.
   */
  renameFile?: (filePath: string, title: string) => boolean
  maxConcurrentTranscriptReads?: number
  maxPendingTranscriptReads?: number
}

export class SessionService {
  readonly harness: HarnessId
  readonly sessionRoot: string
  private readonly recursiveWatch: boolean
  private runtimeForSession: (filePath: string) => RuntimeSessionState | undefined = () => undefined
  private listRuntimeSessions: (() => readonly RuntimeSessionSnapshot[]) | null = null
  private stopRuntimeForSession: (filePath: string) => Promise<void> = async () => undefined
  private renameRuntimeSession: (filePath: string, title: string) => Promise<boolean> = async () => false
  private readonly catalog: SessionMetadataCatalog
  private readonly metadataReader: SessionMetadataReader
  private readonly transcriptReads = createSingleFlight<string, TranscriptMessage[]>()
  private catalogSyncQueue: Promise<void> = Promise.resolve()
  private readonly catalogSync = new SessionCatalogSync()
  private readonly transcriptAdmission: AdmissionQueue
  private readonly transcriptReader: TranscriptReader
  private readonly isSessionPathAuthorized: SessionPathAuthorizer
  private readonly watchDirectory: SessionWatchFactory
  private readonly renameFile: ((filePath: string, title: string) => boolean) | undefined
  private readonly changeListeners = new Set<(event: SessionChangeEvent) => void>()
  private sessionWatcher: SessionWatcher | null = null
  private readonly bucketWatchers = new Map<string, SessionWatcher>()
  private bucketWatcherRefresh: Promise<void> | null = null
  private bucketWatcherRefreshPending = false
  private watcherRetry: NodeJS.Timeout | null = null
  private changeTimer: NodeJS.Timeout | null = null
  private readonly changedNames = new Set<string>()
  private catalogOnlyChange = false

  constructor(
    private readonly store: JsonStateStore,
    private readonly primeAgentPath: ExecutableSource,
    maxSessionFiles = MAX_SESSION_FILES,
    options: SessionServiceOptions = {},
  ) {
    const transcriptLimit = options.maxConcurrentTranscriptReads ?? MAX_CONCURRENT_TRANSCRIPT_READS
    const pendingLimit = options.maxPendingTranscriptReads ?? MAX_PENDING_TRANSCRIPT_READS
    if (!Number.isInteger(transcriptLimit) || transcriptLimit < 1) throw new RangeError('maxConcurrentTranscriptReads must be a positive integer')
    if (!Number.isInteger(pendingLimit) || pendingLimit < 0) throw new RangeError('maxPendingTranscriptReads must be a non-negative integer')
    this.transcriptAdmission = createAdmissionQueue({
      maxConcurrent: transcriptLimit,
      maxPending: pendingLimit,
      pendingLimitError: () => new Error('Too many transcript reads are pending'),
      closedError: () => new Error('Too many transcript reads are pending'),
    })
    this.harness = options.harness ?? 'omp'
    this.sessionRoot = options.sessionRoot ?? join(homedir(), '.omp', 'agent', 'sessions')
    this.recursiveWatch = options.recursiveWatch === true
    this.metadataReader = options.metadataReader ?? createSessionMetadataReader()
    this.transcriptReader = options.transcriptReader ?? readTranscript
    this.isSessionPathAuthorized = options.isSessionPathAuthorized ?? authorizeOmpSessionPath
    this.watchDirectory = options.watchDirectory ?? watchSessionDirectory
    this.catalog = new SessionMetadataCatalog(
      () => this.sessionRoot,
      primeAgentPath,
      maxSessionFiles,
      (filePath, knownStat) => this.readMetadata(filePath, knownStat),
      options.catalogIo,
      options.catalogNameTimestamp,
    )
    this.renameFile = options.renameFile
  }

  bindRuntimeHooks(hooks: {
    get(filePath: string): RuntimeSessionState | undefined
    all?(): readonly RuntimeSessionSnapshot[]
    stop(filePath: string): Promise<void>
    rename(filePath: string, title: string): Promise<boolean>
  }): void {
    this.runtimeForSession = hooks.get
    this.listRuntimeSessions = hooks.all ?? null
    this.stopRuntimeForSession = hooks.stop
    this.renameRuntimeSession = hooks.rename
  }

  onDidChange(listener: (event: SessionChangeEvent) => void): () => void {
    this.changeListeners.add(listener)
    this.startWatcher()
    return () => {
      this.changeListeners.delete(listener)
      if (!this.changeListeners.size) this.stopWatcher()
    }
  }

  async list(projectPath?: unknown, includeArchivedValue: unknown = false, forceValue: unknown = false): Promise<SessionRecord[]> {
    const includeArchived = requireBoolean(includeArchivedValue, 'includeArchived')
    const force = requireBoolean(forceValue, 'force')
    const requestedProject = projectPath ? requireString(projectPath, 'projectPath', { min: 1, max: 4096 }) : undefined
    let project = requestedProject ? resolve(requestedProject) : undefined
    if (requestedProject) {
      try { project = await requireExistingDirectory(requestedProject, 'projectPath') } catch { /* Preserve stale lexical filtering. */ }
    }
    // A caller reconciling a just-created session cannot rely on fs.watch:
    // recursive delivery varies by platform and an event may still be queued.
    // Force advances the scan revision while retaining metadata-level caches.
    if (force) this.catalog.invalidateLiveCatalog()
    const sessions = await this.catalog.all()
    const archived = new Set(this.store.getArchivedSessions().map((path) => resolve(path)))
    const pinned = new Set(this.store.getPinnedSessions().map((path) => resolve(path)))
    // One runtime snapshot per list call; each session then resolves in O(1).
    const runtimeBySession = this.snapshotRuntimeSessions()
    const records: SessionRecord[] = []
    for (const original of sessions) {
      const metadata = { ...original }
      const isArchived = archived.has(resolve(metadata.filePath))
      if ((isArchived && !includeArchived) || (project && resolve(metadata.projectPath) !== project)) continue
      const runtime = runtimeBySession
        ? runtimeBySession.get(resolve(metadata.filePath))
        : this.runtimeForSession(metadata.filePath)
      if (runtime) metadata.status = runtime.isStreaming || runtime.isCompacting ? 'running' : 'idle'
      const { sessionName: _sessionName, ...record } = metadata
      records.push({ ...record, harness: this.harness, archived: isArchived, pinned: pinned.has(resolve(metadata.filePath)) })
    }
    return records.sort((a, b) => Date.parse(b.lastUserMessageAt ?? b.createdAt) - Date.parse(a.lastUserMessageAt ?? a.createdAt) || comparePaths(a.filePath, b.filePath))
  }

  private snapshotRuntimeSessions(): Map<string, RuntimeSessionState> | null {
    if (!this.listRuntimeSessions) return null
    const bySession = new Map<string, RuntimeSessionState>()
    for (const runtime of this.listRuntimeSessions()) {
      if (!runtime.sessionFile) continue
      const key = resolve(runtime.sessionFile)
      if (!bySession.has(key)) bySession.set(key, runtime)
    }
    return bySession
  }

  async sync(revision: unknown = undefined): Promise<SessionCatalogUpdate> {
    if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)) throw new TypeError('Invalid catalog revision')
    // A caller observing a later invalidation must never join a scan that already captured older records.
    const operation = this.catalogSyncQueue.then(async () => {
      this.catalogSync.publish(await this.list(undefined, true))
      return this.catalogSync.read(revision)
    })
    this.catalogSyncQueue = operation.then(() => undefined, () => undefined)
    // IPC supplies the process-boundary clone; no mutable catalog state is sent back into services.
    return operation
  }

  async projectPaths(): Promise<string[]> {
    const sessions = await this.list()
    return [...new Set(sessions.map((session) => session.projectPath).filter((path) => path.startsWith('/')))]
  }

  async read(filePath: unknown): Promise<TranscriptMessage[]> {
    const requested = requireString(filePath, 'filePath', { min: 1, max: 4096 })
    const safePath = await this.requireSessionPath(requested)
    // Coalesced callers share one immutable result; the IPC boundary clones it
    // for the renderer, so a pre-IPC structuredClone would be a second copy.
    return this.transcriptReads.run(safePath, () => this.transcriptAdmission.run(async () => {
      const runtime = this.runtimeForSession(safePath)
      return this.transcriptReader(safePath, runtime?.isStreaming === true || runtime?.isCompacting === true)
    }))
  }


  async rename(filePath: unknown, title: unknown): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    const safeTitle = requireString(title, 'title', { min: 1, max: 200, trim: true })
    if (safeTitle.startsWith('-') || /[\r\n]/.test(safeTitle)) throw new TypeError('title contains invalid characters')
    if (await this.renameRuntimeSession(safePath, safeTitle)) return true
    const primeAgentPath = resolveExecutable(this.primeAgentPath)
    // The OMP service is constructed with a null CLI path (electron/main/index.ts).
    if (!primeAgentPath) return this.renameFile?.(safePath, safeTitle) ?? false
    const metadata = await this.readMetadata(safePath)
    const result = await runProcess(primeAgentPath, ['rename', metadata.id, safeTitle, '--json'], { timeoutMs: 30_000 })
    return result.code === 0
  }

  async archive(filePath: unknown, archivedValue: unknown = true): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    const archived = requireBoolean(archivedValue, 'archived')
    if (archived) await this.stopRuntimeForSession(safePath)
    await this.store.update((state) => {
      state.archivedSessions = state.archivedSessions.filter((path) => resolve(path) !== resolve(safePath))
      if (archived) state.archivedSessions.push(safePath)
    })
    return true
  }

  /**
   * Pins or unpins a session in the persisted app store. Mirrors `archive`:
   * the store update is the whole mutation and the renderer reconciles its
   * local record from the resolved call, so no change event is emitted.
   */
  async setPinned(filePath: unknown, pinnedValue: unknown): Promise<void> {
    const safePath = await this.requireSessionPath(filePath)
    const pinned = requireBoolean(pinnedValue, 'pinned')
    await this.store.update((state) => {
      state.pinnedSessions = state.pinnedSessions.filter((path) => resolve(path) !== resolve(safePath))
      if (pinned) state.pinnedSessions.push(safePath)
    })
  }

  /**
   * Forks a session by copying its file to a fresh bucketed sibling named
   * `<now>_<fresh uuid>.jsonl`. The copy is byte-exact except that its session
   * identity header is re-stamped with the fresh uuid (OMP ties the file-name
   * uuid to the session id), so the fork is a distinct session while the
   * source file is never modified.
   */
  async branch(filePath: unknown): Promise<SessionRecord> {
    const safePath = await this.requireSessionPath(filePath)
    const fileStat = await stat(safePath)
    if (fileStat.size > MAX_SESSION_FILE_BYTES) throw new Error('Session file is too large to branch')
    const id = randomUUID()
    const target = join(dirname(safePath), branchSessionFileName(id))
    await this.copySessionFork(safePath, target, id)
    this.emitChange({ harness: this.harness })
    const records = await this.list(undefined, true, true)
    const record = records.find((candidate) => resolve(candidate.filePath) === resolve(target))
    if (!record) throw new Error('Branched session did not appear in the session catalog')
    return record
  }

  async delete(filePath: unknown): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    await this.stopRuntimeForSession(safePath)
    // Recheck containment after the runtime has stopped and flushed its file.
    await unlink(await this.requireSessionPath(safePath))
    this.catalog.invalidateLiveCatalog()
    await this.store.update((state) => {
      state.archivedSessions = state.archivedSessions.filter((path) => resolve(path) !== resolve(safePath))
    })
    this.emitChange({ harness: this.harness })
    return true
  }

  async requireSessionPath(value: unknown): Promise<string> {
    const requested = requireString(value, 'filePath', { min: 1, max: 4096 })
    const root = await realpath(this.sessionRoot)
    const path = await realpath(requested)
    if (!this.isSessionPathAuthorized(root, path)) throw new TypeError('Session path is outside the Prime session directory')
    return path
  }

  /**
   * Streams a session file to a fresh sibling, rewriting only the first
   * `{"type":"session"}` identity record to the branched id. Every other byte
   * (including fixed-width leading slots) is copied verbatim, and a failed
   * copy never leaves a partial target behind.
   */
  private async copySessionFork(source: string, target: string, sessionId: string): Promise<void> {
    const input = await open(source, 'r')
    let output: FileHandle | null = null
    try {
      output = await open(target, 'wx')
      const chunk = Buffer.allocUnsafe(BRANCH_COPY_CHUNK_BYTES)
      let pending: Buffer = Buffer.alloc(0)
      let scanned = 0
      let headerRewritten = false
      let gaveUp = false
      let position = 0
      while (true) {
        const { bytesRead } = await input.read(chunk, 0, chunk.length, position)
        if (bytesRead === 0) break
        position += bytesRead
        let data = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
        pending = Buffer.alloc(0)
        if (!headerRewritten && !gaveUp) {
          scanned += bytesRead
          while (!headerRewritten) {
            const newline = data.indexOf(0x0a)
            if (newline < 0) break
            const line = data.subarray(0, newline)
            data = data.subarray(newline + 1)
            const rewritten = rewrittenSessionHeader(line, sessionId)
            if (rewritten !== null) headerRewritten = true
            await output.write(rewritten !== null ? Buffer.from(rewritten, 'utf8') : line)
            await output.write(SESSION_HEADER_NEWLINE)
          }
          if (!headerRewritten && scanned >= MAX_BRANCH_HEADER_SCAN_BYTES) gaveUp = true
        }
        if (headerRewritten || gaveUp) await output.write(data)
        else pending = Buffer.from(data)
      }
      // A source without a trailing newline keeps its final partial line; it
      // can still be the identity header when the file is one line long.
      if (pending.length) {
        const rewritten = headerRewritten ? null : rewrittenSessionHeader(pending, sessionId)
        await output.write(rewritten !== null ? Buffer.from(rewritten, 'utf8') : pending)
      }
    } catch (error) {
      await unlink(target).catch(() => undefined)
      throw error
    } finally {
      await input.close()
      await output?.close()
    }
  }

  private startWatcher(): void {
    if (this.sessionWatcher || this.watcherRetry || !this.changeListeners.size) return
    try {
      // A missing session root (harness never used on this machine) throws
      // here and lands in the retry below, which watches once the root appears.
      const watcher = this.watchDirectory(this.sessionRoot, { persistent: false }, (_eventType, filename) => {
        this.queueSessionChange(filename)
        if (this.recursiveWatch) this.refreshBucketWatchers(watcher)
      })
      this.sessionWatcher = watcher
      if (this.recursiveWatch) this.refreshBucketWatchers(watcher)
      watcher.on('error', () => {
        if (this.sessionWatcher !== watcher) return
        watcher.close()
        this.sessionWatcher = null
        this.closeBucketWatchers()
        this.queueSessionChange(null)
        this.scheduleWatcherRetry()
      })
    } catch {
      this.scheduleWatcherRetry()
    }
  }

  private scheduleWatcherRetry(): void {
    if (this.watcherRetry || !this.changeListeners.size) return
    this.watcherRetry = setTimeout(() => {
      this.watcherRetry = null
      this.startWatcher()
    }, 1_000)
    this.watcherRetry.unref()
  }

  private stopWatcher(): void {
    this.sessionWatcher?.close()
    this.sessionWatcher = null
    this.closeBucketWatchers()
    if (this.watcherRetry) clearTimeout(this.watcherRetry)
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.watcherRetry = null
    this.changeTimer = null
    this.changedNames.clear()
    this.catalogOnlyChange = false
    this.bucketWatcherRefreshPending = false
  }

  /**
   * OMP keeps JSONL files exactly one bucket below the session root, so
   * watch a bounded set of real child directories and feed their root-relative
   * names through the same containment checks as root events. Using this on
   * every platform keeps behavior identical where recursive `fs.watch` is not
   * implemented (notably Linux).
   */
  private refreshBucketWatchers(rootWatcher: SessionWatcher): void {
    if (this.bucketWatcherRefresh) {
      this.bucketWatcherRefreshPending = true
      return
    }
    this.bucketWatcherRefresh = this.performBucketWatcherRefresh(rootWatcher)
      .finally(() => {
        const refreshAgain = this.bucketWatcherRefreshPending
        this.bucketWatcherRefreshPending = false
        this.bucketWatcherRefresh = null
        const currentWatcher = this.sessionWatcher
        if (refreshAgain && currentWatcher && this.changeListeners.size) this.refreshBucketWatchers(currentWatcher)
      })
  }

  private async performBucketWatcherRefresh(rootWatcher: SessionWatcher): Promise<void> {
    let entries: Dirent<string>[]
    let root: string
    try {
      [entries, root] = await Promise.all([
        readdir(this.sessionRoot, { withFileTypes: true }),
        realpath(this.sessionRoot),
      ])
    } catch { return }
    if (this.sessionWatcher !== rootWatcher || !this.changeListeners.size) return

    const bucketNames = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()
        && entry.name.length > 0 && entry.name.length <= 255 && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_SESSION_WATCH_DIRECTORIES)
    const wanted = new Set(bucketNames)
    for (const [name, watcher] of this.bucketWatchers) {
      if (wanted.has(name)) continue
      watcher.close()
      this.bucketWatchers.delete(name)
    }

    for (const name of bucketNames) {
      if (this.bucketWatchers.has(name)) continue
      try {
        const bucketPath = await realpath(join(root, name))
        if (this.sessionWatcher !== rootWatcher || !this.changeListeners.size) return
        if (!isPathWithin(root, bucketPath) || bucketPath === root) continue
        const watcher = this.watchDirectory(bucketPath, { persistent: false }, (_eventType, filename) => {
          if (this.sessionWatcher !== rootWatcher) return
          const leaf = typeof filename === 'string' ? filename : ''
          this.queueSessionChange(leaf ? join(name, leaf) : null)
        })
        this.bucketWatchers.set(name, watcher)
        watcher.on('error', () => {
          if (this.bucketWatchers.get(name) !== watcher) return
          watcher.close()
          this.bucketWatchers.delete(name)
          this.queueSessionChange(null)
        })
      } catch { /* The root watcher will report replacements and retry discovery. */ }
    }
  }

  private closeBucketWatchers(): void {
    for (const watcher of this.bucketWatchers.values()) watcher.close()
    this.bucketWatchers.clear()
  }

  /**
   * Root-relative watch names this watcher can resolve to one session file:
   * a bare file name, plus exactly one bucket-directory level when watching
   * recursively. Everything else coalesces into a catalog-wide refresh.
   */
  private isWatchedSessionName(name: string): boolean {
    if (!name.endsWith('.jsonl')) return false
    const segments = name.split(sep)
    if (segments.length > (this.recursiveWatch ? 2 : 1)) return false
    return segments.every((segment) => segment.length > 0 && !segment.startsWith('.'))
  }

  private queueSessionChange(filename: string | Buffer | null): void {
    const name = typeof filename === 'string' ? filename : Buffer.isBuffer(filename) ? filename.toString('utf8') : ''
    if (!name || !this.isWatchedSessionName(name)) {
      this.catalogOnlyChange = true
    } else if (this.changedNames.size < 256) {
      this.changedNames.add(name)
    } else {
      this.catalogOnlyChange = true
    }
    if (!this.changeTimer) {
      this.changeTimer = setTimeout(() => {
        this.changeTimer = null
        void this.flushSessionChanges()
      }, 120)
      this.changeTimer.unref()
    }
  }

  private async flushSessionChanges(): Promise<void> {
    const names = [...this.changedNames]
    let catalogOnly = this.catalogOnlyChange
    this.changedNames.clear()
    this.catalogOnlyChange = false

    let paths: string[]
    if (!catalogOnly && names.length) {
      const result = await this.catalog.reconcileKnownChanges(names)
      if (result.kind === 'reconciled') {
        paths = result.paths
      } else {
        paths = await this.resolveChangedSessionPaths(names)
        if (paths.length !== names.length) catalogOnly = true
      }
    } else {
      // Missing/invalid names, watcher errors, and admission overflow leave
      // the changed catalog membership unknowable, so retain the full-scan path.
      this.catalog.invalidateLiveCatalog()
      paths = await this.resolveChangedSessionPaths(names)
      if (paths.length !== names.length) catalogOnly = true
    }
    if (!this.changeListeners.size) return
    for (const filePath of paths) this.emitChange({ filePath, harness: this.harness })
    if (catalogOnly) this.emitChange({ harness: this.harness })
  }

  private async resolveChangedSessionPaths(names: readonly string[]): Promise<string[]> {
    return (await Promise.all(names.map(async (name) => {
      try { return await this.requireSessionPath(join(this.sessionRoot, name)) } catch { return null }
    }))).filter((path): path is string => path !== null)
  }

  private emitChange(event: SessionChangeEvent): void {
    for (const listener of this.changeListeners) {
      try { listener(event) } catch { /* A renderer listener cannot break session watching. */ }
    }
  }

  private async readMetadata(filePath: string, knownStat?: Stats): Promise<SessionMetadata> {
    const metadata = await this.metadataReader(filePath, knownStat)
    if (metadata.projectPath) {
      try { metadata.projectPath = await requireExistingDirectory(metadata.projectPath, 'session project path') }
      catch { if (metadata.projectPath.startsWith('/')) metadata.projectPath = resolve(metadata.projectPath) }
    }
    return metadata
  }
}
