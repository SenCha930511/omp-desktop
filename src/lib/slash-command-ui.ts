import type { MessageKey, useI18n } from './i18n'
import type { SlashCommand } from './slash-commands'

// Desktop controls own session navigation, setup, plugin management and exports.
// Custom/extension/file/skill commands keep their upstream names and descriptions.
const GUI_COMMANDS = new Set([
  'model', 'switch', 'effort', 'fast', 'slow', 'modelpreset', 'context', 'tools',
  'usage', 'jobs', 'compact', 'handoff', 'fresh', 'shake', 'retry', 'todo',
  'memory', 'advisor', 'skillful', 'extended-context', 'force', 'security',
])

export function desktopSlashCommands(commands: SlashCommand[], t: ReturnType<typeof useI18n>['t']): SlashCommand[] {
  return commands.filter((command) => command.source !== 'builtin' || GUI_COMMANDS.has(command.name)).map((command) => {
    if (command.source !== 'builtin' || !GUI_COMMANDS.has(command.name)) return command
    return { ...command, description: t(`slash.command.${command.name}` as MessageKey) }
  })
}
