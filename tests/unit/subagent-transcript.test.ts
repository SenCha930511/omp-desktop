import { expect, it } from 'vitest'
import { subagentTranscript } from '../../src/lib/subagent-transcript'

it('pairs late and parallel tool results by call identity in the shared transcript', () => {
  const messages = subagentTranscript([
    { role: 'user', timestamp: 1, content: 'Inspect the project' },
    { role: 'assistant', timestamp: 2, content: [
      { type: 'thinking', thinking: 'Inspecting files' },
      { type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'a.ts' } },
      { type: 'toolCall', id: 'b', name: 'read', arguments: { path: 'b.ts' } },
    ] },
    { role: 'toolResult', timestamp: 3, toolCallId: 'b', toolName: 'read', content: [{ type: 'text', text: 'B' }] },
    { role: 'toolResult', timestamp: 4, toolCallId: 'a', toolName: 'read', content: [{ type: 'text', text: 'A' }], isError: true },
    { role: 'assistant', timestamp: 5, content: 'Summary' },
  ], false)
  expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  expect(messages[1].parts.map((part) => part.type)).toEqual(['thinking', 'toolCall', 'toolResult', 'toolCall', 'toolResult', 'text'])
  expect(messages[1].parts[2]).toMatchObject({ text: 'A', isError: true })
  expect(messages[1].parts[4]).toMatchObject({ text: 'B' })
  expect(messages[1].streaming).toBe(false)
})

it('keeps independent turns and attachments and marks only the live assistant', () => {
  const messages = subagentTranscript([
    { role: 'user', timestamp: 1, content: [{ type: 'image', mimeType: 'image/png', data: 'aA==' }] },
    { role: 'assistant', timestamp: 2, content: 'First response' },
    { role: 'user', timestamp: 3, content: 'Continue' },
    { role: 'assistant', timestamp: 4, content: [{ type: 'thinking', thinking: 'Continuing' }] },
  ], true)
  expect(messages[0].parts[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
  expect(messages[1].streaming).toBeUndefined()
  expect(messages[3].streaming).toBe(true)
})
