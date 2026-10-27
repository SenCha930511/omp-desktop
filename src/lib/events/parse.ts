import type { MessagePart } from '@/types/api'
import { contentText, customMessageShape } from './message-content'

/** Record and field coercion for raw Prime events. */

export type UnknownRecord = Record<string, unknown>

export function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' ? value as UnknownRecord : undefined
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 工具結果的可讀文字：與持久化 transcript 共用 contentText 語意，
 * block 陣列抽取文字、物件以 pretty JSON 呈現，避免兩側漂移。
 */
export function resultText(value: unknown): string {
  return contentText(value)
}

export function agentMessagePart(raw: Record<string, unknown>): Extract<MessagePart, { type: 'agentMessage' }> | undefined {
  const shape = customMessageShape(raw)
  if (shape?.kind !== 'agentMessage') return undefined
  return { type: 'agentMessage', text: shape.text, agentName: shape.agentName }
}
