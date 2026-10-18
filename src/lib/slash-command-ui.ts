import type { MessageKey, useI18n } from './i18n'
import type { SlashCommand } from './slash-commands'
import { DEFERRED_SLASH_COMMANDS, DEFERRED_TUI_MODES, INITIAL_SLASH_COMMANDS, tuiOnlySubcommand } from './slash-commands'

// Desktop controls own model/effort/speed selection, retry, session navigation,
// setup, plugin management and exports. Manual invocation still uses OMP.
// Custom/extension/file/skill commands keep their upstream names and descriptions.
const GUI_COMMANDS = new Set([
  'modelpreset', 'context', 'tools',
  'usage', 'jobs', 'compact', 'handoff', 'fresh', 'shake', 'todo',
  'memory', 'advisor', 'skillful', 'extended-context', 'force', 'security',
])

const BUILTIN_COMMANDS = new Set([...INITIAL_SLASH_COMMANDS.map((command) => command.name), ...DEFERRED_SLASH_COMMANDS, ...DEFERRED_TUI_MODES, ...GUI_COMMANDS])

export function desktopSlashCommands(commands: SlashCommand[], t: ReturnType<typeof useI18n>['t']): SlashCommand[] {
  const builtin = (command: SlashCommand) => command.source === 'builtin' || (!command.source && BUILTIN_COMMANDS.has(command.name))
  return commands.filter((command) => !builtin(command) || GUI_COMMANDS.has(command.name)).map((command) => {
    if (!builtin(command)) return command
    return { ...command, description: t(`slash.command.${command.name}` as MessageKey), subcommands: command.subcommands?.filter((sub) => !tuiOnlySubcommand(command.name, sub.name)) }
  })
}
