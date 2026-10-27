/**
 * GUI extension capability registry (parity audit phase 6.3).
 *
 * Single source of truth for which upstream extension API surfaces this app
 * supports, degrades to a data view, or explicitly does not support. Evidence
 * refers to oh-my-pi v18.12.6 (commit 45c35e4) paths; the DOC counterpart is
 * docs/gui-extension-contract.md.
 *
 * Status semantics:
 * - supported:    the capability has a complete, verified GUI surface.
 * - degraded:     the capability reaches the GUI in a reduced (data-only) form;
 *                 the reduced form is itself rendered, not dropped.
 * - unsupported:  no GUI surface exists. Wire frames that do reach the app are
 *                 surfaced as an explicit notice (never silently swallowed);
 *                 capabilities that never emit wire frames are documented here
 *                 and in the contract document instead.
 */

export type ExtensionCapabilityStatus = 'supported' | 'degraded' | 'unsupported'

export interface ExtensionCapability {
  /** Stable registry id. */
  id: string
  /** Upstream API surface (`ui.*` = ExtensionUIContext, `api.*` = ExtensionAPI). */
  surface: string
  status: ExtensionCapabilityStatus
  /** How/where the GUI presents this capability (or why it cannot). */
  presentation: string
  /** Upstream evidence as path:line under packages/coding-agent/. */
  upstream: string
}

export const EXTENSION_CAPABILITIES: readonly ExtensionCapability[] = [
  // -------------------------------------------------------------------
  // Dialog requests (answered via extension_ui_response) — 3.5/3.6 scope
  // -------------------------------------------------------------------
  {
    id: 'dialog-select',
    surface: 'ui.select',
    status: 'supported',
    presentation: 'ExtensionUiModal 選擇對話框（含 optionDetails 與 questionnaire）',
    upstream: 'src/extensibility/extensions/types.ts:308',
  },
  {
    id: 'dialog-confirm',
    surface: 'ui.confirm',
    status: 'supported',
    presentation: 'ExtensionUiModal 確認對話框',
    upstream: 'src/extensibility/extensions/types.ts:315',
  },
  {
    id: 'dialog-input',
    surface: 'ui.input',
    status: 'supported',
    presentation: 'ExtensionUiModal 單行輸入對話框',
    upstream: 'src/extensibility/extensions/types.ts:320',
  },
  {
    id: 'dialog-editor',
    surface: 'ui.editor',
    status: 'supported',
    presentation: 'ExtensionUiModal 多行編輯對話框',
    upstream: 'src/extensibility/extensions/types.ts:389',
  },
  {
    id: 'dialog-ask',
    surface: 'ui.askDialog',
    status: 'supported',
    presentation: 'ExtensionUiModal 豐富問卷對話框（host 以 set_ask_dialog 宣告後啟用）',
    upstream: 'src/extensibility/extensions/types.ts:323',
  },
  {
    id: 'dialog-approve',
    surface: 'ui.approve',
    status: 'degraded',
    presentation: '上游 RPC host 未實作 approve，呼叫端統一降級為 select，GUI 以選擇對話框呈現',
    upstream: 'src/extensibility/extensions/types.ts:337',
  },
  {
    id: 'dialog-cancel',
    surface: '(wire) cancel frame',
    status: 'supported',
    presentation: '上游自行結算對話時關閉 GUI 端待回應請求',
    upstream: 'src/modes/rpc/rpc-types.ts:729',
  },

  // -------------------------------------------------------------------
  // Presentation frames (fire-and-forget)
  // -------------------------------------------------------------------
  {
    id: 'notify',
    surface: 'ui.notify',
    status: 'supported',
    presentation: '導入指令輸出面板（useAgentEvents.ts:128）',
    upstream: 'src/modes/rpc/rpc-mode.ts:1487',
  },
  {
    id: 'status',
    surface: 'ui.setStatus',
    status: 'supported',
    presentation: 'composer 上方狀態列項目',
    upstream: 'src/modes/rpc/rpc-mode.ts:1498',
  },
  {
    id: 'widget-lines',
    surface: 'ui.setWidget (string[] content)',
    status: 'supported',
    presentation: 'composer 上/下方多行文字面板（依 widgetPlacement 分流）',
    upstream: 'src/modes/rpc/rpc-mode.ts:1513',
  },
  {
    id: 'widget-factory',
    surface: 'ui.setWidget (component factory)',
    status: 'unsupported',
    presentation: '上游 RPC mode 直接忽略元件工廠，wire 上不存在；extension 應以字行內容提供降級',
    upstream: 'src/modes/rpc/rpc-mode.ts:1513',
  },
  {
    id: 'editor-text',
    surface: 'ui.setEditorText / ui.pasteToEditor',
    status: 'degraded',
    presentation: '預覽卡片＋使用者明確套用/關閉；pasteToEditor 上游降級成 set_editor_text',
    upstream: 'src/modes/rpc/rpc-mode.ts:1552',
  },
  {
    id: 'open-url',
    surface: '(wire) open_url frame',
    status: 'supported',
    presentation: '安全網址卡片（僅 http/https），供 OAuth 等流程手動開啟',
    upstream: 'src/modes/rpc/rpc-mode.ts:2550',
  },
  {
    id: 'window-title',
    surface: 'ui.setTitle',
    status: 'unsupported',
    presentation: '視窗標題由 GUI 自主管理；收到 frame 時顯示明確不支援徽章。上游預設也不送（PI_RPC_EMIT_TITLE opt-in）',
    upstream: 'src/modes/rpc/rpc-mode.ts:1536',
  },

  // -------------------------------------------------------------------
  // Upstream RPC stubs (never emit wire frames — doc-level only)
  // -------------------------------------------------------------------
  {
    id: 'working-message',
    surface: 'ui.setWorkingMessage',
    status: 'unsupported',
    presentation: '上游 RPC host 全程忽略，無 wire frame；GUI 工作訊息為本機渲染',
    upstream: 'src/modes/rpc/rpc-mode.ts:1509',
  },
  {
    id: 'terminal-input',
    surface: 'ui.onTerminalInput',
    status: 'unsupported',
    presentation: '上游 RPC mode 無終端輸入通道（no-op），無法由 GUI 補足',
    upstream: 'src/modes/rpc/rpc-mode.ts:1482',
  },
  {
    id: 'custom-component',
    surface: 'ui.custom',
    status: 'unsupported',
    presentation: '上游直接 reject；TUI 元件樹無法序列化跨行程。需上游宣告式元件協定（見 contract 文件）',
    upstream: 'src/modes/rpc/rpc-mode.ts:1547',
  },
  {
    id: 'header-footer',
    surface: 'ui.setHeader / ui.setFooter',
    status: 'unsupported',
    presentation: '上游 RPC mode 忽略；GUI 版面固定，可考慮以 status/widget 字行類管道取代',
    upstream: 'src/modes/rpc/rpc-mode.ts:1528',
  },
  {
    id: 'editor-component',
    surface: 'ui.setEditorComponent',
    status: 'unsupported',
    presentation: '上游 RPC mode 忽略；GUI composer 為 Web 元件，無 CustomEditor 對應',
    upstream: 'src/modes/rpc/rpc-mode.ts:1612',
  },
  {
    id: 'autocomplete-provider',
    surface: 'ui.addAutocompleteProvider',
    status: 'unsupported',
    presentation: '文件明定 headless/RPC 模式接受並忽略；無 wire 補全請求通道',
    upstream: 'src/extensibility/extensions/types.ts:399',
  },
  {
    id: 'open-terminal',
    surface: 'ui.openTerminal',
    status: 'unsupported',
    presentation: 'RPC host 未實作此可選方法（缺省即不支援），extension 須自備降級',
    upstream: 'src/extensibility/extensions/types.ts:317',
  },
  {
    id: 'theme-api',
    surface: 'ui.theme / getAllThemes / getTheme / setTheme',
    status: 'unsupported',
    presentation: '上游回傳固定 theme 或錯誤；GUI 主題由本機設定管理',
    upstream: 'src/modes/rpc/rpc-mode.ts:1586',
  },
  {
    id: 'tools-expanded',
    surface: 'ui.getToolsExpanded / setToolsExpanded',
    status: 'unsupported',
    presentation: '上游 RPC host 回傳固定值並忽略寫入',
    upstream: 'src/modes/rpc/rpc-mode.ts:1603',
  },
  {
    id: 'get-editor-text',
    surface: 'ui.getEditorText（RPC 同步語意）',
    status: 'degraded',
    presentation: '上游回傳空字串；GUI composer 內容不回流。仰賴此值的 extension 判斷失準',
    upstream: 'src/modes/rpc/rpc-mode.ts:1567',
  },

  // -------------------------------------------------------------------
  // ExtensionAPI registration surfaces
  // -------------------------------------------------------------------
  {
    id: 'register-tool',
    surface: 'api.registerTool（exec 部分）',
    status: 'supported',
    presentation: '工具正常註冊與執行；結果經 tool_execution 事件流向 GUI',
    upstream: 'src/extensibility/extensions/types.ts:1725',
  },
  {
    id: 'tool-renderers',
    surface: 'ToolDefinition.renderCall / renderResult',
    status: 'degraded',
    presentation: 'TUI Component 不跨行程；GUI 以通用 args/result 檢視降級呈現工具呼叫',
    upstream: 'src/extensibility/extensions/types.ts:945',
  },
  {
    id: 'register-command',
    surface: 'api.registerCommand',
    status: 'supported',
    presentation: '命令經 available_commands_update 抵達 GUI 可派送執行',
    upstream: 'src/extensibility/extensions/types.ts:1789',
  },
  {
    id: 'command-arg-completions',
    surface: 'registerCommand options.getArgumentCompletions',
    status: 'unsupported',
    presentation: '補全在 TUI 編輯器端運算；RPC host 無補全請求通道，GUI 斜線選單不吃此 hook',
    upstream: 'src/extensibility/extensions/types.ts:1601',
  },
  {
    id: 'register-shortcut',
    surface: 'api.registerShortcut',
    status: 'unsupported',
    presentation: '快捷鍵註冊無 wire 公告，GUI 無法得知，更無對映手勢可派發。需上游協定擴充',
    upstream: 'src/extensibility/extensions/types.ts:1799',
  },
  {
    id: 'message-renderer',
    surface: 'api.registerMessageRenderer',
    status: 'degraded',
    presentation: 'custom_message 以具名 activity part 降級呈現（events/message-content.ts:93）',
    upstream: 'src/extensibility/extensions/types.ts:1828',
  },
  {
    id: 'thinking-renderer',
    surface: 'api.registerAssistantThinkingRenderer',
    status: 'unsupported',
    presentation: 'renderer 為 TUI 元件，不可序列化；GUI 僅顯示原始 thinking 文字',
    upstream: 'src/extensibility/extensions/types.ts:1831',
  },
  {
    id: 'composer-shape',
    surface: 'api.registerComposerShape',
    status: 'unsupported',
    presentation: '互動編輯器形狀為 TUI 概念，無 wire 面；GUI composer 為 Web 元件',
    upstream: 'src/extensibility/extensions/types.ts:1839',
  },
  {
    id: 'annotations-overlay',
    surface: 'annotations API（經 ui.custom 疊層）',
    status: 'unsupported',
    presentation: '上游自訂疊層元件在 RPC mode 直接失敗；GUI 另有自建 annotation picker',
    upstream: 'src/extensibility/custom-commands/bundled/annotate/fullscreen.ts:114',
  },
]

// ---------------------------------------------------------------------------
// Runtime classification of unhandled wire frames
// ---------------------------------------------------------------------------

/**
 * Methods whose frames this app knowingly does not render, even though the
 * upstream RPC host may emit them. Fire-and-forget by design: never answered.
 */
const KNOWN_UNHANDLED_METHODS: ReadonlySet<string> = new Set(['setTitle'])

// Methods routed to a handler outside the showExtensionUi dispatch (notify in
// useAgentEvents) or carrying no method semantics worth flagging (cancel).
const HANDLED_ELSEWHERE_METHODS: ReadonlySet<string> = new Set(['cancel', 'notify'])

export type ExtensionUiCapabilityNoticeKind = 'knownUnsupported' | 'unknown'

export interface ExtensionUiCapabilityNotice {
  /** Stable state key: `unsupported:<method>` or `unknown:<method>`. */
  id: string
  method: string
  kind: ExtensionUiCapabilityNoticeKind
  /** Frame id when present; unknown methods may await a response upstream. */
  requestId?: string
}

/**
 * Classify an `extension_ui_request` frame that none of the parsers claimed
 * (not a renderable dialog, not a known presentation update, not a cancel).
 * Known-fire-and-forget methods map to an explicit notice only; anything else
 * is treated as an unknown method that may still await an answer.
 */
export function classifyUnhandledExtensionUiFrame(raw: Record<string, unknown>): ExtensionUiCapabilityNotice | undefined {
  if (raw.type !== 'extension_ui_request') return undefined
  const method = raw.method
  if (typeof method !== 'string' || method.trim().length === 0) return undefined
  if (HANDLED_ELSEWHERE_METHODS.has(method)) return undefined
  // Dialog/presentation parse failures already produce explicit rejections in
  // the callers; reaching here with these methods means a non-standard payload.
  const requestId = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 200 ? raw.id : undefined
  if (KNOWN_UNHANDLED_METHODS.has(method)) {
    return { id: `unsupported:${method}`, method, kind: 'knownUnsupported', ...(requestId ? { requestId } : {}) }
  }
  return { id: `unknown:${method}`, method, kind: 'unknown', ...(requestId ? { requestId } : {}) }
}
