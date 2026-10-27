import { createReadStream } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MessagePart, TranscriptMessage } from '../../../src/types/api'
import {
  boundedString,
  contentText,
  customMessageShape,
  MAX_PART_IMAGE_CHARS,
  MAX_PART_TEXT_CHARS,
  textFromContent,
  unsupportedPartFromBlock,
} from '../../../src/lib/events/message-content'
import { SESSION_FILE_RECORD_LIMIT_BYTES } from '../jsonl-limits'
import { strictJsonLines } from '../jsonl'
import { isRecord } from '../validation'
import type { JsonRecord } from './metadata'
import { parseGooeyPiAgentMessage } from '../collaboration/message-envelope'

const MAX_TRANSCRIPT_GRAPH_BYTES = 16 * 1024 * 1024
const MAX_TRANSCRIPT_GRAPH_RECORDS = 10_000
const MAX_TRANSCRIPT_MESSAGES = 400
const MAX_TRANSCRIPT_PARTS = 2_000
const MAX_TRANSCRIPT_TEXT_CHARS = 1024 * 1024
const MAX_TRANSCRIPT_TOOL_CHARS = 512 * 1024
const MAX_TRANSCRIPT_ARGS_CHARS = 256 * 1024
// Image budgets: session files already admit records up to 64 MiB, and pasted
// screenshots routinely exceed the old 2 MiB caps, so a single large image (or
// a handful of smaller ones) marked dataTruncated and the renderer showed
// "圖片附件無法使用" after reload. The budget only exists to bound renderer
// memory, so keep it generous: 8 MiB per part and 24 MiB across the transcript.
const MAX_TRANSCRIPT_IMAGE_CHARS = 24 * 1024 * 1024
const MAX_PART_TOOL_CHARS = 128 * 1024
const MAX_PART_ARGS_CHARS = 128 * 1024
const MAX_PARTS_PER_RECORD = 200

// 文字抽取與 bounding 的純語意已搬至 src/lib/events/message-content.ts，
// 讓 renderer 的 live reducer 與此處共用；保留同名 re-export 供既有 importer 使用。
export { boundedString, MAX_PART_TEXT_CHARS, textFromContent }

export function compactText(value: string, max = 160): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

export function validTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = new Date(value)
    if (Number.isFinite(timestamp.getTime())) return timestamp.toISOString()
  }
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString()
  return fallback
}

function roleOf(message: JsonRecord): TranscriptMessage['role'] {
  switch (message.role) {
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    case 'system': return 'system'
    default: return 'tool'
  }
}

function boundedArgs(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    return serialized.length <= MAX_PART_ARGS_CHARS ? value : boundedString(serialized, MAX_PART_ARGS_CHARS)
  } catch { return '[unserializable arguments]' }
}

function partsFromMessage(message: JsonRecord): MessagePart[] {
  const content = message.content
  const parts: MessagePart[] = []
  if (typeof content === 'string') parts.push({ type: 'text', text: boundedString(content, MAX_PART_TEXT_CHARS) })
  else if (Array.isArray(content)) {
    const selected = content.length <= MAX_PARTS_PER_RECORD ? content : [...content.slice(0, 20), ...content.slice(-(MAX_PARTS_PER_RECORD - 20))]
    for (const raw of selected) {
      if (!isRecord(raw) || typeof raw.type !== 'string') continue
      if (raw.type === 'text' && typeof raw.text === 'string') parts.push({ type: 'text', text: boundedString(raw.text, MAX_PART_TEXT_CHARS) })
      else if (raw.type === 'thinking' && typeof raw.thinking === 'string') parts.push({ type: 'thinking', text: boundedString(raw.thinking, MAX_PART_TEXT_CHARS) })
      else if ((raw.type === 'toolCall' || raw.type === 'tool_call') && typeof raw.name === 'string') {
        parts.push({
          type: 'toolCall',
          id: typeof raw.id === 'string' ? boundedString(raw.id, 1_024) : undefined,
          name: boundedString(raw.name, 512),
          args: boundedArgs(raw.arguments ?? raw.args),
        })
      } else if (raw.type === 'image') {
        parts.push({
          type: 'image',
          mimeType: typeof raw.mimeType === 'string' ? boundedString(raw.mimeType, 128) : undefined,
          data: typeof raw.data === 'string' ? boundedString(raw.data, MAX_PART_IMAGE_CHARS) : undefined,
          dataTruncated: typeof raw.data === 'string' && raw.data.length > MAX_PART_IMAGE_CHARS || undefined,
        })
      } else {
        // GAP 3 + 階段 6.2：未知的 content block（file/audio、provider 專屬
        // block 等）連同原始資料保留讓渲染層顯示可讀資料視圖，不再靜默消失。
        // 與 live reducer 共用 unsupportedPartFromBlock，兩側資料視圖一致。
        // 非結構化的 block 仍略過。
        parts.push(unsupportedPartFromBlock(raw))
      }
    }
  }
  if (message.role === 'toolResult' || message.role === 'tool') {
    // GAP 2/5：文字以外的 part（圖片、未知的附件）保留在 toolResult 之後；
    // 純物件內容以 pretty JSON 呈現，與 live reducer 的 contentText 一致。
    const textParts = parts.filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    const keptParts = parts.filter((part) => part.type === 'image' || part.type === 'unsupported')
    const joined = textParts.map((part) => part.text).join('\n')
    const text = joined || (typeof content === 'string' || Array.isArray(content) ? '' : contentText(content))
    return [{
      type: 'toolResult',
      name: typeof message.toolName === 'string' ? boundedString(message.toolName, 512) : undefined,
      text: boundedString(text, MAX_PART_TOOL_CHARS),
      isError: message.isError === true,
    }, ...keptParts]
  }
  if (message.role === 'bashExecution') {
    // 使用者 `!` bash 的歷史列:與 live 結果列(src/lib/bash-result.ts)同形狀
    // (toolCall bash → toolResult bash → 非文字 kept-parts)。狀態註記
    // (cancelled/truncated)附在輸出尾;exitCode≠0 走 isError 樣式。磁碟上
    // 的歷史不含 i18n,狀態保留上游欄位原文([cancelled]/[truncated])。
    const parts: MessagePart[] = []
    if (typeof message.command === 'string' && message.command) {
      parts.push({ type: 'toolCall', name: 'bash', args: boundedArgs({ command: boundedString(message.command, MAX_PART_ARGS_CHARS) }) })
    }
    const status = [message.cancelled === true ? '[cancelled]' : '', message.truncated === true ? '[truncated]' : ''].filter(Boolean).join(' ')
    const output = typeof message.output === 'string' ? boundedString(message.output, MAX_PART_TOOL_CHARS) : ''
    parts.push({
      type: 'toolResult',
      name: 'bash',
      text: [output, status].filter(Boolean).join('\n'),
      isError: message.cancelled === true || (typeof message.exitCode === 'number' && message.exitCode !== 0),
    })
    // 非文字內容(圖片)比照 toolResult 的 kept-parts 管線,不靜默丟棄。
    if (Array.isArray(message.images)) {
      for (const raw of message.images) {
        if (!isRecord(raw) || typeof raw.data !== 'string' || typeof raw.mimeType !== 'string') continue
        parts.push({ type: 'image', data: raw.data, mimeType: raw.mimeType })
      }
    }
    return parts
  }
  return parts.length ? parts : [{ type: 'text', text: '' }]
}

function boundedTranscript(transcript: TranscriptMessage[]): TranscriptMessage[] {
  let textBudget = MAX_TRANSCRIPT_TEXT_CHARS
  let toolBudget = MAX_TRANSCRIPT_TOOL_CHARS
  let argsBudget = MAX_TRANSCRIPT_ARGS_CHARS
  let imageBudget = MAX_TRANSCRIPT_IMAGE_CHARS
  let partBudget = MAX_TRANSCRIPT_PARTS
  const bounded: TranscriptMessage[] = []

  for (const message of transcript.slice(-MAX_TRANSCRIPT_MESSAGES).reverse()) {
    const parts: MessagePart[] = []
    for (const part of [...message.parts].reverse()) {
      if (partBudget <= 0) break
      let next: MessagePart | undefined
      if (part.type === 'text' || part.type === 'thinking' || part.type === 'agentMessage') {
        if (textBudget > 0) {
          const text = boundedString(part.text, textBudget)
          textBudget -= text.length
          next = part.type === 'agentMessage'
            ? { ...part, text, agentName: part.agentName ? boundedString(part.agentName, 200) : undefined }
            : { ...part, text }
        }
      } else if (part.type === 'toolResult') {
        if (toolBudget > 0) {
          const text = boundedString(part.text, toolBudget)
          toolBudget -= text.length
          next = { ...part, text }
        }
      } else if (part.type === 'toolCall') {
        let args: unknown
        if (part.args !== undefined && argsBudget > 0) {
          const serialized = typeof part.args === 'string' ? part.args : JSON.stringify(part.args)
          if (serialized.length <= argsBudget) args = part.args
          else args = boundedString(serialized, argsBudget)
          argsBudget -= Math.min(serialized.length, argsBudget)
        }
        next = { ...part, args }
      } else if (part.type === 'compaction') {
        const boundedText = (value: string | undefined): string | undefined => {
          if (!value || textBudget <= 0) return undefined
          const text = boundedString(value, textBudget)
          textBudget -= text.length
          return text
        }
        next = {
          ...part,
          summary: boundedText(part.summary),
          error: boundedText(part.error),
          customInstructions: boundedText(part.customInstructions),
        }
      } else if (part.type === 'image') {
        let data: string | undefined
        if (part.data && imageBudget > 0) {
          data = boundedString(part.data, imageBudget)
          imageBudget -= Math.min(part.data.length, imageBudget)
        }
        next = { ...part, data, dataTruncated: part.dataTruncated || Boolean(part.data && data !== part.data) || undefined }
      } else if (part.type === 'unsupported') {
        // 未知附件的 placeholder 體積小（型別字串）加上資料視圖文字；
        // data 走文字預算，整支 transcript 的渲染記憶體仍有界。
        let data: string | undefined
        if (part.data && textBudget > 0) {
          data = boundedString(part.data, textBudget)
          textBudget -= Math.min(part.data.length, textBudget)
        }
        next = { ...part, contentType: boundedString(part.contentType, 200), data }
      }
      if (next) {
        parts.push(next)
        partBudget -= 1
      }
    }
    if (parts.length) bounded.push({ ...message, parts: parts.reverse() })
  }
  return bounded.reverse()
}

/**
 * Harness-specific transcript rendering over the shared branch machinery.
 * `isRenderable` selects which payloads enter the retained graph; leaf
 * selection and ancestry include non-renderable records. `renderEntry` renders
 * retained record types the shared walk does not handle itself (anything other
 * than `message`, `compaction`, and `custom_message`).
 */
export interface TranscriptDialect {
  isRenderable(entry: JsonRecord): boolean
  renderEntry?(entry: JsonRecord, safeId: string): TranscriptMessage | undefined
}

const primeTranscriptDialect: TranscriptDialect = {
  isRenderable: (entry) => entry.type === 'message' || entry.type === 'compaction'
    || (entry.type === 'custom_message' && entry.display === true),
}

export type TranscriptFileReader = (filePath: string, isStreaming: boolean) => Promise<TranscriptMessage[]>

/** OMP externalizes image payloads into a global content-addressed blob store
 * (`<agentDir>/blobs/<sha256>`); session entries carry `blob:sha256:<hash>`
 * references instead of inline base64. Resolution happens after the parse so
 * duplicate references dedupe to one read and the bounding pass below still
 * sees final base64 sizes. */
export function defaultOmpBlobsRoot(): string {
  return join(homedir(), '.omp', 'agent', 'blobs')
}

const BLOB_REFERENCE = /^blob:sha256:([0-9a-f]{64})$/

async function resolveImageBlobReferences(transcript: TranscriptMessage[], blobsRoot: string): Promise<void> {
  const pending = new Map<string, Promise<string | null>>()
  const readBlob = (hash: string): Promise<string | null> => readFile(join(blobsRoot, hash))
    .then((buffer) => {
      const maxBytes = Math.floor(MAX_PART_IMAGE_CHARS * 3 / 4)
      return buffer.subarray(0, Math.min(buffer.length, maxBytes)).toString('base64')
    })
    .catch(() => null)
  for (const message of transcript) {
    for (const part of message.parts) {
      if (part.type !== 'image' || !part.data) continue
      const hash = BLOB_REFERENCE.exec(part.data)?.[1]
      if (!hash) continue
      let read = pending.get(hash)
      if (!read) {
        read = readBlob(hash)
        pending.set(hash, read)
      }
      const data = await read
      if (data === null || !data.length) {
        part.data = undefined
        part.dataTruncated = true
      } else {
        part.data = data
        part.dataTruncated = data.length >= MAX_PART_IMAGE_CHARS || undefined
      }
    }
  }
}

export function createTranscriptReader(dialect: TranscriptDialect = primeTranscriptDialect, blobsRoot: string = defaultOmpBlobsRoot()): TranscriptFileReader {
  return (filePath, isStreaming) => readTranscriptWithDialect(dialect, filePath, isStreaming, blobsRoot)
}

/** Yields complete LF-delimited lines from the end of the file toward the
 * start. Lines are cut on newline boundaries only (matching strictJsonLines,
 * which keeps U+2028/U+2029 inside JSON strings), so multi-byte UTF-8
 * sequences never split. A newline-free region (a long record spanning many
 * chunks) buffers its chunks and assembles each line exactly once when its
 * start delimiter arrives — linear, never quadratic. */
async function* jsonLinesReverse(filePath: string): AsyncGenerator<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    let position = (await handle.stat()).size
    if (position > 256 * 1024 * 1024) throw new Error('Session transcript is too large to display')
    // Fragments are appended in reverse file order and reversed only when
    // assembling a complete line, avoiding both byte copies and array shifts.
    let pending: Buffer[] = []
    let pendingLength = 0
    const chunkSize = 64 * 1024
    while (position > 0) {
      const readSize = Math.min(chunkSize, position)
      position -= readSize
      const chunk = Buffer.alloc(readSize)
      let filled = 0
      while (filled < readSize) {
        const { bytesRead } = await handle.read(chunk, filled, readSize - filled, position + filled)
        if (bytesRead === 0) throw new Error('Session transcript changed while reading ancestry')
        filled += bytesRead
      }
      if (!chunk.includes(0x0a)) {
        pending.push(chunk)
        pendingLength += chunk.length
        if (pendingLength > SESSION_FILE_RECORD_LIMIT_BYTES) throw new Error('Session transcript record is too large to display')
        continue
      }
      const data = pendingLength > 0 ? Buffer.concat([chunk, ...pending.reverse()]) : chunk
      pending = []
      pendingLength = 0
      let end = data.length
      while (end > 0) {
        const delimiter = data.lastIndexOf(0x0a, end - 1)
        if (delimiter === -1) break
        if (delimiter + 1 < end) yield data.subarray(delimiter + 1, end)
        end = delimiter
      }
      if (end > 0) {
        pending = [data.subarray(0, end)]
        pendingLength = end
      }
    }
    if (pendingLength > 0) yield Buffer.concat(pending.reverse())
  } finally {
    await handle.close()
  }
}

/** Load global last-occurrence edges only after the normal bounded window
 * misses. Positional ancestor matching cannot resolve out-of-order records or
 * rewritten ancestors reliably: the authoritative occurrence may already have
 * passed before its id becomes needed. A reverse scan keeps each id's first
 * occurrence, which is its global last write, before walking any ancestry.
 * The temporary edge index has explicit record/byte budgets; exhaustion is an
 * error, never permission to guess another active branch. Renderable payloads
 * still come exclusively from the original bounded entries map. */
async function recoverTranscriptEdges(filePath: string): Promise<Map<string, string | null>> {
  const edges = new Map<string, string | null>()
  let edgeBytes = 0
  let recordCount = 0
  for await (const line of jsonLinesReverse(filePath)) {
    if (++recordCount > 200_000) throw new Error('Session transcript has too many records')
    // A live append after the forward pass has not passed its record-size
    // validation yet. Never decode or parse oversized recovery records.
    if (line.length > SESSION_FILE_RECORD_LIMIT_BYTES) throw new Error('Session transcript record is too large to display')
    let entry: unknown
    try { entry = JSON.parse(line.toString('utf8')) } catch { continue }
    if (!isRecord(entry) || entry.type === 'session' || typeof entry.id !== 'string' || entry.id.length > 1_024) continue
    if (edges.has(entry.id)) continue
    const parentId = typeof entry.parentId === 'string' && entry.parentId.length <= 1_024 ? entry.parentId : null
    // Charge retained UTF-16 strings plus a fixed per-edge allowance, keeping
    // recovery independently bounded by the existing graph byte budget.
    edgeBytes += (entry.id.length + (parentId?.length ?? 0)) * 2 + 64
    if (edgeBytes > MAX_TRANSCRIPT_GRAPH_BYTES) throw new Error('Session transcript ancestry is too large to display')
    edges.set(entry.id, parentId)
  }
  return edges
}

async function readTranscriptWithDialect(dialect: TranscriptDialect, filePath: string, isStreaming: boolean, blobsRoot: string): Promise<TranscriptMessage[]> {
  if ((await stat(filePath)).size > 256 * 1024 * 1024) throw new Error('Session transcript is too large to display')
  const entries = new Map<string, { id: string; parentId: string | null; entry: JsonRecord; bytes: number }>()
  // A light id→parentId edge map covers every record, so the parent-chain walk
  // still traverses nodes that never render (and never charge the budgets).
  const parentEdges = new Map<string, string | null>()
  let graphBytes = 0
  // True once the renderable payload FIFO ever evicts: the retained graph no
  // longer covers the full file, so a confirmed capture whose branch yields
  // no retained payload must fail closed instead of rendering another branch.
  let payloadEvictionOccurred = false
  // Upstream v18.12.6 session-entries.ts parity: the active leaf replays the
  // LAST record's captured `activeLeafId` (an off-branch record — late usage,
  // a routed background result — restores the branch it interrupted) instead
  // of defaulting to the newest renderable record. `null` records a cleared
  // leaf; absence keeps ordinary last-entry semantics.
  let lastRecordId: string | null = null
  let lastRecordActiveLeaf: string | null | undefined
  let selfSelectedLeafId: string | null = null
  let recordCount = 0
  // The metadata reader of the same file MUST share this per-record tolerance:
  // a record the catalog accepts must never make the transcript unopenable.
  for await (const line of strictJsonLines(createReadStream(filePath), SESSION_FILE_RECORD_LIMIT_BYTES)) {
    if (!line) continue
    if (++recordCount > 200_000) throw new Error('Session transcript has too many records')
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    if (!isRecord(entry) || entry.type === 'session' || typeof entry.id !== 'string' || entry.id.length > 1_024) continue
    const parentId = typeof entry.parentId === 'string' && entry.parentId.length <= 1_024 ? entry.parentId : null
    parentEdges.delete(entry.id)
    parentEdges.set(entry.id, parentId)
    while (parentEdges.size > MAX_TRANSCRIPT_GRAPH_RECORDS * 4) {
      const oldestEdge = parentEdges.keys().next().value as string | undefined
      if (oldestEdge === undefined) break
      parentEdges.delete(oldestEdge)
    }
    const rawActiveLeaf: unknown = entry.activeLeafId
    lastRecordId = entry.id
    // sessionEntryLeafId parity: a string leaf restores the captured branch,
    // null clears it, and only an absent (or self-pointing) value lets the
    // record select itself. Corrupt non-string values read as absent so one
    // bad record cannot make the transcript unopenable.
    lastRecordActiveLeaf = rawActiveLeaf === null ? null
      : typeof rawActiveLeaf === 'string' ? boundedString(rawActiveLeaf, 1_024)
      : undefined
    if (lastRecordActiveLeaf === undefined || lastRecordActiveLeaf === entry.id) selfSelectedLeafId = entry.id
    // Payload is last-write-wins like the edges: a rewrite that flips an id
    // from renderable to non-renderable must drop the stale retained payload
    // (and refund its byte charge) instead of leaving the old message in place.
    const existing = entries.get(entry.id)
    if (existing) {
      graphBytes -= existing.bytes
      entries.delete(entry.id)
    }
    if (!dialect.isRenderable(entry)) continue
    const bytes = Buffer.byteLength(line, 'utf8')
    entries.set(entry.id, { id: entry.id, parentId, entry, bytes })
    graphBytes += bytes
    while (entries.size > MAX_TRANSCRIPT_GRAPH_RECORDS || graphBytes > MAX_TRANSCRIPT_GRAPH_BYTES) {
      const oldestId = entries.keys().next().value as string | undefined
      if (oldestId === undefined) break
      payloadEvictionOccurred = true
      graphBytes -= entries.get(oldestId)?.bytes ?? 0
      entries.delete(oldestId)
    }
  }
  let recoveredParentEdges: Map<string, string | null> | undefined
  const walkBranch = (startId: string | null): { branch: Array<{ id: string; entry: JsonRecord }>; missingEdgeId: string | null } => {
    const collected: Array<{ id: string; entry: JsonRecord }> = []
    const visited = new Set<string>()
    let currentId = startId
    let missingEdgeId: string | null = null
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const node = entries.get(currentId)
      if (node) collected.push(node)
      const parent = (recoveredParentEdges ?? parentEdges).get(currentId)
      // undefined = the edge fell outside the retained window (recoverable);
      // null = a genuine root.
      if (parent === undefined) { missingEdgeId = currentId; break }
      currentId = parent
    }
    return { branch: collected, missingEdgeId }
  }
  // Normal reads walk the small FIFO window. On its first miss, load one
  // bounded global last-occurrence index and reuse it for every subsequent
  // walk, regardless of how many interleaved eviction gaps the branch has.
  const walkBranchWithRecovery = async (startId: string | null): Promise<Array<{ id: string; entry: JsonRecord }>> => {
    const walked = walkBranch(startId)
    if (walked.missingEdgeId === null || recoveredParentEdges !== undefined) return walked.branch
    recoveredParentEdges = await recoverTranscriptEdges(filePath)
    return walkBranch(startId).branch
  }
  // resolveSessionLeafId parity: the last record decides. An explicit null is
  // a cleared session (empty branch, never the dead-end fallback). A captured
  // id missing from the FIFO window requires the complete bounded index to
  // distinguish an evicted valid leaf from an actually nonexistent capture;
  // only the latter uses the upstream newest-self-selecting fallback.
  let leafId: string | null
  if (lastRecordId === null) leafId = null
  else {
    const captured = lastRecordActiveLeaf !== undefined ? lastRecordActiveLeaf : lastRecordId
    if (captured === null) leafId = null
    else if (captured === lastRecordId || parentEdges.has(captured)) leafId = captured
    else {
      recoveredParentEdges = await recoverTranscriptEdges(filePath)
      leafId = recoveredParentEdges.has(captured) ? captured : selfSelectedLeafId
    }
  }
  let branch = leafId === null ? [] : await walkBranchWithRecovery(leafId)
  if (!branch.length && entries.size && leafId !== null) {
    if (payloadEvictionOccurred && leafId !== selfSelectedLeafId) {
      // A confirmed capture whose branch retained no payload after FIFO
      // eviction: rendering any other branch would silently switch the
      // conversation, so fail closed like every other budget exhaustion
      // instead of guessing. The self-selected fallback keeps the legacy
      // dead-branch behavior because it never promised another branch.
      throw new Error('Session transcript active branch is too large to display')
    }
    // The active branch dead-ended before reaching any retained record; fall
    // back to the most recently retained renderable record instead of
    // rendering an empty transcript.
    let fallbackId: string | null = null
    for (const id of entries.keys()) fallbackId = id
    branch = await walkBranchWithRecovery(fallbackId)
  }
  branch.reverse()
  const transcript: TranscriptMessage[] = []
  let activeAssistant: TranscriptMessage | undefined
  // First toolCall part index per id for the active turn: tool results resolve
  // their call in O(1) instead of scanning the accumulated parts.
  let toolCallIndexById = new Map<string, number>()
  const beginAssistantTurn = (): void => { toolCallIndexById = new Map() }
  const registerToolCalls = (startIndex: number, added: MessagePart[]): void => {
    for (let offset = 0; offset < added.length; offset += 1) {
      const part = added[offset]
      if (part.type === 'toolCall' && part.id !== undefined && !toolCallIndexById.has(part.id)) {
        toolCallIndexById.set(part.id, startIndex + offset)
      }
    }
  }
  const appendAssistantParts = (added: MessagePart[]): void => {
    if (!activeAssistant) return
    registerToolCalls(activeAssistant.parts.length, added)
    activeAssistant.parts.push(...added)
  }
  for (const { id, entry } of branch) {
    const safeId = boundedString(id, 1_024)
    if (entry.type === 'compaction') {
      const timestamp = typeof entry.timestamp === 'string' ? boundedString(entry.timestamp, 128) : undefined
      const tokensBefore = typeof entry.tokensBefore === 'number' && Number.isFinite(entry.tokensBefore) && entry.tokensBefore >= 0 ? entry.tokensBefore : undefined
      const tokensAfter = typeof entry.tokensAfter === 'number' && Number.isFinite(entry.tokensAfter) && entry.tokensAfter >= 0 ? entry.tokensAfter : undefined
      const summary = typeof entry.summary === 'string' ? boundedString(entry.summary, MAX_PART_TEXT_CHARS) : undefined
      const firstKeptEntryId = typeof entry.firstKeptEntryId === 'string' ? boundedString(entry.firstKeptEntryId, 1_024) : undefined
      const customInstructions = typeof entry.customInstructions === 'string' ? boundedString(entry.customInstructions, MAX_PART_TEXT_CHARS) : undefined
      transcript.push({
        id: safeId,
        role: 'system',
        timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        parts: [{ type: 'compaction', status: 'done', tokensBefore, tokensAfter, summary, firstKeptEntryId, customInstructions }],
      })
      activeAssistant = undefined
      continue
    }
    if (entry.type === 'custom_message') {
      const details = isRecord(entry.details) ? entry.details : undefined
      const customType = typeof entry.customType === 'string' ? boundedString(entry.customType, 200) : 'activity'
      if (customType === 'compaction_outcome') {
        const outcome = details?.outcome === 'cancelled' ? 'cancelled' : details?.outcome === 'skipped' ? 'skipped' : 'failed'
        const reason = details?.reason === 'manual' || details?.reason === 'threshold' || details?.reason === 'overflow' || details?.reason === 'requested'
          ? details.reason
          : undefined
        const timestamp = typeof entry.timestamp === 'string' ? boundedString(entry.timestamp, 128) : undefined
        const text = boundedString(textFromContent(entry.content), MAX_PART_TEXT_CHARS)
        transcript.push({
          id: safeId,
          role: 'system',
          timestamp,
          startedAt: timestamp,
          completedAt: timestamp,
          parts: [{ type: 'compaction', status: outcome === 'cancelled' ? 'cancelled' : 'failed', outcome, reason, error: text }],
        })
        activeAssistant = undefined
        continue
      }
      // customType/details/content 的形狀決策與 live reducer 共用
      // （src/lib/events/message-content.ts 的 customMessageShape），此處只做 bounding 與落點。
      const shape = customMessageShape(entry)
      if (shape) {
        const text = boundedString(shape.text, MAX_PART_TEXT_CHARS)
        const agentName = shape.kind === 'agentMessage' && shape.agentName !== undefined ? boundedString(shape.agentName, 200) : undefined
        const timestamp = typeof entry.timestamp === 'string' ? boundedString(entry.timestamp, 128) : undefined
        if (shape.kind === 'agentMessage' && activeAssistant) {
          appendAssistantParts([{ type: 'agentMessage', text, agentName }])
          activeAssistant.completedAt = timestamp ?? activeAssistant.completedAt
        } else if (shape.kind === 'activity' && activeAssistant) {
          appendAssistantParts([{ type: 'toolCall', id: safeId, name: shape.name }, { type: 'toolResult', name: shape.name, text }])
          activeAssistant.completedAt = timestamp ?? activeAssistant.completedAt
        } else {
          transcript.push({
            id: safeId,
            role: shape.kind === 'agentMessage' ? 'agent' : shape.kind === 'goal' ? 'goal' : 'tool',
            timestamp,
            agentName,
            parts: shape.kind !== 'activity'
              ? [{ type: 'text', text }]
              : [{ type: 'toolCall', id: safeId, name: shape.name }, { type: 'toolResult', name: shape.name, text }],
          })
          activeAssistant = undefined
        }
      }
      continue
    }
    if (entry.type !== 'message') {
      // A dialect-specific record type reached the walk; render it standalone.
      const rendered = dialect.renderEntry?.(entry, safeId)
      if (rendered) transcript.push(rendered)
      activeAssistant = undefined
      continue
    }
    const message = isRecord(entry.message) ? entry.message : {}
    const collaborationMessage = message.role === 'user' ? parseGooeyPiAgentMessage(textFromContent(message.content)) : undefined
    if (collaborationMessage) {
      const rawTimestamp = typeof message.timestamp === 'string' || typeof message.timestamp === 'number' ? message.timestamp
        : typeof entry.timestamp === 'string' ? entry.timestamp : undefined
      transcript.push({
        id: safeId,
        role: 'agent',
        timestamp: typeof rawTimestamp === 'string' ? boundedString(rawTimestamp, 128) : rawTimestamp,
        agentName: collaborationMessage.fromTitle ? boundedString(collaborationMessage.fromTitle, 200) : undefined,
        parts: [{ type: 'text', text: boundedString(collaborationMessage.text, MAX_PART_TEXT_CHARS) }],
      })
      activeAssistant = undefined
      continue
    }
    const role = roleOf(message)
    // Messages start at their own timestamp; the enclosing entry is persisted at completion.
    const entryTimestamp = typeof entry.timestamp === 'string' ? boundedString(entry.timestamp, 128) : undefined
    const rawTimestamp = typeof message.timestamp === 'string' || typeof message.timestamp === 'number' ? message.timestamp : entryTimestamp
    const timestamp = typeof rawTimestamp === 'string' ? boundedString(rawTimestamp, 128) : rawTimestamp
    const completedAt = entryTimestamp ?? timestamp
    const parts = partsFromMessage(message)
    if (role === 'tool' && activeAssistant) {
      const toolCallId = typeof message.toolCallId === 'string' ? boundedString(message.toolCallId, 1_024) : undefined
      const callIndex = toolCallId !== undefined ? toolCallIndexById.get(toolCallId) ?? -1 : -1
      if (callIndex >= 0) {
        activeAssistant.parts.splice(callIndex + 1, 0, ...parts)
        for (const [callId, index] of toolCallIndexById) {
          if (index > callIndex) toolCallIndexById.set(callId, index + parts.length)
        }
        registerToolCalls(callIndex + 1, parts)
      } else appendAssistantParts(parts)
      activeAssistant.completedAt = completedAt ?? activeAssistant.completedAt
      continue
    }
    if (role === 'assistant') {
      // A provider failure persists as an assistant record with no content and
      // stopReason "error". Surface it as a failed turn plus its own error row
      // after it: the recovery bar keys off that row being the transcript
      // tail, so a successful retry (which appends after the row) dismisses
      // the bar instead of leaving it stuck on the reopened failed turn.
      const failed = message.stopReason === 'error'
      const outcome = failed ? 'failed' as const : undefined
      if (activeAssistant) {
        appendAssistantParts(parts)
        activeAssistant.completedAt = completedAt ?? activeAssistant.completedAt
        if (outcome) activeAssistant.outcome = outcome
      } else {
        beginAssistantTurn()
        registerToolCalls(0, parts)
        activeAssistant = { id: safeId, role, timestamp, startedAt: timestamp, completedAt, parts, outcome }
        transcript.push(activeAssistant)
      }
      if (failed) {
        const failure = typeof message.errorMessage === 'string' && message.errorMessage.trim() ? boundedString(message.errorMessage, MAX_PART_TEXT_CHARS) : 'The turn failed.'
        transcript.push({ id: `error-${safeId}`, role: 'system', timestamp: completedAt ?? timestamp, parts: [{ type: 'text', text: failure }] })
        activeAssistant = undefined
      }
      continue
    }
    const item: TranscriptMessage = { id: safeId, role, timestamp, parts }
    transcript.push(item)
    activeAssistant = undefined
  }
  await resolveImageBlobReferences(transcript, blobsRoot)
  return boundedTranscript(transcript)
}

export const readTranscript: TranscriptFileReader = createTranscriptReader()
