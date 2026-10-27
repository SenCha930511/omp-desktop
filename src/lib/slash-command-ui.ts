import type { MessageKey, useI18n } from './i18n'
import type { RuntimeInfo } from '@/types/api'
import { formatSessionCost, formatSessionTokens } from '@/lib/format-cost'
import type { SlashCommand } from './slash-commands'
import { DEFERRED_SLASH_COMMANDS, DEFERRED_TUI_MODES, INITIAL_SLASH_COMMANDS, parseSlashInvocation, tuiOnlySubcommand } from './slash-commands'

// Desktop 專用介面已接管的命令(模型/速度/工作階段選擇、plugin 管理等),
// 選單不重複列出;手動輸入仍交付上游處理。
const DESKTOP_OWNED_COMMANDS = new Set(['model', 'switch', 'effort', 'fast', 'retry', 'rename', 'session', 'mcp', 'plugins'])

const KNOWN_BUILTIN_COMMANDS = new Set([
  ...INITIAL_SLASH_COMMANDS.map((command) => command.name),
  ...DEFERRED_SLASH_COMMANDS,
  ...DEFERRED_TUI_MODES,
  // 只出現在 live catalog 的內建命令;BUILTIN 判定需要它們,以免被當成自訂命令。
  'force', 'security',
  // 已由 GUI 入口接出、不再列於 DEFERRED 的內建命令(gui-action / respond-local)。
  'tree', 'branch', 'rewind', 'fork', 'new', 'clear', 'resume', 'help', 'login', 'logout',
])

// 有本地化描述的內建命令;其餘內建命令直接採用上游 catalog 的描述。
const LOCALIZED_DESCRIPTION_COMMANDS = new Set([
  'model', 'switch', 'effort', 'fast', 'modelpreset', 'btw', 'context', 'tools',
  'usage', 'jobs', 'compact', 'handoff', 'fresh', 'shake', 'retry', 'todo', 'memory',
  'advisor', 'skillful', 'extended-context', 'force', 'security',
  'ssh', 'marketplace', 'reload-plugins', 'export', 'dump', 'changelog', 'dirs', 'add-dir', 'remove-dir',
  // GUI 入口接出的命令:live catalog 與 /help 清單同樣以本地化描述呈現。
  'tree', 'branch', 'fork', 'new', 'clear', 'resume', 'help',
])

/**
 * 選單目錄:以上游 live catalog(get_available_commands / available_commands_update)
 * 為權威來源。上游新增的 builtin / extension / 自帶命令一律顯示(依上游
 * description / source / aliases 呈現),只有兩類被擋下:
 * - Desktop 專用介面已接管的命令(DESKTOP_OWNED_COMMANDS);
 * - TUI-only 命令(DEFERRED_*):送出去只會被 deferredSlashCommand 拒絕。
 * 無 bridge / 離線時由 Composer 以 INITIAL_SLASH_COMMANDS 降級,走同一個過濾器。
 */
export function desktopSlashCommands(commands: SlashCommand[], t: ReturnType<typeof useI18n>['t']): SlashCommand[] {
  const builtin = (command: SlashCommand) => command.source === 'builtin' || (!command.source && KNOWN_BUILTIN_COMMANDS.has(command.name))
  return commands.filter((command) => {
    if (!builtin(command)) return true
    if (DESKTOP_OWNED_COMMANDS.has(command.name)) return false
    if ((DEFERRED_SLASH_COMMANDS as readonly string[]).includes(command.name)) return false
    if ((DEFERRED_TUI_MODES as readonly string[]).includes(command.name)) return false
    return true
  }).map((command) => {
    if (!builtin(command)) return command
    const description = LOCALIZED_DESCRIPTION_COMMANDS.has(command.name)
      ? t(`slash.command.${command.name}` as MessageKey)
      : command.description
    return { ...command, description, subcommands: command.subcommands?.filter((sub) => !tuiOnlySubcommand(command.name, sub.name)) }
  })
}

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

/**
 * 唯讀 slash 的本地回應(busySlashDisposition 的 respond-local 類)。
 * 資料全部來自 runtime 快照(model / thinking / contextUsage / sessionUsage
 * / serviceTier / sessionFile),忙碌時快照由事件流持續更新,因此不送 RPC。
 * 尚無 runtime 時(空閒 /status)以 workspaceFallback 補充工作階段與目錄。
 */
export function localSlashResponse(
  prompt: string,
  runtime: RuntimeInfo | undefined,
  t: Translate,
  workspaceFallback?: { cwd?: string | null; sessionFile?: string | null },
): string {
  const invocation = parseSlashInvocation(prompt)
  const name = invocation?.name.toLowerCase() ?? ''
  if (name === 'fast') return t('slash.local.tier', { tier: runtime?.serviceTier ?? 'default' })
  const modelLine = t('slash.local.model', {
    model: runtime?.model?.name ?? ([runtime?.model?.provider, runtime?.model?.id].filter(Boolean).join('/') || t('slash.local.unknown')),
  })
  const thinkingLine = t('slash.local.thinking', { effort: runtime?.thinkingLevel ?? runtime?.configuredThinkingLevel ?? 'auto' })
  const sessionFile = runtime?.sessionFile ?? workspaceFallback?.sessionFile ?? undefined
  const sessionLine = sessionFile ? t('slash.local.session', { file: sessionFile }) : t('slash.local.sessionNone')
  const projectLine = t('slash.local.project', { cwd: runtime?.cwd ?? workspaceFallback?.cwd ?? t('slash.local.unknown') })
  const stateLine = t('slash.local.state', { state: t(runtime?.isStreaming ? 'slash.local.state.busy' : 'slash.local.state.idle') })
  const contextLine = runtime?.contextUsage && runtime.contextUsage.tokens !== null
    ? t('slash.local.context', {
      used: runtime.contextUsage.tokens.toLocaleString('en-US'),
      window: runtime.contextUsage.contextWindow.toLocaleString('en-US'),
      percent: runtime.contextUsage.percent === null ? t('slash.local.unknown') : Math.round(runtime.contextUsage.percent),
    })
    : t('slash.local.contextUnknown')
  const usageLine = (() => {
    const cost = formatSessionCost(runtime?.sessionUsage)
    const tokens = formatSessionTokens(runtime?.sessionUsage)
    if (cost === null && tokens === null) return t('slash.local.usageNone')
    return t('slash.local.usage', { cost: cost ?? t('slash.local.unknown'), tokens: tokens ?? t('slash.local.unknown') })
  })()
  // TUI 說明畫面的資訊等價物:列出可用命令。資料源是 INITIAL 後備目錄
  // 加上 GUI 入口命令(不含 TUI-only 與 desktop 隱藏指令之外的命令;
  // 與 composer 選單不同,desktop-owned 的命令在此一併列出,因為手動
  // 輸入仍然有效)。
  if (name === 'help') {
    const guiEntries: SlashCommand[] = ['tree', 'branch', 'fork', 'new', 'clear', 'resume', 'help'].map((entryName) => ({ name: entryName, source: 'builtin' }))
    const lines = [...INITIAL_SLASH_COMMANDS, ...guiEntries].map((command) => {
      const description = LOCALIZED_DESCRIPTION_COMMANDS.has(command.name) ? t(`slash.command.${command.name}` as MessageKey) : command.description
      return description ? `/${command.name} — ${description}` : `/${command.name}`
    })
    return [t('slash.help.heading'), ...lines].join('\n')
  }
  if (name === 'model') return [modelLine, thinkingLine].join('\n')
  if (name === 'session') return [sessionLine, projectLine, stateLine].join('\n')
  if (name === 'context') return contextLine
  if (name === 'usage') return usageLine
  return [modelLine, thinkingLine, sessionLine, projectLine, stateLine, contextLine, usageLine].join('\n')
}

/** agent-control 命令的回覆以精簡 JSON 呈現(goal RPC 由 4.4 接入,此為通用過渡格式)。 */
export function agentControlResultText(response: Record<string, unknown>): string {
  const payload = response.data ?? response
  try {
    return JSON.stringify(payload, null, 2).slice(0, 4_000)
  } catch {
    return String(payload)
  }
}
