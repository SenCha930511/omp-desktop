import { describe, expect, it } from 'vitest'
import { validateRpcCommand } from '../../electron/main/agent-rpc/command-schema'

const validate = (command: unknown) => validateRpcCommand(command, async (path) => path)

describe('OMP v19 session commands', () => {
  it('validates get_messages_page cursors and limits', async () => {
    await expect(validate({ type: 'get_messages_page' })).resolves.toEqual({ type: 'get_messages_page' })
    await expect(validate({ type: 'get_messages_page', cursor: 'page-1', limit: 100 })).resolves.toEqual({ type: 'get_messages_page', cursor: 'page-1', limit: 100 })
    await expect(validate({ type: 'get_messages_page', limit: 0 })).rejects.toThrow('1 to 256')
    await expect(validate({ type: 'get_messages_page', limit: 257 })).rejects.toThrow('1 to 256')
    await expect(validate({ type: 'get_messages_page', extra: true })).rejects.toThrow('not supported')
  })

  it('validates set_event_filter selections', async () => {
    await expect(validate({ type: 'set_event_filter', events: ['agent_start', 'agent_end'], messageUpdates: 'delta' })).resolves.toEqual({
      type: 'set_event_filter',
      events: ['agent_start', 'agent_end'],
      messageUpdates: 'delta',
    })
    await expect(validate({ type: 'set_event_filter', events: null })).resolves.toEqual({ type: 'set_event_filter', events: null })
    await expect(validate({ type: 'set_event_filter', events: 'agent_start' })).rejects.toThrow('array or null')
    await expect(validate({ type: 'set_event_filter', events: ['agent_start'], messageUpdates: 'partial' })).rejects.toThrow('full or delta')
  })

  it('validates navigate_tree entry and summary options', async () => {
    await expect(validate({ type: 'navigate_tree', entryId: 'entry-1', summarize: true, customInstructions: 'keep the plan' })).resolves.toEqual({
      type: 'navigate_tree',
      entryId: 'entry-1',
      summarize: true,
      customInstructions: 'keep the plan',
    })
    await expect(validate({ type: 'navigate_tree' })).rejects.toThrow('entryId')
  })

  it('validates set_label with and without a label', async () => {
    await expect(validate({ type: 'set_label', entryId: 'entry-1', label: 'Checkpoint' })).resolves.toEqual({ type: 'set_label', entryId: 'entry-1', label: 'Checkpoint' })
    await expect(validate({ type: 'set_label', entryId: 'entry-1' })).resolves.toEqual({ type: 'set_label', entryId: 'entry-1' })
  })

  it('validates export_html and handoff options', async () => {
    await expect(validate({ type: 'export_html', outputPath: '/tmp/session.html' })).resolves.toEqual({ type: 'export_html', outputPath: '/tmp/session.html' })
    await expect(validate({ type: 'export_html' })).resolves.toEqual({ type: 'export_html' })
    await expect(validate({ type: 'handoff', customInstructions: 'summarize the session' })).resolves.toEqual({ type: 'handoff', customInstructions: 'summarize the session' })
    await expect(validate({ type: 'handoff' })).resolves.toEqual({ type: 'handoff' })
  })

  it('validates set_host_tools definitions', async () => {
    const tool = { name: 'echo_host', description: 'Echo a value', parameters: { type: 'object', properties: { message: { type: 'string' } } } }
    await expect(validate({ type: 'set_host_tools', tools: [tool] })).resolves.toEqual({ type: 'set_host_tools', tools: [tool] })
    await expect(validate({ type: 'set_host_tools', tools: [tool, tool] })).rejects.toThrow('duplicated')
    await expect(validate({ type: 'set_host_tools', tools: [{ ...tool, name: 'bad name' }] })).rejects.toThrow('invalid characters')
    await expect(validate({ type: 'set_host_tools', tools: [{ ...tool, loadMode: 'sometimes' }] })).rejects.toThrow('loadMode is invalid')
  })

  it('validates set_host_uri_schemes definitions', async () => {
    await expect(validate({ type: 'set_host_uri_schemes', schemes: [{ scheme: 'DB', writable: true }] })).resolves.toEqual({
      type: 'set_host_uri_schemes',
      schemes: [{ scheme: 'db', writable: true }],
    })
    await expect(validate({ type: 'set_host_uri_schemes', schemes: [{ scheme: 'db' }, { scheme: 'db' }] })).rejects.toThrow('duplicated')
    await expect(validate({ type: 'set_host_uri_schemes', schemes: [{ scheme: '1db' }] })).rejects.toThrow('invalid')
  })
})
