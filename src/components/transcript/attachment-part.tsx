import { useI18n } from '@/lib/i18n'
import { boundText } from '@/lib/render-bounds'
import type { MessagePart } from '@/types/api'
import { TranscriptImage } from './TranscriptImage'

/** Image parts are immutable once they reach the renderer (the reducer only
 *  rewrites tool args in place), so the data URL is built once per part object
 *  instead of re-copying up to 8 MiB of base64 on every render. */
const imageSources = new WeakMap<object, string | undefined>()

/** data URL 僅在型別與 base64 內容都通過檢查時才產生；其餘走可讀 fallback。 */
export function imageSource(part: Extract<MessagePart, { type: 'image' }>): string | undefined {
  if (imageSources.has(part)) return imageSources.get(part)
  let source: string | undefined
  if (!part.dataTruncated && part.data && part.mimeType && /^image\/(png|jpeg|gif|webp)$/i.test(part.mimeType) && /^[a-z\d+/=\s]+$/i.test(part.data)) {
    // Base64 from the transcript reader never contains whitespace, so the
    // replace() copy is only paid when the data actually carries any.
    source = `data:${part.mimeType};base64,${/\s/.test(part.data) ? part.data.replace(/\s/g, '') : part.data}`
  }
  imageSources.set(part, source)
  return source
}

/** 使用者附件與工具輸出共用的圖片 part；alt 文字由呼叫端依來源提供。 */
export function ImagePart({ part, alt }: { part: Extract<MessagePart, { type: 'image' }>; alt: string }) {
  const { t } = useI18n()
  const source = imageSource(part)
  if (source) return <TranscriptImage source={source} alt={alt} />
  return <div className="image-part image-part--unavailable">{t('transcript.image.unavailable')}</div>
}

// 渲染層再截斷一層:來源已按 MAX_UNSUPPORTED_DATA_CHARS 收口,
// 這裡的 4_000 字元上限保護 DOM 大小,原始資料仍以截斷標記交代後續。
const UNSUPPORTED_DATA_RENDER_CHARS = 4_000

/**
 * 無法呈現內容的 content block（file/audio、extension 自訂 renderer 的資料等）
 * 的可讀資料視圖——GUI 沒有對應 adapter 時標示「自訂檢視不可用」並展示
 * 原始 block 的格式化 JSON,絕不渲染空白或靜默消失。資料以純文字 <pre>
 * 呈現,不走 dangerouslySetInnerHTML,script 標籤等注入原樣顯示。
 */
export function UnsupportedAttachment({ contentType, data }: { contentType: string; data?: string }) {
  const { t } = useI18n()
  const label = t('transcript.attachment.unsupported', { type: contentType })
  if (!data) return <span className="attachment-part attachment-part--unsupported">{label}</span>
  return (
    <div className="attachment-part attachment-part--unsupported attachment-part--with-data">
      <span className="attachment-part__label">
        {label} <span className="attachment-part__notice">{t('transcript.attachment.customViewUnavailable')}</span>
      </span>
      <pre className="attachment-part__data">{boundText(data, UNSUPPORTED_DATA_RENDER_CHARS, '…')}</pre>
    </div>
  )
}
