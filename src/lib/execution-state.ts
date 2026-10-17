import type { MessagePart, RuntimeInfo, SessionStatus, TranscriptMessage } from '@/types/api'

export type ExecutionPhase = 'idle' | 'unknown' | 'starting' | 'thinking' | 'running' | 'waiting' | 'compacting' | 'completed' | 'failed' | 'cancelled'
export interface ExecutionState {
  phase: ExecutionPhase
  detail?: string
  since?: string | number
  until?: string | number
}

export function isInteractiveTool(name: string): boolean {
  return /^(ask_user|request_user_input|request_input|ui\.select)$/i.test(name)
}

export function activityState(parts: MessagePart[]): Pick<ExecutionState, 'phase' | 'detail'> {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    const next = parts[index + 1]
    if (part.type === 'toolCall' && (next?.type !== 'toolResult' || next.streaming)) {
      return { phase: isInteractiveTool(part.name) ? 'waiting' : 'running', detail: part.name }
    }
  }
  const last = parts.at(-1)
  return { phase: last?.type === 'thinking' ? 'thinking' : 'running' }
}

/** Session/runtime signals take precedence over the last visible content. */
export function conversationExecution({ runtime, messages, submitting, waiting, sessionStatus }: {
  runtime: RuntimeInfo | null
  messages: TranscriptMessage[]
  submitting: boolean
  waiting: boolean
  sessionStatus?: SessionStatus
}): ExecutionState {
  const last = messages.at(-1)
  let assistant: TranscriptMessage | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') { assistant = messages[index]; break }
  }
  const since = assistant?.startedAt ?? assistant?.timestamp
  if (submitting && (!runtime || (!runtime.isStreaming && !assistant?.streaming))) return { phase: 'starting', since }
  if (waiting || sessionStatus === 'waiting') return { phase: 'waiting', since }
  if (runtime?.isCompacting) return { phase: 'compacting', since }
  if (runtime?.isStreaming || assistant?.streaming || sessionStatus === 'running') return { ...activityState(assistant?.parts ?? []), since }
  if (last?.outcome === 'failed' || sessionStatus === 'failed' || (last?.role === 'system' && /^error[-:]/.test(last.id))) return { phase: 'failed', since, until: last?.timestamp }
  if (assistant?.outcome === 'cancelled') return { phase: 'cancelled', since, until: assistant.completedAt }
  if (assistant && (sessionStatus === 'complete' || assistant.parts.some((part) => part.type === 'text' && part.text.trim()))) return { phase: 'completed', since, until: assistant.completedAt ?? assistant.timestamp }
  return { phase: 'idle' }
}
