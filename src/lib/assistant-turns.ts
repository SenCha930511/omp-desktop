import type { TranscriptMessage } from '@/types/api'

/** Keeps completed group identities stable while a later turn streams; retains only the current groups. */
export function createAssistantTurnCoalescer(): (messages: TranscriptMessage[]) => TranscriptMessage[] {
  let previous = new Map<TranscriptMessage, { members: TranscriptMessage[]; message: TranscriptMessage }>()
  return (messages) => {
    const next = new Map<TranscriptMessage, { members: TranscriptMessage[]; message: TranscriptMessage }>()
    const grouped: TranscriptMessage[] = []
    let changed = false
    for (let index = 0; index < messages.length;) {
      const first = messages[index++]
      if (first.role !== 'assistant' || messages[index]?.role !== 'assistant') { grouped.push(first); continue }
      const members = [first]
      while (messages[index]?.role === 'assistant') members.push(messages[index++])
      changed = true
      const cached = previous.get(first)
      const reusable = cached && cached.members.length === members.length && members.every((member, offset) => cached.members[offset] === member)
      const streaming = members.some((member) => member.streaming)
      const message = reusable ? cached.message : {
        ...first,
        completedAt: streaming ? undefined : members.reduce((completedAt, member) => member.completedAt ?? completedAt, first.completedAt),
        streaming,
        parts: members.flatMap((member) => member.parts),
      }
      next.set(first, { members, message })
      grouped.push(message)
    }
    previous = next
    return changed ? grouped : messages
  }
}

export function coalesceAssistantTurns(messages: TranscriptMessage[]): TranscriptMessage[] {
  return createAssistantTurnCoalescer()(messages)
}
