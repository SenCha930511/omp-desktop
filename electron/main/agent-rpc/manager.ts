import type { PrimeEventEnvelope, PrimeModelCatalog, PrimeModelDescriptor, RuntimeInfo } from '../../../src/types/api'
import { readLatestCompactionRecord, type ManualCompactionReader } from './manual-compaction'
import { assertNoMcpAuthenticationCommand } from '../../../src/lib/mcp-policy'
import { parseSessionActionSnapshot, streamingBehaviorForIntent } from '../../../src/lib/session-actions'
import { resolveExecutable, type ExecutableSource } from '../process-utils'
import { canonicalSessionPath } from '../session-paths'
import { isPathWithin, isRecord, rejectUnknownKeys, requireId, requireRecord, requireString } from '../validation'
import { isThinkingLevel, validateRpcCommand } from './command-schema'
import { OMP_RPC_ADAPTER, type HarnessRpcAdapter } from './harness-adapter'
import { RpcRuntime } from './runtime'
import type { RpcObject } from './types'
import type { WorkspaceUseLease, WorkspaceUseOwner } from '../repository-use-gate'
import { recordSessionDiagnostic } from './session-diagnostics'

/**
 * Structural slice of the provider catalog the manager needs; PrimeProviderService
 * satisfies it today and a future OMP model catalog can be injected in its place.
 */
export interface ProviderCatalog {
  requireAvailableModel(rawKey: unknown): Promise<PrimeModelDescriptor>
  capabilities(provider: string | undefined, modelId: string | undefined): Promise<PrimeModelDescriptor | undefined>
  catalog(force?: boolean): Promise<PrimeModelCatalog>
}

export interface RuntimeRetentionOptions { idleMs?: number; warmCount?: number }
/** Settings-backed source so the idle window follows the live preference. */
export type RuntimeRetentionSource = RuntimeRetentionOptions | (() => RuntimeRetentionOptions)
const RETENTION_EVENTS = new Set(['agent_start', 'agent_end', 'runtime_state', 'session_action_update', 'compaction_start', 'compaction_end', 'auto_retry_end', 'prompt_result', 'runtime_exit', 'session_settled', 'extension_ui_request'])

export class AgentRpcManager {
  private readonly runtimes = new Map<string, RpcRuntime>()
  private readonly startingRuntimes = new Set<string>()
  private readonly retiringRuntimes = new Set<string>()
  private readonly runtimeEnvironmentRevisions = new Map<string, number>()
  /** Requested resume path per runtime id, valid until the handshake reports the authoritative session file. */
  private readonly startSessionPathById = new Map<string, string>()
  /** 每支 runtime 最後一次 durable 綁定過 capability claim 的 session 身分(sessionId + 規範化 sessionFile)。 */
  private readonly durableIdentityByRuntimeId = new Map<string, { sessionId?: string; sessionFile: string }>()
  /** sessionId 滾動(true identity change)後遭隔離的 runtime:舊 token 的 claim 已撤,不得再承載任何命令,只等安全退役。 */
  private readonly quarantinedRuntimes = new Set<string>()
  private runtimeEnvironmentRevision = 0
  private eventSink: (envelope: PrimeEventEnvelope) => void = () => undefined
  private runtimeEnvironmentProvider: (scope: { cwd: string; sessionPath?: string; interactive: boolean }) => NodeJS.ProcessEnv = () => ({})
  private runtimeStartListener: (environment: NodeJS.ProcessEnv, info: RuntimeInfo) => void = () => undefined
  private runtimeEndListener: (environment: NodeJS.ProcessEnv, info?: RuntimeInfo) => void = () => undefined
  private runtimeSessionReboundListener: (environment: NodeJS.ProcessEnv, previousInfo: RuntimeInfo, nextInfo: RuntimeInfo) => void = () => undefined
  private runtimeAdmission: Promise<void> = Promise.resolve()
  private beginWorkspaceUse: (
    cwd: string,
    owner: WorkspaceUseOwner,
    retireIfIdle: () => Promise<boolean>,
  ) => Promise<WorkspaceUseLease> = async () => ({ release: () => undefined })
  private closed = false
  private readonly commandsInFlight = new Map<string, number>()
  private readonly sessionMutations = new Set<string>()
  private readonly idleSince = new Map<string, number>()
  private idleTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly executable: ExecutableSource,
    private readonly authorizeCwd: (cwd: string) => Promise<string>,
    private readonly validateSessionPath: (path: string) => Promise<string>,
    private readonly providers?: ProviderCatalog,
    private readonly adapter: HarnessRpcAdapter = OMP_RPC_ADAPTER,
    /** OMP approval-mode override consumed by the harness arg builder. */
    private readonly approvalMode: () => string | undefined = () => undefined,
    private readonly retention: RuntimeRetentionSource = {},
    /** Reads the compaction record a manual compact wrote; injectable for tests. */
    private readonly manualCompactionReader: ManualCompactionReader = readLatestCompactionRecord,
  ) {}

  setEventSink(sink: (envelope: PrimeEventEnvelope) => void): void { this.eventSink = sink }

  setWorkspaceUseProvider(provider: (
    cwd: string,
    owner: WorkspaceUseOwner,
    retireIfIdle: () => Promise<boolean>,
  ) => Promise<WorkspaceUseLease>): void {
    this.beginWorkspaceUse = provider
  }

  setRuntimeEnvironmentProvider(provider: (scope: { cwd: string; sessionPath?: string; interactive: boolean }) => NodeJS.ProcessEnv): void {
    this.runtimeEnvironmentProvider = provider
  }

  /** Called after startup, on the first durable session binding of an initially file-less runtime, and again on a same-identity path-only move (sessionId unchanged, file changed). Never rebinds claims to a different sessionId — that transition revokes instead. */
  setRuntimeStartListener(listener: (environment: NodeJS.ProcessEnv, info: RuntimeInfo) => void): void {
    this.runtimeStartListener = listener
  }

  /** Called once when ownership of a spawned environment ends, including starts that fail before a runtime can be created. */
  setRuntimeEndListener(listener: (environment: NodeJS.ProcessEnv, info?: RuntimeInfo) => void): void {
    this.runtimeEndListener = listener
  }

  /**
   * Called on a path-only move: same session identity (sessionId unchanged)
   * reported under a different session file. The claim-owning wiring moves the
   * existing token's scope from previousInfo.sessionFile to nextInfo.sessionFile;
   * the token itself is never rotated or revoked for this transition.
   */
  setRuntimeSessionReboundListener(listener: (environment: NodeJS.ProcessEnv, previousInfo: RuntimeInfo, nextInfo: RuntimeInfo) => void): void {
    this.runtimeSessionReboundListener = listener
  }

  beginShutdown(): void {
    this.closed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.idleSince.clear()
  }

  async start(raw: unknown): Promise<RuntimeInfo> {
    return this.startWithMode(raw, true)
  }

  /** Internal scheduler entrypoint: unattended children must never expose UI-blocking tools. */
  async startUnattended(raw: unknown): Promise<RuntimeInfo> {
    return this.startWithMode(raw, false)
  }

  private async startWithMode(raw: unknown, interactive: boolean): Promise<RuntimeInfo> {
    this.requireOpen()
    const executable = resolveExecutable(this.executable)
    if (!executable) throw new Error(`${this.adapter.agentName} executable was not found`)
    const options = requireRecord(raw, 'options')
    rejectUnknownKeys(options, ['cwd', 'sessionPath', 'model', 'thinking', 'fast'], 'options')
    const cwd = await this.authorizeCwd(requireString(options.cwd, 'cwd', { min: 1, max: 4096 }))
    this.requireOpen()
    const sessionPath = options.sessionPath === undefined
      ? undefined
      : await this.validateSessionPath(requireString(options.sessionPath, 'sessionPath', { max: 4096 }))
    if (sessionPath !== undefined) {
      // Reuse the process that already owns this file. Opening it in a second
      // OMP process can trigger lock-conflict forking; normal resume itself
      // does not imply a new session identity.
      const existing = this.getForSession(sessionPath)
      if (existing && this.sessionMutations.has(existing.runtimeId)) throw new Error('Session identity is being changed')
      if (existing && !this.retiringRuntimes.has(existing.runtimeId)) return existing
    }
    let selectedModel: PrimeModelDescriptor | undefined
    let modelId: string | undefined
    if (options.model !== undefined) {
      selectedModel = this.providers
        ? await this.providers.requireAvailableModel(options.model)
        : undefined
      modelId = selectedModel?.id ?? requireString(options.model, 'model', { min: 1, max: 256, trim: true })
    }
    let thinking: string | undefined
    if (options.thinking !== undefined) {
      thinking = requireString(options.thinking, 'thinking', { min: 1, max: 16, trim: true })
      if (!isThinkingLevel(thinking)) throw new TypeError('Invalid thinking level')
      if (selectedModel && (thinking === 'auto' ? !selectedModel.reasoning : !selectedModel.availableThinkingLevels.includes(thinking))) throw new TypeError(`${selectedModel.name} does not support ${thinking} reasoning`)
    }
    if (options.fast !== undefined && typeof options.fast !== 'boolean') throw new TypeError('fast must be a boolean')
    this.requireOpen()
    const runtimeEnvironmentRevision = this.runtimeEnvironmentRevision
    const runtimeEnvironment = this.runtimeEnvironmentProvider({ cwd, sessionPath, interactive })
    let runtime: RpcRuntime | undefined
    let workspaceUse!: WorkspaceUseLease
    workspaceUse = await this.beginWorkspaceUse(
      cwd,
      { kind: 'agent', harness: this.adapter.id, runtimeId: `starting-${Date.now()}` },
      async () => {
        if (!runtime) return false
        const retired = await this.retireForCheckout(runtime)
        if (retired) workspaceUse.release()
        return retired
      },
    )
    let environmentEnded = false
    let runtimeStartNotified = false
    const notifyRuntimeEnd = (info?: RuntimeInfo): void => {
      if (environmentEnded) return
      environmentEnded = true
      workspaceUse.release()
      try { this.runtimeEndListener(runtimeEnvironment, info) } catch { /* capability cleanup must never fail runtime cleanup */ }
    }
    try {
      const args = this.adapter.buildStartArgs({
        cwd,
        sessionPath,
        providerId: selectedModel?.provider,
        modelId,
        thinking,
        approvalMode: this.approvalMode(),
        environment: runtimeEnvironment,
      })
      runtime = await this.admitRuntime(() => {
        const created = new RpcRuntime(
          executable,
          args,
          cwd,
          (event) => {
            // 每次 runtime_state 抵達時、snapshot 已是最新:對照看護 durable 身分
            // (初次 durable 綁定 / path-only move / true identity change)。
            if (event.event.type === 'runtime_state' && runtimeStartNotified && runtime && !environmentEnded) {
              this.observeDurableIdentity(runtime, runtimeEnvironment, notifyRuntimeEnd)
            }
            this.eventSink(event)
            if (RETENTION_EVENTS.has(String(event.event.type))) this.scheduleIdleRetirement()
          },
          (closed) => {
            this.startingRuntimes.delete(closed.runtimeId)
            this.runtimes.delete(closed.runtimeId)
            this.retiringRuntimes.delete(closed.runtimeId)
            this.startSessionPathById.delete(closed.runtimeId)
            this.durableIdentityByRuntimeId.delete(closed.runtimeId)
            this.quarantinedRuntimes.delete(closed.runtimeId)
            this.idleSince.delete(closed.runtimeId)
            // Normal close must release the environment generation exactly like
            // the failed-start path does; a leftover entry would keep a retired
            // child counted against the next settings refresh.
            this.runtimeEnvironmentRevisions.delete(closed.runtimeId)
            this.scheduleIdleRetirement()
            notifyRuntimeEnd(closed.snapshot())
          },
          runtimeEnvironment,
          {},
          this.adapter,
        )
        // Record the environment generation before admission resolves so a
        // concurrent settings refresh cannot mistake this child for a new one.
        this.runtimeEnvironmentRevisions.set(created.runtimeId, runtimeEnvironmentRevision)
        if (sessionPath !== undefined) this.startSessionPathById.set(created.runtimeId, canonicalSessionPath(sessionPath))
        return created
      })
      if (runtimeEnvironmentRevision < this.runtimeEnvironmentRevision) void this.retireWhenIdle(runtime)
      await runtime.handshake()
      await this.decorate(runtime)
      if (runtime.snapshot().fastModeSupported && options.fast === true) await runtime.setServiceTier('priority', true)
      try {
        const state = runtime.snapshot()
        this.runtimeStartListener(runtimeEnvironment, state)
        runtimeStartNotified = true
        if (state.sessionFile) this.durableIdentityByRuntimeId.set(runtime.runtimeId, { sessionId: state.sessionId, sessionFile: canonicalSessionPath(state.sessionFile) })
      } catch { /* capability binding must never fail a start */ }
      this.startingRuntimes.delete(runtime.runtimeId)
      this.scheduleIdleRetirement()
      return runtime.snapshot()
    } catch (error) {
      if (runtime) {
        // Release the runtime slot explicitly: the close-event cleanup may never
        // fire if the child cannot be reaped, and a failed start must not remain
        // in the resident-process catalog.
        this.startingRuntimes.delete(runtime.runtimeId)
        this.runtimes.delete(runtime.runtimeId)
        this.runtimeEnvironmentRevisions.delete(runtime.runtimeId)
        this.startSessionPathById.delete(runtime.runtimeId)
        this.durableIdentityByRuntimeId.delete(runtime.runtimeId)
        this.quarantinedRuntimes.delete(runtime.runtimeId)
        await runtime.stop().catch(() => false)
      }
      // Admission/constructor failures have no close event; failed handshakes
      // can also leave an unreapable child. The once guard joins all paths.
      notifyRuntimeEnd(runtime?.snapshot())
      throw error
    }
  }

  /**
   * 每次 runtime_state 抵達時對照看護 durable 身分(snapshot 此刻已是最新):
   *  1. 尚未 durable 綁定(initially file-less runtime 第一次拿到檔案)→ 視為
   *     初次綁定,沿用 start listener;listener 拋錯時不記錄,由下一次
   *     runtime_state 重試。
   *  2. sessionId 不變但 sessionFile 變 → path-only move:同一組 token 不撤、
   *     不換發;重觸發 start listener(契約觀察點),並通知 rebind listener 讓
   *     bridge 真正改寫既有 claim 的 scope。
   *  3. sessionId 變 → true identity change:撤銷 claims(end listener 的 once
   *     守護保證每支 runtime 只撤一次),quarantine 該 runtime、自 session 路由
   *     移除,等 canRetireSafely 退役;新 identity 絕不沿用舊 token,bound 不再
   *     重觸發。
   * listener 失敗絕不阻斷事件流或 runtime 清理。
   */
  private observeDurableIdentity(runtime: RpcRuntime, environment: NodeJS.ProcessEnv, notifyEnd: (info?: RuntimeInfo) => void): void {
    if (this.quarantinedRuntimes.has(runtime.runtimeId)) return
    // Manager 主導的身分操作(fork)由 forkForSession 自己的 retire/claims 路徑
    // 處理;自發觀測點不得把這種自觸發的換檔誤判成 path-only move 而重複觸發。
    // 注意不能擋 retiringRuntimes:quarantine 的退役也走那條路,仍須可被觀測。
    if (this.sessionMutations.has(runtime.runtimeId)) return
    const state = runtime.snapshot()
    if (!state.sessionFile) return
    const record = this.durableIdentityByRuntimeId.get(runtime.runtimeId)
    if (!record) {
      try {
        this.runtimeStartListener(environment, state)
        this.durableIdentityByRuntimeId.set(runtime.runtimeId, { sessionId: state.sessionId, sessionFile: canonicalSessionPath(state.sessionFile) })
      } catch { /* a later state update can retry the initial binding */ }
      return
    }
    const sessionFile = canonicalSessionPath(state.sessionFile)
    if (record.sessionFile === sessionFile && record.sessionId === state.sessionId) return
    if (record.sessionId !== state.sessionId) {
      this.quarantinedRuntimes.add(runtime.runtimeId)
      this.durableIdentityByRuntimeId.delete(runtime.runtimeId)
      this.startSessionPathById.delete(runtime.runtimeId)
      notifyEnd(state)
      if (this.canReclaim(runtime)) void this.retireForCheckout(runtime)
      else this.scheduleIdleRetirement()
      return
    }
    const previousInfo: RuntimeInfo = { ...state, sessionFile: record.sessionFile }
    try { this.runtimeStartListener(environment, state) } catch { /* capability rebinding must never break the event stream */ }
    try { this.runtimeSessionReboundListener(environment, previousInfo, state) } catch { /* capability rebinding must never break the event stream */ }
    this.durableIdentityByRuntimeId.set(runtime.runtimeId, { sessionId: state.sessionId, sessionFile })
  }

  /**
   * Retire children launched with stale capability settings. Idle runtimes are
   * stopped now; busy runtimes are polled until their current turn settles.
   */
  async requestRuntimeEnvironmentRefresh(): Promise<void> {
    this.runtimeEnvironmentRevision += 1
    await Promise.all([...this.runtimes.values()].map((runtime) => this.retireWhenIdle(runtime)))
  }

  async command(runtimeId: unknown, rawCommand: unknown): Promise<RpcObject> {
    let admittedId: string | undefined
    try {
      this.requireOpen()
      const runtime = this.requireRuntime(runtimeId)
      if (this.retiringRuntimes.has(runtime.runtimeId)) throw new Error('Runtime is being retired')
      if (this.quarantinedRuntimes.has(runtime.runtimeId)) throw new Error('Runtime is quarantined after a session identity change')
      if (this.sessionMutations.has(runtime.runtimeId)) throw new Error('Session identity is being changed')
      admittedId = runtime.runtimeId
      this.commandsInFlight.set(admittedId, (this.commandsInFlight.get(admittedId) ?? 0) + 1)
      this.idleSince.delete(admittedId)
      return await this.dispatchCommand(runtimeId, rawCommand)
    } catch (error) {
      // Delivery failures for user-visible commands (steer, prompt, follow_up)
      // are otherwise only surfaced as a transient renderer toast; keep a
      // durable trace in the main-process log for diagnosis.
      const type = isRecord(rawCommand) && typeof rawCommand.type === 'string' ? rawCommand.type : 'invalid'
      console.error(`[agent-rpc] ${new Date().toISOString()} command ${type} failed:`, error instanceof Error ? error.message : error)
      throw error
    } finally {
      if (admittedId) {
        const remaining = (this.commandsInFlight.get(admittedId) ?? 1) - 1
        if (remaining) this.commandsInFlight.set(admittedId, remaining)
        else this.commandsInFlight.delete(admittedId)
        this.scheduleIdleRetirement()
      }
    }
  }

  /**
   * User-triggered authoritative state refresh — the retry for a compaction
   * whose post-completion synchronization failed (sync_pending). Mirrors the
   * command channel's identity guards, then re-reads the state once: a
   * failure rejects so the caller can surface it without looping, and success
   * republishes the snapshot through the runtime's runtime_state event.
   */
  async refreshState(runtimeId: unknown): Promise<RuntimeInfo> {
    this.requireOpen()
    const runtime = this.requireRuntime(runtimeId)
    if (this.retiringRuntimes.has(runtime.runtimeId)) throw new Error('Runtime is being retired')
    if (this.quarantinedRuntimes.has(runtime.runtimeId)) throw new Error('Runtime is quarantined after a session identity change')
    if (this.sessionMutations.has(runtime.runtimeId)) throw new Error('Session identity is being changed')
    return runtime.refreshState()
  }

  private async dispatchCommand(runtimeId: unknown, rawCommand: unknown): Promise<RpcObject> {
    this.requireOpen()
    const runtime = this.requireRuntime(runtimeId)
    if (this.retiringRuntimes.has(runtime.runtimeId)) throw new Error('Runtime is being retired for a branch checkout')
    if (this.quarantinedRuntimes.has(runtime.runtimeId)) throw new Error('Runtime is quarantined after a session identity change')
    const command = await validateRpcCommand(rawCommand, this.validateSessionPath)
    this.requireOpen()
    const policyPrompt = command.type === 'prompt' || command.type === 'steer' || command.type === 'follow_up'
      ? command.message
      : undefined
    if (typeof policyPrompt === 'string') assertNoMcpAuthenticationCommand(policyPrompt)
    // Validation is harness-independent; the harness vocabulary applies after
    // it. set_service_tier passes through untranslated because the fast-mode
    // interception below routes it via runtime.setServiceTier instead.
    const translated = this.adapter.translateCommand(command)
    if (command.type === 'set_model' && this.providers) {
      await this.providers.requireAvailableModel(`${String(command.provider)}/${String(command.modelId)}`)
    }
    if (command.type === 'set_service_tier') {
      const serviceTier = command.serviceTier === 'priority' ? 'priority' : 'default'
      const supported = await runtime.setServiceTier(serviceTier)
      if (!supported) throw new Error('Fast mode is not supported by the selected model')
      return { type: 'response', command: 'set_service_tier', success: true }
    }
    if (Array.isArray(command.images) && command.images.length > 0 && runtime.snapshot().imageInputSupported === false) {
      throw new Error('The active model does not accept images. Choose a vision model and try again.')
    }
    if (this.sessionMutations.has(runtime.runtimeId)) throw new Error('Session identity is being changed')
    // 診斷用 leaf 查詢是唯讀 get_tree；失敗/逾時降級為未知，不阻擋 compact
    if (command.type === 'compact') recordSessionDiagnostic('compact-requested', runtime.snapshot(), undefined, await runtime.readLeafId())
    if (command.type === 'new_session') {
      // new_session 是 renderer 發起的合法身分切換(durable 空邊界):fileless
      // runtime 啟動時已佔一個初始 session 檔,切到新邊界會同時改 sessionId 與
      // 檔案。observeDurableIdentity 對任何 sessionId 變更都視為敵意 drift 而
      // quarantine+retire,導致後續 get_state 以 "Runtime was not found" 失敗
      // (僅在有既有 session 的髒專案重現;e2e 的乾淨暫存目錄摸不到)。與 fork
      // 同模式以 sessionMutations 擋住命令期間的觀測點;成功後撤守前清掉舊
      // durable record,讓下一個 runtime_state 事件走「初次綁定」路徑——
      // runtimeStartListener 重綁 capability 並綁上新身分,與 fileless 啟動後
      // 的第一次事件同語意,絕不觸發敵意身分 quarantine。
      this.sessionMutations.add(runtime.runtimeId)
      try {
        const response = await runtime.command(translated)
        if (isRecord(response) && response.success === true) this.durableIdentityByRuntimeId.delete(runtime.runtimeId)
        return response
      } finally {
        this.sessionMutations.delete(runtime.runtimeId)
      }
    }
    const response = await runtime.command(translated)
    if (command.type === 'compact' && isRecord(response) && response.success === true) {
      // Normal compaction appends to the current file. Read back its record
      // only after OMP confirms the current identity; never synthesize a
      // success from an old file when a state query failed.
      try {
        await runtime.refreshState()
        // 同步後重讀權威 leaf（compaction 會改寫 tree 末端）；失敗同樣降級為未知
        recordSessionDiagnostic('compact-synchronized', runtime.snapshot(), undefined, await runtime.readLeafId())
      } catch {
        recordSessionDiagnostic('compact-sync-pending', runtime.snapshot(), undefined, await runtime.readLeafId())
        this.eventSink({
          runtimeId: runtime.runtimeId,
          event: {
            type: 'notice',
            level: 'warning',
            source: 'desktop.compaction-sync',
            message: 'Compaction completed, but session state could not be synchronized. Refresh the session before continuing; do not repeat compaction.',
          },
        })
        return { ...response, synchronizationPending: true }
      }
      const sessionFile = runtime.snapshot().sessionFile
      if (sessionFile) {
        const record = await this.manualCompactionReader(sessionFile).catch(() => undefined)
        if (record) {
          this.eventSink({
            runtimeId: runtime.runtimeId,
            event: { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: record },
          })
        }
      }
    }
    if (command.type === 'steer' || command.type === 'follow_up') {
      // OMP reports only queuedMessageCount. Refresh after admission so the
      // refreshed count reaches the renderer before a queued row can appear
      // to vanish.
      try {
        const state = await runtime.command({ type: 'get_state' })
        const explicitActions = isRecord(state.data) ? parseSessionActionSnapshot(state.data.sessionActions) : null
        const sessionActions = explicitActions ?? runtime.snapshot().sessionActions
        // Zero without an active-turn marker is not proof that a steer was read.
        if (explicitActions || (sessionActions && sessionActions.queuedCount > 0)) {
          return { ...response, sessionActions }
        }
      } catch { /* action events remain the fallback */ }
      return response
    }
    if (command.type === 'set_model' || command.type === 'cycle_model') {
      const preference = runtime.serviceTierPreference()
      await this.decorate(runtime)
      if (runtime.snapshot().fastModeSupported) await runtime.setServiceTier(preference, true)
    } else if (command.type === 'set_thinking_level' || command.type === 'cycle_thinking_level') await this.decorate(runtime)
    return response
  }

  async runPromptToCompletion(runtimeId: unknown, messageValue: unknown, timeoutMs = 30 * 60_000): Promise<RuntimeInfo> {
    const id = requireId(runtimeId, 'runtimeId')
    const message = requireString(messageValue, 'message', { min: 1, max: 1024 * 1024 })
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60_000) throw new TypeError('Invalid scheduled run timeout')
    const runtime = this.requireRuntime(id)
    const startedAt = Date.now()
    let observedBusy = runtime.snapshot().isStreaming
    await this.command(id, {
      type: 'prompt',
      message,
      streamingBehavior: streamingBehaviorForIntent('queue'),
    })
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise<void>((resolveDelay) => {
        const timer = setTimeout(resolveDelay, 200)
        timer.unref()
      })
      this.requireOpen()
      if (!this.runtimes.has(id)) throw new Error('Scheduled runtime exited before the prompt completed')
      try { await runtime.command({ type: 'get_state' }) } catch { /* the event snapshot may still be authoritative */ }
      const snapshot = runtime.snapshot()
      if (snapshot.isStreaming || snapshot.isCompacting) observedBusy = true
      if (!snapshot.isStreaming && !snapshot.isCompacting && (observedBusy || Date.now() - startedAt >= 750)) return snapshot
    }
    try { await runtime.command({ type: 'abort' }) } catch { /* timeout remains authoritative */ }
    throw new Error('Scheduled run timed out')
  }

  async stop(runtimeId: unknown): Promise<boolean> {
    const id = requireId(runtimeId, 'runtimeId')
    const runtime = this.runtimes.get(id)
    if (!runtime) return false
    if (this.sessionMutations.has(id)) throw new Error('Session identity is being changed')
    return runtime.stop()
  }

  /** Renderer-visible runtime list. Retiring/quarantined runtimes are excluded:
   * commands against them fail by design, so advertising them only invites the
   * renderer to adopt one inside the ~30s stop window and surface a raw
   * "Runtime is being retired" error — the idle-prompt path must instead see
   * them as gone and transparently start a fresh runtime. */
  list(): RuntimeInfo[] {
    return [...this.runtimes.values()].filter((runtime) => !this.retiringRuntimes.has(runtime.runtimeId) && !this.quarantinedRuntimes.has(runtime.runtimeId)).map((runtime) => runtime.snapshot())
  }

  /** Cheap ownership probe for IPC routing; requireRuntime keeps the authoritative not-found error. */
  has(runtimeId: string): boolean { return this.runtimes.has(runtimeId) }

  getForSession(filePath: string): RuntimeInfo | undefined {
    const wanted = canonicalSessionPath(filePath)
    return this.list().find((runtime) => {
      // 遭 quarantine 的 runtime 只等退役;任何檔案(含滾動後的新檔)都不得再導向它。
      if (this.quarantinedRuntimes.has(runtime.runtimeId)) return false
      const sessionFile = runtime.sessionFile
      if (sessionFile !== undefined && canonicalSessionPath(sessionFile) === wanted) return true
      // Before the handshake reports the authoritative file, a starting child
      // is known by the resume path it was spawned with.
      return sessionFile === undefined && this.startSessionPathById.get(runtime.runtimeId) === wanted
    })
  }

  async stopForSession(filePath: string): Promise<void> {
    const wanted = canonicalSessionPath(filePath)
    const matches = [...this.runtimes.values()].filter((runtime) => {
      const path = runtime.snapshot().sessionFile
      return path !== undefined && canonicalSessionPath(path) === wanted
    })
    if (matches.some((runtime) => this.sessionMutations.has(runtime.runtimeId))) throw new Error('Session identity is being changed')
    await Promise.all(matches.map((runtime) => runtime.stop()))
  }

  async stopForProjectRoots(roots: string[]): Promise<void> {
    const matches = [...this.runtimes.values()].filter((runtime) => roots.some((root) => isPathWithin(root, runtime.snapshot().cwd)))
    await Promise.all(matches.map((runtime) => runtime.stop()))
  }

  async renameForSession(filePath: string, title: string): Promise<boolean> {
    this.requireOpen()
    const wanted = canonicalSessionPath(filePath)
    const runtime = [...this.runtimes.values()].find((candidate) => {
      const path = candidate.snapshot().sessionFile
      return path !== undefined && canonicalSessionPath(path) === wanted
    })
    if (!runtime) return false
    const response = await this.command(runtime.runtimeId, { type: 'set_session_name', name: title })
    return response.success === true
  }

  /** Fork through OMP so its hooks, active branch and artifacts share one owner. */
  async forkForSession(filePath: string, cwd: string): Promise<string> {
    const source = await this.validateSessionPath(filePath)
    const started = await this.start({ cwd, sessionPath: source })
    let retiringRuntime: RpcRuntime | undefined
    let retirementFailed = false
    try {
      return await this.withRuntimeAdmission(async () => {
        const runtime = this.requireRuntime(started.runtimeId)
        if (!this.isIdle(runtime)) throw new Error('Session must be idle before creating a fork')
        const currentFile = runtime.snapshot().sessionFile
        if (!currentFile || canonicalSessionPath(currentFile) !== canonicalSessionPath(source)) {
          throw new Error('Session identity changed before creating a fork')
        }
        this.sessionMutations.add(runtime.runtimeId)
        this.commandsInFlight.set(runtime.runtimeId, 1)
        try {
          // Once issued, an unacknowledged mutation may already have changed
          // identity. Never leave source-scoped capabilities on that process.
          retiringRuntime = runtime
          const response = await runtime.command({ type: 'fork' })
          if (response.success !== true) {
            retiringRuntime = undefined
            throw new Error(typeof response.error === 'string' ? response.error : 'OMP could not fork the session')
          }
          if (isRecord(response.data) && response.data.cancelled === true) {
            retiringRuntime = undefined
            throw new Error('Session fork was cancelled')
          }
          const state = await runtime.refreshState()
          if (!state.sessionFile || canonicalSessionPath(state.sessionFile) === canonicalSessionPath(source)) {
            throw new Error('OMP did not confirm the forked session path')
          }
          return await this.validateSessionPath(state.sessionFile)
        } finally {
          // Mark under admission, stop outside it. The close lifecycle revokes
          // browser/collaboration/schedule claims and a later resume mints new ones.
          if (retiringRuntime) this.retiringRuntimes.add(runtime.runtimeId)
          this.sessionMutations.delete(runtime.runtimeId)
          this.commandsInFlight.delete(runtime.runtimeId)
          this.scheduleIdleRetirement()
        }
      })
    } finally {
      // noUnsafeFinally: 不在 finally 內拋出（會遮蔽 try 區塊原本的例外）；
      // 以旗標記下，離開 finally 後再拋。
      retirementFailed = retiringRuntime !== undefined && !await retiringRuntime.stop().catch(() => false)
    }
    if (retirementFailed) {
      throw new Error('The fork may have been created, but its runtime could not be safely retired. Refresh the session list before retrying.')
    }
  }


  async stopAll(): Promise<void> {
    this.beginShutdown()
    const runtimes = [...this.runtimes.values()]
    await Promise.all(runtimes.map((runtime) => runtime.stop()))
  }

  private async retireWhenIdle(runtime: RpcRuntime): Promise<void> {
    const wantedRevision = this.runtimeEnvironmentRevision
    if (!this.runtimes.has(runtime.runtimeId)
      || (this.runtimeEnvironmentRevisions.get(runtime.runtimeId) ?? wantedRevision) >= wantedRevision) return
    if (this.canReclaim(runtime)) {
      if (await this.retireForCheckout(runtime)) return
    }
    const timer = setTimeout(() => { void this.retireWhenIdle(runtime) }, 250)
    timer.unref()
  }

  private async retireForCheckout(runtime: RpcRuntime, eligible: () => boolean = () => true): Promise<boolean> {
    const decision = await this.withRuntimeAdmission(async () => {
      if (!this.runtimes.has(runtime.runtimeId)) return 'gone'
      if (!this.canReclaim(runtime) || !eligible()) return 'busy'
      this.retiringRuntimes.add(runtime.runtimeId)
      return 'retiring'
    })
    if (decision === 'gone') return true
    if (decision === 'busy') return false
    try {
      const stopped = await runtime.stop()
      if (stopped && this.runtimes.get(runtime.runtimeId) === runtime) {
        this.runtimes.delete(runtime.runtimeId)
        this.idleSince.delete(runtime.runtimeId)
      }
      return stopped
    } finally {
      this.retiringRuntimes.delete(runtime.runtimeId)
    }
  }

  private isIdle(runtime: RpcRuntime): boolean {
    if ((this.commandsInFlight.get(runtime.runtimeId) ?? 0) > 0) return false
    if (this.startingRuntimes.has(runtime.runtimeId)) return false
    if (this.retiringRuntimes.has(runtime.runtimeId)) return false
    const snapshot = runtime.snapshot()
    const actions = snapshot.sessionActions
    return !snapshot.isStreaming && !snapshot.isCompacting && !actions?.active
      && (actions?.queuedCount ?? 0) === 0
  }

  /**
   * Automatic reclamation guard: manual mutations (fork) keep the plain idle
   * predicate, while every automatic retire path additionally requires OMP
   * to have authoritatively settled the session with no extension dialog
   * still waiting for a user answer. Unknown settlement fails safe.
   */
  private canReclaim(runtime: RpcRuntime): boolean {
    return this.isIdle(runtime) && runtime.canRetireSafely()
  }

  private requireOpen(): void {
    if (this.closed) throw new Error(`${this.adapter.agentName} manager is shutting down`)
  }

  private retentionOptions(): RuntimeRetentionOptions {
    return typeof this.retention === 'function' ? this.retention() : this.retention
  }

  /** Re-evaluate the idle window after the preference changes. */
  refreshRetention(): void {
    this.scheduleIdleRetirement()
  }

  /** One timer for safely idle children beyond the warm budget, never one polling loop per child. */
  private scheduleIdleRetirement(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.closed) return
    const options = this.retentionOptions()
    const idleMs = options.idleMs ?? 5 * 60_000
    // 0 / non-finite disables automatic retirement entirely (user opted out).
    if (!Number.isFinite(idleMs) || idleMs <= 0) return
    const now = Date.now()
    const idle: RpcRuntime[] = []
    for (const runtime of this.runtimes.values()) {
      if (!this.canReclaim(runtime)) { this.idleSince.delete(runtime.runtimeId); continue }
      if (!this.idleSince.has(runtime.runtimeId)) this.idleSince.set(runtime.runtimeId, now)
      idle.push(runtime)
    }
    const recency = new Map([...this.idleSince.keys()].map((id, index) => [id, index]))
    idle.sort((a, b) => recency.get(b.runtimeId)! - recency.get(a.runtimeId)!)
    const warmCount = options.warmCount ?? 1
    const expiredCandidates = idle.slice(warmCount)
    if (!expiredCandidates.length) return
    const deadline = Math.min(...expiredCandidates.map((runtime) => this.idleSince.get(runtime.runtimeId)! + idleMs))
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      void (async () => {
        const current = this.retentionOptions()
        const currentIdleMs = current.idleMs ?? 5 * 60_000
        if (!Number.isFinite(currentIdleMs) || currentIdleMs <= 0) return
        for (const runtime of expiredCandidates) {
          const since = this.idleSince.get(runtime.runtimeId)
          if (since === undefined || Date.now() - since < currentIdleMs) continue
          // The existing admission barrier marks retiring atomically against new commands.
          try {
            const eligible = () => {
              const recentIdle = [...this.idleSince.keys()].reverse().filter((id) => {
                const candidate = this.runtimes.get(id)
                return candidate !== undefined && this.canReclaim(candidate)
              })
              const since = this.idleSince.get(runtime.runtimeId)
              return since !== undefined && Date.now() - since >= currentIdleMs
                && recentIdle.slice(current.warmCount ?? 1).includes(runtime.runtimeId)
            }
            if (!await this.retireForCheckout(runtime, eligible)) this.idleSince.set(runtime.runtimeId, Date.now())
          } catch (error) {
            this.idleSince.set(runtime.runtimeId, Date.now())
            console.warn('Idle runtime retirement failed:', error)
          }
        }
      })().catch((error) => console.warn('Idle runtime retirement failed:', error)).finally(() => this.scheduleIdleRetirement())
    }, Math.max(0, deadline - now))
    this.idleTimer.unref()
  }

  private async admitRuntime(createRuntime: () => RpcRuntime): Promise<RpcRuntime> {
    return this.withRuntimeAdmission(async () => {
      this.requireOpen()
      // A new session replaces the oldest safely idle child instead of
      // accumulating resident processes. Busy, queued, compacting, and
      // still-starting runtimes remain alive, with no numeric concurrency cap.
      const idle = [...this.runtimes.values()].find((runtime) => this.canReclaim(runtime))
      if (idle) {
        this.retiringRuntimes.add(idle.runtimeId)
        try {
          const stopped = await idle.stop()
          if (stopped && this.runtimes.get(idle.runtimeId) === idle) this.runtimes.delete(idle.runtimeId)
        } finally { this.retiringRuntimes.delete(idle.runtimeId) }
      }
      this.requireOpen()
      const runtime = createRuntime()
      this.runtimes.set(runtime.runtimeId, runtime)
      this.startingRuntimes.add(runtime.runtimeId)
      return runtime
    })
  }

  private async withRuntimeAdmission<T>(action: () => Promise<T>): Promise<T> {
    let releaseAdmission!: () => void
    const previousAdmission = this.runtimeAdmission
    this.runtimeAdmission = new Promise<void>((resolveAdmission) => { releaseAdmission = resolveAdmission })
    await previousAdmission
    try {
      return await action()
    } finally {
      releaseAdmission()
    }
  }

  private async decorate(runtime: RpcRuntime): Promise<void> {
    if (!this.providers) return
    const snapshot = runtime.snapshot()
    const [model, catalog] = await Promise.all([
      this.providers.capabilities(snapshot.model?.provider, snapshot.model?.id),
      this.providers.catalog(),
    ])
    runtime.applyCapabilities(model, catalog.visionDelegation === true)
  }

  private requireRuntime(value: unknown): RpcRuntime {
    const id = requireId(value, 'runtimeId')
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('Runtime was not found')
    return runtime
  }
}
