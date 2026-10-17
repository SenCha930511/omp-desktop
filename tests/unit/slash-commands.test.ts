import { describe, expect, it } from 'vitest'
import { deferredSlashCommand, parseSlashCommands, slashSuggestions } from '../../src/lib/slash-commands'
import { desktopSlashCommands } from '../../src/lib/slash-command-ui'
import { translate } from '../../src/lib/i18n'

describe('slash command catalog', () => {
  it('keeps conversation commands localized and preserves custom commands', () => {
    const commands = desktopSlashCommands([
      { name: 'context', source: 'builtin', description: 'Show context usage' },
      { name: 'marketplace', source: 'builtin' },
      { name: 'login', source: 'builtin' },
      { name: 'marketplace', source: 'extension', description: 'Custom extension' },
    ], (key, values) => translate('zh-TW', key, values))
    expect(commands.map((command) => command.name)).toEqual(['context', 'marketplace'])
    expect(commands[0].description).toBe('查看上下文用量')
    expect(commands[1].description).toBe('Custom extension')
  })
  const commands = [{ name: 'model', aliases: ['models'], description: 'Model' }, { name: 'effort', subcommands: [{ name: 'high', description: 'Deep' }, { name: 'low' }] }]
  it('completes runtime names, aliases and arguments', () => {
    expect(slashSuggestions(commands, '/mo').map((item) => item.command)).toEqual(['/model'])
    expect(slashSuggestions(commands, '/models')[0].command).toBe('/models')
    expect(slashSuggestions(commands, '/effort h')).toEqual([{ command: '/effort high', detail: 'Deep' }])
    expect(slashSuggestions(commands, '/effort high extra')).toEqual([])
  })
  it('separates terminal displays from executable commands', () => {
    expect(deferredSlashCommand('/theme')).toBe('theme')
    expect(deferredSlashCommand('/todo edit')).toBe('todo edit')
    expect(deferredSlashCommand('/todo done tests')).toBeUndefined()
    expect(deferredSlashCommand('/effort high')).toBeUndefined()
    expect(parseSlashCommands([null, { name: 3 }, { name: 'context' }])).toEqual([{ name: 'context' }])
  })
})
