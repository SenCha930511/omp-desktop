/**
 * Session partition shared by the in-app browser webviews. The renderer's
 * webview attribute must match the main process's will-attach-webview gate
 * exactly, or webview attach is silently blocked.
 */
export const BROWSER_PARTITION = 'persist:omp-desktop-browser'

export type ThemeMode = 'system' | 'light' | 'dark'
export type WorkspaceView = 'session' | 'projects' | 'activity' | 'scheduled' | 'plugins' | 'settings'
export type InspectorTab = 'summary' | 'changes' | 'browser' | 'files'
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'complete' | 'failed' | 'unknown'

export const HARNESS_IDS = ['omp'] as const
export type HarnessId = (typeof HARNESS_IDS)[number]

/**
 * OMP tool-approval preference. 'inherit' defers to OMP's own
 * `~/.omp/agent/config.yml`; the other values are passed to the omp CLI as
 * `--approval-mode` when starting an OMP runtime.
 */
export const OMP_APPROVAL_MODES = ['inherit', 'always-ask', 'write', 'yolo'] as const
export type OmpApprovalMode = (typeof OMP_APPROVAL_MODES)[number]

export interface HarnessStatus {
  path: string | null
  version: string | null
  problem?: {
    path: string
    reason: string
  }
}

export interface AppMeta {
  version: string
  platform: NodeJS.Platform
  homeDir: string
  harnesses: Record<HarnessId, HarnessStatus>
}

export type ApplicationMenuName = 'file' | 'edit' | 'view' | 'window' | 'help'

/** One entry in a native context menu shown at the cursor via `menu.popup`. */
export interface NativeMenuItem {
  id: string
  label: string
  enabled?: boolean
  separator?: boolean
}

export type AppUpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error' | 'unsupported'

export interface AppUpdateState {
  phase: AppUpdatePhase
  version?: string
  percent?: number
  message?: string
}

/** Result of the manual GitHub latest-release check used when the running bundle cannot self-update. */
export interface LatestReleaseCheck {
  currentVersion: string
  latestVersion: string
  newer: boolean
  url: string
}

/** Lifecycle of the `omp update` flow driven from the main process. */
export type HarnessUpdatePhase = 'idle' | 'available' | 'installing' | 'installed' | 'up-to-date' | 'error'

export interface HarnessUpdateState {
  phase: HarnessUpdatePhase
  /** Version of the omp executable the check ran against. */
  currentVersion?: string
  /** Version `omp update --check` reported as installable. */
  availableVersion?: string
  /** Failure detail; present only in the error phase. */
  message?: string
}

export interface ProjectScripts {
  setup: string
  run: string
  /** Exact setup command most recently started for this project. */
  setupLastRun?: string
  /** Missing while the latest setup command is running or was interrupted. */
  setupLastExitCode?: number
}

export interface ProjectRecord {
  id: string
  /** Agent harness this project grant belongs to; grants never cross harnesses. */
  harness: HarnessId
  name: string
  path: string
  folders: string[]
  primaryFolder: string
  pinned: boolean
  createdAt: string
  lastOpenedAt: string
  sessionCount: number
  gitBranch?: string
  inferred?: boolean
  readOnly?: boolean
  scripts?: ProjectScripts
}

export interface SessionRecord {
  id: string
  /** Agent harness that owns this session; populated by the owning session service. */
  harness: HarnessId
  filePath: string
  projectPath: string
  title: string
  createdAt: string
  updatedAt: string
  lastUserMessageAt?: string
  status: SessionStatus
  model?: string
  provider?: string
  thinkingLevel?: string
  depth: number
  /** Session id or absolute path of the session this file continued (fork / context rollover); absent when the file started fresh. */
  parentSession?: string
  /** Tail user message texts (bounded) from the session file; lets the queue panel clear previews the model already received mid-turn. */
  readonly lastUserTexts?: string[]
  /** Pinned sessions sort first in the sidebar; persisted in the app store, not the session file. */
  pinned?: boolean
  unread?: boolean
  /** Monotonic renderer lifecycle revision used to distinguish attention events. */
  eventRevision?: number
  /** Lifecycle revision that authored the current status; absent when the catalog owns it. */
  statusEventRevision?: number
  preview?: string
  archived?: boolean
  syncRevision?: number
}

export interface PromptImage {
  type: 'image'
  mimeType: string
  data: string
}

export interface BrowserAnnotationRect {
  x: number
  y: number
  width: number
  height: number
}

/** Element info captured from the embedded browser page. Every field is untrusted page data: bounded on capture, rendered as plain text only. */
export interface BrowserAnnotationElement {
  selector: string
  tagName: string
  id: string
  classes: string[]
  text: string
  href?: string
  src?: string
  rect: BrowserAnnotationRect
}

export interface BrowserAnnotation {
  id: string
  comment: string
  element: BrowserAnnotationElement
  pageUrl: string
  pageTitle: string
  /** True once the page navigated away after capture: the live marker is gone but the captured info remains valid. */
  stale: boolean
  createdAt: number
}

export type PrimeCompactionReason = 'manual' | 'threshold' | 'overflow' | 'requested'
export type PrimeCompactionStatus = 'running' | 'sync_pending' | 'done' | 'failed' | 'cancelled'
export type PrimeCompactionOutcome = 'failed' | 'cancelled' | 'skipped'

export type MessagePart =
  | { type: 'text'; partId?: string; text: string }
  | { type: 'thinking'; partId?: string; text: string }
  | { type: 'toolCall'; partId?: string; id?: string; name: string; args?: unknown }
  | { type: 'toolResult'; partId?: string; name?: string; text: string; isError?: boolean; streaming?: boolean }
  | { type: 'agentMessage'; partId?: string; text: string; agentName?: string }
  | { type: 'image'; partId?: string; mimeType?: string; data?: string; dataTruncated?: boolean }
  /**
   * 無法呈現內容的 content block（file/audio、extension 自訂 renderer 的資料、
   * provider 專屬 block 等）：保留型別供渲染層標示，data 帶原 block 的
   * bounded pretty JSON，渲染層一律有可讀資料視圖，不靜默丟棄。
   */
  | { type: 'unsupported'; partId?: string; contentType: string; data?: string }
  | {
      type: 'compaction'
      partId?: string
      status: PrimeCompactionStatus
      reason?: PrimeCompactionReason
      outcome?: PrimeCompactionOutcome
      tokensBefore?: number
      tokensAfter?: number
      firstKeptEntryId?: string
      summary?: string
      error?: string
      customInstructions?: string
      willRetry?: boolean
    }

export interface TranscriptMessage {
  /** Renderer-known outcome; absent on legacy harness history. */
  outcome?: 'failed' | 'cancelled'
  id: string
  role: 'user' | 'assistant' | 'agent' | 'goal' | 'tool' | 'system'
  /** Renderer-local steering lifecycle. Persisted transcripts remain harness-owned. */
  steerState?: 'accepted' | 'read'
  /** Renderer-only row markers: consumed-steer boundaries and level-tagged agent notice rows. */
  kind?: 'steer-read-marker' | 'agent-notice' | 'agent-notice-warning' | 'agent-notice-error'
  timestamp?: string | number
  agentName?: string
  startedAt?: string | number
  completedAt?: string | number
  parts: MessagePart[]
  streaming?: boolean
}

export interface PrimeContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export interface SessionUsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** Steering / follow-up 佇列模式(對應上游 set_steering_mode / set_follow_up_mode 的 mode)。 */
export type SessionQueueMode = 'all' | 'one-at-a-time'
/** 中斷模式(對應上游 set_interrupt_mode 的 mode)。 */
export type SessionInterruptMode = 'immediate' | 'wait'
/** Cache warming 覆寫模式(對應上游 set_cache_warming 的 mode;僅本工作階段生效)。 */
export type SessionCacheWarmingMode = 'off' | 'streaming' | 'idle'

/**
 * 目前工作階段的 OMP 設定快照。真相一律在 RPC 側:欄位來自 get_state
 * (OMP 18.13 回報 steeringMode / followUpMode / interruptMode /
 * autoCompactionEnabled);get_state 未回報的項目(autoRetry、cacheWarming)
 * 由 runtime 在 set_* 成功後採用其回聲,尚未讀到時保持 undefined,UI 顯示
 * 「未知」而不是猜測。GUI 不寫任何自有設定檔。
 */
export interface SessionSettingsSnapshot {
  autoCompaction?: boolean
  autoRetry?: boolean
  steeringMode?: SessionQueueMode
  followUpMode?: SessionQueueMode
  interruptMode?: SessionInterruptMode
  cacheWarming?: SessionCacheWarmingMode
}

/** Cumulative cost and token totals for the in-context session, as reported by get_session_stats. */
export interface SessionUsage {
  /** USD cost summed from catalog pricing; null when the harness reports none. */
  cost: number | null
  tokens?: SessionUsageTokens
}

export interface RuntimeInfo {
  configuredThinkingLevel?: PrimeEffortSelector
  /** Became true once the engine resolved the auto thinking level mid-turn in this session. */
  autoThinkingResolved?: boolean
  availableCommands?: import('../lib/slash-commands').SlashCommand[]
  runtimeId: string
  harness: HarnessId
  sessionId?: string
  sessionFile?: string
  cwd: string
  isStreaming: boolean
  sessionActions?: SessionActionSnapshot
  isCompacting?: boolean
  model?: { provider?: string; id?: string; name?: string } | null
  /** Renderer-local notice; never persisted or used to update the model picker. */
  executingModel?: { provider?: string; id: string; label: string; isFallback: true } | null
  thinkingLevel?: string
  availableThinkingLevels?: PrimeThinkingLevel[]
  fastModeSupported?: boolean
  imageInputSupported?: boolean
  fastModeAvailable?: boolean
  serviceTier?: PrimeServiceTier
  /**
   * 上游 SessionState.usageLimit:帳號已進 wrap-up 或 low-priority 期限流時
   * 才回報。顯示之,避免使用者把限流降速誤判為 app bug。
   */
  usageLimit?: UsageLimitState
  /** Session-scoped OMP settings (auto-compaction, queue modes, …); read from get_state / RPC echoes. */
  sessionSettings?: SessionSettingsSnapshot
  contextUsage?: PrimeContextUsage
  sessionUsage?: SessionUsage
  /** Harness-reported output rate of the last turn (tokens/sec); absent before any turn. */
  tokensPerSecond?: number
  /**
   * Renderer-tracked: a compaction finished but the authoritative session
   * state could not be synchronized afterwards. Snapshots from the main
   * process never carry the flag — the next runtime_state clears it — so a
   * manual refresh retry is the way out, never an automatic repeat.
   */
  synchronizationPending?: boolean
}

export const PRIME_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type PrimeThinkingLevel = (typeof PRIME_THINKING_LEVELS)[number]
/** OMP's auto selector is distinct from a model's concrete supported levels. */
export const PRIME_EFFORT_SELECTORS = ['auto', ...PRIME_THINKING_LEVELS] as const
export type PrimeEffortSelector = PrimeThinkingLevel | 'auto'
export const ACCENT_COLORS = ['prime', 'blue', 'teal', 'green', 'orange', 'pink'] as const
export type AccentColor = (typeof ACCENT_COLORS)[number]
export type PrimeServiceTier = 'auto' | 'default' | 'flex' | 'scale' | 'priority' | null
/** 上游 UsageLimitState:請求改走 provider 低優先佇列。 */
export interface UsageLimitLowPriority {
  stage: 'low_priority'
  /** 上限重置時間(epoch 秒)。 */
  resetsAtSec: number
  /** 低優先額度剩餘百分比(上游有回報時)。 */
  allowanceLeftPercent?: number
}
/** 上游 UsageLimitState:超過用量上限後的短暫收尾額度。 */
export interface UsageLimitWrapUp {
  stage: 'wrap_up'
  resetsAtSec?: number
  /** 額度用盡後是否由付費加購用量承接。 */
  extraUsage: boolean
}
export type UsageLimitState = UsageLimitLowPriority | UsageLimitWrapUp
export type ProviderAuthMethod = 'oauth' | 'api_key' | 'external'
export type ProviderAuthSource = 'stored' | 'runtime' | 'environment' | 'prime_cli' | 'fallback' | 'models_json_key' | 'models_json_command' | 'stale'

export interface PrimeModelDescriptor {
  key: string
  provider: string
  id: string
  name: string
  reasoning: boolean
  input: Array<'text' | 'image'>
  contextWindow: number
  maxTokens: number
  availableThinkingLevels: PrimeThinkingLevel[]
  fastModeSupported: boolean
  available: boolean
}

export interface PrimeProviderDescriptor {
  id: string
  name: string
  authMethod: ProviderAuthMethod
  configured: boolean
  authSource?: ProviderAuthSource
  authLabel?: string
  modelCount: number
  availableModelCount: number
}

/** One OMP model preset: a name bound to a full role table and a default thinking level. */
export interface PrimeModelPresetRecord {
  name: string
  modelRoles: Record<string, string>
  defaultThinkingLevel?: string
}

export interface PrimeModelCatalog {
  primeVersion: string
  refreshedAt: string
  models: PrimeModelDescriptor[]
  providers: PrimeProviderDescriptor[]
  warning?: string
  /** OMP harness has a vision model role configured, so images are delegated to it even for text-only models. */
  visionDelegation?: boolean
  /** Saved `modelPresets` from the harness config; absent when none exist or the config is unreadable. */
  presets?: PrimeModelPresetRecord[]
}

export interface PrimeEventEnvelope {
  runtimeId: string
  event: Record<string, unknown>
}

export interface SessionChangeEvent {
  filePath?: string
  /** Harness whose session catalog changed; absent events predate harness scoping. */
  harness?: HarnessId
}

export type SessionCatalogUpdate =
  | { kind: 'snapshot'; revision: number; records: SessionRecord[] }
  | { kind: 'delta'; baseRevision: number; revision: number; upserts: SessionRecord[]; removals: string[] }

export interface SkillRecord {
  id: string
  name: string
  description: string
  kind: 'skill' | 'extension' | 'prompt' | 'package' | 'mcp'
  location: 'bundled' | 'user' | 'project' | 'system'
  path?: string
  enabled: boolean
  icon?: string
  source?: string
  /** MCP server ids this package exists to bridge. Used to collapse duplicate capability rows. */
  associatedMcpServers?: string[]
  associatedPackageSource?: string
  /** Exact bounded map key used only for definition removal; never rendered as display copy. */
  definitionKey?: string
  /** False when an external definition key cannot be represented safely by the app removal API. */
  definitionRemovalAvailable?: boolean
  /**
   * Bounded summary of an mcp.json definition for the structured editor.
   * Header/env values are never included (secrets); only header names so the
   * editor can preserve them on save. Values still carry ${VAR}/!command
   * verbatim — OMP resolves them at load time.
   */
  mcpDefinition?: {
    transport: 'stdio' | 'http' | 'sse'
    command?: string
    args?: string[]
    url?: string
    headerNames?: string[]
    timeout?: number
    requestIdFormat?: 'string' | 'number'
  }
  availability?: {
    available: boolean
    detail: string
    actionUrl?: string
  }
}

export interface PluginWarning {
  scope: 'user' | 'project'
  path: string
  message: string
}

export interface PluginCatalog {
  skills: SkillRecord[]
  warnings: PluginWarning[]
}

/**
 * mcp.json 結構化寫入,對齊上游 mcp-schema.json:stdio→command、http/sse→url,
 * 兩者互斥。網路定義預設只允許 https;純 http 限 loopback/私有網段且須帶
 * allowInsecureHttp 明示確認。headers/command/args 中的 ${VAR} 與 !command
 * 值原樣寫入,由上游載入時解析,OMP Desktop 絕不展開。
 * mode 'replace' 覆寫同名定義(編輯器保存),保留 harness 擁有的 auth/oauth
 * 與未提供的欄位(如 headers、enabled)。
 */
export type McpConnectionInput = {
  name: string
  scope: 'user' | 'project'
  projectPath?: string
  mode?: 'create' | 'replace'
} & (
  | { type: 'stdio'; command: string; args?: string[] }
  | {
      type: 'http' | 'sse'
      url: string
      headers?: Record<string, string>
      timeout?: number
      requestIdFormat?: 'string' | 'number'
      allowInsecureHttp?: boolean
    }
)

export interface McpStateInput {
  name: string
  scope: 'user' | 'project'
  projectPath?: string
  enabled: boolean
}

export interface CapabilityMutationInput {
  kind: 'package' | 'mcp'
  action: 'enable' | 'disable' | 'remove'
  name: string
  /** Exact bounded MCP map key for definition-only removal. */
  definitionKey?: string
  source?: string
  scope: 'user' | 'project'
  projectPath?: string
}

export interface ExtensionInstallInput {
  source: string
  scope: 'user' | 'project'
  projectPath?: string
}

export interface ProjectFileEntry { path: string; type: 'file' | 'directory' }
export interface ProjectFileListing { entries: ProjectFileEntry[]; skipped: number }

export interface GitWorktree {
  path: string
  name: string
  branch?: string
  head: string
  current: boolean
  detached: boolean
}

export const CHECKOUT_STRATEGIES = ['worktree', 'branch'] as const
export type CheckoutStrategy = (typeof CHECKOUT_STRATEGIES)[number]

export interface LocalGitBranch {
  name: string
  current: boolean
}

export type CheckoutCatalog =
  | { strategy: 'worktree'; activePath: string; checkouts: GitWorktree[] }
  | { strategy: 'branch'; activeName: string; checkouts: LocalGitBranch[] }

export type CheckoutAction =
  | { strategy: 'worktree'; operation: 'open'; path: string }
  | { strategy: 'worktree'; operation: 'create'; branch: string }
  | { strategy: 'branch'; operation: 'switch'; branch: string }
  | { strategy: 'branch'; operation: 'create'; branch: string }

export type CheckoutSelection =
  | { strategy: 'worktree'; path: string }
  | { strategy: 'branch'; branch: string }

export type CheckoutRefusalCode =
  | 'strategy-changed'
  | 'active-work'
  | 'dirty-worktree'
  | 'checkout-not-found'
  | 'checkout-already-exists'

export type CheckoutChangeResult =
  | { kind: 'applied'; project: ProjectRecord; checkout: CheckoutSelection }
  | { kind: 'unchanged'; project: ProjectRecord; checkout: CheckoutSelection }
  | { kind: 'cancelled' }
  | { kind: 'refused'; code: CheckoutRefusalCode; message: string }

export interface GitFileChange {
  path: string
  /** Content identity used to detect equal-line-count edits between status snapshots. */
  contentHash?: string
  status: string
  staged: boolean
  additions: number
  deletions: number
}
export interface GitStatus {
  isRepo: boolean
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  files: GitFileChange[]
  truncated?: boolean
  error?: string
}
export interface GitDiff { path?: string; staged: boolean; text: string; truncated: boolean; error?: string }

/**
 * The one result shape for subprocess-backed operations (git commit, package
 * install, MCP settings updates). `reason` classifies failures: the subprocess
 * timed out, exceeded its output limit, exited non-zero, or the operation was
 * blocked before or instead of running the subprocess.
 */
export type ProcessFailureReason = 'timeout' | 'overflow' | 'exit' | 'blocked'
export interface ProcessOutcome { ok: boolean; output: string; reason?: ProcessFailureReason }

export interface TerminalSpawnOptions { cwd: string; sessionPath?: string; clientId?: string; shell?: string; command?: string; cols?: number; rows?: number }
export interface TerminalDataEvent { terminalId: string; clientId?: string; data: string }
export interface TerminalExitEvent { terminalId: string; exitCode: number; signal?: number }
export interface TerminalSelectionContext { tabId: string; label: string; text: string; truncated: boolean }
export interface TerminalPromptContext extends TerminalSelectionContext { cwd?: string }
export interface TerminalActiveContext { label: string; content: string; truncated: boolean }

export type MessageEnterAction = 'queue' | 'steer'
export type PromptDeliveryIntent = 'queue' | 'steer'
export interface QueuedPrompt {
  id: string
  text: string
  intent: PromptDeliveryIntent
  /** Stable presentation data while a steer waits for the agent to pick it up. */
  timestamp?: number
  parts?: MessagePart[]
  /** The most recent automatic flush attempt failed admission. */
  flushAttemptFailed?: boolean
  /** Restored after restart; explicit user confirmation is required before delivery. */
  recovered?: boolean
  deliveryPending?: boolean
}

export interface SessionActionSnapshot {
  queuedCount: number
  steering: string[]
  followUps: string[]
  active?: {
    kind: 'turn' | 'session_command'
    phase: 'preparing' | 'committing' | 'running'
    label?: string
  }
}

export const INTERFACE_FONT_SCALES = [105, 110, 115] as const
export type InterfaceFontScale = typeof INTERFACE_FONT_SCALES[number]
export const LOCALE_PREFERENCES = ['system', 'en', 'zh-CN', 'zh-TW'] as const
export type LocalePreference = typeof LOCALE_PREFERENCES[number]
export const PROJECT_SORT_MODES = ['recent', 'alphabetical'] as const
export type ProjectSortMode = typeof PROJECT_SORT_MODES[number]

export interface AppSettings {
  conversationDensity: 'compact' | 'comfortable'
  subagentsPanelPinned: boolean
  theme: ThemeMode
  locale: LocalePreference
  /** Workspace accent hue; 'prime' keeps the stock purple. */
  accentColor: AccentColor
  /** Bounded interface text scale; 110 is the designed default. */
  interfaceFontScale: InterfaceFontScale
  /** Order the renderer derives for project lists; 'recent' keeps launch behaviour unchanged. */
  projectSortMode: ProjectSortMode
  sidebarOpen: boolean
  inspectorOpen: boolean
  showFileChangesPopup: boolean
  checkoutStrategy: CheckoutStrategy
  /** Keep the desktop process available for scheduled work after its window closes. */
  keepRunningInBackground: boolean
  /** Ask the operating system to launch OMP Desktop when the user signs in. */
  launchAtLogin: boolean
  terminalOpen: boolean
  defaultInspectorTab: InspectorTab
  browserHome: string
  browserAskForDownloads: boolean
  terminalShell: string
  reduceMotion: boolean
  showReasoningSummaries: boolean
  reasoningExpandedByDefault: boolean
  /** Initial reasoning effort for sessions that carry no explicit choice. */
  defaultEffort: PrimeEffortSelector
  showToolCalls: boolean
  messageEnterAction: MessageEnterAction
  /**
   * 輸入快捷鍵預設的遷移版本戳(2.6):缺此欄位代表「尚未套用 TUI 預設」的舊狀態,
   * 遷移時把舊預設值換成新預設並蓋戳;蓋戳後的使用者明確選擇永遠保留,
   * 之後再調整預設也不再覆寫。舊檔無法區分「沿用預設」與「明確選了舊值」,
   * 依審查決議一律視為沿用預設處理。
   */
  inputShortcutsVersion?: number
  /** Optional absolute executable override; blank keeps automatic discovery. */
  runtimePaths: Record<HarnessId, string>
  /**
   * Legacy diagnostics preference retained for persisted-state compatibility.
   * The Privacy UI deliberately ignores this field; any reporting use needs separate review.
   */
  telemetry: boolean
  /** OMP Desktop-managed ask_user tool for interactive sessions. */
  askUserEnabled: boolean
  /** Expose OMP Desktop's thread-scoped in-app browser controls to new sessions. */
  browserEnabled: boolean
  /** Expose the separately installed TryCUA driver to new sessions through its official CLI. */
  computerUseEnabled: boolean
  /** Last usable model selected; blank falls back to the first usable catalog model. */
  lastSelectedModels: Record<HarnessId, string>
  /** Harness whose workspace the renderer shows; always 'omp'. */
  activeHarness: HarnessId
  /** OMP tool-approval override; 'inherit' leaves OMP's own config in charge. */
  ompApprovalMode: OmpApprovalMode
  /** Speech-to-text path used by the composer microphone. */
  voiceTranscriptionProvider: VoiceTranscriptionProvider
  /** Provider model IDs stay configurable without exposing provider credentials. */
  voiceOpenAiLiveTranscriptionModel: string
  voiceOpenAiTranscriptionModel: string
  voiceGroqTranscriptionModel: string
  voiceDeepgramTranscriptionModel: string
  /** User-managed OpenAI-compatible Parakeet or Whisper transcription server. */
  voiceSelfHostedUrl: string
  voiceSelfHostedModel: string
  /** User-managed whisper.cpp installation for offline transcription. */
  voiceLocalWhisperExecutable: string
  voiceLocalWhisperModel: string
}

export const VOICE_TRANSCRIPTION_PROVIDERS = ['openai-live', 'openai', 'groq', 'deepgram', 'self-hosted', 'local-whisper'] as const
export type VoiceTranscriptionProvider = typeof VOICE_TRANSCRIPTION_PROVIDERS[number]
export const VOICE_CREDENTIAL_PROVIDERS = ['openai', 'groq', 'deepgram', 'self-hosted'] as const
export type VoiceCredentialProvider = typeof VOICE_CREDENTIAL_PROVIDERS[number]

export interface VoiceCredentialStorageStatus {
  available: boolean
  message?: string
}

export interface VoiceCredentialStatus {
  configured: Record<VoiceCredentialProvider, boolean>
  source: Partial<Record<VoiceCredentialProvider, 'saved' | 'environment' | 'session'>>
  storage: VoiceCredentialStorageStatus
}

export interface VoiceRealtimeCallRequest {
  mode: 'transcription'
  sdp: string
}

export interface VoiceTranscriptionRequest {
  provider: Exclude<VoiceTranscriptionProvider, 'openai-live'>
  audio: Uint8Array
}

export interface VoiceSelfHostedTestRequest {
  url: string
  model: string
}

export type ScheduleDefinitionStatus = 'active' | 'paused' | 'completed' | 'blocked'
export type ScheduleRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'interrupted' | 'cancelled'
export type ScheduleCreatedBy = 'user' | 'agent'

export type ScheduleTarget =
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; projectId: string; sessionId: string }

export type ScheduleTiming =
  | { kind: 'once'; at: string }
  | { kind: 'rrule'; dtstartLocal: string; timeZone: string; rrule: string }

export interface ScheduleExecution {
  model: 'auto' | string
  thinking: 'auto' | PrimeThinkingLevel
  speed: 'normal' | 'fast'
}

export interface ScheduleRunRecord {
  id: string
  taskId: string
  taskRevision: number
  trigger: 'scheduled' | 'manual'
  scheduledFor: string
  queuedAt: string
  startedAt?: string
  finishedAt?: string
  status: ScheduleRunStatus
  execution: ScheduleExecution
  sessionId?: string
  sessionFile?: string
  error?: string
  skippedCount?: number
}

export interface AutomationScheduleRecord {
  schemaVersion: 1
  id: string
  /** Harness that owns the target, model catalog, and runtime for every run. */
  harness: HarnessId
  revision: number
  title: string
  prompt: string
  target: ScheduleTarget
  timing: ScheduleTiming
  execution: ScheduleExecution
  status: ScheduleDefinitionStatus
  createdBy: ScheduleCreatedBy
  createdAt: string
  updatedAt: string
  nextRunAt?: string
  blockedReason?: string
  runs: ScheduleRunRecord[]
}

export interface ScheduleInput {
  title?: string
  prompt: string
  target: ScheduleTarget
  timing: ScheduleTiming
  execution: ScheduleExecution
  createdBy?: ScheduleCreatedBy
}

export interface SchedulePatch {
  revision: number
  title?: string
  prompt?: string
  target?: ScheduleTarget
  timing?: ScheduleTiming
  execution?: ScheduleExecution
}

export interface SchedulePreview {
  timing: ScheduleTiming
  occurrences: string[]
}

export interface ScheduleChangeEvent {
  taskId?: string
  reason: 'created' | 'updated' | 'deleted' | 'run'
}

/** One agent-controlled browser tab. The registry lives in the main process; the renderer hosts the webview guests and mirrors this state. */
export interface AgentBrowserTabRecord {
  tabId: string
  /** Canonical session file path of the thread this tab belongs to. */
  sessionFile: string
  url: string
  title: string
  /** Whether a live webview guest is currently bound to this tab. */
  attached: boolean
  /** Whether this is the session's currently targeted tab. */
  active: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface AgentBrowserState {
  tabs: AgentBrowserTabRecord[]
}

/** Emitted for every agent browser action, so the UI can surface the Browser panel while the agent works. */
export interface AgentBrowserActivityEvent {
  sessionFile: string
  tabId: string
}

/** Emitted when the agent moves the pointer in a tab, so the UI can animate a synthetic cursor along the same path on the same clock. */
export interface AgentBrowserPointerEvent {
  tabId: string
  sessionFile: string
  /** Previous pointer position, or null when the cursor first appears in a tab. */
  from: { x: number; y: number } | null
  to: { x: number; y: number }
  action: 'move' | 'click' | 'scroll'
  /** How long the glide takes; 0 means the cursor appears in place. */
  durationMs: number
}

// Side questions are the app's vocabulary for the harness's /btw command: a
// quick question that runs beside a live session's main turn. One topic holds
// an opening turn plus follow-up turns (records nested under `followUps`,
// positional — only the last one streams); the harness rejects a second
// question while one is already running in the same session view.
export const SIDE_QUESTION_STATUSES = ['running', 'complete', 'cancelled', 'error', 'interrupted'] as const
export type SideQuestionStatus = (typeof SIDE_QUESTION_STATUSES)[number]
export interface SideQuestionTurn {
  question: string
  answer: string
  status: SideQuestionStatus
  createdAt: number
  updatedAt: number
}
export interface SideQuestionTopic extends SideQuestionTurn {
  id: string
  followUps: SideQuestionTurn[]
}

export interface DesktopApi {
  app: { getMeta(): Promise<AppMeta>; refreshHarnesses(): Promise<{ meta: AppMeta; settings: AppSettings }>; openExternal(url: string): Promise<boolean>; revealPath(path: string): Promise<boolean>; popupMenu(menu: ApplicationMenuName, x: number, y: number): Promise<boolean>; setTitleBarTheme(theme: Exclude<ThemeMode, 'system'>): Promise<boolean>; onOpenSettings(callback: () => void): () => void }
  menu: { popup(items: NativeMenuItem[]): Promise<string | null> }
  updates: {
    getState(): Promise<AppUpdateState>
    check(): Promise<AppUpdateState>
    checkLatestRelease(): Promise<LatestReleaseCheck>
    downloadAndInstall(): Promise<boolean>
    onChanged(callback: (state: AppUpdateState) => void): () => void
  }
  harnessUpdates: {
    getState(): Promise<HarnessUpdateState>
    install(): Promise<HarnessUpdateState>
    onChanged(callback: (state: HarnessUpdateState) => void): () => void
  }
  projects: {
    list(harness?: HarnessId): Promise<ProjectRecord[]>
    listFiles(root: string, harness?: HarnessId): Promise<ProjectFileListing>
    listCheckouts(projectId: string, harness?: HarnessId): Promise<CheckoutCatalog>
    executeCheckout(projectId: string, action: CheckoutAction, harness?: HarnessId): Promise<CheckoutChangeResult>
    add(harness?: HarnessId): Promise<ProjectRecord | null>
    grantInferred(path: string, harness?: HarnessId): Promise<ProjectRecord>
    relocate(id: string, harness?: HarnessId): Promise<ProjectRecord | null>
    remove(id: string, harness?: HarnessId): Promise<boolean>
    touch(id: string, harness?: HarnessId): Promise<boolean>
    setPinned(id: string, pinned: boolean, harness?: HarnessId): Promise<boolean>
    updateScripts(id: string, scripts: Pick<ProjectScripts, 'setup' | 'run'>, harness?: HarnessId): Promise<ProjectScripts>
    markSetupStarted(id: string, setup: string, harness?: HarnessId): Promise<ProjectScripts>
    finishSetup(id: string, setup: string, exitCode: number, harness?: HarnessId): Promise<ProjectScripts | undefined>
  }
  sessions: {
    list(projectPath?: string, includeArchived?: boolean, harness?: HarnessId, force?: boolean): Promise<SessionRecord[]>
    sync(revision?: number, harness?: HarnessId): Promise<SessionCatalogUpdate>
    read(filePath: string): Promise<TranscriptMessage[]>
    rename(filePath: string, title: string): Promise<boolean>
    archive(filePath: string, archived?: boolean): Promise<boolean>
    branch(filePath: string): Promise<SessionRecord>
    setPinned(filePath: string, pinned: boolean): Promise<void>
    delete(filePath: string): Promise<boolean>
    onChanged(callback: (event: SessionChangeEvent) => void): () => void
  }
  agent: {
    start(options: { cwd: string; sessionPath?: string; model?: string; thinking?: string; fast?: boolean; harness?: HarnessId }): Promise<RuntimeInfo>
    command(runtimeId: string, command: Record<string, unknown>): Promise<Record<string, unknown>>
    /** User-triggered authoritative state refresh (compact sync-pending retry); rejects when the runtime or the state read fails. */
    refreshState(runtimeId: string): Promise<RuntimeInfo>
    stop(runtimeId: string): Promise<boolean>
    list(): Promise<RuntimeInfo[]>
    onEvent(callback: (envelope: PrimeEventEnvelope) => void): () => void
  }
  providers: {
    catalog(force?: boolean, harness?: HarnessId): Promise<PrimeModelCatalog>
  }
  voice: {
    credentialStatus(): Promise<VoiceCredentialStatus>
    saveApiKey(provider: VoiceCredentialProvider, apiKey: string): Promise<VoiceCredentialStatus>
    deleteApiKey(provider: VoiceCredentialProvider): Promise<VoiceCredentialStatus>
    createRealtimeCall(request: VoiceRealtimeCallRequest): Promise<string>
    transcribe(request: VoiceTranscriptionRequest): Promise<string>
    testSelfHosted(request: VoiceSelfHostedTestRequest): Promise<boolean>
  }
  terminal: {
    create(options: TerminalSpawnOptions): Promise<{ terminalId: string; shell: string }>
    bindSession(terminalId: string, sessionPath: string): Promise<boolean>
    input(terminalId: string, data: string): void
    acknowledge(terminalId: string, consumedChars: number): void
    resize(terminalId: string, cols: number, rows: number): void
    setActiveContext(terminalId: string, context: TerminalActiveContext): void
    clearActiveContext(terminalId: string): void
    kill(terminalId: string): Promise<boolean>
    onData(callback: (event: TerminalDataEvent) => void): () => void
    onExit(callback: (event: TerminalExitEvent) => void): () => void
  }
  git: { status(cwd: string): Promise<GitStatus>; diff(cwd: string, path?: string, staged?: boolean): Promise<GitDiff>; stage(cwd: string, paths: string[]): Promise<boolean>; unstage(cwd: string, paths: string[]): Promise<boolean>; restore(cwd: string, paths: string[]): Promise<boolean>; commit(cwd: string, message: string): Promise<ProcessOutcome> }
  plugins: {
    list(projectPath?: string, harness?: HarnessId): Promise<PluginCatalog>
    install(source: string, harness?: HarnessId): Promise<ProcessOutcome>
    installExtension(input: ExtensionInstallInput, harness?: HarnessId): Promise<ProcessOutcome>
    connectMcp(input: McpConnectionInput, harness?: HarnessId): Promise<ProcessOutcome>
    setMcpEnabled(input: McpStateInput, harness?: HarnessId): Promise<ProcessOutcome>
    mutateCapability(input: CapabilityMutationInput, harness?: HarnessId): Promise<ProcessOutcome>
    refresh(harness?: HarnessId): Promise<PluginCatalog>
  }
  settings: { get(): Promise<AppSettings>; update(patch: Partial<AppSettings>): Promise<AppSettings>; resetBrowserData(): Promise<boolean> }
  browser: {
    state(): Promise<AgentBrowserState>
    attachTab(tabId: string, webContentsId: number): Promise<boolean>
    selectTab(tabId: string): Promise<boolean>
    closeTab(tabId: string): Promise<boolean>
    setPreviewContext(webContentsId: number | null, sessionFile: string | null): Promise<boolean>
    navigateTab(tabId: string, action: 'back' | 'forward' | 'reload' | 'url', url?: string): Promise<boolean>
    onChanged(callback: (state: AgentBrowserState) => void): () => void
    onPointer(callback: (event: AgentBrowserPointerEvent) => void): () => void
    onActivity(callback: (event: AgentBrowserActivityEvent) => void): () => void
  }
  schedules: {
    list(harness?: HarnessId): Promise<AutomationScheduleRecord[]>
    get(id: string): Promise<AutomationScheduleRecord>
    preview(timing: ScheduleTiming, count?: number): Promise<SchedulePreview>
    create(input: ScheduleInput, harness?: HarnessId): Promise<AutomationScheduleRecord>
    update(id: string, patch: SchedulePatch): Promise<AutomationScheduleRecord>
    pause(id: string): Promise<AutomationScheduleRecord>
    resume(id: string): Promise<AutomationScheduleRecord>
    delete(id: string): Promise<boolean>
    runNow(id: string): Promise<ScheduleRunRecord>
    onChanged(callback: (event: ScheduleChangeEvent) => void): () => void
  }
}

declare global { interface Window { desktop: DesktopApi } }
