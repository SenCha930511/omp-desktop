import { spawn, type ChildProcess } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'
import type { WebContents } from 'electron'
import { IPC_CHANNELS } from '../../src/types/ipc'
import type { ProjectScriptExitEvent, ProjectScriptKind, ProjectScriptOutputEvent, ProjectScriptStartOptions } from '../../src/types/api'
import type { WorkspaceUseLease, WorkspaceUseOwner } from './repository-use-gate'
import { killProcessTree, processTree, safeChildEnvironment, waitForProcessExit } from './process-utils'
import { canonicalSessionPath } from './session-paths'
import { isPathWithin, requireString } from './validation'

/**
 * Combined stdout/stderr bytes forwarded to the renderer per run. A dev server
 * may log for hours, so the cap drops the stream instead of the process.
 */
export const PROJECT_SCRIPT_OUTPUT_LIMIT = 256 * 1024
export const PROJECT_SCRIPT_TRUNCATION_NOTICE = '\n[OMP Desktop stopped forwarding project script output]\n'
const MAX_CONCURRENT_PROJECT_SCRIPTS = 8

/**
 * Login shell for project scripts. GUI launches do not inherit the user's
 * shell environment, so the platform default is resolved here instead of a
 * persisted setting.
 */
export function defaultProjectShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec && isAbsolute(process.env.ComSpec) ? process.env.ComSpec : 'C:\\Windows\\System32\\cmd.exe'
  }
  return process.env.SHELL?.startsWith('/') ? process.env.SHELL : '/bin/zsh'
}

interface OwnedScriptRun {
  id: string
  projectId: string
  kind: ProjectScriptKind
  cwd: string
  sessionPath?: string
  child: ChildProcess
  owner: WebContents
  ownerId: number
  lease: WorkspaceUseLease
  forwardedBytes: number
  truncationSent: boolean
  cancelling: boolean
  exited: boolean
  exitCode?: number
  finalized: boolean
  exitTimer?: NodeJS.Timeout
}

/**
 * Shell invocation for one command. POSIX shells run it as a login shell so
 * GUI-launched apps see the user's PATH; PowerShell needs explicit exit-code
 * tracking because `-Command` otherwise reports the last statement's success.
 */
function shellArguments(shell: string, command: string): string[] {
  if (process.platform !== 'win32') return ['-lc', command]
  const name = basename(shell).toLowerCase()
  if (name === 'cmd.exe') return ['/D', '/S', '/C', command]
  if (name === 'powershell.exe' || name === 'pwsh.exe') {
    const trackedCommand = `${command}\n$gooeyPiSuccess = $?\n$gooeyPiExitCode = $LASTEXITCODE\nif (-not $gooeyPiSuccess) {\n  if ($null -ne $gooeyPiExitCode -and $gooeyPiExitCode -ne 0) { exit $gooeyPiExitCode }\n  exit 1\n}\nexit 0`
    return ['-NoLogo', '-Command', trackedCommand]
  }
  return [command]
}

function scriptEnvironment(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(safeChildEnvironment({ TERM: 'dumb' })).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  // npm injects its configured prefix into apps launched through `npm run`;
  // login-shell nvm refuses to initialize while that npm override is present.
  delete env.npm_config_prefix
  delete env.NPM_CONFIG_PREFIX
  return env
}

function runKey(projectId: string, kind: ProjectScriptKind): string {
  return `${projectId}\u0000${kind}`
}

/**
 * Headless replacement for the project setup/run scripts that used to open a
 * PTY drawer tab. It runs one shell command per (project, kind) in an
 * authorized project folder, holds a RepositoryUseGate lease for the whole
 * run, streams bounded output, and kills the process group on stop, session or
 * project deletion, grant revoke, owner teardown, and app quit.
 */
export class ProjectScriptRunner {
  private readonly runs = new Map<string, OwnedScriptRun>()
  private readonly activeByKey = new Map<string, string>()
  private readonly terminations = new Map<OwnedScriptRun, Promise<void>>()

  constructor(
    private readonly authorizeCwd: (cwd: string) => Promise<string>,
    private readonly configuredShell: () => string,
    private readonly authorizeSessionPath: (path: string) => Promise<string> = async (path) => canonicalSessionPath(path),
    private readonly beginWorkspaceUse: (cwd: string, owner: WorkspaceUseOwner) => Promise<WorkspaceUseLease> = async () => ({ release: () => undefined }),
  ) {}

  async start(owner: WebContents, options: ProjectScriptStartOptions): Promise<{ runId: string }> {
    const key = runKey(options.projectId, options.kind)
    if (this.activeByKey.has(key)) throw new Error(`The ${options.kind} script for this project is already running`)
    if (this.runs.has(options.runId)) throw new Error('Project script id is already in use')
    if (this.runs.size >= MAX_CONCURRENT_PROJECT_SCRIPTS) throw new Error(`OMP Desktop supports at most ${MAX_CONCURRENT_PROJECT_SCRIPTS} concurrent project scripts`)
    // Reserve the slot before the first await so two starts cannot interleave.
    this.activeByKey.set(key, options.runId)
    let lease: WorkspaceUseLease | undefined
    try {
      const cwd = await this.authorizeCwd(options.cwd)
      const sessionPath = options.sessionPath === undefined
        ? undefined
        : canonicalSessionPath(await this.authorizeSessionPath(options.sessionPath))
      if (owner.isDestroyed()) throw new Error('Project script owner was closed')
      lease = await this.beginWorkspaceUse(cwd, { kind: 'script', scriptId: options.runId })
      const shell = this.configuredShell()
      const child = spawn(shell, shellArguments(shell, options.command), {
        cwd,
        env: scriptEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Its own process group, so the kill ladder reaches dev servers the
        // shell spawned instead of only the shell itself.
        detached: process.platform !== 'win32',
      })
      const run: OwnedScriptRun = {
        id: options.runId,
        projectId: options.projectId,
        kind: options.kind,
        cwd,
        sessionPath,
        child,
        owner,
        ownerId: owner.id,
        lease,
        forwardedBytes: 0,
        truncationSent: false,
        cancelling: false,
        exited: false,
        finalized: false,
      }
      this.runs.set(run.id, run)
      child.stdout?.on('data', (chunk: Buffer) => this.forwardOutput(run, chunk))
      child.stderr?.on('data', (chunk: Buffer) => this.forwardOutput(run, chunk))
      child.on('error', (error) => {
        // Spawn failures never produce an exit status.
        this.forwardOutput(run, Buffer.from(`[OMP Desktop could not start this script: ${error.message}]\n`))
        this.finish(run, -1)
      })
      child.on('exit', (code, signal) => {
        run.exited = true
        run.exitCode = code ?? (signal ? -1 : 0)
        // A detached grandchild can hold the pipes open after the shell exits;
        // finalize anyway instead of waiting for a close that may never come.
        run.exitTimer = setTimeout(() => this.finish(run, run.exitCode ?? -1), 250)
      })
      child.on('close', () => {
        if (run.exitTimer) clearTimeout(run.exitTimer)
        run.exitTimer = undefined
        this.finish(run, run.exitCode ?? -1)
      })
      return { runId: run.id }
    } catch (error) {
      lease?.release()
      this.releaseSlot(options.projectId, options.kind, options.runId)
      throw error
    }
  }

  async stop(owner: WebContents, runIdValue: unknown): Promise<boolean> {
    const runId = requireString(runIdValue, 'runId', { min: 1, max: 128 })
    const run = this.runs.get(runId)
    if (!run || run.ownerId !== owner.id) return false
    await this.terminate(run, true)
    return true
  }

  async killOwner(ownerId: number): Promise<void> {
    await Promise.all([...this.runs.values()].filter((run) => run.ownerId === ownerId).map((run) => this.terminate(run, true)))
  }

  async killAll(): Promise<void> {
    const starting = [...this.runs.values()].map((run) => this.terminate(run, true))
    await Promise.all([...new Set([...this.terminations.values(), ...starting])])
  }

  async killForSession(sessionPathValue: unknown): Promise<void> {
    const sessionPath = canonicalSessionPath(requireString(sessionPathValue, 'sessionPath', { min: 1, max: 4096 }))
    await Promise.all([...this.runs.values()].filter((run) => run.sessionPath === sessionPath).map((run) => this.terminate(run, true)))
  }

  async killForProjectRoots(roots: string[]): Promise<void> {
    await Promise.all([...this.runs.values()].filter((run) => roots.some((root) => isPathWithin(root, run.cwd))).map((run) => this.terminate(run, true)))
  }

  private forwardOutput(run: OwnedScriptRun, chunk: Buffer): void {
    if (run.finalized || run.owner.isDestroyed()) return
    const remaining = PROJECT_SCRIPT_OUTPUT_LIMIT - run.forwardedBytes
    if (remaining > 0) {
      const retained = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      run.forwardedBytes += retained.length
      this.send(run, IPC_CHANNELS.projectScripts.onOutput, { runId: run.id, data: retained.toString('utf8') } satisfies ProjectScriptOutputEvent)
    }
    if ((remaining <= 0 || chunk.length > remaining) && !run.truncationSent) {
      run.truncationSent = true
      this.send(run, IPC_CHANNELS.projectScripts.onOutput, { runId: run.id, data: PROJECT_SCRIPT_TRUNCATION_NOTICE } satisfies ProjectScriptOutputEvent)
    }
  }

  private finish(run: OwnedScriptRun, exitCode: number): void {
    if (run.finalized) return
    run.finalized = true
    if (run.exitTimer) clearTimeout(run.exitTimer)
    run.exitTimer = undefined
    this.runs.delete(run.id)
    this.releaseSlot(run.projectId, run.kind, run.id)
    run.lease.release()
    this.send(run, IPC_CHANNELS.projectScripts.onExit, { runId: run.id, exitCode, cancelled: run.cancelling } satisfies ProjectScriptExitEvent)
  }

  private releaseSlot(projectId: string, kind: ProjectScriptKind, runId: string): void {
    const key = runKey(projectId, kind)
    if (this.activeByKey.get(key) === runId) this.activeByKey.delete(key)
  }

  private terminate(run: OwnedScriptRun, cancelled: boolean): Promise<void> {
    if (cancelled) run.cancelling = true
    // Free the single-flight slot now; the exit event still follows once the
    // process tree is actually gone.
    this.releaseSlot(run.projectId, run.kind, run.id)
    const active = this.terminations.get(run)
    if (active) return active
    const operation = this.terminateProcess(run)
    this.terminations.set(run, operation)
    void operation.finally(() => { if (this.terminations.get(run) === operation) this.terminations.delete(run) })
    return operation
  }

  private async terminateProcess(run: OwnedScriptRun): Promise<void> {
    if (run.finalized) return
    const pid = run.child.pid
    if (!pid) {
      this.finish(run, -1)
      return
    }
    // Signal a snapshot of the descendant tree alongside the group at every
    // rung: shell children can detach from the process group.
    const descendants = await processTree(pid)
    const graceful = await killProcessTree(pid, {
      ladder: [
        { signal: 'SIGHUP', waitMs: 150 },
        { signal: 'SIGTERM', waitMs: 350 },
      ],
      hasExited: () => run.exited,
      descendants,
      signalDirect: (signal) => { try { run.child.kill(signal) } catch { /* already exited */ } },
    })
    if (process.platform === 'win32' || graceful || run.exited) return
    // Re-snapshot before SIGKILL so a recycled PID from the stale snapshot is
    // never force-killed.
    const survivors = new Set(await processTree(pid))
    await killProcessTree(pid, {
      ladder: [{ signal: 'SIGKILL', waitMs: 0 }],
      descendants: descendants.filter((descendant) => survivors.has(descendant)),
      signalDirect: (signal) => { try { run.child.kill(signal) } catch { /* already exited */ } },
    })
    await waitForProcessExit(run.child, 1_000)
  }

  private send(run: OwnedScriptRun, channel: string, payload: ProjectScriptOutputEvent | ProjectScriptExitEvent): void {
    if (run.owner.isDestroyed()) return
    try { run.owner.send(channel, payload) } catch { /* renderer exited */ }
  }
}
