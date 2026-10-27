export interface SlashCommand {
  source?: string
  name: string
  description?: string
  aliases?: string[]
  input?: { hint: string }
  subcommands?: Array<{ name: string; description?: string; usage?: string }>
}

export function parseSlashCommands(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) return []
  const text = (raw: unknown) => typeof raw === 'string' ? raw.slice(0, 2_000) : undefined
  return value.slice(0, 1_024).flatMap((item) => {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name || item.name.length > 200) return []
    return [{
      name: item.name,
      source: text(item.source),
      description: text(item.description),
      aliases: Array.isArray(item.aliases) ? item.aliases.filter((alias: unknown): alias is string => typeof alias === 'string').slice(0, 32) : undefined,
      input: typeof item.input?.hint === 'string' ? { hint: text(item.input.hint)! } : undefined,
      subcommands: Array.isArray(item.subcommands) ? item.subcommands.slice(0, 256).flatMap((sub: unknown) => {
        if (!sub || typeof sub !== 'object' || !('name' in sub) || typeof sub.name !== 'string') return []
        return [{ name: sub.name, description: 'description' in sub ? text(sub.description) : undefined, usage: 'usage' in sub ? text(sub.usage) : undefined }]
      }) : undefined,
    }]
  })
}

// RPC advertises only commands with text-mode handlers. These terminal UI
// commands are listed separately and never forwarded as ordinary model input.
//
// 已接出的命令(不再屬於本清單,見 busySlashDisposition 的 gui-action):
// - tree/branch/rewind → 開啟 SessionTreeDialog;get_tree/branch 上游 RPC
//   由 dialog 自處理,絕不送模型。
// - fork → 既有 native full fork(bridge.sessions.branch);上游對進行中
//   session 拒絕 fork(session_busy),故 idle-only、忙碌排隊等 idle。
//   子命令 pane/window/tab 是終端 multiplexer 介面,GUI 無等價,仍屬
//   TUI-only(見 tuiOnlySubcommand)。
// - new → durable newSession 邊界(全新 runtime,不打斷進行中回合)。
// - clear → 同上對應 durable newSession。上游語意已查證(omp 18.13.1):
//   「原地清除對話 context、保留 session」(resetSessionContext,streaming
//   中拒絕,且無 RPC)。GUI 沒有原地清除入口,最接近且不打斷回合的對應
//   就是 durable 新工作階段;session 識別會改變,差異註記於此,不偽裝
//   成上游原地語意。
// - resume → gui-action resume-session(語意是切換):上游 bare /resume 開
//   啟 session 選擇器、/resume <id> 直接切換;GUI 對應為開啟 sidebar 工作
//   階段清單,或以 id/title/路徑比對既有 catalog 後走 selectSession +
//   --resume 的既有流程。工作區切換不打斷進行中的 runtime,忙碌時可直接
//   分派;@claude/@codex 目標為其他 harness,桌面版不支援。
// - help → respond-local:以目錄(INITIAL 後備 + GUI 入口)列出可用命令,
//   等同 TUI 說明畫面的資訊呈現,取代 overlay。
// - login/logout → gui-action provider-accounts:開啟 Capabilities 頁的
//   provider 帳號面板(上游 login/get_login_providers/get_logout_accounts/
//   logout RPC 已在 command-schema 開放;流程走既有 extension_ui 的
//   open_url + input,憑證 OMP custody)。查詢與認證 RPC 都是 busy-safe,
//   因此忙碌時同樣立即開啟面板。
// 維持擋住、缺口記錄於此:
// - /todo edit|expand|collapse 與 /advisor configure:見 tuiOnlySubcommand。
export const DEFERRED_SLASH_COMMANDS = [
  'theme', 'settings', 'config', 'hotkeys',
  'quit', 'q', 'exit', 'delete', 'live', 'record',
  'setup', 'providers', 'extensions', 'agents', 'git', 'hub',
] as const

// 上游 v18.12.6 RPC 命令表沒有 plan / plan-review / vibe / guided-goal / loop /
// queue 對應的 RPC(僅 TUI handleTui),GUI 也未自建生命週期,維持擋住、
// 不偽裝成可用。/queue:上游同樣無檢視 RPC;composer 的 queue chips 已能
// 顯示並操作 steering/followUp 佇列,但沒有可由文字命令展開的獨立檢視區塊,
// 因此 /queue 維持擋住——缺口記錄於此與 docs/gui-tui-parity-audit。
export const DEFERRED_TUI_MODES = ['plan', 'plan-review', 'vibe', 'guided-goal', 'loop', 'queue'] as const

export function parseSlashInvocation(prompt: string): { name: string; args: string } | undefined {
  const match = /^\/([^\s:]+)(?:[\s:]([\s\S]*))?$/.exec(prompt.trim())
  return match ? { name: match[1], args: match[2]?.trim() ?? '' } : undefined
}

/**
 * 以 live catalog 把別名反查回主命令名(上游 builtin-registry 的 Wd 以
 * 主名與 aliases 指向同一命令,catalog 同樣帶 aliases 欄位)。
 * GUI 不維護別名對照表——上游新增別名時隨 catalog 一併到達。
 * 未命中 catalog(尚未載入、未知命令)維持原小寫名。
 */
export function canonicalSlashName(name: string, catalog?: readonly SlashCommand[]): string {
  const lower = name.toLowerCase()
  if (!catalog) return lower
  for (const command of catalog) {
    if (command.name.toLowerCase() === lower) return command.name.toLowerCase()
    if (command.aliases?.some((alias) => alias.toLowerCase() === lower)) return command.name.toLowerCase()
  }
  return lower
}

// --- /compact 解析(與上游 compact-modes.ts 的 Yke/Kke/Ale 同語意) ---
//
// 上游(omp 18.13.1,packages/coding-agent/src/session/compact-modes.ts):
// - 第一個空白 token 不分大小寫比對 soft|remote|snapcompact;
// - 命中模式 → { mode, instructions? },其餘文字為該模式的 focus 指示;
// - snapcompact 標明 rejectsFocus:帶指示是用法錯誤(不接受參數);
// - 第一個 token 不是模式時,整段視為自定指示(customInstructions)。
// RPC `compact` 命令只接受 customInstructions(上游 RPC 命令表),不承載
// 模式——模式命令必須由送出端原樣交給上游 slash dispatcher(prompt 路徑)。
export type CompactCommandMode = 'soft' | 'remote' | 'snapcompact'

const COMPACT_MODES: ReadonlyMap<string, CompactCommandMode> = new Map<CompactCommandMode, CompactCommandMode>([
  ['soft', 'soft'],
  ['remote', 'remote'],
  ['snapcompact', 'snapcompact'],
])

export type ParsedCompactCommand =
  | { kind: 'rpc'; customInstructions?: string }
  | { kind: 'mode'; mode: CompactCommandMode }
  // 上游 rejectsFocus:snapcompact 只做點陣圖歸檔(沒有 LLM 摘要),不接受指示。
  | { kind: 'error'; error: 'snapcompact-focus' }

export function parseCompactCommand(prompt: string): ParsedCompactCommand | undefined {
  const trimmed = prompt.trim()
  if (trimmed === '/compact') return { kind: 'rpc' }
  if (!trimmed.toLowerCase().startsWith('/compact ')) return undefined
  const rest = trimmed.slice(9).trim()
  if (!rest) return { kind: 'rpc' }
  const space = rest.search(/\s/)
  const firstToken = (space < 0 ? rest : rest.slice(0, space)).toLowerCase()
  const mode = COMPACT_MODES.get(firstToken)
  if (!mode) return { kind: 'rpc', customInstructions: rest }
  const instructions = space < 0 ? '' : rest.slice(space + 1).trim()
  if (instructions) return mode === 'snapcompact' ? { kind: 'error', error: 'snapcompact-focus' } : { kind: 'mode', mode }
  return { kind: 'mode', mode }
}

// 其餘 /todo 子命令(檢視、done 等)仍可轉送上游文字處理器;edit|expand|
// collapse 需要 set_todos RPC,上游 command-schema 未開放,維持擋住
// (不另開 command-schema——超出本項範圍,如需另案處理)。
// - /advisor configure 是上游 overlay,無對應 RPC,同樣維持擋住。
// - /fork pane|window|tab 是終端 multiplexer 分頁介面,GUI 無等價;bare
//   /fork(native full fork)已由 gui-action 接出,不在此擋。
export function tuiOnlySubcommand(name: string, args: string): boolean {
  const verb = args.split(/\s+/)[0].toLowerCase()
  return (name === 'todo' && ['edit', 'expand', 'collapse'].includes(verb))
    || (name === 'advisor' && verb === 'configure')
    || (name === 'fork' && ['pane', 'window', 'tab'].includes(verb))
}

/**
 * Commands the desktop runs as side effects rather than conversation. Their
 * results are already visible in the dedicated chrome (the model picker
 * reflects the switched preset), so the command chip would be pure noise.
 * Matches both picker-initiated and manually typed invocations.
 */
export const isBackgroundedSlashCommand = (prompt: string): boolean => /^\/modelpreset\s+switch\s+\S/.test(prompt.trim())

export function deferredSlashCommand(prompt: string, catalog?: readonly SlashCommand[]): string | undefined {
  const invocation = parseSlashInvocation(prompt)
  if (!invocation) return
  // 上游別名(/q、/providers、/rewind …)正規化後再分類;catalog 未載入時
  // 退回既有小寫 name,DEFERRED 清單裡的手寫別名仍兜底。GUI 自有命令
  // 優先以打出原名判定(/status 恰好也是上游 extensions 的別名)。
  const typedName = invocation.name.toLowerCase()
  const name = canonicalSlashName(typedName, catalog)
  if (tuiOnlySubcommand(typedName, invocation.args) || tuiOnlySubcommand(name, invocation.args)) return `${invocation.name} ${invocation.args}`
  // 打出原名優先:/providers 本身在 DEFERRED,即使上游某命令把它當別名也不得改判。
  return [...DEFERRED_SLASH_COMMANDS, ...DEFERRED_TUI_MODES].find((command) => command === typedName) ?? [...DEFERRED_SLASH_COMMANDS, ...DEFERRED_TUI_MODES].find((command) => command === name)
}

// Useful before the first runtime starts; a live catalog replaces this list.
export const INITIAL_SLASH_COMMANDS: SlashCommand[] = [
  ['model', 'Show current model'], ['switch', 'Switch model: provider/model'],
  ['effort', 'Set reasoning effort'], ['fast', 'Fast mode: on | off | status'],
  ['modelpreset', 'Manage model presets'],
  ['context', 'Show context usage'], ['tools', 'Show available tools'],
  ['session', 'Show session information'], ['usage', 'Show provider usage'],
  ['jobs', 'Show background jobs'], ['compact', 'Compact conversation'],
  ['handoff', 'Summarize and compact in place'], ['fresh', 'Reset provider stream state'],
  ['shake', 'Remove heavy context'], ['retry', 'Retry last failed turn'],
  ['rename', 'Rename session'], ['goal', 'Goal mode: show | set | pause | resume | drop'],
  ['pause', 'Pause the session goal'], ['todo', 'Manage todos'], ['memory', 'Manage memory'],
  ['mcp', 'Manage MCP servers'], ['ssh', 'Manage SSH connections'],
  ['plugins', 'Manage plugins'], ['marketplace', 'Manage marketplaces'],
  ['reload-plugins', 'Reload plugins'], ['export', 'Export HTML'],
  ['dump', 'Export transcript'], ['changelog', 'Show changelog'],
  ['advisor', 'Advisor: on | off | status'], ['skillful', 'Toggle skill listing'],
  ['extended-context', 'Toggle extended context'], ['dirs', 'List workspace directories'],
  ['add-dir', 'Add workspace directory'], ['remove-dir', 'Remove workspace directory'],
  ['btw', 'Open side questions'],
].map(([name, description]) => ({ name, description, source: 'builtin' }))

export function slashSuggestions(commands: SlashCommand[], value: string) {
  const rawQuery = value.slice(1).toLowerCase()
  const colon = rawQuery.indexOf(':')
  const query = colon >= 0 && commands.some((item) => item.subcommands && (item.name === rawQuery.slice(0, colon) || item.aliases?.includes(rawQuery.slice(0, colon))))
    ? `${rawQuery.slice(0, colon)} ${rawQuery.slice(colon + 1)}` : rawQuery
  const [name, ...args] = query.split(/\s+/)
  if (args.length) {
    const command = commands.find((item) => item.name === name || item.aliases?.includes(name))
    return (command?.subcommands ?? []).filter((item) => item.name.startsWith(args.join(' '))).map((item) => ({
      command: `/${name} ${item.name}`, detail: [item.description, item.usage].filter(Boolean).join(' · '),
    }))
  }
  return commands.filter((item) => item.name.startsWith(query) || item.aliases?.some((alias) => alias.startsWith(query))).map((item) => ({
    command: `/${item.aliases?.find((alias) => alias.startsWith(query)) && !item.name.startsWith(query) ? item.aliases.find((alias) => alias.startsWith(query)) : item.name}`,
    detail: [item.description, item.input?.hint].filter(Boolean).join(' · '),
  }))
}

// --- 忙碌時的 slash 分派 ---
//
// 忙碌(turn 進行中)不再一律排隊等 idle,依命令語意分三類:
// - respond-local:TUI overlay 型唯讀查詢。上游 busy 時會拒絕無
//   streamingBehavior 的 prompt,但這些命令的資料本就來自 get_state /
//   get_session_stats / 服務層級快照(全部唯讀、busy 可用),GUI 直接以
//   runtime 快照本地呈現,不送 RPC。/status 因上游 RPC 無文字處理器,
//   空閒時也走同一本地路徑(slash 與 GUI 操作共用入口)。
// - agent-control:agent 控制有專用 busy-safe RPC(/pause、/goal get 對應
//   goal RPC),runtime 忙碌時直接送達。
// - queue-until-idle:其餘命令上游 busy 語意未查證,保守維持排隊等 idle。
/** GUI 自有入口處理的 slash 動作:不送模型,由 sendPrompt 直接分派。 */
export type GuiSlashAction =
  // tree/branch/rewind → 開啟 SessionTreeDialog(dialog 自處理上游
  // get_tree/branch RPC;branch 忙碌時可用,因此忙碌也可立即開啟)。
  | 'session-tree'
  // fork → native full fork(既有 branchSession);上游對進行中 session
  // 拒絕 fork(session_busy),分派端在忙碌時排隊等 idle 才執行。
  | 'fork'
  // new/clear → durable newSession 邊界(全新 runtime,不中斷進行中回合)。
  | 'new-session'
  // resume → 既有「選取 session + --resume 啟動」切換流程(target 為使用者
  // 指定的 session 識別:bare 開啟 sidebar 選取)。語意是工作區切換,不中
  // 斷進行中的 runtime,忙碌時可直接分派。
  | 'resume-session'
  // login/logout → 開啟 Capabilities 頁的 provider 帳號面板(查詢/認證
  // RPC 皆 busy-safe,忙碌時立即開啟)。
  | 'provider-accounts'

export type BusySlashDisposition =
  | { kind: 'respond-local' }
  | { kind: 'agent-control'; command: Record<string, unknown> }
  | { kind: 'gui-action'; action: GuiSlashAction; target?: string }
  | { kind: 'queue-until-idle' }
  // /goal 用法錯誤(缺 objective、不支援的 budget 子命令等):不送上游、
  // 也不排隊(idle 後會把用法錯字送成模型輸入),原地以 i18n hint 回報。
  | { kind: 'goal-usage-error'; messageKey: string }

// --- /goal、/pause → goal RPC 的對照 ---
//
// 上游 v18.12.6 已有原生 goal RPC(rpc-goal.handle),其文字命令只有 TUI
// handleTui(/goal、/pause 均無 text-mode handle),因此不論忙碌或空閒,
// 一律走專用 RPC,不能把 /goal … 文字送給模型。
// 上游目標子命令語彙為 set/show/pause/resume/drop;RPC op 語彙為
// get/create/resume/pause/drop,兩邊都接受:show/get、set/create 互通。
// - 裸 /goal 與 /goal show、/goal get → op get(沿用 TUI 顯示目標的語意,
//   以 RPC 唯一讀取操作對齊)。
// - /goal set|create <objective> 或 /goal <objective> → op create;
//   缺 objective 是用法錯誤。
// - /goal budget … 在上游 RPC 只能於 create 時帶 token_budget,無法調整既有
//   目標的預算 → 回報不支援,不靜默忽略。
// 上游 rpc-goal.handle 只等 exit/reconcile settle、不依 streaming 擋命令
// (create 於串流中直接以 steer 補上下文),故 create/resume/drop 亦屬
// busy-safe,全部以 agent-control 即時送達(/goal drop 由 UI 先確認)。
export type GoalSlashDispatch =
  | { kind: 'rpc'; command: Record<string, unknown> }
  | { kind: 'error'; messageKey: string }

export function goalSlashDispatch(name: string, args: string): GoalSlashDispatch | undefined {
  const lowerName = name.toLowerCase()
  if (lowerName === 'pause') return args ? undefined : { kind: 'rpc', command: { type: 'goal', op: 'pause' } }
  if (lowerName !== 'goal') return undefined
  const space = args.search(/\s/)
  const verb = (space < 0 ? args : args.slice(0, space)).toLowerCase()
  const rest = space < 0 ? '' : args.slice(space).trim()
  switch (verb) {
    case '':
    case 'show':
    case 'get':
    case 'status':
      return rest ? { kind: 'error', messageKey: 'goal.error.usage' } : { kind: 'rpc', command: { type: 'goal', op: 'get' } }
    case 'pause':
      return rest ? { kind: 'error', messageKey: 'goal.error.usage' } : { kind: 'rpc', command: { type: 'goal', op: 'pause' } }
    case 'resume':
      return rest ? { kind: 'error', messageKey: 'goal.error.usage' } : { kind: 'rpc', command: { type: 'goal', op: 'resume' } }
    case 'drop':
      return rest ? { kind: 'error', messageKey: 'goal.error.usage' } : { kind: 'rpc', command: { type: 'goal', op: 'drop' } }
    case 'budget':
      return { kind: 'error', messageKey: 'goal.error.budgetUnsupported' }
    case 'set':
    case 'create':
      return rest ? { kind: 'rpc', command: { type: 'goal', op: 'create', objective: rest } } : { kind: 'error', messageKey: 'goal.error.createNeedsObjective' }
    default:
      // 直接接 objective 的形式(/goal fix the flaky tests)沿用 TUI inlineHint
      // 「[objective]」語意,視為 set。
      return rest ? { kind: 'rpc', command: { type: 'goal', op: 'create', objective: args } } : { kind: 'error', messageKey: 'goal.error.usage' }
  }
}

// 無論忙碌與否都以本地快照回應(上游沒有對應的文字命令)。/help 取代
// TUI 說明畫面,同樣空閒時也走本地路徑。
const ALWAYS_LOCAL_SLASH_COMMANDS = new Set(['status', 'help'])
// 空閒時交給上游文字處理器(輸出更詳細),忙碌時改以本地快照回應。
const BUSY_LOCAL_SLASH_COMMANDS = new Set(['context', 'usage', 'model', 'session'])

/** /status 這類在空閒時也必須本地處理的唯讀命令。 */
export function alwaysLocalSlashCommand(name: string, catalog?: readonly SlashCommand[]): boolean {
  // 打出原名優先:/status 是 GUI 自有命令,恰好也是上游 extensions 的別名;
  // 上游 dispatch 才以主名為主鍵。
  return ALWAYS_LOCAL_SLASH_COMMANDS.has(name) || ALWAYS_LOCAL_SLASH_COMMANDS.has(canonicalSlashName(name, catalog))
}

export function busySlashDisposition(prompt: string, catalog?: readonly SlashCommand[]): BusySlashDisposition {
  const invocation = parseSlashInvocation(prompt)
  if (!invocation) return { kind: 'queue-until-idle' }
  // 上游 dispatch 以主名為主鍵、別名指向同一命令;GUI 分類以 catalog 反查
  // 主名,同時保留打出原名(GUI 自有命令如 /status 優先於上游同名別名)。
  const typedName = invocation.name.toLowerCase()
  const name = canonicalSlashName(typedName, catalog)
  const args = invocation.args
  const either = (...names: readonly string[]) => names.some((n) => n === typedName || n === name)
  if (!args && [...ALWAYS_LOCAL_SLASH_COMMANDS, ...BUSY_LOCAL_SLASH_COMMANDS].some((command) => either(command))) return { kind: 'respond-local' }
  // /fast status 只查詢目前的服務層級,不是切換。
  if (name === 'fast' && args.toLowerCase() === 'status') return { kind: 'respond-local' }
  // /help 帶參數時同樣本地呈現(TUI 說明畫面不因主題參數改變資料來源)。
  if (either('help')) return { kind: 'respond-local' }
  // GUI 自有入口:tree/branch/rewind 開啟 SessionTreeDialog、new/clear 建立
  // durable 邊界、fork 走 native full fork(idle-only)、resume 切換既有
  // 工作階段,一律不送模型。
  if (either('tree', 'branch', 'rewind')) return { kind: 'gui-action', action: 'session-tree' }
  if (either('fork')) return { kind: 'gui-action', action: 'fork' }
  if (either('new')) return { kind: 'gui-action', action: 'new-session' }
  // /clear:上游語意已查證為原地清除 context、保留 session(resetSession
  // Context,無 RPC);GUI 無原地清除入口,以 durable 新工作階段對應。
  if (either('clear')) return { kind: 'gui-action', action: 'new-session' }
  // /resume 語意是切換到既有工作階段;target 帶給分派端做 catalog 比對。
  if (either('resume')) return { kind: 'gui-action', action: 'resume-session', target: args || undefined }
  // /login /logout:上游查詢與認證 RPC 皆非 session-mutation(busy-safe),
  // 一律開啟 provider 帳號面板,絕不把參數送進模型;providerId 等參數由
  // 面板上的操作攜帶。
  if (either('login', 'logout')) return { kind: 'gui-action', action: 'provider-accounts' }
  // goal RPC 在 command-schema 已開放;/goal 各 op 與 /pause 皆 busy-safe,
  // 一律立即送達,用法錯誤原地回報。/pause 對映上游 TUI 的凍結畫面;
  // RPC 主機可用的等價介入是 goal pause(暫停目標續行),註記於上。
  const goalDispatch = goalSlashDispatch(typedName, args) ?? goalSlashDispatch(name, args)
  if (goalDispatch?.kind === 'rpc') return { kind: 'agent-control', command: goalDispatch.command }
  if (goalDispatch?.kind === 'error') return { kind: 'goal-usage-error', messageKey: goalDispatch.messageKey }
  return { kind: 'queue-until-idle' }
}

/**
 * 依命令能力判斷 slash 命令是否承載圖片附件(上游源碼語意):
 * - skill 命令(source 'skill'):上游 runRpcSkillCommand 把圖片併入
 *   promptCustomMessage 的 content([{type:'text'}, ...images])→ 接受;
 * - 模板展開型命令(source 'file'|'custom'|'mcp_prompt'):handle 只回傳
 *   { prompt },上游 prompt 派發在展開後仍把原 images 併入同一個
 *   t.prompt → 接受;
 * - builtin / extension:命令在本地消化,上游會靜默丟棄圖片 → GUI 拒絕
 *   (比上游靜默丟棄更安全);
 * - catalog 未載入(尚未有 runtime)時保守拒絕。
 * /compact 由 parseCompactCommand 先行接管,其 catalog 條目是 builtin,
 * 在本函式同樣回傳 false。
 */
export function slashCommandAcceptsImages(prompt: string, catalog?: readonly SlashCommand[]): boolean {
  const match = /^\/(\S+)/.exec(prompt.trim())
  if (!match) return false
  const typed = match[1].toLowerCase()
  const command = catalog?.find((candidate) => candidate.name.toLowerCase() === typed || candidate.aliases?.some((alias) => alias.toLowerCase() === typed))
  return command?.source === 'skill' || command?.source === 'file' || command?.source === 'custom' || command?.source === 'mcp_prompt'
}
