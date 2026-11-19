const redirectToStderr = (...args: unknown[]): void => {
  const line = args.map((item) => (typeof item === 'string' ? item : String(item))).join(' ')
  process.stderr.write(`${line}\n`)
}

// Keep stdout strictly reserved for Conformance Protocol v1 JSONL responses.
console.log = redirectToStderr
console.info = redirectToStderr

import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { WebContents } from 'electron'
import { AgentRpcManager, OMP_RPC_ADAPTER } from '../../../electron/main/agent-rpc'
import { CheckoutService } from '../../../electron/main/checkouts'
import { AgentCollaborationBridge } from '../../../electron/main/collaboration/agent-bridge'
import { configureGooeyPiAgentMessageSigning, encodeGooeyPiAgentMessage, loadOrCreateGooeyPiAgentMessageKey, parseGooeyPiAgentMessage } from '../../../electron/main/collaboration/message-envelope'
import { GitService } from '../../../electron/main/git'
import { readModelPresets } from '../../../electron/main/model-presets'
import { PluginService } from '../../../electron/main/plugins'
import { deleteProjectSessions, resolveProjectRoots } from '../../../electron/main/project-sessions'
import { ProjectService } from '../../../electron/main/projects'
import { OmpModelCatalogService } from '../../../electron/main/providers-omp'
import { RepositoryUseGate } from '../../../electron/main/repository-use-gate'
import { AgentScheduleBridge } from '../../../electron/main/schedules/agent-bridge'
import { ScheduledRunExecutor } from '../../../electron/main/schedules/executor'
import { AutomationService } from '../../../electron/main/schedules/service'
import { SessionService } from '../../../electron/main/sessions'
import { ompSessionServiceOptions } from '../../../electron/main/sessions/omp'
import { SettingsService } from '../../../electron/main/settings-schedules'
import { CURRENT_DESKTOP_STATE_FILENAME, JsonStateStore, LEGACY_DESKTOP_STATE_FILENAME } from '../../../electron/main/store'
import { TerminalService } from '../../../electron/main/terminal'
import { migrateLegacyUserData } from '../../../electron/main/user-data-migration'
import { assertNoMcpAuthenticationCommand } from '../../../src/lib/mcp-policy'
import type { PrimeEventEnvelope, TerminalDataEvent, TerminalExitEvent } from '../../../src/types/api'
import { CONFORMANCE_CAPABILITIES, CONFORMANCE_PROTOCOL_VERSION, type ConformanceRequest, type ConformanceResponse, type WorkspaceResetParams } from '../protocol'
import { setNextOpenDialogPaths, setNextSaveDialogPath } from './electron-shim'

interface TerminalBuffer {
  output: string
  exited: boolean
  exitCode?: number
  signal?: number
}

interface WorkspaceRuntime {
  sandbox: WorkspaceResetParams
  store: JsonStateStore
  settings: SettingsService
  projects: ProjectService
  checkouts: CheckoutService
  sessions: SessionService
  catalog: OmpModelCatalogService
  agents: AgentRpcManager
  git: GitService
  plugins: PluginService
  schedules: AutomationService
  scheduleBridge: AgentScheduleBridge
  collaborationBridge: AgentCollaborationBridge
  terminals: TerminalService
  terminalOwner: WebContents
  terminalOwnerDestroyed: boolean
  terminalBuffers: Map<string, TerminalBuffer>
  eventBuffer: PrimeEventEnvelope[]
}

let activeSandbox: WorkspaceResetParams | null = null
let activeRuntime: WorkspaceRuntime | null = null
const baselineEnvKeys = ['HOME', 'USERPROFILE', 'OMP_BINARY', 'OMP_FIXTURE_HOME', 'OMP_FIXTURE_STATE_DIR'] as const
const savedBaselineEnv = new Map<string, string | undefined>(baselineEnvKeys.map((key) => [key, process.env[key]]))
let appliedExtraEnvKeys = new Set<string>()

function restoreEnvironment(): void {
  for (const key of appliedExtraEnvKeys) {
    if (savedBaselineEnv.has(key)) {
      const value = savedBaselineEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    } else {
      delete process.env[key]
    }
  }
  appliedExtraEnvKeys = new Set()
  for (const key of baselineEnvKeys) {
    const value = savedBaselineEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function resolveDefaultShell(configured: string): string {
  if (configured && existsSync(configured)) return configured
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec
    if (comspec && existsSync(comspec)) return comspec
    return 'C:\\Windows\\System32\\cmd.exe'
  }
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(candidate)) return candidate
  }
  return '/bin/sh'
}

async function closeRuntime(): Promise<void> {
  const runtime = activeRuntime
  activeRuntime = null
  if (!runtime) return
  runtime.terminalOwnerDestroyed = true
  await Promise.allSettled([
    runtime.scheduleBridge.stop(),
    runtime.collaborationBridge.stop(),
    runtime.schedules.stop(),
    runtime.terminals.killAll(),
    runtime.agents.stopAll(),
    runtime.store.beginShutdown(),
  ])
}

async function openStoreAndServices(): Promise<WorkspaceRuntime> {
  if (!activeSandbox) throw new Error('workspace.reset must be called before state.open')
  await closeRuntime()
  const sandbox = activeSandbox
  const platform = sandbox.platformOverride ?? process.platform
  const store = new JsonStateStore(join(sandbox.userDataDir, CURRENT_DESKTOP_STATE_FILENAME), undefined, join(sandbox.userDataDir, LEGACY_DESKTOP_STATE_FILENAME), platform)
  await store.ready()

  const signingKey = loadOrCreateGooeyPiAgentMessageKey(join(sandbox.userDataDir, 'agent-message-signing.key'))
  configureGooeyPiAgentMessageSigning(signingKey)

  const sessionRoot = join(sandbox.homeDir, '.omp', 'agent', 'sessions')
  const ompOptions = ompSessionServiceOptions(sessionRoot)
  const sessions = new SessionService(store, null, undefined, {
    ...ompOptions,
    watchDirectory: (() => ({ on: () => undefined, close: () => undefined })) as never,
  })
  const projects = new ProjectService(store, () => null)
  const repositoryUseGate = new RepositoryUseGate()
  const checkouts = new CheckoutService(() => store.getSettings().checkoutStrategy, projects, repositoryUseGate)
  const git = new GitService(
    (cwd) => projects.authorizeCwd(cwd),
    (cwd) => projects.authorizeReadOnlyCwd(cwd),
  )
  const catalog = new OmpModelCatalogService(() => sandbox.ompExecutable)
  const agents = new AgentRpcManager(
    () => sandbox.ompExecutable,
    (cwd) => projects.authorizeCwd(cwd),
    (path) => sessions.requireSessionPath(path),
    catalog,
    OMP_RPC_ADAPTER,
    () => {
      const mode = store.getSettings().ompApprovalMode
      return mode === 'inherit' ? undefined : mode
    },
    () => {
      const minutes = store.getSettings().idleSessionMinutes
      return { idleMs: minutes === 0 ? 0 : minutes * 60_000, warmCount: 0 }
    },
  )
  agents.setWorkspaceUseProvider((cwd, owner, retireIfIdle) => repositoryUseGate.beginWorkspaceUse(cwd, owner, retireIfIdle))

  const eventBuffer: PrimeEventEnvelope[] = []
  agents.setEventSink((envelope) => {
    eventBuffer.push(envelope)
  })

  sessions.bindRuntimeHooks({
    get: (path) => agents.getForSession(path),
    all: () => agents.list(),
    stop: async (path) => {
      await agents.stopForSession(path)
    },
    rename: async (path, title) => agents.renameForSession(path, title),
  })
  sessions.setRuntimeForker((filePath, cwd) => agents.forkForSession(filePath, cwd))

  const terminalBuffers = new Map<string, TerminalBuffer>()
  let terminalOwnerDestroyed = false
  let terminalsRef: TerminalService | null = null
  const terminalOwner = {
    id: 1,
    isDestroyed: () => terminalOwnerDestroyed,
    send(channel: string, payload: unknown) {
      if (channel === 'terminal:data') {
        const event = payload as TerminalDataEvent
        const entry = terminalBuffers.get(event.terminalId) ?? { output: '', exited: false }
        entry.output += event.data
        terminalBuffers.set(event.terminalId, entry)
        queueMicrotask(() => {
          if (!terminalOwnerDestroyed && terminalsRef) {
            try {
              terminalsRef.acknowledge(terminalOwner, event.terminalId, event.data.length)
            } catch {}
          }
        })
      } else if (channel === 'terminal:exit') {
        const event = payload as TerminalExitEvent
        const entry = terminalBuffers.get(event.terminalId) ?? { output: '', exited: false }
        entry.exited = true
        entry.exitCode = event.exitCode
        entry.signal = event.signal
        terminalBuffers.set(event.terminalId, entry)
      }
    },
  } as unknown as WebContents

  const terminals = new TerminalService(
    (cwd) => projects.authorizeCwd(cwd),
    () => resolveDefaultShell(store.getSettings().terminalShell),
    (path) => sessions.requireSessionPath(path),
    (cwd, owner) => repositoryUseGate.beginWorkspaceUse(cwd, owner),
  )
  terminalsRef = terminals

  const settings = new SettingsService(store, (shell) => terminals.validateShell(shell))
  const plugins = new PluginService(
    () => sandbox.ompExecutable,
    (path) => projects.authorizeProjectRoot(path),
    {
      harness: 'omp',
      agentDir: join(sandbox.homeDir, '.omp', 'agent'),
    },
  )

  projects.bindProviders({
    sessions: () => sessions.list(undefined, true),
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => {
      plugins.evictProjects(roots)
      await Promise.all([agents.stopForProjectRoots(roots), terminals.killForProjectRoots(roots)])
    },
  })

  const scheduledRuns = new ScheduledRunExecutor(projects, sessions, agents, catalog)
  const schedules = new AutomationService(store, {
    validateTarget: (target) => scheduledRuns.validateTarget(target),
    validateExecution: (execution) => scheduledRuns.validateExecution(execution),
    validatePrompt: assertNoMcpAuthenticationCommand,
    run: (task) => scheduledRuns.run(task),
  })
  await schedules.start()

  const scheduleBridge = new AgentScheduleBridge({
    service: schedules,
    harness: 'omp',
    skillPath: join(sandbox.rootDir, 'omp-work-schedules.ts'),
    resolveScope: async ({ cwd, sessionPath }) => {
      const catalogList = await projects.list()
      const compare = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
      const canonicalCwd = compare(await realpath(cwd).catch(() => resolve(cwd)))
      let project: (typeof catalogList)[number] | undefined
      for (const candidate of catalogList) {
        if (candidate.inferred) continue
        for (const folder of candidate.folders) {
          const root = compare(await realpath(folder).catch(() => resolve(folder)))
          if (canonicalCwd === root || canonicalCwd.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) {
            project = candidate
            break
          }
        }
        if (project) break
      }
      if (!project) throw new Error('The agent is not running in an explicitly granted OMP Desktop project')
      if (!sessionPath) return { projectId: project.id }
      const scheduledSession = (await sessions.list(undefined, true)).find((candidate) => resolve(candidate.filePath) === resolve(sessionPath))
      return { projectId: project.id, sessionId: scheduledSession?.id }
    },
  })

  const collaborationBridge = new AgentCollaborationBridge({
    extensionPath: join(sandbox.rootDir, 'omp-work-collaboration.ts'),
    sessions: { omp: sessions },
    agents: { omp: agents },
    catalogs: { omp: catalog },
  })

  await Promise.all([scheduleBridge.start(), collaborationBridge.start()])

  const runtime: WorkspaceRuntime = {
    sandbox,
    store,
    settings,
    projects,
    checkouts,
    sessions,
    catalog,
    agents,
    git,
    plugins,
    schedules,
    scheduleBridge,
    collaborationBridge,
    terminals,
    terminalOwner,
    get terminalOwnerDestroyed() {
      return terminalOwnerDestroyed
    },
    set terminalOwnerDestroyed(value: boolean) {
      terminalOwnerDestroyed = value
    },
    terminalBuffers,
    eventBuffer,
  }
  activeRuntime = runtime
  return runtime
}

function requireRuntime(): WorkspaceRuntime {
  if (!activeRuntime) throw new Error('State is not open; call workspace.reset or state.open first')
  return activeRuntime
}

function requireSandbox(): WorkspaceResetParams {
  if (!activeSandbox) throw new Error('Sandbox is not initialized; call workspace.reset first')
  return activeSandbox
}

async function handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'adapter.info':
      return {
        protocolVersion: CONFORMANCE_PROTOCOL_VERSION,
        implementation: 'electron-node',
        platform: process.platform,
        capabilities: [...CONFORMANCE_CAPABILITIES],
      }

    case 'workspace.reset': {
      await closeRuntime()
      restoreEnvironment()
      const resetParams = params as unknown as WorkspaceResetParams
      activeSandbox = { ...resetParams }
      process.env.HOME = resetParams.homeDir
      process.env.USERPROFILE = resetParams.homeDir
      process.env.OMP_BINARY = resetParams.ompExecutable
      process.env.OMP_FIXTURE_HOME = resetParams.homeDir
      process.env.OMP_FIXTURE_STATE_DIR = join(resetParams.rootDir, 'fixture-state')
      if (resetParams.extraEnv) {
        for (const [key, value] of Object.entries(resetParams.extraEnv)) {
          if (!savedBaselineEnv.has(key)) savedBaselineEnv.set(key, process.env[key])
          appliedExtraEnvKeys.add(key)
          process.env[key] = value
        }
      }
      if (resetParams.autoOpen !== false) {
        await openStoreAndServices()
      }
      return { ok: true }
    }

    case 'workspace.shutdown': {
      await closeRuntime()
      restoreEnvironment()
      activeSandbox = null
      return { ok: true }
    }

    case 'state.migrateUserData': {
      const sandbox = requireSandbox()
      return migrateLegacyUserData(sandbox.appDataDir, sandbox.userDataDir)
    }

    case 'state.open': {
      await openStoreAndServices()
      return { ok: true }
    }

    case 'state.getSnapshot':
      return requireRuntime().store.snapshot()

    case 'state.getSettings':
      return requireRuntime().settings.get()

    case 'state.updateSettings':
      return requireRuntime().settings.update(params.patch)

    case 'state.close': {
      await closeRuntime()
      return { ok: true }
    }

    case 'projects.grant': {
      const runtime = requireRuntime()
      setNextOpenDialogPaths([String(params.path)])
      return runtime.projects.add()
    }

    case 'projects.list':
      return requireRuntime().projects.list()

    case 'projects.listFiles':
      return requireRuntime().projects.listFiles(params.root)

    case 'projects.remove': {
      const runtime = requireRuntime()
      const id = String(params.id)
      const target = (await runtime.projects.list()).find((project) => project.id === id)
      const removed = await runtime.projects.remove(id)
      if (!removed) return false
      if (target) {
        await deleteProjectSessions(
          {
            listSessions: () => runtime.sessions.list(undefined, true, true),
            deleteSession: (filePath) => runtime.sessions.delete(filePath),
            closeBrowserView: () => undefined,
            killTerminal: (filePath) => runtime.terminals.killForSession(filePath),
          },
          await resolveProjectRoots(target.folders),
        )
      }
      return true
    }

    case 'sessions.list':
      return requireRuntime().sessions.list(params.projectPath, params.includeArchived, params.force)

    case 'sessions.sync':
      return requireRuntime().sessions.sync(params.revision)

    case 'sessions.read':
      return requireRuntime().sessions.read(params.filePath)

    case 'sessions.setPinned':
      await requireRuntime().sessions.setPinned(params.filePath, params.pinned)
      return { ok: true }

    case 'sessions.archive':
      return requireRuntime().sessions.archive(params.filePath, params.archived)

    case 'sessions.delete':
      return requireRuntime().sessions.delete(params.filePath)

    case 'models.catalog':
      return requireRuntime().catalog.catalog(params.force === true)

    case 'models.presets':
      return readModelPresets(join(requireSandbox().homeDir, '.omp', 'agent', 'config.yml'))

    case 'agent.start':
      return requireRuntime().agents.start(params)

    case 'agent.command':
      return requireRuntime().agents.command(params.runtimeId, params.command)

    case 'agent.drainEvents': {
      const runtime = requireRuntime()
      const filterId = typeof params.runtimeId === 'string' ? params.runtimeId : undefined
      if (!filterId) {
        return runtime.eventBuffer.splice(0)
      }
      const matched: PrimeEventEnvelope[] = []
      const kept: PrimeEventEnvelope[] = []
      for (const envelope of runtime.eventBuffer) {
        if (envelope.runtimeId === filterId) matched.push(envelope)
        else kept.push(envelope)
      }
      runtime.eventBuffer.splice(0, runtime.eventBuffer.length, ...kept)
      return matched
    }

    case 'agent.list':
      return requireRuntime().agents.list()

    case 'agent.stop':
      return requireRuntime().agents.stop(params.runtimeId)

    case 'git.status':
      return requireRuntime().git.status(params.cwd)

    case 'git.diff':
      return requireRuntime().git.diff(params.cwd, params.path, params.staged)

    case 'git.stage':
      return requireRuntime().git.stage(params.cwd, params.paths)

    case 'git.unstage':
      return requireRuntime().git.unstage(params.cwd, params.paths)

    case 'git.restore':
      return requireRuntime().git.restore(params.cwd, params.paths)

    case 'git.commit':
      return requireRuntime().git.commit(params.cwd, params.message)

    case 'checkouts.list':
      return requireRuntime().checkouts.list(params.projectId)

    case 'checkouts.execute': {
      const runtime = requireRuntime()
      if (typeof params.saveDialogPath === 'string') {
        setNextSaveDialogPath(params.saveDialogPath)
      }
      return runtime.checkouts.execute(params.projectId, params.action)
    }

    case 'plugins.list':
      return requireRuntime().plugins.list(params.projectPath)

    case 'plugins.connectMcp':
      return requireRuntime().plugins.connectMcp(params.input)

    case 'plugins.setMcpEnabled':
      return requireRuntime().plugins.setMcpEnabled(params.input)

    case 'plugins.mutateCapability':
      return requireRuntime().plugins.mutateCapability(params.input)

    case 'plugins.install':
      return requireRuntime().plugins.install(params.source)

    case 'schedules.preview':
      return requireRuntime().schedules.preview(params.timing, params.count)

    case 'schedules.create':
      return requireRuntime().schedules.create(params.input, (params.createdBy as 'user' | 'agent' | undefined) ?? 'user', 'omp')

    case 'schedules.list':
      return requireRuntime().schedules.list('omp')

    case 'schedules.update':
      return requireRuntime().schedules.update(params.id, params.patch)

    case 'schedules.pause':
      return requireRuntime().schedules.pause(params.id)

    case 'schedules.resume':
      return requireRuntime().schedules.resume(params.id)

    case 'schedules.delete':
      return requireRuntime().schedules.delete(params.id)

    case 'schedules.brokerInfo': {
      const runtime = requireRuntime()
      const env = runtime.scheduleBridge.environmentFor({
        cwd: String(params.cwd),
        sessionPath: typeof params.sessionPath === 'string' ? params.sessionPath : undefined,
      })
      return {
        url: env.OMP_DESKTOP_SCHEDULE_URL ?? '',
        token: env.OMP_DESKTOP_SCHEDULE_TOKEN ?? '',
      }
    }

    case 'collaboration.encodeEnvelope': {
      const sandbox = requireSandbox()
      const key = loadOrCreateGooeyPiAgentMessageKey(join(sandbox.userDataDir, 'agent-message-signing.key'))
      configureGooeyPiAgentMessageSigning(key)
      return {
        envelope: encodeGooeyPiAgentMessage({
          fromSessionId: String(params.fromSessionId),
          text: String(params.text),
        }),
      }
    }

    case 'collaboration.verifyEnvelope': {
      const sandbox = requireSandbox()
      const key = loadOrCreateGooeyPiAgentMessageKey(join(sandbox.userDataDir, 'agent-message-signing.key'))
      configureGooeyPiAgentMessageSigning(key)
      return {
        parsed: parseGooeyPiAgentMessage(String(params.value)) ?? null,
      }
    }

    case 'collaboration.brokerInfo': {
      const runtime = requireRuntime()
      const env = runtime.collaborationBridge.environmentFor({
        cwd: String(params.cwd),
        sessionPath: typeof params.sessionPath === 'string' ? params.sessionPath : undefined,
        harness: 'omp',
      })
      const token = env.GOOEYPI_COLLABORATION_TOKEN ?? ''
      if (typeof params.sessionPath === 'string') {
        runtime.collaborationBridge.bindSession(token, params.sessionPath, typeof params.runtimeId === 'string' ? params.runtimeId : 'conformance-runtime')
      }
      return {
        url: env.GOOEYPI_COLLABORATION_URL ?? '',
        token,
      }
    }

    case 'terminal.create': {
      const runtime = requireRuntime()
      return runtime.terminals.create(runtime.terminalOwner, params)
    }

    case 'terminal.input': {
      const runtime = requireRuntime()
      runtime.terminals.input(runtime.terminalOwner, params.terminalId, params.data)
      return { ok: true }
    }

    case 'terminal.readOutput': {
      const runtime = requireRuntime()
      const terminalId = String(params.terminalId)
      const entry = runtime.terminalBuffers.get(terminalId)
      if (!entry) return { output: '', exited: false }
      const output = entry.output
      entry.output = ''
      return {
        output,
        exited: entry.exited,
        exitCode: entry.exitCode,
        signal: entry.signal,
      }
    }

    case 'terminal.resize': {
      const runtime = requireRuntime()
      runtime.terminals.resize(runtime.terminalOwner, params.terminalId, params.cols, params.rows)
      return { ok: true }
    }

    case 'terminal.kill': {
      const runtime = requireRuntime()
      return runtime.terminals.kill(runtime.terminalOwner, params.terminalId)
    }

    default:
      throw new TypeError(`Unknown conformance method: ${method}`)
  }
}

function sendResponse(response: ConformanceResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

let queue: Promise<void> = Promise.resolve()

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })

rl.on('line', (line) => {
  if (!line.trim()) return
  let request: ConformanceRequest
  try {
    request = JSON.parse(line) as ConformanceRequest
  } catch {
    return
  }
  const id = request.id
  queue = queue.then(async () => {
    try {
      const result = await handleMethod(request.method, request.params ?? {})
      sendResponse({ id, ok: true, result })
    } catch (error) {
      const code = error instanceof Error && error.name ? error.name : 'Error'
      const message = error instanceof Error ? error.message : String(error)
      sendResponse({ id, ok: false, error: { code, message } })
    }
  })
})

rl.on('close', () => {
  void queue.then(() => closeRuntime()).finally(() => process.exit(0))
})
