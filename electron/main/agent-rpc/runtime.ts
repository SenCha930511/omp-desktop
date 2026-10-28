import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { PrimeContextUsage, PrimeEventEnvelope, PrimeModelDescriptor, PrimeServiceTier, RuntimeInfo, SessionCacheWarmingMode, SessionInterruptMode, SessionQueueMode, SessionSettingsSnapshot } from '../../../src/types/api'
import { emptySessionActionSnapshot, parseSessionActionSnapshot } from '../../../src/lib/session-actions'
import { parseSlashCommands } from '../../../src/lib/slash-commands'
import { RPC_READ_FRAME_LIMIT_BYTES } from '../jsonl-limits'
import { killProcessTree, prepareExecutableSpawn, safeChildEnvironment, waitForProcessExit } from '../process-utils'
import { canonicalSessionPath } from '../session-paths'
import { errorMessage, isRecord } from '../validation'
import { redactedStderrTail } from '../lib/process-detail'
import { AgentEventForwarder } from './events'
import { OMP_RPC_ADAPTER, parseContextUsage, parseSessionUsage, type HarnessRpcAdapter } from './harness-adapter'
import { LiveContextUsageTracker, withLiveContextUsage } from './context-usage'
import { FramedRpcTransport, type QueuedRpcWrite } from './transport'
import type { RpcObject } from './types'
import { recordSessionDiagnostic } from './session-diagnostics'

interface PendingRequest {
  resolve(value: RpcObject): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  bytes: number
  command: string
}

export interface CompactionWatchdogTimings {
  /** How often to poll get_state for the compacting flag while the runtime is active. */
  pollIntervalMs: number
  /** How long to wait for the agent's own compaction_end after a poll reports the compaction over. */
  endGraceMs: number
  /** How long after the last agent activity polling keeps running on an idle runtime. */
  idleWindowMs: number
}

const DEFAULT_COMPACTION_WATCHDOG_TIMINGS: CompactionWatchdogTimings = {
  pollIntervalMs: 2_000,
  endGraceMs: 4_000,
  idleWindowMs: 30_000,
}

interface ChunkAssembly {
  count: number
  nextIndex: number
  bytes: number
  parts: Buffer[]
  expiresAt: number
}

export interface RpcChunkAssemblyTimer {
  unref(): void
}

export interface RpcChunkAssemblyTiming {
  /** Monotonic elapsed time; wall-clock adjustments must not affect expiry. */
  now(): number
  schedule(callback: () => void, delayMs: number): RpcChunkAssemblyTimer
  cancel(timer: RpcChunkAssemblyTimer): void
}

interface ContextUsageRefreshRequest {
  generation: number
  sessionId?: string
  activityTokens?: number
}

const MAX_RPC_CHUNK_COUNT = 4096
const MAX_CONCURRENT_RPC_CHUNK_IDS = 4
export const RPC_CHUNK_ASSEMBLY_INACTIVITY_MS = 30_000
const DEFAULT_RPC_CHUNK_ASSEMBLY_TIMING: RpcChunkAssemblyTiming = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (timer) => clearTimeout(timer as NodeJS.Timeout),
}
/**
 * omp redirects a resumed session's writes to a forked copy when the requested
 * session file is still held open by another process (a terminal TUI, another
 * app window). get_state keeps reporting the requested path, so the child's
 * stderr notice is the only reliable signal. Without this check the desktop
 * runs on the fork while the session list shows both the original session and
 * the empty stub the abandoned fork left behind.
 */
const SESSION_HELD_ELSEWHERE = /is open for writing in another (?:omp )?process/
const SESSION_HELD_ELSEWHERE_MESSAGE = 'This session is open in another OMP process (for example, a terminal or another OMP Desktop window). Close it there, then try again.'

// Extension UI methods whose requests block until an extension_ui_response
// (or OMP's own cancel frame) settles them. Presentation methods are
// fire-and-forget and never tracked.
const DIALOG_REQUEST_METHODS: ReadonlySet<string> = new Set(['select', 'confirm', 'input', 'editor', 'ask'])
// Commands that can start or redirect agent work: admitting one means the
// session is no longer settled even before the next authoritative state.
const WORK_INITIATING_COMMANDS: ReadonlySet<string> = new Set(['prompt', 'steer', 'follow_up', 'compact', 'abort', 'abort_retry', 'new_session', 'switch_session', 'clone', 'fork', 'branch'])
// Session 設定六件組(上游 18.13 wire 實測皆有):成功後一律回讀 get_state
// 讓權威快照說話;get_state 不回報的項目(autoRetry、cacheWarming)採用
// 命令/回應回聲,直到未來上游開始回報。
const SESSION_SETTING_COMMANDS: ReadonlySet<string> = new Set(['set_auto_compaction', 'set_auto_retry', 'set_steering_mode', 'set_follow_up_mode', 'set_interrupt_mode', 'set_cache_warming'])
const isSessionQueueMode = (value: unknown): value is SessionQueueMode => value === 'all' || value === 'one-at-a-time'
const isSessionInterruptMode = (value: unknown): value is SessionInterruptMode => value === 'immediate' || value === 'wait'
const isSessionCacheWarmingMode = (value: unknown): value is SessionCacheWarmingMode => value === 'off' || value === 'streaming' || value === 'idle'

export class RpcRuntime {
  readonly runtimeId = randomUUID()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly uncertainDeliveries = new Set<string>()
  private pendingBytes = 0
  private transportFailed = false
  private receivedFrame = false
  private readonly child: ChildProcessWithoutNullStreams
  private readonly transport: FramedRpcTransport
  private stopPromise: Promise<boolean> | null = null
  private readonly eventForwarder: AgentEventForwarder
  private stopped = false
  private info: RuntimeInfo
  private resumedSession = false
  private requestedServiceTier: PrimeServiceTier = 'default'
  private contextUsageRefresh: Promise<void> | null = null
  private contextUsageRefreshRequest: ContextUsageRefreshRequest | null = null
  private readonly liveContextUsage = new LiveContextUsageTracker()
  private authoritativeContextUsage: PrimeContextUsage | undefined
  private contextUsageActivityBaseline = 0
  private contextUsageGeneration = 0
  private contextUsageEmitTimer: NodeJS.Timeout | null = null
  private lastContextUsageEmitAt = 0
  private continuationPending = false
  // Provider auto-retry backoff: agent_end has fired but the agent will
  // continue the same turn, so the runtime must keep reporting busy. Kept
  // outside info so get_state refreshes (which report isStreaming false
  // during the backoff) cannot clear it.
  private retryPending = false
  // Compaction watchdog: some OMP agent event paths buffer compaction_start
  // until the surrounding RPC command settles, so the desktop would learn
  // about a compaction only after it finished. get_state responses are never
  // buffered, so polling the compacting flag while the runtime is active lets
  // the desktop expose running/unknown state; only authoritative completion
  // events can establish a result. Real events take precedence.
  private readonly watchdogTimings: CompactionWatchdogTimings
  private compactionEpisode: 'none' | 'real' | 'synthetic' = 'none'
  private compactionEndFallback: NodeJS.Timeout | null = null
  private compactionPollTimer: NodeJS.Timeout | null = null
  private compactionPollInFlight = false
  private watchdogDisposed = false
  private lastActivityAt = Date.now()
  private lastRealCompactionEventAt = 0
  // v2 chunked frames: base64 rpc_chunk sequences reassembled per chunkId,
  // bounded by the shared read frame limit and small concurrency caps.
  private readonly chunkAssemblies = new Map<string, ChunkAssembly>()
  private chunkAssemblySweepTimer: RpcChunkAssemblyTimer | null = null
  private acceptingChunkFrames = true
  // Safe-retirement tracking for automatic reclamation. OMP 18.13+ reports
  // settlement authoritatively (get_state isSettled/hasPendingAsyncWork and
  // the session_settled frame); until it does, or while background work may
  // still re-wake the session, the child must not be reclaimed. Extension
  // dialogs are tracked by request id only — never titles, prefill, options,
  // or answers — so no prompt content or secret is retained here.
  private readonly pendingExtensionDialogs = new Set<string>()
  private settlement: 'unknown' | 'settled' | 'unsettled' = 'unknown'
  private settlementEpoch = 0

  constructor(
    executable: string,
    args: string[],
    cwd: string,
    onEvent: (envelope: PrimeEventEnvelope) => void,
    private readonly onExit: (runtime: RpcRuntime) => void,
    extraEnvironment: NodeJS.ProcessEnv = {},
    watchdogTimings: Partial<CompactionWatchdogTimings> = {},
    private readonly adapter: HarnessRpcAdapter = OMP_RPC_ADAPTER,
    private readonly chunkAssemblyTiming: RpcChunkAssemblyTiming = DEFAULT_RPC_CHUNK_ASSEMBLY_TIMING,
  ) {
    this.watchdogTimings = { ...DEFAULT_COMPACTION_WATCHDOG_TIMINGS, ...watchdogTimings }
    this.info = { runtimeId: this.runtimeId, harness: this.adapter.id, cwd, isStreaming: false, isCompacting: false, sessionActions: emptySessionActionSnapshot() }
    if (args.indexOf('--thinking') >= 0 && args[args.indexOf('--thinking') + 1] === 'auto') this.info.configuredThinkingLevel = 'auto'
    this.resumedSession = args.indexOf('--resume') >= 0
    this.eventForwarder = new AgentEventForwarder(this.runtimeId, onEvent)
    // The harness child is spawned with the authorized cwd as its working
    // directory.
    const invocation = prepareExecutableSpawn(executable, args, safeChildEnvironment(extraEnvironment))
    this.child = spawn(invocation.file, invocation.args, { cwd, env: invocation.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    this.transport = new FramedRpcTransport(
      this.child,
      (line) => this.handleLine(line),
      (error) => this.failTransport(error),
      () => !this.stopped,
    )
    this.child.stdin.on('error', (error) => this.fail(error))
    this.child.once('error', (error) => this.fail(error))
    this.child.once('close', (code, signal) => {
      this.disposeCompactionWatchdog()
      this.disposeContextUsage()
      const detail = code !== 0 && code !== null && !this.stopped && !this.receivedFrame ? redactedStderrTail(this.transport.stderrTail()) : ''
      this.fail(new Error(`${this.adapter.agentName} RPC exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`))
      this.emit({ type: 'runtime_exit', code, signal, expected: this.stopped })
      this.onExit(this)
    })
    this.scheduleCompactionPoll()
  }

  /** Frozen shallow copy: nested state is replaced wholesale on update, and the IPC boundary clones for the renderer. */
  snapshot(): RuntimeInfo {
    return Object.freeze(this.continuationPending || this.retryPending ? { ...this.info, isStreaming: true } : { ...this.info })
  }

  /**
   * Whether automatic retirement may reclaim this child: OMP has
   * authoritatively reported the session settled (no live run, queued
   * message, or background work that could re-wake it) and no extension
   * dialog is still waiting for an answer. Unknown settlement fails safe.
   */
  canRetireSafely(): boolean {
    return this.settlement === 'settled' && this.pendingExtensionDialogs.size === 0
  }

  /**
   * 直接向 OMP 查詢權威 leafId（唯讀 get_tree；不需要選 cursor，也不載入
   * history）。僅供診斷時點呼叫——不併入每次 get_state，避免多餘負擔。
   * 失敗、逾時或回應形狀不符一律降級為 undefined，絕不 throw。
   */
  async readLeafId(): Promise<string | undefined> {
    try {
      const response = await this.request({ type: 'get_tree' }, 5_000)
      if (response.success === true && isRecord(response.data) && typeof response.data.leafId === 'string' && response.data.leafId.length > 0) {
        return response.data.leafId
      }
      return undefined
    } catch {
      return undefined
    }
  }

  async handshake(): Promise<RuntimeInfo> {
    // Harnesses with a versioned protocol must agree on the version before any
    // other request; unsolicited frames (ready, available_commands_update) may
    // arrive before or after this and are simply forwarded.
    if (this.adapter.negotiateProtocolVersion !== undefined) {
      try {
        await this.request({ type: 'negotiate_protocol', protocolVersion: this.adapter.negotiateProtocolVersion }, 60_000)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`${this.adapter.agentName} does not support RPC protocol v${this.adapter.negotiateProtocolVersion} (${reason}). Update the ${this.adapter.agentName} CLI and try again.`)
      }
    }
    const stateEpoch = this.settlementEpoch
    const response = await this.request({ type: 'get_state' }, 60_000)
    this.updateFromState(response.data, stateEpoch)
    if (this.resumedSession) await this.assertSessionNotHeldElsewhere()
    // Optional on older OMP builds; observability must not prevent startup.
    void this.request({ type: 'set_subagent_subscription', level: 'events' }, 5_000).catch(() => undefined)
    // The desktop now renders native ask requests and validates their answer
    // shape. Older engines can retain their select/editor fallback.
    void this.request({ type: 'set_ask_dialog', enabled: true }, 5_000).catch(() => undefined)
    const contextDeadline = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250)
      timer.unref()
    })
    await Promise.race([this.refreshContextUsage(), contextDeadline])
    return this.snapshot()
  }

  /**
   * The fork notice is emitted during boot — measurably before the get_state
   * response on a held session — so the immediate check after get_state is
   * almost always decisive; a single 400ms retry covers slower flushes. A
   * clean resume pays at most that one retry.
   */
  private async assertSessionNotHeldElsewhere(): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (SESSION_HELD_ELSEWHERE.test(this.transport.stderrTail())) throw new Error(SESSION_HELD_ELSEWHERE_MESSAGE)
      if (attempt >= 1) return
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 400)
        timer.unref()
      })
    }
  }

  applyCapabilities(model: PrimeModelDescriptor | undefined, visionDelegation = false): void {
    this.info.availableThinkingLevels = model?.availableThinkingLevels ?? ['off']
    this.info.fastModeSupported = model?.fastModeSupported ?? false
    this.info.imageInputSupported = model ? model.input.includes('image') || visionDelegation : undefined
    if (!this.info.fastModeSupported) {
      this.requestedServiceTier = 'default'
      this.info.serviceTier = 'default'
    }
  }

  async setServiceTier(serviceTier: 'default' | 'priority', probe = false): Promise<boolean> {
    const buildServiceTierCommand = this.adapter.buildServiceTierCommand
    if (!buildServiceTierCommand) {
      // The harness has no service-tier command at all; nothing goes on the
      // wire, and a direct request fails with a per-harness error.
      this.requestedServiceTier = 'default'
      this.info.serviceTier = 'default'
      this.info.fastModeAvailable = false
      if (probe) return false
      throw new Error(`Service tier is not supported by the ${this.adapter.agentName} harness`)
    }
    if (serviceTier === 'priority' && !this.info.fastModeSupported) {
      this.requestedServiceTier = 'default'
      this.info.serviceTier = 'default'
      return false
    }
    try {
      await this.request(buildServiceTierCommand(serviceTier), 10_000)
      this.requestedServiceTier = serviceTier
      this.info.serviceTier = serviceTier
      this.info.fastModeAvailable = true
      return true
    } catch (error) {
      this.info.fastModeAvailable = false
      this.info.serviceTier = 'default'
      if (!probe) throw error
      return false
    }
  }

  serviceTierPreference(): 'default' | 'priority' { return this.requestedServiceTier === 'priority' ? 'priority' : 'default' }

  async command(command: RpcObject): Promise<RpcObject> {
    this.lastActivityAt = Date.now()
    this.scheduleCompactionPoll()
    if (this.resumedSession && SESSION_HELD_ELSEWHERE.test(this.transport.stderrTail())) throw new Error(SESSION_HELD_ELSEWHERE_MESSAGE)
    if (command.type === 'extension_ui_response') {
      // Fire-and-forget on the wire: the dialog id may only be forgotten
      // once the line has actually been flushed to the child.
      await this.transport.enqueue(`${JSON.stringify(command)}\n`).done
      if (typeof command.id === 'string') this.pendingExtensionDialogs.delete(command.id)
      return { type: 'response', command: 'extension_ui_response', success: true }
    }
    const stateEpoch = this.settlementEpoch
    // Admitted work invalidates settlement before the first event or state
    // refresh can report it, closing the reclamation gap after the response.
    if (WORK_INITIATING_COMMANDS.has(String(command.type))) this.markUnsettled()
    // 使用者 `!` bash 由上游以 session 的 bash timeout 執行(預設 300 秒,
    // tools 上限見上游 tool-timeouts);回應在命令結束時才送達,所以用戶端
    // 逾時必須蓋過預設的 300 秒。超過 10 分鐘的命令不中斷執行,只回報
    // 「已送達、可能仍在執行」;abort_bash 仍是使用者明確中止的入口。
    // login 的 OAuth 流程讓使用者在瀏覽器完成授權並回填授權碼,上游
    // timeoutMs 是 600_000(rpc.md);用戶端逾時必須蓋過整個流程,否則
    // 「已送達、可能仍在執行」的錯誤會誤導面板狀態。取消入口是
    // extension_ui input dialog 的 cancel(上游中止 flow)。
    const timeout = command.type === 'compact' || command.type === 'bash' || command.type === 'login' ? 10 * 60_000 : 60_000
    const response = await this.request(command, timeout)
    if (command.type === 'set_thinking_level' && response.success === true) {
      this.info.configuredThinkingLevel = command.level as RuntimeInfo['configuredThinkingLevel']
      if (command.level !== 'auto') this.info.autoThinkingResolved = false
    }
    if (command.type === 'get_state' && response.success === true && isRecord(response.data)) {
      this.updateFromState(response.data, stateEpoch)
      this.emit({ type: 'runtime_state', state: this.snapshot() })
    }
    if (response.success === true && SESSION_SETTING_COMMANDS.has(String(command.type))) {
      // Session 設定:先採用 get_state 不回報的回聲(autoRetry / cacheWarming
      // 的生效 mode),再回讀權威快照刷新四項有回報的設定,一次 runtime_state
      // 全部推送——GUI 與 TUI 之後讀 get_state 會得到同一份真相。
      this.adoptSessionSettingEcho(command, response)
      const followUpEpoch = this.settlementEpoch
      try {
        const state = await this.request({ type: 'get_state' }, 60_000)
        this.updateFromState(state.data, followUpEpoch)
      } catch { /* 設定已生效;快照交給下一次 runtime_state */ }
      this.emit({ type: 'runtime_state', state: this.snapshot() })
    }
    if (response.success === true && ['set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level'].includes(String(command.type))) {
      const followUpEpoch = this.settlementEpoch
      // 模型/層級變更後 serviceTier 等真值在 get_state,立刻回讀,
      // GUI 徽章即時更新(不靠等待下次事件)。
      const state = await this.request({ type: 'get_state' }, 60_000)
      this.updateFromState(state.data, followUpEpoch)
      void this.refreshContextUsage()
    } else if (response.success === true && command.type === 'prompt') {
      // get_state discovers the new session file promptly. Its mid-stream
      // context snapshot does not include the active assistant message, so a
      // usage refresh waits for message/tool boundaries below.
      const followUpEpoch = this.settlementEpoch
      void this.request({ type: 'get_state' }, 60_000).then((state) => {
        this.updateFromState(state.data, followUpEpoch)
        this.emit({ type: 'runtime_state', state: this.snapshot() })
      }).catch(() => undefined)
    } else if (response.success === true && ['new_session', 'switch_session', 'clone', 'fork', 'branch'].includes(String(command.type))) {
      // Native session boundaries can materialize an empty durable file
      // before any prompt. Publish the authoritative state so the manager
      // can bind initially file-less capability claims at that boundary.
      void this.refreshState().then(() => this.refreshContextUsage()).catch(() => undefined)
    }
    return response
  }

  /** Publish OMP's authoritative identity and execution state. Compaction
   * normally appends in place; only the returned state can establish an
   * actual path change (for example a move or lock-conflict fork). */
  async refreshState(): Promise<RuntimeInfo> {
    const stateEpoch = this.settlementEpoch
    const state = await this.request({ type: 'get_state' }, 60_000)
    if (state.success !== true || !isRecord(state.data)) {
      throw new Error('OMP session state could not be synchronized')
    }
    this.updateFromState(state.data, stateEpoch)
    const snapshot = this.snapshot()
    this.emit({ type: 'runtime_state', state: snapshot })
    return snapshot
  }


  stop(): Promise<boolean> {
    if (!this.stopPromise) {
      // Stop accepting partial frames before the abort round-trip: the child
      // may keep writing while that request is in flight.
      this.acceptingChunkFrames = false
      this.disposeChunkAssemblies()
      this.stopPromise = this.performStop()
    }
    return this.stopPromise
  }

  private async performStop(): Promise<boolean> {
    this.disposeCompactionWatchdog()
    this.disposeChunkAssemblies()
    if (this.info.isStreaming || this.info.isCompacting || this.retryPending) {
      try { await this.request({ type: 'abort' }, 5_000) } catch { /* close stdin and escalate below */ }
    }
    this.stopped = true
    this.transport.endInput()
    if (await this.waitForExit(750)) return true
    return this.killTree()
  }

  private killTree(): Promise<boolean> {
    if (!this.child.pid) return this.waitForExit(3_500)
    return killProcessTree(this.child.pid, {
      ladder: [{ signal: 'SIGTERM', waitMs: 2_000 }, { signal: 'SIGKILL', waitMs: 1_500 }],
      hasExited: () => this.child.exitCode !== null || this.child.signalCode !== null,
      waitForExit: (timeoutMs) => this.waitForExit(timeoutMs),
      signalDirect: (signal) => this.child.kill(signal),
    })
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    return waitForProcessExit(this.child, timeoutMs)
  }

  private failTransport(reason: unknown): void {
    if (this.transportFailed) return
    this.transportFailed = true
    const error = reason instanceof Error ? reason : new Error(errorMessage(reason))
    this.emit({ type: 'transport_error', error: errorMessage(error) })
    this.transport.pauseOutput()
    this.fail(error)
    this.stopPromise ??= this.performTransportStop()
  }

  private performTransportStop(): Promise<boolean> {
    this.disposeCompactionWatchdog()
    this.stopped = true
    this.transport.destroyInput()
    return this.killTree()
  }

  private scheduleCompactionPoll(): void {
    if (this.watchdogDisposed || this.compactionPollTimer || !this.shouldPollCompaction()) return
    this.compactionPollTimer = setTimeout(() => {
      this.compactionPollTimer = null
      void this.pollCompactionState().finally(() => this.scheduleCompactionPoll())
    }, this.watchdogTimings.pollIntervalMs)
    this.compactionPollTimer.unref()
  }

  private async pollCompactionState(): Promise<void> {
    if (this.watchdogDisposed || this.compactionPollInFlight || !this.shouldPollCompaction()) return
    this.compactionPollInFlight = true
    const requestedAt = Date.now()
    try {
      const response = await this.request({ type: 'get_state' }, 5_000)
      const raw = isRecord(response.data) ? response.data : null
      // A poll issued before the latest real compaction event answers with
      // stale state; only responses newer than that event are trusted.
      if (!this.watchdogDisposed && raw && typeof raw.isCompacting === 'boolean' && requestedAt > this.lastRealCompactionEventAt) {
        this.observePolledCompaction(raw.isCompacting)
      }
      // The turn can end without agent_end reaching us (a lost frame or an
      // upstream gap) — the transcript then sits complete while the pill
      // keeps spinning. While no event has arrived since this probe was
      // issued, omp's own isStreaming verdict is authoritative, so settle
      // exactly like a real end. Pending retries and continuations keep the
      // working state true by design and are never overridden.
      if (!this.watchdogDisposed && raw && typeof raw.isStreaming === 'boolean'
        && requestedAt >= this.lastActivityAt
        && !this.retryPending && !this.continuationPending
        && this.info.isStreaming && !raw.isStreaming) {
        this.info.isStreaming = false
        this.bakeLiveContextUsage()
        this.emit({ type: 'agent_end', synthetic: true })
        this.emit({ type: 'runtime_state', state: this.snapshot() })
      }
      // omp does not reliably push session_action_update when it delivers a
      // queued follow-up between turns; a stale snapshot then keeps the
      // queue tray (and the busy flag it feeds, which also blocks the local
      // queue flush) rendering long after delivery. While no turn is in
      // flight — events own the live truth then — fold the authoritative
      // queue snapshot into runtime state so the GUI self-heals within one
      // poll interval even when the delivery event never arrives. The fold
      // only fires to clear residue: an already-empty snapshot must not push
      // periodic runtime_state frames that perturb workspace adoption races.
      if (!this.watchdogDisposed && raw && !this.info.isStreaming && !this.retryPending && !this.continuationPending) {
        const current = this.info.sessionActions
        if (current && (current.queuedCount > 0 || (current.steering?.length ?? 0) > 0 || (current.followUps?.length ?? 0) > 0)) {
          // omp reports the queue as queuedMessageCount/queuedMessages; the
          // adapter owns that translation (raw.sessionActions does not exist
          // on the wire, which once left the fold a silent no-op).
          const actions = this.adapter.readState(raw).sessionActions ?? null
          if (actions && JSON.stringify(actions) !== JSON.stringify(current)) {
            this.info.sessionActions = actions
            this.emit({ type: 'runtime_state', state: this.snapshot() })
          }
        }
      }
    } catch { /* transient poll failures are ignored; the next tick retries */ }
     finally { this.compactionPollInFlight = false }
  }

  private shouldPollCompaction(): boolean {
    if (!this.transport.writable()) return false
    if (this.info.isStreaming || this.info.isCompacting || this.retryPending || this.continuationPending) return true
    return Date.now() - this.lastActivityAt < this.watchdogTimings.idleWindowMs
  }

  private observePolledCompaction(isCompacting: boolean): void {
    if (isCompacting) {
      this.info.isCompacting = true
      this.clearCompactionEndFallback()
      if (this.compactionEpisode === 'none') {
        this.compactionEpisode = 'synthetic'
        this.emit({ type: 'compaction_start', synthetic: true })
      }
      return
    }
    this.info.isCompacting = false
    if (this.compactionEpisode === 'none' || this.compactionEndFallback) return
    // Polling proves only that compaction stopped, not whether it succeeded,
    // failed or was cancelled. Keep the result explicitly pending synchronization.
    this.compactionEndFallback = setTimeout(() => {
      this.compactionEndFallback = null
      if (this.watchdogDisposed || this.compactionEpisode === 'none') return
      this.compactionEpisode = 'none'
      this.emit({ type: 'compaction_sync_pending', synthetic: true })
      void this.refreshContextUsage()
      // Synchronize the actual identity; compaction does not imply a new file.
      void this.refreshState().catch(() => undefined)
    }, this.watchdogTimings.endGraceMs)
    this.compactionEndFallback.unref()
  }

  private clearCompactionEndFallback(): void {
    if (!this.compactionEndFallback) return
    clearTimeout(this.compactionEndFallback)
    this.compactionEndFallback = null
  }

  private disposeCompactionWatchdog(): void {
    this.watchdogDisposed = true
    if (this.compactionPollTimer) {
      clearTimeout(this.compactionPollTimer)
      this.compactionPollTimer = null
    }
    this.clearCompactionEndFallback()
  }

  private request(command: RpcObject, timeoutMs: number): Promise<RpcObject> {
    if (!this.transport.writable()) return Promise.reject(new Error('Runtime is not available'))
    if (this.pending.size >= 32) return Promise.reject(new Error('Too many pending RPC requests'))
    const commandType = String(command.type)
    const id = randomUUID()
    const line = `${JSON.stringify({ ...command, id })}\n`
    const bytes = Buffer.byteLength(line)
    if (this.pendingBytes + bytes > 32 * 1024 * 1024) return Promise.reject(new Error('RPC in-flight byte budget exceeded'))
    this.pendingBytes += bytes
    return new Promise((resolveRequest, reject) => {
      let write: QueuedRpcWrite | null = null
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pendingBytes -= pending.bytes
        this.pending.delete(id)
        if (write?.cancel() !== 'flushed') {
          // The line never reached the child: the command cannot execute, so
          // a retry is safe.
          pending.reject(new Error(`RPC command ${commandType} timed out before it was sent`))
          return
        }
        // The line reached the child, which may still execute the command. A
        // late response must be consumed silently rather than reported as an
        // orphan, and the caller must not retry automatically.
        this.rememberUncertainDelivery(id)
        pending.reject(new Error(`RPC command ${commandType} timed out after delivery; the agent may still run it — do not retry automatically`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve: resolveRequest, reject, timer, bytes, command: commandType })
      const failWrite = (error: unknown) => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingBytes -= pending.bytes
        this.pending.delete(id)
        pending.reject(error instanceof Error ? error : new Error(errorMessage(error)))
      }
      write = this.transport.enqueue(line)
      void write.done.catch(failWrite)
    })
  }

  private handleLine(line: string): void {
    let value: unknown
    try { value = JSON.parse(line) } catch {
      this.disposeChunkAssemblies()
      this.emit({ type: 'transport_error', error: `${this.adapter.agentName} emitted malformed JSON` })
      return
    }
    this.handleFrame(value)
  }

  private handleFrame(raw: unknown): void {
    if (!isRecord(raw) || typeof raw.type !== 'string') return
    this.receivedFrame = true
    if (raw.type !== 'response') { this.lastActivityAt = Date.now(); this.scheduleCompactionPoll() }
    if (raw.type === 'response' && typeof raw.id === 'string') {
      const pending = this.pending.get(raw.id)
      if (!pending) {
        // A late answer to a request that timed out after its write flushed
        // is consumed, not surfaced as an orphan.
        if (this.uncertainDeliveries.delete(raw.id)) return
        this.emit({ type: 'orphan_response', command: raw.command })
        return
      }
      clearTimeout(pending.timer)
      this.pendingBytes -= pending.bytes
      this.pending.delete(raw.id)
      if (raw.command !== pending.command) {
        pending.reject(new Error(`${this.adapter.agentName} returned a mismatched response for ${pending.command}`))
        this.emit({ type: 'transport_error', error: `${this.adapter.agentName} returned a mismatched RPC response` })
        return
      }
      if (raw.success !== true) {
        const detail = typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim().slice(0, 4_000) : `RPC command ${pending.command} failed`
        pending.reject(new Error(detail))
        return
      }
      pending.resolve(raw)
      return
    }
    if (this.adapter.chunkedFrames && raw.type === 'rpc_chunk') {
      if (!this.acceptingChunkFrames) return
      this.handleChunkFrame(raw)
      return
    }
    const value = this.adapter.normalizeEvent(raw)
    if (!value) return
    if (value.type === 'notice' && value.source === 'session-persistence'
      && (value.level === 'info' || value.level === 'warning' || value.level === 'error')) {
      recordSessionDiagnostic('persistence-notice', this.snapshot(), value.level)
    }
    if (value.type === 'thinking_level_changed') {
      this.info.configuredThinkingLevel = (value.configured ?? value.thinkingLevel) as RuntimeInfo['configuredThinkingLevel']
      if (this.info.configuredThinkingLevel === 'auto') {
        // Merely pointing the selector at auto is a config change; only a
        // resolution event raised during a live turn counts as resolved.
        if (this.info.isStreaming) this.info.autoThinkingResolved = true
      } else {
        this.info.autoThinkingResolved = false
      }
    }
    if (value.type === 'available_commands_update') this.info.availableCommands = parseSlashCommands(value.commands)
    const liveUsageUpdate = this.liveContextUsage.handleEvent(value)
    if (liveUsageUpdate.reset) {
      this.contextUsageActivityBaseline = 0
      this.contextUsageGeneration += 1
    }
    if (value.type === 'extension_ui_request') this.trackExtensionDialog(value)
    if (value.type === 'session_settled') this.settlement = 'settled'
    if (value.type === 'prompt_result' && typeof value.sessionSettled === 'boolean') {
      // The terminal frame of an accepted prompt carries OMP's own
      // settlement verdict for the work it caused.
      this.settlement = value.sessionSettled ? 'settled' : 'unsettled'
    }
    if (value.type === 'session_action_update') {
      const actions = parseSessionActionSnapshot(value.actions)
      if (actions) this.info.sessionActions = actions
    }
    if (value.type === 'agent_start') {
      this.continuationPending = false
      this.retryPending = false
      this.info.isStreaming = true
      this.info.isCompacting = false
      this.markUnsettled()
      if (this.compactionEpisode !== 'none') {
        // A new turn proves compaction is no longer running, but says nothing
        // about its outcome. Preserve that uncertainty until a real end arrives.
        this.compactionEpisode = 'none'
        this.clearCompactionEndFallback()
        this.emit({ type: 'compaction_sync_pending', synthetic: true })
        // Synchronize the actual identity without assuming the file changed.
        void this.refreshState().catch(() => undefined)
      }
    } else if (value.type === 'agent_end') {
      // retryPending is cleared only by agent_start or auto_retry_end, never
      // by agent_end: a failed run's agent_end is followed by auto_retry_start
      // when the agent will continue the turn after backoff.
      this.continuationPending = false
      this.info.isStreaming = false
      this.info.isCompacting = false
      this.bakeLiveContextUsage()
    } else if (value.type === 'prompt_result' && value.agentInvoked === false) {
      // Local-only slash commands complete with prompt_result, not agent_end;
      // without this the runtime reports streaming until the next real turn.
      this.info.isStreaming = false
      this.info.isCompacting = false
      this.bakeLiveContextUsage()
    } else if (value.type === 'compaction_start') {
      recordSessionDiagnostic('compaction-start', this.snapshot())
      this.info.isCompacting = true
      this.markUnsettled()
      this.lastRealCompactionEventAt = Date.now()
      this.clearCompactionEndFallback()
      // A late real start after the watchdog already announced this compaction
      // would open a duplicate row in the renderer; the real end still flows.
      if (this.compactionEpisode === 'synthetic') return
      this.compactionEpisode = 'real'
    } else if (value.type === 'compaction_end') {
      recordSessionDiagnostic('compaction-end', this.snapshot())
      this.continuationPending = value.willRetry === true
      this.info.isCompacting = false
      this.lastRealCompactionEventAt = Date.now()
      this.clearCompactionEndFallback()
      this.compactionEpisode = 'none'
    } else if (value.type === 'auto_retry_start') this.retryPending = true
    else if (value.type === 'auto_retry_end') this.retryPending = false
    this.emit(value)
    if (liveUsageUpdate.changed || liveUsageUpdate.reset) this.publishLiveContextUsage(value.type === 'message_end')
    if (value.type === 'message_end'
      || value.type === 'tool_execution_end'
      || value.type === 'turn_end'
      || value.type === 'agent_end') {
      void this.refreshContextUsage(this.liveContextUsage.tokens)
      // The engine finalizes its per-turn output rate at agent_end; publish
      // the fresh snapshot so the composer shows the authoritative value.
      if (value.type === 'agent_end') void this.refreshState().catch(() => undefined)
    } else if (value.type === 'compaction_end') {
      void this.refreshContextUsage()
      // Query the engine's actual identity after compaction. It normally keeps
      // the same file; a move or persistence conflict may legitimately change it.
      void this.refreshState().catch(() => undefined)
    }
  }

  private handleChunkFrame(frame: RpcObject): void {
    const chunkId = frame.chunkId
    if (typeof chunkId !== 'string' || !chunkId || chunkId.length > 128) {
      this.failChunkReassembly(undefined, 'chunked frame carried an invalid chunkId')
      return
    }
    const index = frame.index
    const count = frame.count
    if (!Number.isSafeInteger(index) || Number(index) < 0
      || !Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > MAX_RPC_CHUNK_COUNT
      || typeof frame.data !== 'string') {
      this.failChunkReassembly(chunkId, 'chunked frame carried invalid sequencing')
      return
    }
    if (this.expireChunkAssemblies(chunkId) && index !== 0) return
    const assembly = this.chunkAssemblies.get(chunkId)
    if (!assembly) {
      if (index !== 0) {
        this.failChunkReassembly(chunkId, 'chunk indices arrived out of order')
        return
      }
      if (this.chunkAssemblies.size >= MAX_CONCURRENT_RPC_CHUNK_IDS) {
        this.failChunkReassembly(chunkId, 'too many concurrent chunk reassemblies')
        return
      }
    } else if (index !== assembly.nextIndex || count !== assembly.count) {
      this.failChunkReassembly(chunkId, 'chunk indices arrived out of order')
      return
    }
    if (frame.data.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(frame.data)) {
      this.failChunkReassembly(chunkId, 'chunk data was not valid base64')
      return
    }
    const decoded = Buffer.from(frame.data, 'base64')
    if (frame.byteLength !== undefined && frame.byteLength !== decoded.length) {
      this.failChunkReassembly(chunkId, 'chunk byteLength did not match its data')
      return
    }
    const current = assembly ?? { count: Number(count), nextIndex: 0, bytes: 0, parts: [], expiresAt: 0 }
    if (current.bytes + decoded.length > RPC_READ_FRAME_LIMIT_BYTES) {
      this.failChunkReassembly(chunkId, 'chunked frame exceeded the maximum frame size')
      return
    }
    current.bytes += decoded.length
    current.parts.push(decoded)
    current.nextIndex += 1
    // A new prefix always needs an initial deadline, including an empty first
    // chunk. Once admitted, only retained-byte progress extends its lifetime.
    if (!assembly || decoded.length > 0) current.expiresAt = this.chunkAssemblyTiming.now() + RPC_CHUNK_ASSEMBLY_INACTIVITY_MS
    if (current.nextIndex < current.count) {
      this.chunkAssemblies.set(chunkId, current)
      this.rescheduleChunkAssemblySweep()
      return
    }
    this.chunkAssemblies.delete(chunkId)
    this.rescheduleChunkAssemblySweep()
    let value: unknown
    try { value = JSON.parse(Buffer.concat(current.parts).toString('utf8')) } catch {
      this.disposeChunkAssemblies()
      this.emit({ type: 'transport_error', error: `${this.adapter.agentName} emitted a malformed chunked frame` })
      return
    }
    this.handleFrame(value)
  }

  /** A broken reassembly is dropped without killing the runtime: the agent is still running, so the renderer reconciles from disk. */
  private failChunkReassembly(chunkId: string | undefined, error: string): void {
    if (chunkId !== undefined) {
      this.chunkAssemblies.delete(chunkId)
      this.rescheduleChunkAssemblySweep()
    }
    this.emit({ type: 'transport_limit', kind: 'chunk', error })
  }

  /** Keeps one unref'd timer aimed at the earliest inactivity deadline across the bounded assembly map. */
  private rescheduleChunkAssemblySweep(): void {
    if (this.chunkAssemblySweepTimer) this.chunkAssemblyTiming.cancel(this.chunkAssemblySweepTimer)
    this.chunkAssemblySweepTimer = null
    if (this.chunkAssemblies.size === 0 || this.stopped || this.transportFailed) return
    const deadline = Math.min(...[...this.chunkAssemblies.values()].map((assembly) => assembly.expiresAt))
    const timer = this.chunkAssemblyTiming.schedule(() => {
      if (this.chunkAssemblySweepTimer !== timer) return
      this.chunkAssemblySweepTimer = null
      this.expireChunkAssemblies()
    }, Math.max(0, deadline - this.chunkAssemblyTiming.now()))
    timer.unref()
    this.chunkAssemblySweepTimer = timer
  }

  private expireChunkAssemblies(wantedChunkId?: string): boolean {
    const now = this.chunkAssemblyTiming.now()
    let expiredAny = false
    let wantedExpired = false
    for (const [chunkId, assembly] of this.chunkAssemblies) {
      if (assembly.expiresAt > now) continue
      this.chunkAssemblies.delete(chunkId)
      expiredAny = true
      if (chunkId === wantedChunkId) wantedExpired = true
      this.emit({
        type: 'transport_limit',
        kind: 'chunk',
        error: 'RPC chunk assembly expired after inactivity',
      })
    }
    if (expiredAny || this.chunkAssemblySweepTimer === null) this.rescheduleChunkAssemblySweep()
    return wantedExpired
  }

  private disposeChunkAssemblies(): void {
    if (this.chunkAssemblySweepTimer) this.chunkAssemblyTiming.cancel(this.chunkAssemblySweepTimer)
    this.chunkAssemblySweepTimer = null
    this.chunkAssemblies.clear()
  }

  private refreshContextUsage(activityTokens?: number): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const request: ContextUsageRefreshRequest = {
      generation: this.contextUsageGeneration,
      sessionId: this.info.sessionId,
      ...(activityTokens === undefined ? {} : { activityTokens }),
    }
    const queued = this.contextUsageRefreshRequest
    if (!queued || queued.generation !== request.generation || queued.sessionId !== request.sessionId) {
      this.contextUsageRefreshRequest = request
    } else if (activityTokens !== undefined) {
      queued.activityTokens = Math.max(queued.activityTokens ?? 0, activityTokens)
    }
    this.contextUsageRefresh ??= this.drainContextUsageRefreshes()
    return this.contextUsageRefresh
  }

  private async drainContextUsageRefreshes(): Promise<void> {
    try {
      while (!this.stopped && this.contextUsageRefreshRequest) {
        const request = this.contextUsageRefreshRequest
        this.contextUsageRefreshRequest = null
        await this.performContextUsageRefresh(request)
      }
    } finally {
      // Clearing inside the drain closes the old single-flight race: a request
      // queued by agent_end while an earlier stats RPC is in flight is observed
      // by the loop before this promise can become idle.
      this.contextUsageRefresh = null
    }
  }

  private async performContextUsageRefresh(request: ContextUsageRefreshRequest): Promise<void> {
    try {
      const response = await this.request({ type: 'get_session_stats' }, 10_000)
      const usage = isRecord(response.data) ? parseContextUsage(response.data.contextUsage) : null
      const sessionUsage = parseSessionUsage(response.data)
      if (request.generation !== this.contextUsageGeneration || request.sessionId !== this.info.sessionId) return
      if (sessionUsage && !this.stopped) {
        this.info.sessionUsage = sessionUsage
        this.emit({ type: 'session_usage', sessionUsage })
      }
      if (usage) this.applyAuthoritativeContextUsage(usage, request.activityTokens)
    } catch { /* older OMP agent versions may not expose session stats */ }
  }

  private applyAuthoritativeContextUsage(usage: PrimeContextUsage, activityTokens?: number): void {
    if (activityTokens !== undefined) {
      const previous = this.authoritativeContextUsage
      const activityDelta = Math.max(0, activityTokens - this.contextUsageActivityBaseline)
      // A message_end event is forwarded just before persistence. If a very
      // fast stats response still reflects the preceding message, keep its
      // activity live and let the guaranteed trailing refresh absorb it.
      const includesActivity = activityDelta === 0
        || previous === undefined
        || previous?.tokens === null
        || usage.tokens === null
        || (previous?.tokens !== undefined && usage.tokens >= previous.tokens + activityDelta)
      if (includesActivity) this.contextUsageActivityBaseline = Math.max(this.contextUsageActivityBaseline, activityTokens)
    }
    this.authoritativeContextUsage = usage
    this.publishLiveContextUsage(true)
  }

  private bakeLiveContextUsage(): void {
    if (!this.authoritativeContextUsage) return
    this.authoritativeContextUsage = withLiveContextUsage(
      this.authoritativeContextUsage,
      this.liveContextUsage.tokens,
      this.contextUsageActivityBaseline,
    )
    this.contextUsageActivityBaseline = this.liveContextUsage.tokens
    this.publishLiveContextUsage(true)
  }

  private publishLiveContextUsage(immediate = false): void {
    const snapshot = this.authoritativeContextUsage
    if (!snapshot) return
    const usage = withLiveContextUsage(snapshot, this.liveContextUsage.tokens, this.contextUsageActivityBaseline)
    const current = this.info.contextUsage
    const changed = !current
      || current.tokens !== usage.tokens
      || current.contextWindow !== usage.contextWindow
      || current.percent !== usage.percent
    this.info.contextUsage = usage
    if (!changed) return

    const elapsed = Date.now() - this.lastContextUsageEmitAt
    if (immediate || elapsed >= 100) {
      this.emitContextUsageNow()
      return
    }
    if (this.contextUsageEmitTimer) return
    this.contextUsageEmitTimer = setTimeout(() => {
      this.contextUsageEmitTimer = null
      this.emitContextUsageNow()
    }, 100 - elapsed)
    this.contextUsageEmitTimer.unref()
  }

  private emitContextUsageNow(): void {
    if (this.contextUsageEmitTimer) {
      clearTimeout(this.contextUsageEmitTimer)
      this.contextUsageEmitTimer = null
    }
    const usage = this.info.contextUsage
    if (!usage || this.stopped) return
    this.lastContextUsageEmitAt = Date.now()
    this.emit({ type: 'context_usage', contextUsage: usage })
  }

  private disposeContextUsage(): void {
    if (this.contextUsageEmitTimer) clearTimeout(this.contextUsageEmitTimer)
    this.contextUsageEmitTimer = null
    this.contextUsageRefreshRequest = null
  }

  private updateFromState(raw: unknown, stateEpoch = this.settlementEpoch): void {
    if (!isRecord(raw)) return
    if (typeof raw.sessionId === 'string') {
      if (this.info.sessionId !== undefined && raw.sessionId !== this.info.sessionId) {
        this.liveContextUsage.reset()
        this.contextUsageActivityBaseline = 0
        this.contextUsageGeneration += 1
        this.authoritativeContextUsage = undefined
        delete this.info.contextUsage
        delete this.info.sessionUsage
        delete this.info.tokensPerSecond
        // A state dump is a persisted configuration, not resolution evidence.
        this.info.autoThinkingResolved = false
      }
      this.info.sessionId = raw.sessionId
    }
    // Canonicalize once at the boundary (cached): every later comparison
    // against catalog and validator paths uses the canonical form.
    if (typeof raw.sessionFile === 'string') this.info.sessionFile = canonicalSessionPath(raw.sessionFile)
    if (typeof raw.isStreaming === 'boolean') this.info.isStreaming = raw.isStreaming
    if (typeof raw.isCompacting === 'boolean') this.info.isCompacting = raw.isCompacting
    if (typeof raw.thinkingLevel === 'string') this.info.thinkingLevel = raw.thinkingLevel
    this.mergeSessionSettingsFromState(raw)
    const reading = this.adapter.readState(raw)
    if (reading.serviceTier) {
      this.info.serviceTier = reading.serviceTier
      this.info.fastModeAvailable = true
      this.requestedServiceTier = reading.serviceTier
    }
    // state dump 以欄位缺席表達「未限流」;據此清除。
    if (reading.usageLimit !== undefined) this.info.usageLimit = reading.usageLimit
    else delete this.info.usageLimit
    if (reading.contextUsage) {
      // Harnesses that report usage inside get_state feed the same authoritative
      // path as the get_session_stats refresh.
      this.applyAuthoritativeContextUsage(reading.contextUsage)
    }
    if (reading.tokensPerSecond === null) delete this.info.tokensPerSecond
    else if (reading.tokensPerSecond !== undefined) this.info.tokensPerSecond = reading.tokensPerSecond
    const sessionActions = parseSessionActionSnapshot(raw.sessionActions) ?? reading.sessionActions ?? null
    if (sessionActions) this.info.sessionActions = sessionActions
    if (isRecord(raw.model)) {
      this.info.model = {
        provider: typeof raw.model.provider === 'string' ? raw.model.provider : undefined,
        id: typeof raw.model.id === 'string' ? raw.model.id : undefined,
        name: typeof raw.model.name === 'string' ? raw.model.name : undefined,
      }
    } else if (raw.model === null) this.info.model = null
    // OMP 18.13+ reports settlement authoritatively: isSettled is the same
    // predicate as the session_settled frame and hasPendingAsyncWork names
    // background work that can still re-wake the session. Both fields must
    // agree before the session counts as settled; anything else (absent,
    // partial, or failed) leaves the previous knowledge in place, and the
    // initial unknown state blocks automatic retirement.
    if (raw.isSettled === true && raw.hasPendingAsyncWork === false) {
      // A get_state requested before later work was admitted must not
      // resurrect safety with a stale settled snapshot.
      if (stateEpoch === this.settlementEpoch) this.settlement = 'settled'
    } else if (raw.isSettled === false || raw.hasPendingAsyncWork === true) {
      this.settlement = 'unsettled'
    }
  }

  /**
   * Session 設定的 get_state 讀入(OMP 18.13 實測回報 steeringMode /
   * followUpMode / interruptMode / autoCompactionEnabled;autoRetryEnabled 與
   * cacheWarming 屬前瞻解析,上游開始回報即自動生效)。缺席欄位一律不清除:
   * autoRetry / cacheWarming 的已知值來自 set_* 回聲,權威快照不回報不代表失效。
   */
  private mergeSessionSettingsFromState(raw: Record<string, unknown>): void {
    const next: SessionSettingsSnapshot = { ...this.info.sessionSettings }
    let changed = false
    const apply = <K extends keyof SessionSettingsSnapshot>(key: K, value: SessionSettingsSnapshot[K]): void => {
      if (value === undefined || next[key] === value) return
      next[key] = value
      changed = true
    }
    apply('autoCompaction', typeof raw.autoCompactionEnabled === 'boolean' ? raw.autoCompactionEnabled : undefined)
    apply('autoRetry', typeof raw.autoRetryEnabled === 'boolean' ? raw.autoRetryEnabled : undefined)
    apply('steeringMode', isSessionQueueMode(raw.steeringMode) ? raw.steeringMode : undefined)
    apply('followUpMode', isSessionQueueMode(raw.followUpMode) ? raw.followUpMode : undefined)
    apply('interruptMode', isSessionInterruptMode(raw.interruptMode) ? raw.interruptMode : undefined)
    apply('cacheWarming', isSessionCacheWarmingMode(raw.cacheWarming) ? raw.cacheWarming : undefined)
    if (changed) this.info.sessionSettings = next
  }

  /**
   * get_state(18.13)不回報的 session 設定,在 set_* 成功後採用回聲:
   * set_auto_retry 無 data(以送出的 enabled 為準);set_cache_warming 回傳
   * 生效 mode(data.mode,本 session 覆寫)。RPC 成功才算數——不寫 GUI 自有檔。
   */
  private adoptSessionSettingEcho(command: RpcObject, response: RpcObject): void {
    const type = String(command.type)
    let patch: SessionSettingsSnapshot | undefined
    if (type === 'set_auto_retry' && typeof command.enabled === 'boolean') patch = { autoRetry: command.enabled }
    else if (type === 'set_cache_warming' && isRecord(response.data) && isSessionCacheWarmingMode(response.data.mode)) patch = { cacheWarming: response.data.mode }
    if (patch) this.info.sessionSettings = { ...this.info.sessionSettings, ...patch }
  }

  /** Tracks dialog lifecycles by request id only; OMP's own cancel frames settle dialogs the host never answered. */
  private trackExtensionDialog(value: RpcObject): void {
    if (value.method === 'cancel') {
      if (typeof value.targetId === 'string' && value.targetId) this.pendingExtensionDialogs.delete(value.targetId)
      return
    }
    if (typeof value.method === 'string' && DIALOG_REQUEST_METHODS.has(value.method)
      && typeof value.id === 'string' && value.id) {
      this.pendingExtensionDialogs.add(value.id)
    }
  }

  /** Local unsettled knowledge outranks any get_state response already in flight. */
  private markUnsettled(): void {
    this.settlementEpoch += 1
    this.settlement = 'unsettled'
  }

  private emit(event: RpcObject): void { this.eventForwarder.emit(event) }

  private rememberUncertainDelivery(id: string): void {
    this.uncertainDeliveries.add(id)
    if (this.uncertainDeliveries.size <= 64) return
    const oldest = this.uncertainDeliveries.values().next().value
    if (oldest !== undefined) this.uncertainDeliveries.delete(oldest)
  }

  private fail(error: Error): void {
    this.acceptingChunkFrames = false
    this.disposeChunkAssemblies()
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.uncertainDeliveries.clear()
    this.pendingBytes = 0
  }
}
