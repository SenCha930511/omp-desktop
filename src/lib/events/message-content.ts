import type { MessagePart } from '../../types/api'

/**
 * live reducer（renderer）與 session transcript reader（main process）共用的
 * 純內容語意：文字抽取、custom_message 形狀、工具結果非文字保留。
 * 本模組不得依賴 Node 或 DOM。兩側各自負責 bounding 與 IO；此處只做形狀決策。
 */

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined
}

const TRUNCATION_MARKER = '\n… [truncated] …\n'

/** Head/tail 截斷（與 transcript.ts 原實作逐字相同，搬移至共用模組）。 */
export function boundedString(value: string, max: number): string {
  if (max <= 0) return ''
  if (value.length <= max) return value
  if (max <= TRUNCATION_MARKER.length) return value.slice(-max)
  const available = max - TRUNCATION_MARKER.length
  const head = Math.floor(available / 3)
  return `${value.slice(0, head)}${TRUNCATION_MARKER}${value.slice(-(available - head))}`
}

export const MAX_PART_TEXT_CHARS = 256 * 1024
// 單一圖片 part 的大小上限；與 transcript.ts 原本的量級相同（8 MiB），
// 供持久化與 live 兩側計算 dataTruncated 旗標，保證 reload 前後一致。
export const MAX_PART_IMAGE_CHARS = 8 * 1024 * 1024

/**
 * 從 message content（字串或 content block 陣列）抽取可讀文字：
 * text/thinking block 以換行相接。非陣列的物件回傳空字串，
 * 物件要用 contentText 才會得到可讀 JSON。
 */
export function textFromContent(content: unknown, max = MAX_PART_TEXT_CHARS): string {
  if (typeof content === 'string') return boundedString(content, max)
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    const block = isRecord(part)
    if (!block) continue
    const addition = block.type === 'text' && typeof block.text === 'string' ? block.text
      : block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking : ''
    if (!addition) continue
    text += `${text ? '\n' : ''}${addition}`
    if (text.length > max) return boundedString(text, max)
  }
  return text
}

/**
 * 統一的可讀文字抽取（GAP 4/5）：live 的 resultText 與持久化的
 * toolResult/agent_message 文字抽取共用同一語意——
 * 字串原樣、block 陣列走 textFromContent、包裝物件認 output/text/content，
 * 其餘物件以 pretty JSON 呈現，純量（非字串）與 null/undefined 回空字串。
 */
export function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return textFromContent(value)
  const result = isRecord(value)
  if (result) {
    if (typeof result.output === 'string') return result.output
    if (typeof result.text === 'string') return result.text
    if (Array.isArray(result.content)) return textFromContent(result.content)
    try { return JSON.stringify(value, null, 2) } catch { return String(value) }
  }
  return ''
}

/** customType → 可讀活動名稱（ipython 特例全大寫，其餘逐字首字母大寫）。 */
export function customActivityName(value: string): string {
  return value.split(/[_-]+/).filter(Boolean).map((word) => word.toLowerCase() === 'ipython'
    ? 'IPython'
    : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(' ') || 'Activity'
}

/**
 * custom_message 的顯示形狀（GAP 1）：live reducer 與 transcript reader
 * 依同一規則決定 goal_context→goal 列、agent_message→agentMessage part、
 * 其餘 customType→具名 toolCall+toolResult 活動 part；
 * 兩側再依「是否有活動助理回合」各自決定附加或獨立成列。
 * compaction_outcome 由 compaction 路徑處理，這裡回 undefined。
 */
export type CustomMessageShape =
  | { kind: 'agentMessage'; text: string; agentName?: string }
  | { kind: 'goal'; text: string }
  | { kind: 'activity'; name: string; text: string }

const MAX_CUSTOM_TYPE_CHARS = 200

export function customMessageShape(entry: UnknownRecord): CustomMessageShape | undefined {
  const customType = typeof entry.customType === 'string' && entry.customType ? boundedString(entry.customType, MAX_CUSTOM_TYPE_CHARS) : 'activity'
  if (customType === 'compaction_outcome') return undefined
  const details = isRecord(entry.details)
  const detailMessage = typeof details?.message === 'string' ? details.message : undefined
  if (customType === 'agent_message') {
    const from = isRecord(details?.from)
    return {
      kind: 'agentMessage',
      text: detailMessage ?? contentText(entry.content),
      agentName: typeof from?.sessionName === 'string' ? from.sessionName : undefined,
    }
  }
  if (customType === 'goal_context') {
    const goalObjective = typeof details?.objective === 'string' ? details.objective : undefined
    return { kind: 'goal', text: goalObjective ?? detailMessage ?? contentText(entry.content) }
  }
  return { kind: 'activity', name: customActivityName(customType), text: detailMessage ?? contentText(entry.content) }
}

type ImagePart = Extract<MessagePart, { type: 'image' }>
type UnsupportedPart = Extract<MessagePart, { type: 'unsupported' }>

function imagePartFromBlock(block: UnknownRecord): ImagePart | undefined {
  if (block.type !== 'image') return undefined
  const data = typeof block.data === 'string' ? block.data : undefined
  return {
    type: 'image',
    mimeType: typeof block.mimeType === 'string' ? boundedString(block.mimeType, 128) : undefined,
    data: data !== undefined ? boundedString(data, MAX_PART_IMAGE_CHARS) : undefined,
    dataTruncated: data !== undefined && data.length > MAX_PART_IMAGE_CHARS || undefined,
  }
}

// 未知 content block（未來的 extension 型別、上游 provider 專屬 block 等）的
// 資料視圖上限:足以看清形狀,爆炸性 payload 仍以截斷標記收口,避免把整個
// 資料夾/二進位 dump 進 transcript。
export const MAX_UNSUPPORTED_DATA_CHARS = 16 * 1024

/**
 * 未知 content block → 可讀資料視圖 part(GAP 3 + 階段 6.2)。
 * 保留原 block 的完整 pretty JSON,讓沒有 GUI adapter 的型別
 * (extension 自訂 renderer 的資料、provider 專屬 block)都能被檢視,
 * 而不是靜默消失或只留一個型別名稱。
 */
export function unsupportedPartFromBlock(block: UnknownRecord): UnsupportedPart {
  let data: string | undefined
  try { data = JSON.stringify(block, null, 2) } catch { data = undefined }
  return {
    type: 'unsupported',
    contentType: boundedString(String(block.type), 200),
    data: data !== undefined ? boundedString(data, MAX_UNSUPPORTED_DATA_CHARS) : undefined,
  }
}

// 單一工具結果可保留的補充 part(圖片 + 未知)上限;惡意結果塞上千個
// image block 也不會把 renderer 記憶體撐爆。超出者直接捨棄——
// toolResult 文字與截斷標記已交代存在額外內容。
const MAX_SUPPLEMENTARY_PARTS_PER_RESULT = 50

const NO_SUPPLEMENTARY_PARTS: MessagePart[] = Object.freeze([]) as unknown as MessagePart[]

// 工具結果 block 中「已知可呈現」的型別:文字走 contentText、
// 圖片/其餘以資料視圖保留;不在清單內的才落入 unsupported。
function isKnownResultBlock(block: UnknownRecord): boolean {
  return (block.type === 'text' && typeof block.text === 'string')
    || (block.type === 'thinking' && typeof block.thinking === 'string')
    || block.type === 'image'
}

/**
 * GAP 2 + 階段 6.2:工具結果(live 事件 result 或持久化 content)內的
 * 非文字補充 part——圖片保留原始型別,未知 block 以資料視圖保留,
 * 兩者在 reload 前後都不丟棄。無補充內容時回傳共用凍結空陣列,
 * perf-critical 的 reducer 路徑不為每個事件配置垃圾。
 */
export function supplementaryPartsFromResult(result: unknown): MessagePart[] {
  const wrapper = isRecord(result)
  const content = Array.isArray(result) ? result : wrapper && Array.isArray(wrapper.content) ? wrapper.content : undefined
  if (!content) return NO_SUPPLEMENTARY_PARTS
  let parts: MessagePart[] | undefined
  for (const item of content) {
    const block = isRecord(item)
    if (!block || typeof block.type !== 'string') continue
    if (isKnownResultBlock(block)) {
      const image = imagePartFromBlock(block)
      if (image) {
        if (!parts) parts = []
        parts.push(image)
      }
    } else {
      if (!parts) parts = []
      parts.push(unsupportedPartFromBlock(block))
    }
    if (parts && parts.length >= MAX_SUPPLEMENTARY_PARTS_PER_RESULT) break
  }
  return parts ?? NO_SUPPLEMENTARY_PARTS
}

/**
 * GAP 2：工具結果（live 事件 result 或持久化 content）內的 image block。
 * 文字走 contentText，圖片另行保留為 image part，reload 前後都不丟棄。
 */
export function imagePartsFromResult(result: unknown): ImagePart[] {
  return supplementaryPartsFromResult(result).filter((part): part is ImagePart => part.type === 'image')
}
