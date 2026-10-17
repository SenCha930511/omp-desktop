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
export const DEFERRED_SLASH_COMMANDS = [
  'theme', 'settings', 'config', 'hotkeys', 'help', 'tree', 'resume', 'new',
  'clear', 'fork', 'login', 'logout', 'quit', 'q', 'exit', 'delete', 'live', 'record', 'pause',
  'setup', 'providers', 'extensions', 'status', 'agents', 'git', 'hub', 'branch', 'rewind',
] as const

export const DEFERRED_TUI_MODES = ['plan', 'plan-review', 'vibe', 'goal', 'guided-goal', 'loop', 'queue'] as const

export function parseSlashInvocation(prompt: string): { name: string; args: string } | undefined {
  const match = /^\/([^\s:]+)(?:[\s:]([\s\S]*))?$/.exec(prompt.trim())
  return match ? { name: match[1], args: match[2]?.trim() ?? '' } : undefined
}

export function tuiOnlySubcommand(name: string, args: string): boolean {
  const verb = args.split(/\s+/)[0].toLowerCase()
  return (name === 'todo' && ['edit', 'expand', 'collapse'].includes(verb)) || (name === 'advisor' && verb === 'configure')
}

export function deferredSlashCommand(prompt: string): string | undefined {
  const invocation = parseSlashInvocation(prompt)
  if (!invocation) return
  if (tuiOnlySubcommand(invocation.name, invocation.args)) return `${invocation.name} ${invocation.args}`
  return [...DEFERRED_SLASH_COMMANDS, ...DEFERRED_TUI_MODES].find((command) => command === invocation.name)
}

// Useful before the first runtime starts; a live catalog replaces this list.
export const INITIAL_SLASH_COMMANDS: SlashCommand[] = [
  ['model', 'Show current model'], ['switch', 'Switch model: provider/model'],
  ['effort', 'Set reasoning effort'], ['fast', 'Fast mode: on | off | status'],
  ['slow', 'Slow mode: on | off | status'], ['modelpreset', 'Manage model presets'],
  ['context', 'Show context usage'], ['tools', 'Show available tools'],
  ['session', 'Show session information'], ['usage', 'Show provider usage'],
  ['jobs', 'Show background jobs'], ['compact', 'Compact conversation'],
  ['handoff', 'Summarize and compact in place'], ['fresh', 'Reset provider stream state'],
  ['shake', 'Remove heavy context'], ['retry', 'Retry last failed turn'],
  ['rename', 'Rename session'], ['todo', 'Manage todos'], ['memory', 'Manage memory'],
  ['mcp', 'Manage MCP servers'], ['ssh', 'Manage SSH connections'],
  ['plugins', 'Manage plugins'], ['marketplace', 'Manage marketplaces'],
  ['reload-plugins', 'Reload plugins'], ['export', 'Export HTML'],
  ['dump', 'Export transcript'], ['changelog', 'Show changelog'],
  ['advisor', 'Advisor: on | off | status'], ['skillful', 'Toggle skill listing'],
  ['extended-context', 'Toggle extended context'], ['dirs', 'List workspace directories'],
  ['add-dir', 'Add workspace directory'], ['remove-dir', 'Remove workspace directory'],
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
