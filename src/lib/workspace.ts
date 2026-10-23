import type { GitFileChange, GitStatus, ProjectRecord, RuntimeInfo, SessionRecord } from '@/types/api'


export interface OwnedGitStatus {
  cwd?: string
  status: GitStatus
}

/** Stable identity for "no git status", so memoized consumers of the result keep their memo across renders. */
export const EMPTY_GIT_STATUS: GitStatus = Object.freeze({ isRepo: false, files: [] })

export function gitStatusForWorkspace(snapshot: OwnedGitStatus, cwd?: string): GitStatus {
  return cwd && snapshot.cwd === cwd ? snapshot.status : EMPTY_GIT_STATUS
}

/** Changed files since turn start. Counts describe their current Git diff,
    not a reversible patch for this turn. Scope distinguishes index/worktree. */
export function turnFileDeltas(current: readonly GitFileChange[], baseline: readonly GitFileChange[] | null): GitFileChange[] {
  if (!baseline) return []
  const before = new Map(baseline.map((file) => [`${file.staged}:${file.path}`, file]))
  const deltas: GitFileChange[] = []
  for (const file of current) {
    const prior = before.get(`${file.staged}:${file.path}`)
    if (file.contentHash !== undefined && prior?.contentHash !== undefined) {
      if (file.contentHash !== prior.contentHash || file.status !== prior.status) deltas.push(file)
      continue
    }
    const additions = file.additions - (prior?.additions ?? 0)
    const deletions = file.deletions - (prior?.deletions ?? 0)
    if (additions > 0 || deletions > 0) deltas.push({ ...file, additions, deletions })
  }
  for (const file of baseline) {
    if (file.contentHash !== undefined && !current.some((candidate) => candidate.path === file.path && candidate.staged === file.staged)) {
      deltas.push({ ...file, additions: 0, deletions: 0 })
    }
  }
  const files = new Map<string, GitFileChange>()
  for (const file of deltas) {
    const previous = files.get(file.path)
    files.set(file.path, previous ? { ...file, additions: previous.additions + file.additions, deletions: previous.deletions + file.deletions } : file)
  }
  return [...files.values()]
}

export interface WorkspaceSelection {
  project?: ProjectRecord
  session?: SessionRecord
  runtime?: RuntimeInfo
  cwd?: string
}

export interface SingleFlightAdmission {
  readonly active: boolean
  run(task: () => Promise<void> | void): Promise<boolean>
  /** Resolves once no admission is in flight; callers use it to queue work behind the gate. */
  waitForIdle(): Promise<void>
}

const PATH_SEPARATORS = new Set(['/', '\\'])

function stripTrailingSeparators(path: string): string {
  let end = path.length
  while (end > 1 && PATH_SEPARATORS.has(path[end - 1]!)) end -= 1
  return path.slice(0, end)
}

/** Boundary-safe containment: equal, or separated by a path separator. Platform-agnostic so recorded POSIX and Windows paths both match. */
function pathIsWithin(path: string, folder: string): boolean {
  const base = stripTrailingSeparators(folder)
  if (path === base) return true
  // An empty folder matches nothing beyond exact equality; a lone separator
  // is a filesystem root and contains every path.
  if (base.length === 0) return false
  if (base.length === 1 && PATH_SEPARATORS.has(base)) return true
  return path.startsWith(base) && PATH_SEPARATORS.has(path.charAt(base.length))
}

function matchingFolder(project: ProjectRecord, path: string): string | undefined {
  return [project.path, ...project.folders].find((folder) => pathIsWithin(path, folder))
}

export function projectContainsPath(project: ProjectRecord, path?: string): boolean {
  return Boolean(path && matchingFolder(project, path))
}

export function findProjectForSession(projects: ProjectRecord[], session?: SessionRecord): ProjectRecord | undefined {
  if (!session) return undefined
  let best: { project: ProjectRecord; folder: string } | undefined
  for (const project of projects) {
    const folder = matchingFolder(project, session.projectPath)
    if (folder === undefined) continue
    // Deterministic under containment: the project whose matching folder is
    // longest (most specific) wins, so <repo>/packages/app maps to the nested
    // project rather than whichever repo-scoped project iterated first.
    if (best === undefined || folder.length > best.folder.length) best = { project, folder }
  }
  return best?.project
}

export function workspaceCwd(project?: ProjectRecord, session?: SessionRecord): string | undefined {
  if (!project) return undefined
  return session && projectContainsPath(project, session.projectPath) ? session.projectPath : project.primaryFolder
}

export function newSessionProject(
  requestedProject?: ProjectRecord,
  workspaceProject?: ProjectRecord,
  displayedProject?: ProjectRecord,
): ProjectRecord | undefined {
  return requestedProject ?? workspaceProject ?? displayedProject
}

/**
 * Git status refreshes on turn boundaries, never on per-append catalog ticks:
 * an externally running session triggers one refresh when it stops running.
 * Locally owned runtimes already refresh through their own agent_end events.
 */
export function shouldRefreshGitOnSessionTransition(
  previousStatus: SessionRecord['status'] | undefined,
  status: SessionRecord['status'] | undefined,
  locallyOwned: boolean,
): boolean {
  return !locallyOwned && previousStatus === 'running' && status !== undefined && status !== 'running'
}

export function runtimeMatchesWorkspace(runtime: RuntimeInfo, cwd: string, sessionFile: string): boolean {
  return runtime.cwd === cwd && runtime.sessionFile === sessionFile
}

export function findRuntimeForWorkspace(runtimes: RuntimeInfo[], cwd?: string, sessionFile?: string): RuntimeInfo | undefined {
  if (!cwd || !sessionFile) return undefined
  // Exact cwd agreement wins, but a live runtime owns its session file
  // outright: when the workspace's folder resolution drifts from the
  // runtime's authorized cwd (symlink, folder edit, view switch), the file
  // alone must still reattach the streaming turn — otherwise the next send
  // forked the session into a duplicate.
  return runtimes.find((runtime) => runtimeMatchesWorkspace(runtime, cwd, sessionFile))
    ?? runtimes.find((runtime) => runtime.sessionFile !== undefined && runtime.sessionFile === sessionFile)
}

export function selectStartupWorkspace(
  projects: ProjectRecord[],
  sessions: SessionRecord[],
  runtimes: RuntimeInfo[],
): WorkspaceSelection {
  const session = sessions.find((candidate) => !candidate.archived && Boolean(findProjectForSession(projects, candidate)))
  const project = findProjectForSession(projects, session) ?? projects[0]
  const cwd = workspaceCwd(project, session)
  const runtime = findRuntimeForWorkspace(runtimes, cwd, session?.filePath)
  return { project, session, runtime, cwd }
}

export function createSingleFlightAdmission(): SingleFlightAdmission {
  let active = false
  const idleWaiters: Array<() => void> = []
  const settleIdleWaiters = () => {
    if (active) return
    const pending = idleWaiters.splice(0)
    for (const resolve of pending) resolve()
  }
  return {
    get active() { return active },
    async waitForIdle() {
      if (!active) return
      await new Promise<void>((resolve) => { idleWaiters.push(resolve) })
    },
    async run(task) {
      if (active) return false
      active = true
      try {
        await task()
        return true
      } finally {
        active = false
        settleIdleWaiters()
      }
    },
  }
}
