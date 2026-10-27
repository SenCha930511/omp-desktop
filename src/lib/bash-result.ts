// User-driven `!` bash 的 BashResult 呈現(上游 wire/commands.ts 的 BashResult:
// output/cancelled/truncated/totalLines/totalBytes/outputLines/outputBytes/
// exitCode?/timedOut?/artifactId?/artifactElidedBytes?/artifactError?/workingDir?/images?)。
// 純函式,方便單元測試;渲染形狀對齊歷史 transcript 的 bashExecution 行
// (electron/main/sessions/transcript.ts),讓 live 列與重讀列視覺一致。
import type { MessageKey } from '@/lib/i18n'
import { commandOutputText } from '@/lib/command-output'
import type { MessagePart, TranscriptMessage } from '@/types/api'

/** 上游 BashResult 的防禦性子集:只讀呈現需要的欄位,其餘忽略。 */
export interface BashResultReading {
  output: string
  cancelled: boolean
  truncated: boolean
  timedOut: boolean
  exitCode?: number
  /** 完整輸出被上游卸到 artifact 時的識別與被省略的位元組數。 */
  artifactId?: string
  artifactElidedBytes?: number
  /** 非文字輸出(圖片):走 image part,與歷史 toolResult kept-parts 同管線。 */
  images: Array<{ data: string; mimeType: string }>
}

const MAX_BASH_OUTPUT_CHARS = 256 * 1024
const MAX_BASH_RESULT_IMAGES = 8
const MAX_BASE64_IMAGE_CHARS = 8 * 1024 * 1024

function boundedOutput(text: string): string {
  return text.length > MAX_BASH_OUTPUT_CHARS ? text.slice(0, MAX_BASH_OUTPUT_CHARS) : text
}

/**
 * 防禦性解析 RPC 回覆的 BashResult:缺欄位/型別不符時降級為空結果而不是拋錯。
 * output 經 commandOutputText 去 ANSI——直接 bash 輸出是終端文字,渲染層不吃控制碼。
 */
export function readBashResult(data: unknown): BashResultReading {
  const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
  const images = Array.isArray(record.images)
    ? record.images.flatMap((raw) => {
      const image = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
      return typeof image.data === 'string' && image.data.length > 0 && image.data.length <= MAX_BASE64_IMAGE_CHARS && typeof image.mimeType === 'string'
        ? [{ data: image.data, mimeType: image.mimeType }]
        : []
    }).slice(0, MAX_BASH_RESULT_IMAGES)
    : []
  return {
    output: commandOutputText(boundedOutput(typeof record.output === 'string' ? record.output : '')),
    cancelled: record.cancelled === true,
    truncated: record.truncated === true,
    timedOut: record.timedOut === true,
    ...(typeof record.exitCode === 'number' && Number.isFinite(record.exitCode) ? { exitCode: record.exitCode } : {}),
    ...(typeof record.artifactId === 'string' && record.artifactId ? { artifactId: record.artifactId } : {}),
    ...(typeof record.artifactElidedBytes === 'number' && record.artifactElidedBytes > 0 ? { artifactElidedBytes: record.artifactElidedBytes } : {}),
    images,
  }
}

/** 結果列的狀態註記(在輸出尾端一行):exitCode/cancelled/truncated/timedOut/artifact。 */
export function bashResultStatusText(result: BashResultReading, t: (key: MessageKey, values?: Record<string, string | number>) => string): string {
  const notes: string[] = []
  if (result.cancelled) notes.push(t('bash.output.cancelled'))
  if (result.timedOut) notes.push(t('bash.output.timedOut'))
  if (result.exitCode !== undefined && result.exitCode !== 0) notes.push(t('bash.output.exitCode', { code: result.exitCode }))
  if (result.truncated) notes.push(t('bash.output.truncated'))
  if (result.artifactId) {
    notes.push(result.artifactElidedBytes !== undefined
      ? t('bash.output.artifactNoteBytes', { id: result.artifactId, bytes: result.artifactElidedBytes })
      : t('bash.output.artifactNote', { id: result.artifactId }))
  }
  return notes.join(' · ')
}

/** 面板/訊息共用的失敗判定:非零 exit、取消或逾時都視為失敗樣式。 */
export function bashResultFailed(result: BashResultReading): boolean {
  return result.cancelled || result.timedOut || (result.exitCode !== undefined && result.exitCode !== 0)
}

/**
 * live transcript 列:role 'tool',與歷史 bashExecution 轉換(partsFromMessage)
 * 同一形狀(toolCall bash → toolResult bash → 圖片 kept-parts)。id 的
 * `bash-` 前綴在 LOCAL_MESSAGE_ID 白名單內,重讀到磁碟上的 bashExecution 時
 * reconcile 會以 persisted 列取代(persisted() 以 role 比對),不會重複呈現。
 */
export function buildBashResultMessage(
  id: string,
  command: string,
  result: BashResultReading,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
  timestamp = Date.now(),
): TranscriptMessage {
  const status = bashResultStatusText(result, t)
  const parts: MessagePart[] = [
    { type: 'toolCall', id, name: 'bash', args: { command } },
    {
      type: 'toolResult',
      name: 'bash',
      text: [result.output, status].filter(Boolean).join('\n'),
      isError: bashResultFailed(result),
    },
    ...result.images.map((image, index) => ({ type: 'image' as const, partId: `${id}-image-${index}`, data: image.data, mimeType: image.mimeType })),
  ]
  return { id, role: 'tool', timestamp, parts }
}
