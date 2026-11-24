import { lstat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { GitDiff, GitFileChange, GitStatus, GitWorktree, LocalGitBranch, ProcessOutcome } from '../../src/types/api'
import { restrictedGitEnvironment, runProcess, type ProcessResult } from './process-utils'
import { errorMessage, requireGitPath, requireString, stripAnsi } from './validation'
import { gitWorktreeContentHash } from './git-content-hash'

interface Numstat { additions: number; deletions: number }
interface ParsedNumstat { values: Map<string, Numstat>; truncated: boolean }

export const GIT_STATUS_ENTRY_LIMIT = 1_000
export const GIT_DIFF_LINE_LIMIT = 5_000
const GIT_STATUS_OUTPUT_LIMIT = 4 * 1024 * 1024
const GIT_CONFIG_OUTPUT_LIMIT = 512 * 1024
const GIT_DIFF_OUTPUT_LIMIT = 2 * 1024 * 1024
const GIT_ERROR_LIMIT = 2_000
const GIT_IDENTITY_VALUE_LIMIT = 320
const GIT_WORKTREE_OUTPUT_LIMIT = 1024 * 1024
const GIT_WORKTREE_LIMIT = 1_000
const GIT_BRANCH_OUTPUT_LIMIT = 1024 * 1024
const GIT_BRANCH_LIMIT = 1_000
const EMPTY_CONFIG_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null'
const BASE_GIT_CONFIG = [
  'core.fsmonitor=false',
  `core.hooksPath=${EMPTY_CONFIG_PATH}`,
  'diff.external=',
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'status.submoduleSummary=false',
  'submodule.recurse=false',
] as const

function hardenedGitArgs(args: readonly string[], extraConfig: readonly string[] = []): string[] {
  const result = ['--no-pager']
  for (const config of [...BASE_GIT_CONFIG, ...extraConfig]) result.push('-c', config)
  return [...result, ...args]
}

function runGit(cwd: string, args: readonly string[], options: { timeoutMs: number; maxBytes: number; input?: string }, extraConfig: readonly string[] = []): Promise<ProcessResult> {
  return runProcess('git', hardenedGitArgs(args, extraConfig), { cwd, ...options, env: restrictedGitEnvironment() })
}

function resultDetail(result: ProcessResult): string {
  return stripAnsi(result.stderr || result.stdout).trim().slice(0, GIT_ERROR_LIMIT)
}

function processError(operation: string, result: ProcessResult): Error {
  if (result.outputExceeded) return new Error(`${operation} output exceeded the safety limit; the result is incomplete`)
  if (result.timedOut) return new Error(`${operation} timed out; the result is unknown`)
  const detail = resultDetail(result)
  const suffix = result.signal ? ` (signal ${result.signal})` : ` (exit ${result.code})`
  return new Error(detail ? `${operation} failed: ${detail}` : `${operation} failed${suffix}`)
}

function requireProcessSuccess(operation: string, result: ProcessResult): void {
  if (result.code !== 0 || result.timedOut || result.outputExceeded) throw processError(operation, result)
}

export function isNotARepositoryFailure(error: unknown): boolean {
  return /not a git repository/i.test(errorMessage(error))
}

function nextNulField(output: string, cursor: number): { value: string; cursor: number } {
  const end = output.indexOf('\0', cursor)
  if (end < 0) return { value: output.slice(cursor), cursor: output.length }
  return { value: output.slice(cursor, end), cursor: end + 1 }
}

function parseNumstat(output: string, maxEntries = GIT_STATUS_ENTRY_LIMIT): ParsedNumstat {
  const values = new Map<string, Numstat>()
  let cursor = 0
  let truncated = false
  while (cursor < output.length) {
    const header = nextNulField(output, cursor)
    cursor = header.cursor
    if (!header.value) continue
    const firstTab = header.value.indexOf('\t')
    const secondTab = header.value.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const additions = Number.parseInt(header.value.slice(0, firstTab), 10)
    const deletions = Number.parseInt(header.value.slice(firstTab + 1, secondTab), 10)
    let path = header.value.slice(secondTab + 1)
    if (!path) {
      // With -z, renames are: numstat header, old path, new path.
      const oldPath = nextNulField(output, cursor)
      const newPath = nextNulField(output, oldPath.cursor)
      cursor = newPath.cursor
      path = newPath.value || oldPath.value
    }
    if (!path) continue
    if (values.size >= maxEntries) { truncated = true; break }
    values.set(path, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    })
  }
  return { values, truncated }
}

/** Which diff families the status codes prove non-empty. `git diff --numstat`
 * never reports untracked (`??`) files, so only a tracked worktree code needs
 * the unstaged diff; only an index code needs either `--cached` read. */
function statusChangeFlags(output: string): { hasIndexChanges: boolean; hasTrackedWorktreeChanges: boolean } {
  const flags = { hasIndexChanges: false, hasTrackedWorktreeChanges: false }
  let cursor = 0
  while (cursor < output.length) {
    const field = nextNulField(output, cursor)
    cursor = field.cursor
    const record = field.value
    if (!record || record.startsWith('## ') || record.length < 4) continue
    const code = record.slice(0, 2)
    if (code[0] !== ' ' && code[0] !== '?') flags.hasIndexChanges = true
    if (code !== '??' && code[1] !== ' ' && code[1] !== '!') flags.hasTrackedWorktreeChanges = true
    if (code.includes('R') || code.includes('C')) cursor = nextNulField(output, cursor).cursor
    if (flags.hasIndexChanges && flags.hasTrackedWorktreeChanges) break
  }
  return flags
}

const EMPTY_NUMSTAT: ParsedNumstat = { values: new Map(), truncated: false }

async function settledNumstat(operation: string, result: ProcessResult | undefined): Promise<ParsedNumstat> {
  if (!result) return EMPTY_NUMSTAT
  requireProcessSuccess(operation, result)
  return parseNumstat(result.stdout)
}

function parseBranch(header: string, status: GitStatus): void {
  let value = header.slice(3)
  if (value.startsWith('No commits yet on ')) value = value.slice('No commits yet on '.length)
  if (value.startsWith('Initial commit on ')) value = value.slice('Initial commit on '.length)
  const detailIndex = value.indexOf(' [')
  const details = detailIndex >= 0 ? value.slice(detailIndex + 2, -1) : ''
  const name = detailIndex >= 0 ? value.slice(0, detailIndex) : value
  const upstreamIndex = name.indexOf('...')
  status.branch = upstreamIndex >= 0 ? name.slice(0, upstreamIndex) : name
  if (upstreamIndex >= 0) status.upstream = name.slice(upstreamIndex + 3)
  const ahead = details.match(/ahead (\d+)/)
  const behind = details.match(/behind (\d+)/)
  if (ahead) status.ahead = Number(ahead[1])
  if (behind) status.behind = Number(behind[1])
}

function addStatusChange(status: GitStatus, path: string, code: string, staged: boolean, stats: Map<string, Numstat>): boolean {
  if (status.files.length >= GIT_STATUS_ENTRY_LIMIT) { status.truncated = true; return false }
  const values = stats.get(path) ?? { additions: 0, deletions: 0 }
  const change: GitFileChange = { path, status: code.trim() || code, staged, ...values }
  status.files.push(change)
  return true
}

function parseStatus(output: string, staged: ParsedNumstat, unstaged: ParsedNumstat): GitStatus {
  const status: GitStatus = { isRepo: true, files: [] }
  if (staged.truncated || unstaged.truncated) status.truncated = true
  let cursor = 0
  while (cursor < output.length) {
    const field = nextNulField(output, cursor)
    cursor = field.cursor
    const record = field.value
    if (!record) continue
    if (record.startsWith('## ')) { parseBranch(record, status); continue }
    if (record.length < 4) continue
    const code = record.slice(0, 2)
    const path = record.slice(3)
    if (!path) continue
    const renamed = code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C'
    if (renamed) cursor = nextNulField(output, cursor).cursor

    const hasIndexChange = code[0] !== ' ' && code[0] !== '?'
    const hasWorktreeChange = code[1] !== ' ' && code[1] !== '!'
    if (hasIndexChange && !addStatusChange(status, path, code, true, staged.values)) break
    if (hasWorktreeChange && !addStatusChange(status, path, code, false, unstaged.values)) break
  }
  return status
}

function capDiffLines(text: string): { text: string; truncated: boolean } {
  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue
    lines += 1
    if (lines > GIT_DIFF_LINE_LIMIT) {
      return {
        text: `${text.slice(0, index)}
[OMP Desktop: diff truncated at ${GIT_DIFF_LINE_LIMIT.toLocaleString('en-US')} lines.]`,
        truncated: true,
      }
    }
  }
  return { text, truncated: false }
}

function filterDriverFromKey(key: string): string | undefined {
  const match = key.match(/^filter\.(.+)\.(?:clean|smudge|process|required)$/i)
  return match?.[1]
}

// Repository metadata caches. A status poll otherwise respawns
// `git config --list` and `git rev-parse --show-toplevel` on every refresh.
// Values are keyed by the repository's `.git/config` and `.git/HEAD` identity
// plus a short TTL, so an edit or checkout is visible within one poll and
// anything the stamps cannot observe (an included config file, a global-scope
// setting) is bounded by the TTL. Errors are never cached.
const REPOSITORY_CACHE_TTL_MS = 5_000
const REPOSITORY_CACHE_LIMIT = 256
const GITDIR_POINTER_LIMIT = 4_096

interface StampedCacheEntry<T> {
  stamp: string
  value: T
  expiresAt: number
}

const repositoryConfigCache = new Map<string, StampedCacheEntry<ReadonlyMap<string, string>>>()
const repositoryBranchCache = new Map<string, StampedCacheEntry<string | undefined>>()
const repositoryRootCache = new Map<string, { value: string; expiresAt: number }>()

async function fileStamp(path: string): Promise<string> {
  try {
    const entry = await lstat(path)
    return `${entry.mtimeMs}:${entry.size}`
  } catch {
    return 'missing'
  }
}

/** The git directory of a worktree, following a linked worktree's `gitdir:` pointer. */
async function gitDirectoryOf(repositoryRoot: string): Promise<string | undefined> {
  const dotGit = join(repositoryRoot, '.git')
  const entry = await lstat(dotGit).catch(() => undefined)
  if (!entry) return undefined
  if (entry.isDirectory()) return dotGit
  if (!entry.isFile()) return undefined
  const pointer = await readFile(dotGit, 'utf8').catch(() => undefined)
  const match = pointer ? /^gitdir:[ \t]*(.+)$/m.exec(pointer.slice(0, GITDIR_POINTER_LIMIT)) : null
  if (!match) return undefined
  return resolve(repositoryRoot, match[1].trim())
}

/** Linked worktrees keep shared configuration in the common git directory. */
async function commonGitDirectoryOf(gitDirectory: string): Promise<string> {
  const pointer = await readFile(join(gitDirectory, 'commondir'), 'utf8').catch(() => undefined)
  const target = pointer?.trim().slice(0, GITDIR_POINTER_LIMIT)
  return target ? resolve(gitDirectory, target) : gitDirectory
}

/**
 * Identity of the files that decide configuration and branch: `.git/config`,
 * `.git/HEAD`, and a linked worktree's `config.worktree`. An unreadable git
 * directory reports `unknown`, which disables caching instead of guessing.
 */
async function repositoryFileStamp(repositoryRoot: string): Promise<string> {
  const gitDirectory = await gitDirectoryOf(repositoryRoot)
  if (!gitDirectory) return 'unknown'
  const commonDirectory = await commonGitDirectoryOf(gitDirectory)
  const [head, config, worktreeConfig] = await Promise.all([
    fileStamp(join(gitDirectory, 'HEAD')),
    fileStamp(join(commonDirectory, 'config')),
    commonDirectory === gitDirectory ? Promise.resolve('none') : fileStamp(join(gitDirectory, 'config.worktree')),
  ])
  return `${head}|${config}|${worktreeConfig}`
}

function pruneStampedCache<T>(cache: Map<string, StampedCacheEntry<T>>, now: number): void {
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key)
  while (cache.size > REPOSITORY_CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done) return
    cache.delete(oldest.value)
  }
}

/**
 * Generation counter for repository mutations. A status read is shared only
 * with callers of the same generation, so a read that started before a
 * stage/unstage/restore/commit/branch switch can never serve a caller that
 * began afterwards.
 */
let gitMutationEpoch = 0
const inFlightGitStatus = new Map<string, Promise<GitStatus>>()

/**
 * Drops cached repository metadata. Mutations call this so the next read
 * observes the new index or HEAD instead of waiting out the TTL; a branch
 * switch outside the service is caught by the HEAD stamp. Calling it without
 * a root clears every repository.
 */
export function invalidateGitRepositoryCaches(repositoryRoot?: string): void {
  gitMutationEpoch += 1
  if (repositoryRoot === undefined) {
    repositoryConfigCache.clear()
    repositoryBranchCache.clear()
    repositoryRootCache.clear()
    return
  }
  repositoryConfigCache.delete(repositoryRoot)
  repositoryBranchCache.delete(repositoryRoot)
  for (const [key, entry] of repositoryRootCache) {
    if (key === repositoryRoot || entry.value === repositoryRoot) repositoryRootCache.delete(key)
  }
}

/** `rev-parse --show-toplevel` for an already-authorized directory. */
async function resolveRepositoryRoot(cwd: string): Promise<string> {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'], { timeoutMs: 5_000, maxBytes: 64 * 1024 })
  requireProcessSuccess('Git repository root inspection', result)
  const repositoryRoot = result.stdout.trim()
  if (!repositoryRoot) throw new Error('Git repository root inspection returned no path')
  return repositoryRoot
}

/** The toplevel of a directory does not move while its repository does, so a short TTL is enough. */
async function cachedRepositoryRoot(cwd: string): Promise<string> {
  const now = Date.now()
  const cached = repositoryRootCache.get(cwd)
  if (cached && cached.expiresAt > now) return cached.value
  const value = await resolveRepositoryRoot(cwd)
  repositoryRootCache.set(cwd, { value, expiresAt: now + REPOSITORY_CACHE_TTL_MS })
  while (repositoryRootCache.size > REPOSITORY_CACHE_LIMIT) {
    const oldest = repositoryRootCache.keys().next()
    if (oldest.done) break
    repositoryRootCache.delete(oldest.value)
  }
  return value
}

/** Current branch label; a detached HEAD reports its short commit instead. */
async function readBranch(cwd: string): Promise<string | undefined> {
  const result = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 5_000, maxBytes: 64 * 1024 })
  if (result.code === 0 && !result.timedOut && !result.outputExceeded) return result.stdout.trim() || undefined
  const detached = await runGit(cwd, ['rev-parse', '--verify', '--short', 'HEAD'], { timeoutMs: 5_000, maxBytes: 64 * 1024 })
  return detached.code === 0 && !detached.timedOut && !detached.outputExceeded ? `HEAD (${detached.stdout.trim()})` : undefined
}

/**
 * Reads the repository's effective configuration in one spawn. With
 * `restrictedGitEnvironment` the system and global scopes are disabled, so
 * this reflects the repository scope (plus its includes and the hardened
 * command-line overrides). Later values win, matching Git precedence.
 * Polls reuse the parsed map until `.git/config` or `.git/HEAD` changes or
 * the TTL expires. Operations that can run clean/smudge filters pass
 * `fresh`, so the filter guard never decides from a cached configuration.
 */
async function repositoryConfig(cwd: string, options?: { fresh?: boolean }): Promise<ReadonlyMap<string, string>> {
  const stamp = await repositoryFileStamp(cwd)
  const now = Date.now()
  if (!options?.fresh && stamp !== 'unknown') {
    const cached = repositoryConfigCache.get(cwd)
    if (cached && cached.stamp === stamp && cached.expiresAt > now) return cached.value
  }
  const result = await runGit(cwd, ['config', '--includes', '--null', '--list'], {
    timeoutMs: 5_000,
    maxBytes: GIT_CONFIG_OUTPUT_LIMIT,
  })
  requireProcessSuccess('Git configuration inspection', result)
  const config = new Map<string, string>()
  let cursor = 0
  while (cursor < result.stdout.length) {
    const field = nextNulField(result.stdout, cursor)
    cursor = field.cursor
    if (!field.value) continue
    const separator = field.value.indexOf('\n')
    const key = separator < 0 ? field.value : field.value.slice(0, separator)
    const value = separator < 0 ? '' : field.value.slice(separator + 1)
    config.set(key, value)
  }
  if (stamp !== 'unknown') {
    repositoryConfigCache.set(cwd, { stamp, value: config, expiresAt: now + REPOSITORY_CACHE_TTL_MS })
    pruneStampedCache(repositoryConfigCache, now)
  }
  return config
}

function filterOverridesFromConfig(config: ReadonlyMap<string, string>): string[] {
  const drivers = new Set<string>()
  for (const key of config.keys()) {
    const driver = filterDriverFromKey(key)
    if (!driver) continue
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(driver)) throw new Error('Git filter configuration contains an unsafe driver name')
    drivers.add(driver)
    if (drivers.size > 128) throw new Error('Git filter configuration exceeds the safety limit')
  }
  const overrides: string[] = []
  for (const driver of drivers) {
    overrides.push(
      `filter.${driver}.clean=`,
      `filter.${driver}.smudge=`,
      `filter.${driver}.process=`,
      `filter.${driver}.required=false`,
    )
  }
  return overrides
}

function validIdentityValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > GIT_IDENTITY_VALUE_LIMIT || /[\0\r\n]/.test(trimmed)) return undefined
  return trimmed
}

async function readGlobalConfigValue(cwd: string, key: 'user.name' | 'user.email' | 'core.excludesFile'): Promise<string | undefined> {
  const env = restrictedGitEnvironment()
  delete env.GIT_CONFIG_GLOBAL
  for (const name of process.platform === 'win32' ? ['USERPROFILE', 'HOME', 'XDG_CONFIG_HOME'] : ['HOME', 'XDG_CONFIG_HOME']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  const result = await runProcess('git', hardenedGitArgs(['config', '--global', '--no-includes', '--get', key]), {
    cwd,
    timeoutMs: 5_000,
    maxBytes: GIT_CONFIG_OUTPUT_LIMIT,
    env,
  })
  if (result.code === 1 && !result.timedOut && !result.outputExceeded) return undefined
  requireProcessSuccess('Git global configuration inspection', result)
  return result.stdout.trim() || undefined
}

function validExcludesFilePath(value: string): string | undefined {
  let candidate = value.trim()
  if (!candidate || candidate.length > 4096 || /[\0\r\n]/.test(candidate)) return undefined
  if (candidate === '~' || candidate.startsWith('~/')) {
    candidate = join(homedir(), candidate.slice(1))
  } else if (process.platform === 'win32' && /^%USERPROFILE%($|[/\\])/i.test(candidate)) {
    const profile = process.env.USERPROFILE
    if (!profile) return undefined
    candidate = join(profile, candidate.slice('%USERPROFILE%'.length))
  }
  return isAbsolute(candidate) ? candidate : undefined
}

// The value is global scope, so the cache key is the environment the read
// resolves against; the TTL bounds staleness for status polling without a
// respawn of `git config` per call.
const GLOBAL_EXCLUDES_CACHE_TTL_MS = 30_000
let globalExcludesCache: { key: string; value: string | undefined; expiresAt: number } | undefined

async function readGlobalExcludesFile(cwd: string): Promise<string | undefined> {
  const key = `${process.env.HOME ?? ''}|${process.env.XDG_CONFIG_HOME ?? ''}|${process.env.USERPROFILE ?? ''}`
  const now = Date.now()
  if (globalExcludesCache && globalExcludesCache.key === key && globalExcludesCache.expiresAt > now) {
    return globalExcludesCache.value
  }
  let value: string | undefined
  try {
    const raw = await readGlobalConfigValue(cwd, 'core.excludesFile')
    if (raw !== undefined) value = validExcludesFilePath(raw)
  } catch {
    value = undefined
  }
  globalExcludesCache = { key, value, expiresAt: now + GLOBAL_EXCLUDES_CACHE_TTL_MS }
  return value
}

/**
 * `restrictedGitEnvironment` disables the global config scope, so a user's
 * `core.excludesFile` never reaches Git on its own. Read that one key safely
 * and supply it via `-c` so status, diff, and restore match plain `git status`.
 * A repository-scope setting must still win: `-c` would otherwise override it.
 */
async function globalExcludesOverride(cwd: string, config: ReadonlyMap<string, string>): Promise<string[]> {
  for (const key of config.keys()) {
    if (key.toLowerCase() === 'core.excludesfile') return []
  }
  const path = await readGlobalExcludesFile(cwd)
  return path ? [`core.excludesFile=${path}`] : []
}

/**
 * Derives commit identity from the already-fetched repository configuration;
 * only a missing repository-scope value costs an extra (global-scope) spawn.
 */
async function commitIdentityOverrides(cwd: string, config: ReadonlyMap<string, string>): Promise<string[]> {
  const localName = validIdentityValue(config.get('user.name') ?? '')
  const localEmail = validIdentityValue(config.get('user.email') ?? '')
  const [globalName, globalEmail] = await Promise.all([
    localName ? Promise.resolve(undefined) : readGlobalConfigValue(cwd, 'user.name').then((value) => (value === undefined ? undefined : validIdentityValue(value))),
    localEmail ? Promise.resolve(undefined) : readGlobalConfigValue(cwd, 'user.email').then((value) => (value === undefined ? undefined : validIdentityValue(value))),
  ])
  const name = localName ?? globalName
  const email = localEmail ?? globalEmail
  return [
    ...(name ? [`user.name=${name}`] : []),
    ...(email ? [`user.email=${email}`] : []),
  ]
}

interface ChangedPathState {
  untracked: boolean
  restorePaths: string[]
}

function changedPathStatesFromStatus(output: string): Map<string, ChangedPathState> {
  const states = new Map<string, ChangedPathState>()
  let cursor = 0
  while (cursor < output.length) {
    const field = nextNulField(output, cursor)
    cursor = field.cursor
    const record = field.value
    if (!record || record.startsWith('## ') || record.length < 4) continue
    const code = record.slice(0, 2)
    const pathValue = record.slice(3)
    if (!pathValue) continue
    const path = requireGitPath(pathValue, 'Git status path')
    const restorePaths = [path]
    if (code.includes('R') || code.includes('C')) {
      const previous = nextNulField(output, cursor)
      cursor = previous.cursor
      if (previous.value) restorePaths.push(requireGitPath(previous.value, 'Git status path'))
    }
    states.set(path, { untracked: code === '??', restorePaths })
  }
  return states
}


async function rejectFilteredPaths(cwd: string, paths: readonly string[], overrides: readonly string[]): Promise<void> {
  if (!paths.length) return
  // Feed the paths to one bounded process. Status output and direct mutation inputs
  // are capped, so this inspects every path without an attacker causing an
  // unbounded sequence of check-attr subprocesses.
  const result = await runGit(cwd, ['check-attr', '-z', '--stdin', 'filter'], {
    timeoutMs: 10_000,
    maxBytes: GIT_CONFIG_OUTPUT_LIMIT,
    input: `${paths.join('\0')}\0`,
  }, overrides)
  requireProcessSuccess('Git filter attribute inspection', result)
  const affected: string[] = []
  let cursor = 0
  while (cursor < result.stdout.length) {
    const path = nextNulField(result.stdout, cursor)
    const attribute = nextNulField(result.stdout, path.cursor)
    const value = nextNulField(result.stdout, attribute.cursor)
    cursor = value.cursor
    if (attribute.value !== 'filter' || value.value === 'unspecified' || value.value === 'unset' || !path.value) continue
    affected.push(path.value)
    if (affected.length >= 5) break
  }
  if (!affected.length) return
  const suffix = affected.length === 1 ? affected[0] : `${affected.join(', ')}${paths.length > affected.length ? ', …' : ''}`
  throw new Error(`Git operation blocked because clean/smudge filters cannot run safely for: ${suffix}. Use a trusted Git client with the required filter (for example Git LFS).`)
}

interface RepositoryContext {
  /** Canonical, authorized repository toplevel; every follow-up command runs here. */
  cwd: string
  /** Filter-neutralizing config overrides derived from the repository configuration. */
  overrides: string[]
  /** Effective repository configuration, read once per operation and reused across polls. */
  config: ReadonlyMap<string, string>
}

function parseWorktreeList(output: string, repositoryRoot: string): GitWorktree[] {
  const records = output.split('\0\0').filter(Boolean)
  if (records.length > GIT_WORKTREE_LIMIT) throw new Error('Git worktree list exceeded the safety limit')
  return records.map((record, index) => {
    const fields = record.split('\0').filter(Boolean)
    const pathField = fields.find((field) => field.startsWith('worktree '))
    const headField = fields.find((field) => field.startsWith('HEAD '))
    const branchField = fields.find((field) => field.startsWith('branch '))
    const pathValue = pathField?.slice('worktree '.length)
    const head = headField?.slice('HEAD '.length)
    if (!pathValue || pathValue.length > 4096 || !head || !/^[0-9a-fA-F]{4,64}$/.test(head)) {
      throw new Error(`Git worktree list returned an invalid record at index ${index}`)
    }
    const path = resolve(pathValue)
    const branchRef = branchField?.slice('branch '.length)
    if (branchRef && (branchRef.length > 1024 || !branchRef.startsWith('refs/heads/'))) {
      throw new Error(`Git worktree list returned an invalid branch at index ${index}`)
    }
    const branch = branchRef?.slice('refs/heads/'.length)
    return {
      path,
      name: basename(path) || path,
      branch,
      head: head.toLowerCase(),
      current: path === resolve(repositoryRoot),
      detached: fields.includes('detached') || branch === undefined,
    }
  })
}

async function inspectRepositoryRoot(cwd: string): Promise<string> {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'], { timeoutMs: 5_000, maxBytes: 64 * 1024 })
  requireProcessSuccess('Git repository root inspection', result)
  const repositoryRoot = result.stdout.trim()
  if (!repositoryRoot || repositoryRoot.length > 4096) throw new Error('Git repository root inspection returned no valid path')
  return resolve(repositoryRoot)
}

export function resolveGitRepositoryRoot(cwd: string): Promise<string> {
  return inspectRepositoryRoot(cwd)
}

/** Caller must authorize cwd before invoking this privileged fixed-argv helper. */
export async function listGitWorktrees(cwd: string): Promise<GitWorktree[]> {
  const repositoryRoot = await inspectRepositoryRoot(cwd)
  const result = await runGit(repositoryRoot, ['worktree', 'list', '--porcelain', '-z'], { timeoutMs: 10_000, maxBytes: GIT_WORKTREE_OUTPUT_LIMIT })
  requireProcessSuccess('Git worktree list', result)
  return parseWorktreeList(result.stdout, repositoryRoot)
}

/** Caller must authorize cwd before invoking this privileged fixed-argv helper. */
export async function validateGitBranch(cwd: string, branchValue: unknown): Promise<string> {
  const repositoryRoot = await inspectRepositoryRoot(cwd)
  const branch = requireString(branchValue, 'branch', { min: 1, max: 255, trim: true })
  const check = await runGit(repositoryRoot, ['check-ref-format', '--branch', branch], { timeoutMs: 5_000, maxBytes: 64 * 1024 })
  requireProcessSuccess('Git branch validation', check)
  return branch
}

/** Caller must authorize cwd and obtain targetPath through a trusted native picker. */
export async function createGitWorktree(cwd: string, targetPath: string, branchValue: unknown): Promise<void> {
  const repositoryRoot = await inspectRepositoryRoot(cwd)
  const branch = await validateGitBranch(repositoryRoot, branchValue)
  const result = await runGit(repositoryRoot, ['worktree', 'add', '-b', branch, '--', resolve(targetPath)], { timeoutMs: 2 * 60_000, maxBytes: GIT_WORKTREE_OUTPUT_LIMIT })
  requireProcessSuccess('Git worktree creation', result)
}

export async function listLocalGitBranches(cwd: string): Promise<LocalGitBranch[]> {
  const repositoryRoot = await inspectRepositoryRoot(cwd)
  const result = await runGit(repositoryRoot, ['for-each-ref', '--format=%(refname:short)%00%(HEAD)%00', '--sort=refname', 'refs/heads'], {
    timeoutMs: 10_000,
    maxBytes: GIT_BRANCH_OUTPUT_LIMIT,
  })
  requireProcessSuccess('Git local branch list', result)
  const fields = result.stdout.split('\0')
  const branches: LocalGitBranch[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const name = fields[index].replace(/^\n+|\n+$/g, '')
    if (!name) continue
    if (name.length > 255 || /[\0\r\n]/.test(name)) throw new Error('Git local branch list returned an invalid branch')
    branches.push({ name, current: fields[index + 1].trim() === '*' })
    if (branches.length > GIT_BRANCH_LIMIT) throw new Error('Git local branch list exceeded the safety limit')
  }
  return branches
}

export type GitWorktreeCleanliness =
  | { kind: 'clean' }
  | { kind: 'dirty'; changedPaths: string[]; truncated: boolean }

export type GitBranchChangeResult =
  | { kind: 'applied' }
  | { kind: 'unchanged' }
  | { kind: 'not-found' }
  | { kind: 'already-exists' }
  | Extract<GitWorktreeCleanliness, { kind: 'dirty' }>

async function inspectGitWorktreeCleanAtRoot(repositoryRoot: string, overrides: readonly string[]): Promise<GitWorktreeCleanliness> {
  const result = await runGit(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], {
    timeoutMs: 10_000,
    maxBytes: GIT_STATUS_OUTPUT_LIMIT,
  }, overrides)
  requireProcessSuccess('Git worktree inspection', result)
  if (!result.stdout) return { kind: 'clean' }
  const changedPaths: string[] = []
  let cursor = 0
  while (cursor < result.stdout.length && changedPaths.length < 20) {
    const record = nextNulField(result.stdout, cursor)
    cursor = record.cursor
    if (record.value.length < 4) continue
    changedPaths.push(record.value.slice(3))
    if (record.value[0] === 'R' || record.value[0] === 'C' || record.value[1] === 'R' || record.value[1] === 'C') {
      cursor = nextNulField(result.stdout, cursor).cursor
    }
  }
  return { kind: 'dirty', changedPaths, truncated: cursor < result.stdout.length }
}

export async function inspectGitWorktreeClean(cwd: string): Promise<GitWorktreeCleanliness> {
  const repositoryRoot = await inspectRepositoryRoot(cwd)
  return inspectGitWorktreeCleanAtRoot(repositoryRoot, filterOverridesFromConfig(await repositoryConfig(repositoryRoot)))
}

async function changeGitBranch(cwd: string, branchValue: unknown, create: boolean): Promise<GitBranchChangeResult> {
  const repositoryRoot = await inspectRepositoryRoot(cwd)
  const branch = await validateGitBranch(repositoryRoot, branchValue)
  const branches = await listLocalGitBranches(repositoryRoot)
  const existing = branches.find((candidate) => candidate.name === branch)
  if (!create && !existing) return { kind: 'not-found' }
  if (create && existing) return { kind: 'already-exists' }
  const overrides = filterOverridesFromConfig(await repositoryConfig(repositoryRoot, { fresh: true }))
  const cleanliness = await inspectGitWorktreeCleanAtRoot(repositoryRoot, overrides)
  if (cleanliness.kind === 'dirty') return cleanliness
  if (existing?.current) return { kind: 'unchanged' }
  if (overrides.length) throw new Error('Git branch checkout is blocked because this repository configures clean/smudge filters. Use a trusted Git client with the required filter support.')
  const result = await runGit(repositoryRoot, create ? ['switch', '--create', branch] : ['switch', '--no-guess', branch], {
    timeoutMs: 2 * 60_000,
    maxBytes: GIT_BRANCH_OUTPUT_LIMIT,
  }, overrides)
  requireProcessSuccess(create ? 'Git branch creation' : 'Git branch switch', result)
  // HEAD moved: retire every status read that began before the switch.
  gitMutationEpoch += 1
  return { kind: 'applied' }
}

export function switchGitBranch(cwd: string, branchValue: unknown): Promise<GitBranchChangeResult> {
  return changeGitBranch(cwd, branchValue, false)
}

export function createAndSwitchGitBranch(cwd: string, branchValue: unknown): Promise<GitBranchChangeResult> {
  return changeGitBranch(cwd, branchValue, true)
}

export class GitService {
  constructor(
    private readonly authorizeCwd: (cwd: string) => Promise<string>,
    private readonly authorizeReadOnlyCwd: (cwd: string) => Promise<string> = authorizeCwd,
  ) {}

  /**
   * Entry guard for every repository operation: authorizes and canonicalizes
   * the toplevel, fetches the repository configuration once, derives the
   * filter-neutralizing overrides, and — when the operation names its input
   * paths up front — rejects paths that require clean/smudge filters. The
   * whole call graph of one operation reuses this context instead of
   * re-resolving the toplevel or re-reading the configuration.
   */
  private async withRepositoryGuards(
    cwdValue: unknown,
    paths?: readonly string[],
    options?: { readOnly?: boolean },
  ): Promise<RepositoryContext> {
    const authorizer = options?.readOnly ? this.authorizeReadOnlyCwd : this.authorizeCwd
    const cwd = await this.repositoryCwd(requireString(cwdValue, 'cwd', { min: 1, max: 4096 }), authorizer)
    // Mutations read the configuration fresh: the filter guard must never
    // decide from a value cached before the repository changed.
    const config = await repositoryConfig(cwd, { fresh: !options?.readOnly })
    const overrides = filterOverridesFromConfig(config)
    overrides.push(...await globalExcludesOverride(cwd, config))
    if (paths?.length) await rejectFilteredPaths(cwd, paths, overrides)
    return { cwd, overrides, config }
  }

  async branch(cwd: string): Promise<string | undefined> {
    try {
      const safeCwd = await this.repositoryCwd(cwd, this.authorizeReadOnlyCwd)
      const stamp = await repositoryFileStamp(safeCwd)
      const now = Date.now()
      if (stamp !== 'unknown') {
        const cached = repositoryBranchCache.get(safeCwd)
        if (cached && cached.stamp === stamp && cached.expiresAt > now) return cached.value
      }
      const branch = await readBranch(safeCwd)
      if (stamp !== 'unknown') {
        repositoryBranchCache.set(safeCwd, { stamp, value: branch, expiresAt: now + REPOSITORY_CACHE_TTL_MS })
        pruneStampedCache(repositoryBranchCache, now)
      }
      return branch
    } catch { return undefined }
  }

  /**
   * Reads the worktree status. Authorization and canonicalization run on every
   * call, so an unauthorized caller can never ride a concurrent authorized
   * read; only the identical canonical root (and the same mutation generation)
   * shares one subprocess burst. Each caller receives its own clone so no
   * caller can observe another's in-place edits.
   */
  async status(cwdValue: unknown): Promise<GitStatus> {
    try {
      const { cwd, overrides } = await this.withRepositoryGuards(cwdValue, undefined, { readOnly: true })
      const key = `${gitMutationEpoch}\0${cwd}`
      let pending = inFlightGitStatus.get(key)
      if (!pending) {
        pending = this.collectStatus(cwd, overrides)
        inFlightGitStatus.set(key, pending)
        const settle = () => { if (inFlightGitStatus.get(key) === pending) inFlightGitStatus.delete(key) }
        pending.then(settle, settle)
      }
      return structuredClone(await pending)
    } catch (error) {
      const message = errorMessage(error).slice(0, GIT_ERROR_LIMIT)
      // Only a genuine "not a repository" detection may claim there is no repo.
      // Every other failure (authorization, filter guard, timeout, output limit)
      // reports a repo whose status could not be read.
      if (isNotARepositoryFailure(error)) return { isRepo: false, files: [], error: message || 'Not a Git repository' }
      return { isRepo: true, files: [], error: message || 'Git status failed' }
    }
  }

  private async collectStatus(cwd: string, overrides: readonly string[]): Promise<GitStatus> {
    const statusResult = await runGit(cwd, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--ignore-submodules=all', '-z'], { timeoutMs: 15_000, maxBytes: GIT_STATUS_OUTPUT_LIMIT }, overrides)
    requireProcessSuccess('Git status', statusResult)
    await rejectFilteredPaths(cwd, [...changedPathStatesFromStatus(statusResult.stdout).keys()], overrides)
    // `git diff --numstat` never counts untracked files and `--cached` only
    // counts index changes, so a clean or untracked-only worktree would pay for
    // subprocesses that can only return nothing. Read the status codes first and
    // skip exactly the diffs whose output is provably empty.
    const flags = statusChangeFlags(statusResult.stdout)
    const [unstagedResult, stagedResult] = await Promise.all([
      flags.hasTrackedWorktreeChanges
        ? runGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--numstat', '-z'], { timeoutMs: 15_000, maxBytes: GIT_STATUS_OUTPUT_LIMIT }, overrides)
        : undefined,
      flags.hasIndexChanges
        ? runGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--cached', '--numstat', '-z'], { timeoutMs: 15_000, maxBytes: GIT_STATUS_OUTPUT_LIMIT }, overrides)
        : undefined,
    ])
    const unstagedStats = await settledNumstat('Git unstaged statistics', unstagedResult)
    const stagedStats = await settledNumstat('Git staged statistics', stagedResult)
    const status = parseStatus(statusResult.stdout, stagedStats, unstagedStats)
    const indexHashes = new Map<string, string>()
    if (flags.hasIndexChanges) {
      const indexResult = await runGit(cwd, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'], { timeoutMs: 15_000, maxBytes: GIT_STATUS_OUTPUT_LIMIT }, overrides)
      requireProcessSuccess('Git index identities', indexResult)
      const fields = indexResult.stdout.split('\0')
      for (let index = 0; index + 1 < fields.length; index += 2) {
        const metadata = fields[index].split(' ')
        indexHashes.set(fields[index + 1], `${metadata[1]}:${metadata[3]}`)
      }
    }
    // Bound disk concurrency even for repositories with many dirty files.
    for (let offset = 0; offset < status.files.length; offset += 8) {
      await Promise.all(status.files.slice(offset, offset + 8).map(async (file) => {
        file.contentHash = file.staged ? indexHashes.get(file.path) : await gitWorktreeContentHash(join(cwd, file.path))
      }))
    }
    return status
  }

  async diff(cwdValue: unknown, pathValue?: unknown, stagedValue?: unknown): Promise<GitDiff> {
    const path = pathValue === undefined ? undefined : requireGitPath(pathValue)
    if (stagedValue !== undefined && typeof stagedValue !== 'boolean') throw new TypeError('staged must be a boolean')
    const staged = stagedValue === true
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all']
    if (staged) args.push('--cached')
    if (path) args.push('--', path)
    const { cwd, overrides } = await this.withRepositoryGuards(cwdValue, path ? [path] : undefined, { readOnly: true })
    if (!path) {
      const statusResult = await runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=all', '-z'], { timeoutMs: 15_000, maxBytes: GIT_STATUS_OUTPUT_LIMIT }, overrides)
      requireProcessSuccess('Git status', statusResult)
      await rejectFilteredPaths(cwd, [...changedPathStatesFromStatus(statusResult.stdout).keys()], overrides)
    }
    const result = await runGit(cwd, args, { timeoutMs: 30_000, maxBytes: GIT_DIFF_OUTPUT_LIMIT }, overrides)
    if (result.outputExceeded) {
      const error = `Diff output exceeded ${GIT_DIFF_OUTPUT_LIMIT / (1024 * 1024)} MiB and was not displayed.`
      return { path, staged, text: `[OMP Desktop: ${error}]`, truncated: true, error }
    }
    requireProcessSuccess('Git diff', result)
    const capped = capDiffLines(result.stdout)
    const error = capped.truncated ? `Diff exceeded ${GIT_DIFF_LINE_LIMIT.toLocaleString('en-US')} lines and was truncated.` : undefined
    return { path, staged, text: capped.text, truncated: capped.truncated, error }
  }

  async stage(cwd: unknown, paths: unknown): Promise<boolean> {
    return this.mutate(cwd, paths, ['add'])
  }

  async unstage(cwdValue: unknown, pathsValue: unknown): Promise<boolean> {
    const paths = this.validPaths(pathsValue)
    const { cwd, overrides } = await this.withRepositoryGuards(cwdValue)
    const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: 5_000, maxBytes: 64 * 1024 }, overrides)
    if (head.timedOut || head.outputExceeded || (head.code !== 0 && head.code !== 1)) requireProcessSuccess('Git HEAD inspection', head)
    const args = head.code === 0
      ? ['restore', '--staged', '--', ...paths]
      : ['rm', '--cached', '--ignore-unmatch', '-r', '-f', '--', ...paths]
    const result = await runGit(cwd, args, { timeoutMs: 30_000, maxBytes: 1024 * 1024 }, overrides)
    requireProcessSuccess('Git unstage', result)
    invalidateGitRepositoryCaches(cwd)
    return true
  }

  async restore(cwdValue: unknown, pathsValue: unknown): Promise<boolean> {
    const paths = this.validPaths(pathsValue)
    const { cwd, overrides } = await this.withRepositoryGuards(cwdValue, paths)
    const statusResult = await runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all', '-z'], { timeoutMs: 15_000, maxBytes: GIT_STATUS_OUTPUT_LIMIT }, overrides)
    requireProcessSuccess('Git status', statusResult)
    const states = changedPathStatesFromStatus(statusResult.stdout)
    const selectedStates = paths.map((path) => states.get(path))
    if (selectedStates.some((state) => !state)) throw new Error('Git restore refused because the selected path has no pending changes')
    const restorePaths = [...new Set(selectedStates.flatMap((state) => state!.restorePaths))]
    await rejectFilteredPaths(cwd, restorePaths, overrides)
    const untracked = restorePaths.filter((path) => states.get(path)?.untracked === true)
    const tracked = restorePaths.filter((path) => !untracked.includes(path))
    const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: 5_000, maxBytes: 64 * 1024 }, overrides)
    if (head.code !== 0 && head.code !== 1) requireProcessSuccess('Git HEAD inspection', head)
    if (head.code === 0) {
      if (tracked.length) {
        const result = await runGit(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked], { timeoutMs: 30_000, maxBytes: 1024 * 1024 }, overrides)
        requireProcessSuccess('Git restore', result)
      }
    } else if (tracked.length) {
      const result = await runGit(cwd, ['rm', '--cached', '--ignore-unmatch', '-r', '-f', '--', ...tracked], { timeoutMs: 30_000, maxBytes: 1024 * 1024 }, overrides)
      requireProcessSuccess('Git restore', result)
    }
    const pathsToClean = head.code === 0 ? untracked : restorePaths
    if (pathsToClean.length) {
      const result = await runGit(cwd, ['clean', '-f', '--', ...pathsToClean], { timeoutMs: 30_000, maxBytes: 1024 * 1024 }, overrides)
      requireProcessSuccess('Git clean', result)
    }
    invalidateGitRepositoryCaches(cwd)
    return true
  }

  async commit(cwdValue: unknown, messageValue: unknown): Promise<ProcessOutcome> {
    const message = requireString(messageValue, 'commit message', { min: 1, max: 20_000, trim: true })
    // No rejectFilteredPaths here on purpose: commit records already-staged
    // index content and never runs clean/smudge filters — the mutations that
    // feed the index (stage/restore/unstage) are the filter-guarded surface.
    const context = await this.withRepositoryGuards(cwdValue)
    const overrides = [...context.overrides, ...await commitIdentityOverrides(context.cwd, context.config)]
    const result = await runGit(context.cwd, ['commit', '--no-verify', '--no-gpg-sign', '--no-status', '-m', message], { timeoutMs: 2 * 60_000, maxBytes: 64 * 1024 }, overrides)
    if (result.outputExceeded) return { ok: false, reason: 'overflow', output: 'Git commit output exceeded the safety limit; the commit result is unknown. Refresh status before retrying.' }
    if (result.timedOut) return { ok: false, reason: 'timeout', output: 'Git commit timed out; the commit result is unknown. Refresh status before retrying.' }
    const output = stripAnsi(`${result.stdout}${result.stderr}`).trim()
    if (result.code !== 0) return { ok: false, reason: 'exit', output: output || processError('Git commit', result).message }
    invalidateGitRepositoryCaches(context.cwd)
    return { ok: true, output: output || 'Commit created.' }
  }

  private async repositoryCwd(
    value: string,
    authorizer: (cwd: string) => Promise<string> = this.authorizeCwd,
  ): Promise<string> {
    // Authorization runs on every call; only the `rev-parse` spawn is cached,
    // so a revoked project cannot ride a cached canonical path.
    const cwd = await authorizer(value)
    return authorizer(await cachedRepositoryRoot(cwd))
  }

  private validPaths(value: unknown): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 500) throw new TypeError('paths must be a non-empty array of at most 500 paths')
    return value.map((path, index) => requireGitPath(path, `paths[${index}]`))
  }

  private async mutate(cwdValue: unknown, pathsValue: unknown, command: string[]): Promise<boolean> {
    const paths = this.validPaths(pathsValue)
    const { cwd, overrides } = await this.withRepositoryGuards(cwdValue, paths)
    const result = await runGit(cwd, [...command, '--', ...paths], { timeoutMs: 30_000, maxBytes: 1024 * 1024 }, overrides)
    requireProcessSuccess(`Git ${command[0]}`, result)
    invalidateGitRepositoryCaches(cwd)
    return true
  }
}
