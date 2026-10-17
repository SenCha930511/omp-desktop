import type { MessagePart, TranscriptMessage } from '@/types/api'
import { record, resultText, string } from './events/parse'

/** Normalize the OMP transcript boundary before sharing the desktop renderer. */
export function subagentTranscript(messages: Record<string, unknown>[], running: boolean): TranscriptMessage[] {
  const turns: TranscriptMessage[] = []
  for (const [index, message] of messages.entries()) {
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : undefined
    const parts: MessagePart[] = []
    if (message.role === 'toolResult') {
      const result: MessagePart = { type: 'toolResult', text: resultText(message), name: string(message.toolName), isError: message.isError === true }
      const previous = turns.at(-1)
      if (previous?.role === 'assistant') {
        const call = typeof message.toolCallId === 'string' ? previous.parts.findIndex((part) => part.type === 'toolCall' && part.id === message.toolCallId) : -1
        previous.parts.splice(call < 0 ? previous.parts.length : call + 1, 0, result)
      } else turns.push({ id: `subagent:${index}`, role: 'tool', timestamp, parts: [result] })
      continue
    }
    if (typeof message.content === 'string') parts.push({ type: 'text', text: message.content })
    else if (Array.isArray(message.content)) for (const raw of message.content) {
      const part = record(raw)
      if (part?.type === 'text') parts.push({ type: 'text', text: string(part.text) ?? '' })
      else if (part?.type === 'thinking') parts.push({ type: 'thinking', text: string(part.thinking) ?? string(part.text) ?? '' })
      else if (part?.type === 'toolCall') parts.push({ type: 'toolCall', id: string(part.id), name: string(part.name) ?? 'Tool', args: part.arguments })
      else if (part?.type === 'image') parts.push({ type: 'image', data: string(part.data), mimeType: string(part.mimeType) })
    }
    const role = message.role === 'user' ? 'user' : 'assistant'
    const previous = turns.at(-1)
    if (role === 'assistant' && previous?.role === 'assistant') previous.parts.push(...parts)
    else turns.push({ id: `subagent:${index}`, role, timestamp, startedAt: timestamp, parts })
  }
  const last = turns.at(-1)
  if (last?.role === 'assistant') last.streaming = running
  return turns
}
