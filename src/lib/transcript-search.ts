import type { MessagePart, TranscriptMessage } from '@/types/api'

export type SearchScope = 'all' | 'messages' | 'tools' | 'thinking'

export function searchablePart(part: MessagePart, scope: SearchScope): string {
  if (part.type === 'text' && (scope === 'all' || scope === 'messages')) return part.text
  if (part.type === 'thinking' && (scope === 'all' || scope === 'thinking')) return part.text
  if (scope === 'all' && part.type === 'agentMessage') return part.text ?? ''
  if (scope === 'all' && part.type === 'compaction') return part.error || part.summary || ''
  if (scope === 'all' || scope === 'tools') {
    if (part.type === 'toolCall') return `${part.name} ${JSON.stringify(part.args) ?? ''}`
    if (part.type === 'toolResult') return part.text
  }
  return ''
}

/** One result per message, including history outside the current rendering window. */
export function searchTranscript(messages: readonly TranscriptMessage[], query: string, scope: SearchScope): string[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  return messages.filter((message) => message.parts.some((part) => searchablePart(part, scope).toLocaleLowerCase().includes(needle))).map((message) => message.id)
}
