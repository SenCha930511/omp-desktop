import { HARNESS_AGENT_NAMES } from '@/lib/harness'
import { EVENT_REPLAY_MAX_BYTES, EVENT_REPLAY_MAX_EVENTS, eventPayloadBytes } from '@/lib/event-buffer'
import { formatGoalEventUpdateText, parseGoalModeState, parseGoalSnapshot } from '@/lib/goal-rpc'
import { translate } from '@/lib/i18n'
import type { MessagePart, QueuedPrompt, TranscriptMessage } from '@/types/api'
import { applyCompactionEvent, isCompactionEvent } from './compaction'
import { nextTranscriptId, withPartId } from './ids'
import { customMessageShape, supplementaryPartsFromResult } from './message-content'
import { fallbackModelFromRecord, fallbackNoticeText } from './model-fallback'
import { record, resultText, string } from './parse'

export interface PrimeEventReplayStats {
  messageScans: number
  eventScans: number
  partScans: number
  transcriptCopies: number
}

interface PartNode {
  part: MessagePart
  previous?: PartNode
  next?: PartNode
}

interface PartDraft {
  head?: PartNode
  tail?: PartNode
  length: number
  firstToolById: Map<string | undefined, PartNode>
}

export interface AgentNotice {
  level: 'info' | 'warning' | 'error'
  message: string
  source?: string
}

/** Notice row kinds: the upstream `level` picks the kind so severity chrome stays i18n-side. */
export type AgentNoticeKind = 'agent-notice' | 'agent-notice-warning' | 'agent-notice-error'

/**
 * Parses the upstream `notice` agent event (OMP ≥18.12). Severity rides `level`
 * ('info' | 'warning' | 'error') and origin rides the optional `source`; any
 * other shape is malformed and yields undefined rather than a guessed level.
 */
export function agentNoticeFromEvent(raw: Record<string, unknown>): AgentNotice | undefined {
  if (string(raw.type) !== 'notice') return undefined
  const message = string(raw.message)
  const level = string(raw.level)
  if (!message) return undefined
  if (level !== 'info' && level !== 'warning' && level !== 'error') return undefined
  const source = string(raw.source)
  return source ? { level, message, source } : { level, message }
}

/** Display body: source and message are raw agent data, not translatable chrome. */
export function agentNoticeBody(notice: AgentNotice): string {
  return notice.source ? `${notice.source}: ${notice.message}` : notice.message
}

/**
 * 上游 config_warnings_changed(OMP ≥18.9 agent-session-events):設定警告
 * 集合改變(reload、.broken-* 隔離、fallbackChains revalidate 後)。事件沒有
 * payload,警告細節由上游留在 session;GUI 只用它觸發提示與功能目錄重整。
 */
export function isConfigWarningsChangedEvent(raw: Record<string, unknown>): boolean {
  return raw.type === 'config_warnings_changed'
}

/** Applies a frame batch with one transcript scan and one scan of each drafted part list. */
/**
 * Tool events without a toolCallId must still pair their start/update/end
 * events onto one tool row instead of appending a phantom second row, so
 * they share a stable name-derived fallback id.
 */
function effectiveToolId(id: string | undefined, name: string): string {
  return id ?? `tool-fallback:${name}`
}

const EMPTY_TURN_FALLBACK = 'Completed without a text response.'
const LOCAL_STEER_PICKUP = Symbol('omp-desktop-steer-pickup')
const LOCAL_STEER_ACCEPTED = Symbol('omp-desktop-steer-accepted')
const LOCAL_QUEUED_MESSAGE = Symbol('omp-desktop-queued-message')
const LOCAL_STEER_RETRACT = Symbol('omp-desktop-steer-retract')

/** Renderer-only event: fixes an admitted steer in history at response time. */
export function createSteerAcceptedEvent(prompt: QueuedPrompt): Record<string, unknown> {
  return { type: 'omp_desktop_steer_accepted', prompt, [LOCAL_STEER_ACCEPTED]: true }
}

/** Renderer-only event: the symbol prevents an agent frame from spoofing a local pickup. */
export function createSteerPickupEvent(prompts: QueuedPrompt[]): Record<string, unknown> {
  return { type: 'omp_desktop_steer_pickup', prompts, [LOCAL_STEER_PICKUP]: true }
}

/** Renderer-only event: a queued or steering prompt renders its user row immediately. */
export function createQueuedMessageEvent(prompt: QueuedPrompt): Record<string, unknown> {
  return { type: 'omp_desktop_queued_message', prompt, [LOCAL_QUEUED_MESSAGE]: true }
}

/** Renderer-only event: drops a queued prompt's optimistic row when it is removed or flushed. */
export function createSteerRetractEvent(prompt: Pick<QueuedPrompt, 'id'>): Record<string, unknown> {
  return { type: 'omp_desktop_steer_retract', prompt, [LOCAL_STEER_RETRACT]: true }
}

export function replayPrimeEvents(
  messages: TranscriptMessage[],
  events: Record<string, unknown>[],
  stats?: PrimeEventReplayStats,
): TranscriptMessage[] {
  if (!events.length) return messages
  let base = messages
  let next = base
  let copiedMessages = false
  let lastStreamingAssistant = -1
  const streaming = new Set<number>()
  const draftedMessages = new Set<number>()
  const partDrafts = new Map<number, PartDraft>()

  const scanStreaming = () => {
    for (let index = 0; index < base.length; index += 1) {
      if (stats) stats.messageScans += 1
      const message = base[index]
      if (!message.streaming) continue
      streaming.add(index)
      if (message.role === 'assistant') lastStreamingAssistant = index
    }
  }
  scanStreaming()

  const copyTranscript = () => {
    if (copiedMessages) return
    next = base.slice()
    copiedMessages = true
    if (stats) stats.transcriptCopies += 1
  }
  const draftMessage = (index: number): TranscriptMessage => {
    copyTranscript()
    if (!draftedMessages.has(index)) {
      next[index] = { ...next[index] }
      draftedMessages.add(index)
    }
    return next[index]
  }
  const appendNode = (draft: PartDraft, part: MessagePart): PartNode => {
    const node: PartNode = { part, previous: draft.tail }
    if (draft.tail) draft.tail.next = node
    else draft.head = node
    draft.tail = node
    draft.length += 1
    if (part.type === 'toolCall' && !draft.firstToolById.has(part.id)) draft.firstToolById.set(part.id, node)
    return node
  }
  const draftParts = (index: number): PartDraft => {
    const existing = partDrafts.get(index)
    if (existing) return existing
    const message = draftMessage(index)
    const draft: PartDraft = { length: 0, firstToolById: new Map() }
    for (const part of message.parts) {
      if (stats) stats.partScans += 1
      appendNode(draft, part)
    }
    partDrafts.set(index, draft)
    return draft
  }
  const insertAfter = (draft: PartDraft, node: PartNode, part: MessagePart): PartNode => {
    const inserted: PartNode = { part, previous: node, next: node.next }
    if (node.next) node.next.previous = inserted
    else draft.tail = inserted
    node.next = inserted
    draft.length += 1
    return inserted
  }
  const appendAssistant = (prefix: 'assistant' | 'stream'): number => {
    copyTranscript()
    const now = Date.now()
    const index = next.length
    next.push({ id: nextTranscriptId(prefix), role: 'assistant', timestamp: now, startedAt: now, streaming: true, parts: [] })
    draftedMessages.add(index)
    streaming.add(index)
    lastStreamingAssistant = index
    return index
  }
  const resumeTailAssistant = (): number | undefined => {
    const tailIndex = next.length - 1
    if (tailIndex < 0 || next[tailIndex].role !== 'assistant') return undefined
    const message = draftMessage(tailIndex)
    message.streaming = true
    message.completedAt = undefined
    streaming.add(tailIndex)
    lastStreamingAssistant = tailIndex
    return tailIndex
  }
  const assistantIndex = () => lastStreamingAssistant >= 0
    ? lastStreamingAssistant
    : resumeTailAssistant() ?? appendAssistant('stream')
  const upsertToolDraft = (index: number, id: string, name: string, args: unknown): PartNode => {
    const draft = draftParts(index)
    const existing = id ? draft.firstToolById.get(id) : undefined
    const tool: MessagePart = { type: 'toolCall', id, name, args }
    if (existing) {
      // Execution updates may omit args; keep the args captured at start
      // rather than blanking the tool preview mid-execution.
      if (args === undefined && existing.part.type === 'toolCall') tool.args = existing.part.args
      existing.part = { ...tool, partId: existing.part.partId }
      return existing
    }
    return appendNode(draft, withPartId(tool))
  }
  const setToolResult = (draft: PartDraft, call: PartNode, result: MessagePart) => {
    if (call.next?.part.type === 'toolResult') call.next.part = { ...result, partId: call.next.part.partId }
    else insertAfter(draft, call, withPartId(result))
  }
  const finalizeStreaming = (completedAt: number, addFallback: boolean) => {
    for (const index of streaming) {
      const message = draftMessage(index)
      message.streaming = false
      message.completedAt = completedAt
      const parts = partDrafts.get(index)
      if (addFallback && (parts?.length ?? message.parts.length) === 0) {
        appendNode(draftParts(index), withPartId({ type: 'text', text: EMPTY_TURN_FALLBACK }))
      }
    }
    streaming.clear()
    lastStreamingAssistant = -1
  }
  const dropTailFallback = (index: number) => {
    const draft = draftParts(index)
    const tail = draft.tail
    if (tail?.part.type !== 'text' || tail.part.text !== EMPTY_TURN_FALLBACK) return
    draft.tail = tail.previous
    if (draft.tail) draft.tail.next = undefined
    else draft.head = undefined
    draft.length -= 1
  }
  const materializeDrafts = () => {
    for (const [index, draft] of partDrafts) {
      const parts: MessagePart[] = []
      for (let node = draft.head; node; node = node.next) parts.push(node.part)
      draftMessage(index).parts = parts
    }
    partDrafts.clear()
  }
  const rebase = (transcript: TranscriptMessage[]) => {
    base = transcript
    next = transcript
    copiedMessages = false
    draftedMessages.clear()
    streaming.clear()
    lastStreamingAssistant = -1
    scanStreaming()
  }

  const steerMessage = (value: unknown, state: 'accepted' | 'read' | undefined): TranscriptMessage | undefined => {
    const prompt = record(value)
    const id = string(prompt?.id)
    const text = string(prompt?.text)
    if (!id || !text) return undefined
    const timestamp = typeof prompt?.timestamp === 'number' && Number.isFinite(prompt.timestamp) ? prompt.timestamp : Date.now()
    const parts = Array.isArray(prompt?.parts) ? prompt.parts as MessagePart[] : [{ type: 'text' as const, text }]
    return { id: `user-${id}`, role: 'user', ...(state ? { steerState: state } : {}), timestamp, parts }
  }

  for (const raw of events) {
    if (stats) stats.eventScans += 1
    const type = string(raw.type) ?? string(raw.event)
    if (!type) continue
    if (type === 'omp_desktop_queued_message' && (raw as Record<PropertyKey, unknown>)[LOCAL_QUEUED_MESSAGE] === true) {
      // A queued or steering prompt shows its user row the moment it is
      // submitted; the accepted/pickup events later reconcile the same row
      // by id, and delivery itself is unchanged.
      const queuedRow = steerMessage(raw.prompt, undefined)
      if (!queuedRow || next.some((message) => message.id === queuedRow.id)) continue
      finalizeStreaming(Date.now(), false)
      copyTranscript()
      next.push(queuedRow)
      continue
    }
    if (type === 'omp_desktop_steer_retract' && (raw as Record<PropertyKey, unknown>)[LOCAL_STEER_RETRACT] === true) {
      const id = string(record(raw.prompt)?.id)
      if (!id) continue
      const index = next.findIndex((message) => message.id === `user-${id}`)
      if (index < 0) continue
      copyTranscript()
      next.splice(index, 1)
      continue
    }
    if (type === 'omp_desktop_steer_accepted' && (raw as Record<PropertyKey, unknown>)[LOCAL_STEER_ACCEPTED] === true) {
      const accepted = steerMessage(raw.prompt, 'accepted')
      if (!accepted) continue
      // Freeze the output already visible when the RPC response confirms
      // admission. Later deltas open a new assistant segment below this row,
      // so the steer cannot ride the live bottom edge as output grows.
      finalizeStreaming(Date.now(), false)
      copyTranscript()
      // The row usually already rendered at submit time; admission upgrades
      // it to the accepted state instead of appending a duplicate.
      const existingIndex = next.findIndex((message) => message.id === accepted.id)
      if (existingIndex >= 0) draftMessage(existingIndex).steerState = 'accepted'
      else next.push(accepted)
      continue
    }
    if (type === 'omp_desktop_steer_pickup' && (raw as Record<PropertyKey, unknown>)[LOCAL_STEER_PICKUP] === true) {
      const prompts = Array.isArray(raw.prompts) ? raw.prompts : []
      const pickedUp = prompts.flatMap((value) => {
        const message = steerMessage(value, 'read')
        return message ? [message] : []
      })
      if (!pickedUp.length) continue
      finalizeStreaming(Date.now(), false)
      copyTranscript()
      for (const message of pickedUp) {
        const existingIndex = next.findIndex((candidate) => candidate.id === message.id)
        if (existingIndex >= 0) draftMessage(existingIndex).steerState = 'read'
        else next.push(message)
      }
      const markerId = `steer-read-${pickedUp.map((message) => message.id).join('-')}`
      if (!next.some((message) => message.id === markerId)) {
        next.push({
          id: markerId,
          role: 'system',
          kind: 'steer-read-marker',
          timestamp: Date.now(),
          parts: [{ type: 'text', text: pickedUp.length === 1 ? 'Steer read here' : `${pickedUp.length} steers read here` }],
        })
      }
      continue
    }
    if (isCompactionEvent(raw)) {
      // Compaction changes the transcript shape (it closes the current
      // assistant turn and inserts a system activity row), so it applies to a
      // materialized transcript: flush the draft, apply the compaction policy,
      // and re-open drafting on the result.
      materializeDrafts()
      rebase(applyCompactionEvent(next, raw) ?? next)
      continue
    }
    if (type === 'goal_updated') {
      // 上游 GoalRuntime 的目標狀態事件(rpc 模式原樣沿用給 RPC 主機)。
      // GUI 主動下的操作已由命令結果列呈現,create/resume 另有 goal_context
      // 列;這裡只承接「沒有其他顯示管道」的終態與退出(預算耗盡、完成、
      // 被捨棄、模式結束),其餘轉移由 formatGoalEventUpdateText 回 undefined 略過。
      const goalValue = raw.goal === null ? undefined : raw.goal
      const stateValue = raw.state === null ? undefined : raw.state
      const goal = parseGoalSnapshot(goalValue)
      const state = parseGoalModeState(stateValue)
      // 異形的 goal/state 是造型不符而非「目標已結束」,略過不猜。
      if ((goalValue !== undefined && !goal) || (stateValue !== undefined && !state)) continue
      const text = formatGoalEventUpdateText(goal, state, (key, values) => translate('en', key, values))
      if (!text) continue
      // replay buffer 可能重播同一事件,以目標+狀態+時戳去重;目標與狀態
      // 皆空的模式退出只擋住緊鄰的重複列。
      const markerId = goal ? `goal-update-${goal.id}-${goal.status}-${goal.updatedAt}` : 'goal-update-ended'
      if (next.some((message) => message.id === markerId) || next.at(-1)?.id === markerId) continue
      finalizeStreaming(Date.now(), false)
      copyTranscript()
      next.push({ id: markerId, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text }] })
      continue
    }
    if (type === 'agent_start' || type === 'turn_start') {
      // Gate on a streaming *assistant* to match the sequential reducer: a
      // compaction system row carried over from a previous batch may still be
      // streaming, yet a new turn must open a fresh assistant message.
      if (lastStreamingAssistant < 0 && resumeTailAssistant() === undefined) appendAssistant('assistant')
      continue
    }
    if (type === 'auto_retry_start') {
      // A provider auto-retry continues the turn that the preceding agent_end
      // finalized: reopen the tail assistant so the transcript keeps showing
      // work in progress through the backoff, and drop the empty-turn fallback
      // the finalize added so retried content does not stream in after it.
      if (lastStreamingAssistant < 0) {
        const resumed = resumeTailAssistant()
        if (resumed === undefined) appendAssistant('assistant')
        else dropTailFallback(resumed)
      }
      continue
    }
    if (type === 'message_update') {
      const delta = record(raw.assistantMessageEvent) ?? record(raw.delta)
      const deltaType = string(delta?.type)
      const text = string(delta?.delta) ?? ''
      if ((deltaType === 'text_delta' || deltaType === 'thinking_delta') && text) {
        const draft = draftParts(assistantIndex())
        const partType = deltaType === 'text_delta' ? 'text' : 'thinking'
        if (draft.tail?.part.type === partType) draft.tail.part = { ...draft.tail.part, text: draft.tail.part.text + text }
        else appendNode(draft, withPartId({ type: partType, text }))
      } else if (deltaType === 'toolcall_end') {
        const tool = record(delta?.toolCall)
        const name = string(tool?.name) ?? 'Tool'
        upsertToolDraft(assistantIndex(), effectiveToolId(string(tool?.id), name), name, tool?.arguments ?? tool?.args)
      }
      continue
    }
    if (type === 'tool_execution_start') {
      const name = string(raw.toolName) ?? 'Tool'
      upsertToolDraft(assistantIndex(), effectiveToolId(string(raw.toolCallId), name), name, raw.args)
      continue
    }
    if (type === 'tool_execution_update') {
      const index = assistantIndex()
      const name = string(raw.toolName) ?? 'Tool'
      const id = effectiveToolId(string(raw.toolCallId), name)
      upsertToolDraft(index, id, name, raw.args)
      const draft = draftParts(index)
      const call = draft.firstToolById.get(id)
      if (call) setToolResult(draft, call, { type: 'toolResult', name, text: resultText(raw.partialResult), streaming: true })
      continue
    }
    if (type === 'tool_execution_end') {
      const index = assistantIndex()
      const name = string(raw.toolName) ?? 'Tool'
      const id = effectiveToolId(string(raw.toolCallId), name)
      const draft = draftParts(index)
      const call = draft.firstToolById.get(id)
      const resultPart: MessagePart = { type: 'toolResult', name, text: resultText(raw.result), isError: raw.isError === true }
      // 圖片與無 GUI adapter 的非文字輸出以資料視圖緊接在 toolResult 之後
      // 保留（GAP 2 + 階段 6.2）；持久化讀取時同樣保留這些 part，
      // reload／fork 前後都不靜默消失。無補充內容時為共用凍結空陣列。
      const supplementary = supplementaryPartsFromResult(raw.result)
      if (call) {
        setToolResult(draft, call, resultPart)
        let anchor = call.next
        for (const part of supplementary) {
          anchor = anchor ? insertAfter(draft, anchor, withPartId(part)) : appendNode(draft, withPartId(part))
        }
      } else {
        appendNode(draft, withPartId({ type: 'toolCall', id, name }))
        appendNode(draft, withPartId(resultPart))
        for (const part of supplementary) appendNode(draft, withPartId(part))
      }
      continue
    }
    if (type === 'custom_message') {
      // 持久化只收 display:true 的 custom_message；live 比照略過明確標示不顯示者，
      // 否則 session_note 之類內部紀錄會 live 可見、reload 後消失。
      if (raw.display === false) continue
      // 與持久化共用 customMessageShape：goal_context→goal 列、agent_message→
      // agentMessage part、其餘 display:true 的 customType→具名活動 part（GAP 1）。
      const shape = customMessageShape(raw)
      if (!shape) continue
      const tailAssistantActive = lastStreamingAssistant >= 0 || next.at(-1)?.role === 'assistant'
      if (shape.kind !== 'goal' && tailAssistantActive) {
        const draft = draftParts(assistantIndex())
        if (shape.kind === 'activity') {
          appendNode(draft, withPartId({ type: 'toolCall', name: shape.name }))
          appendNode(draft, withPartId({ type: 'toolResult', name: shape.name, text: shape.text }))
        } else {
          appendNode(draft, withPartId({ type: 'agentMessage', text: shape.text, agentName: shape.agentName }))
        }
        continue
      }
      // 無活動助理回合，或目標摘要：比照持久化語意產生獨立列。
      finalizeStreaming(Date.now(), false)
      copyTranscript()
      const timestamp = Date.now()
      next.push({
        id: nextTranscriptId(shape.kind === 'agentMessage' ? 'agent' : shape.kind === 'goal' ? 'goal' : 'tool'),
        role: shape.kind === 'agentMessage' ? 'agent' : shape.kind === 'goal' ? 'goal' : 'tool',
        timestamp,
        agentName: shape.kind === 'agentMessage' ? shape.agentName : undefined,
        parts: shape.kind !== 'activity'
          ? [withPartId({ type: 'text', text: shape.text })]
          : [withPartId({ type: 'toolCall', name: shape.name }), withPartId({ type: 'toolResult', name: shape.name, text: shape.text })],
      })
      continue
    }
    if (type === 'agent_end') {
      finalizeStreaming(Date.now(), true)
      continue
    }
    // Local-only slash commands never raise agent_end — admission completes
    // via prompt_result with agentInvoked:false, so that is their terminal.
    if (type === 'prompt_result') {
      if (raw.agentInvoked === false) finalizeStreaming(Date.now(), false)
      continue
    }
    if (type === 'retry_fallback_applied' || type === 'model_change') {
      const fallback = fallbackModelFromRecord(raw)
      if (!fallback) continue
      const text = fallbackNoticeText(fallback.label, fallback.from)
      const last = next.at(-1)
      if (last?.role === 'system' && last.parts.length === 1 && last.parts[0]?.type === 'text' && last.parts[0].text === text) continue
      const timestamp = Date.now()
      finalizeStreaming(timestamp, false)
      copyTranscript()
      next.push({ id: nextTranscriptId('fallback'), role: 'system', timestamp, parts: [withPartId({ type: 'text', text })] })
      continue
    }
    if (type === 'notice') {
      const notice = agentNoticeFromEvent(raw)
      if (!notice) continue
      const kind: AgentNoticeKind = notice.level === 'error'
        ? 'agent-notice-error'
        : notice.level === 'warning' ? 'agent-notice-warning' : 'agent-notice'
      const text = agentNoticeBody(notice)
      const last = next.at(-1)
      if (last?.role === 'system' && last.kind === kind && last.parts.length === 1 && last.parts[0]?.type === 'text' && last.parts[0].text === text) continue
      const timestamp = Date.now()
      // Like queued rows and fallback notices, the row lands below the
      // streamed segment; later deltas open a fresh assistant segment so the
      // transcript keeps chronological order without ending the turn.
      finalizeStreaming(timestamp, false)
      copyTranscript()
      next.push({ id: nextTranscriptId('notice'), role: 'system', kind, timestamp, parts: [withPartId({ type: 'text', text })] })
      continue
    }
    if (type === 'extension_error' || type === 'error' || type === 'transport_error') {
      const text = string(raw.error) ?? string(raw.message) ?? `${HARNESS_AGENT_NAMES.omp} encountered an error.`
      finalizeStreaming(Date.now(), false)
      if (next.at(-1)?.role === 'system') continue
      copyTranscript()
      next.push({ id: nextTranscriptId('error'), role: 'system', timestamp: Date.now(), parts: [withPartId({ type: 'text', text })] })
      continue
    }
    if (type === 'runtime_exit') {
      finalizeStreaming(Date.now(), false)
      if (raw.expected === true || next.at(-1)?.role === 'system') continue
      const reason = raw.code !== null && raw.code !== undefined ? `exit code ${String(raw.code)}` : string(raw.signal) ?? 'an unknown error'
      copyTranscript()
      // This reducer normalizes raw OMP agent events for the renderer.
      next.push({ id: nextTranscriptId('error'), role: 'system', timestamp: Date.now(), parts: [withPartId({ type: 'text', text: `The agent stopped unexpectedly (${reason}). Send the message again to restart it.` })] })
    }
  }

  materializeDrafts()
  return next
}

export interface PrimeEventBuffer {
  readonly size: number
  readonly payloadBytes: number
  readonly overflowed: boolean
  push(event: Record<string, unknown>): boolean
  replay(messages: TranscriptMessage[]): TranscriptMessage[]
}

export function createPrimeEventBuffer({ maxEvents = EVENT_REPLAY_MAX_EVENTS, maxBytes = EVENT_REPLAY_MAX_BYTES } = {}): PrimeEventBuffer {
  const events: Record<string, unknown>[] = []
  let payloadBytes = 0
  let overflowed = false
  return {
    get size() { return events.length },
    get payloadBytes() { return payloadBytes },
    get overflowed() { return overflowed },
    push(event) {
      if (overflowed) return false
      const bytes = eventPayloadBytes(event, maxBytes)
      if (events.length >= maxEvents || payloadBytes + bytes > maxBytes) {
        overflowed = true
        events.length = 0
        payloadBytes = 0
        return false
      }
      payloadBytes += bytes
      events.push(event)
      return true
    },
    replay(messages) { return replayPrimeEvents(messages, events) },
  }
}

/**
 * Sequential application is a batch of one: there is exactly one reducer, so
 * single-event and batched replay cannot diverge for any event type.
 */
export function applyPrimeEvent(messages: TranscriptMessage[], raw: Record<string, unknown>): TranscriptMessage[] {
  return replayPrimeEvents(messages, [raw])
}
