import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROJECT_SCRIPT_OUTPUT_LIMIT,
  PROJECT_SCRIPT_TRUNCATION_NOTICE,
  defaultProjectShell,
  projectScriptSpawnOptions,
  ProjectScriptRunner,
} from '../../electron/main/project-script-runner'
import type { ProjectScriptExitEvent, ProjectScriptOutputEvent } from '../../src/types/api'

const dirs: string[] = []
const shell = process.platform === 'win32' ? defaultProjectShell() : '/bin/sh'
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function shellArgument(value: string): string {
  if (/\0|\r|\n/.test(value)) throw new Error('fixture paths must be single-line')
  if (process.platform !== 'win32') return `'${value.replaceAll("'", "'\\''")}'`
  // cmd expands percent variables (and bang variables with delayed expansion)
  // even inside double quotes, so reject them rather than relying on parser luck.
  if (/["%!]/.test(value)) throw new Error('fixture path cannot be represented safely by cmd.exe')
  return `"${value}"`
}

function nodeScript(cwd: string, name: string, source: string, args: string[] = []): string {
  const script = join(cwd, `${name}.cjs`)
  writeFileSync(script, source)
  return [process.execPath, script, ...args].map(shellArgument).join(' ')
}

const waitFor = async (predicate: () => boolean, timeout = 8_000): Promise<void> => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for the project script')
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

interface ScriptEvents { channel: string; payload: ProjectScriptOutputEvent | ProjectScriptExitEvent }

function owner(id = 21): { contents: WebContents; events: ScriptEvents[] } {
  const events: ScriptEvents[] = []
  const contents = {
    id,
    isDestroyed: () => false,
    send: (channel: string, payload: ScriptEvents['payload']) => { events.push({ channel, payload }) },
  } as unknown as WebContents
  return { contents, events }
}

const exitEvents = (events: ScriptEvents[]): ProjectScriptExitEvent[] =>
  events.filter((event) => event.channel === 'project-scripts:exit').map((event) => event.payload as ProjectScriptExitEvent)

const outputOf = (events: ScriptEvents[], runId: string): string =>
  events
    .filter((event) => event.channel === 'project-scripts:output' && (event.payload as ProjectScriptOutputEvent).runId === runId)
    .map((event) => (event.payload as ProjectScriptOutputEvent).data)
    .join('')

describe('ProjectScriptRunner', () => {
  it('uses verbatim argv only for native cmd.exe project scripts', () => {
    expect(projectScriptSpawnOptions('C:\\Windows\\System32\\cmd.exe', 'win32')).toMatchObject({ windowsVerbatimArguments: true, windowsHide: true, detached: false })
    expect(projectScriptSpawnOptions('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32')).toMatchObject({ windowsVerbatimArguments: false, detached: false })
    expect(projectScriptSpawnOptions('cmd.exe', 'linux')).toMatchObject({ windowsVerbatimArguments: false, detached: true })
    expect(projectScriptSpawnOptions('/bin/sh', 'linux')).toMatchObject({ windowsVerbatimArguments: false, detached: true })
  })

  it('preserves the complete original cmd command inside one /S outer quote pair', async () => {
    const cwd = tempDir('omp-desktop-script-cmd-')
    const { contents, events } = owner()
    const calls: Array<{ file: string; args: string[]; options: SpawnOptions }> = []
    const command = '"C:\\Program Files\\node.exe" "C:\\work dir\\script.cjs" "%PATH%" "!BANG!" ""'
    const runner = new ProjectScriptRunner(
      async () => cwd,
      () => 'C:\\Windows\\System32\\cmd.exe',
      async (path) => path,
      async () => ({ release: () => undefined }),
      'win32',
      (file: string, args: string[], options: SpawnOptions): ChildProcess => {
        calls.push({ file, args, options })
        return spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'pipe', 'pipe'] })
      },
    )

    await runner.start(contents, { runId: 'run-cmd-quoting', projectId: 'project-1', kind: 'run', cwd, command })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(call.args).toEqual(['/D', '/S', '/C', `"${command}"`])
    expect(call.args[3]?.slice(1, -1)).toBe(command)
    expect(call.options).toMatchObject({ windowsVerbatimArguments: true, windowsHide: true, detached: false })
    await waitFor(() => exitEvents(events).length === 1)
    expect(exitEvents(events)[0]).toEqual({ runId: 'run-cmd-quoting', exitCode: 0, cancelled: false })
  })

  it('reports the exit code and streams output for a finished script', async () => {
    const cwd = tempDir('omp-desktop-script-exit-')
    const { contents, events } = owner()
    const runner = new ProjectScriptRunner(async () => cwd, () => shell)

    await runner.start(contents, {
      runId: 'run-exit', projectId: 'project-1', kind: 'run', cwd,
      command: nodeScript(cwd, 'exit-seven', "process.stdout.write('script-out'); process.exit(7)"),
    })
    await waitFor(() => exitEvents(events).length === 1)

    expect(exitEvents(events)[0]).toEqual({ runId: 'run-exit', exitCode: 7, cancelled: false })
    expect(outputOf(events, 'run-exit')).toContain('script-out')
  })

  it('bounds forwarded output and announces the cut exactly once', async () => {
    const cwd = tempDir('omp-desktop-script-bound-')
    const { contents, events } = owner()
    const runner = new ProjectScriptRunner(async () => cwd, () => shell)
    const command = nodeScript(cwd, 'bounded-output', `process.stdout.write('y'.repeat(${PROJECT_SCRIPT_OUTPUT_LIMIT * 2}))`)

    await runner.start(contents, { runId: 'run-bound', projectId: 'project-1', kind: 'setup', cwd, command })
    await waitFor(() => exitEvents(events).length === 1)

    const chunks = events.filter((event) => event.channel === 'project-scripts:output')
    const data = chunks.map((event) => (event.payload as ProjectScriptOutputEvent).data)
    expect(data.filter((chunk) => chunk === PROJECT_SCRIPT_TRUNCATION_NOTICE)).toHaveLength(1)
    const forwarded = data.filter((chunk) => chunk !== PROJECT_SCRIPT_TRUNCATION_NOTICE).join('')
    expect(forwarded.length).toBeLessThanOrEqual(PROJECT_SCRIPT_OUTPUT_LIMIT)
    expect(forwarded.length).toBeGreaterThan(PROJECT_SCRIPT_OUTPUT_LIMIT / 2)
  })

  it('keeps one run per project and kind, including concurrent starts', async () => {
    const cwd = tempDir('omp-desktop-script-single-')
    const { contents, events } = owner()
    const runner = new ProjectScriptRunner(async () => cwd, () => shell)

    try {
      const results = await Promise.allSettled([
        runner.start(contents, { runId: 'first', projectId: 'project-1', kind: 'run', cwd, command: nodeScript(cwd, 'first-run', 'setInterval(() => {}, 1000)') }),
        runner.start(contents, { runId: 'second', projectId: 'project-1', kind: 'run', cwd, command: nodeScript(cwd, 'second-run', 'process.exit(0)') }),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)

      // A different kind for the same project is a separate slot.
      await expect(runner.start(contents, { runId: 'setup', projectId: 'project-1', kind: 'setup', cwd, command: nodeScript(cwd, 'setup-run', 'process.exit(0)') })).resolves.toEqual({ runId: 'setup' })
      await waitFor(() => exitEvents(events).some((event) => event.runId === 'setup'))
    } finally {
      await runner.killAll()
    }
  })

  it('kills the process tree on stop and reports the cancellation', async () => {
    const cwd = tempDir('omp-desktop-script-stop-')
    const pidFile = join(cwd, 'dev-server.pid')
    const { contents, events } = owner()
    const other = owner(22)
    const runner = new ProjectScriptRunner(async () => cwd, () => shell)

    await runner.start(contents, {
      runId: 'run-stop',
      projectId: 'project-1',
      kind: 'run',
      cwd,
      command: nodeScript(cwd, 'dev-server', "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)", [pidFile]),
    })
    await waitFor(() => existsSync(pidFile))
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(pid).toBeGreaterThan(0)

    await expect(runner.stop(other.contents, 'run-stop')).resolves.toBe(false)
    await expect(runner.stop(contents, 'run-stop')).resolves.toBe(true)

    await waitFor(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    })
    await waitFor(() => exitEvents(events).length === 1)
    expect(exitEvents(events)[0]).toMatchObject({ runId: 'run-stop', cancelled: true })
  })

  it('holds the repository use lease until the script exits', async () => {
    const cwd = tempDir('omp-desktop-script-lease-')
    const { contents } = owner()
    const release = vi.fn()
    const begin = vi.fn(async () => ({ release }))
    const runner = new ProjectScriptRunner(async () => cwd, () => shell, async (path) => path, begin)

    await runner.start(contents, { runId: 'run-lease', projectId: 'project-1', kind: 'run', cwd, command: nodeScript(cwd, 'exit-zero', 'process.exit(0)') })
    expect(begin).toHaveBeenCalledWith(cwd, expect.objectContaining({ kind: 'script', scriptId: 'run-lease' }))
    expect(release).not.toHaveBeenCalled()
    await waitFor(() => release.mock.calls.length === 1)
  })

  it('refuses a cwd the project grant does not authorize and frees the slot', async () => {
    const cwd = tempDir('omp-desktop-script-auth-')
    const { contents } = owner()
    const authorize = vi.fn()
      .mockRejectedValueOnce(new Error('cwd is not authorized'))
      .mockResolvedValue(cwd)
    const begin = vi.fn(async () => ({ release: () => undefined }))
    const runner = new ProjectScriptRunner(authorize, () => shell, async (path) => path, begin)

    await expect(runner.start(contents, { runId: 'run-denied', projectId: 'project-1', kind: 'run', cwd, command: nodeScript(cwd, 'exit-zero', 'process.exit(0)') })).rejects.toThrow('not authorized')
    expect(begin).not.toHaveBeenCalled()

    await expect(runner.start(contents, { runId: 'run-allowed', projectId: 'project-1', kind: 'run', cwd, command: nodeScript(cwd, 'exit-zero', 'process.exit(0)') })).resolves.toEqual({ runId: 'run-allowed' })
  })

  it('kills runs bound to a deleted session or an evicted project folder', async () => {
    const cwd = tempDir('omp-desktop-script-scope-')
    const pidFile = join(cwd, 'scoped.pid')
    const { contents, events } = owner()
    const runner = new ProjectScriptRunner(async () => cwd, () => shell, async (path) => path)

    await runner.start(contents, {
      runId: 'run-session',
      projectId: 'project-1',
      kind: 'run',
      cwd,
      command: nodeScript(cwd, 'session-server', "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)", [pidFile]),
      sessionPath: join(cwd, 'session.jsonl'),
    })
    await waitFor(() => existsSync(pidFile))
    const pid = Number(readFileSync(pidFile, 'utf8').trim())

    await runner.killForSession(join(cwd, 'session.jsonl'))
    await waitFor(() => exitEvents(events).some((event) => event.runId === 'run-session'))
    await waitFor(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    })

    await runner.start(contents, { runId: 'run-project', projectId: 'project-2', kind: 'run', cwd, command: nodeScript(cwd, 'project-server', 'setInterval(() => {}, 1000)') })
    await runner.killForProjectRoots([cwd])
    await waitFor(() => exitEvents(events).some((event) => event.runId === 'run-project'))
  })
})
