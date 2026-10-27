// 附件草稿持久化(2.8):讓待送圖片跨重啟保留,並以容量、效期與降級規則
// 取代「inline base64 無限塞 localStorage」的作法。不支援的檔案(unsupportedFiles)
// 沒有可送出的內容,不持久化,只保留圖片。

export interface PersistedComposerImage {
  id: string
  name: string
  size: number
  mimeType: string
  /** base64 影像內容。 */
  data: string
}

interface PersistedAttachmentDraft {
  savedAt: number
  images: PersistedComposerImage[]
}

export interface AttachmentDraftReadResult {
  images: PersistedComposerImage[]
}

const ATTACHMENT_DRAFT_PREFIX = 'omp-desktop.composer-attachments.v1:'

/** 草稿有效期限:超過即視為過期,安全降級為「沒有可恢復的附件」並清掉佔位。 */
export const ATTACHMENT_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 單一 scope 可持久化的 base64 總字元預算;localStorage origin 配額有限,圖片是最大宗。 */
export const MAX_PERSISTED_ATTACHMENT_CHARS = 2 * 1024 * 1024

export function attachmentDraftStorageKey(scope: string): string {
  return `${ATTACHMENT_DRAFT_PREFIX}${scope}`
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * 寫入附件草稿,回傳「未持久化的圖片數」。
 * 預算內保留順序在前的圖片,超過者捨棄;配額錯誤(QuotaExceeded 等)視為全部未寫入。
 * 呼叫端應把回傳值顯示為可見警告,不可靜默遺失。
 */
export function saveAttachmentDraft(scope: string, images: readonly PersistedComposerImage[]): number {
  const store = storage()
  if (!store) return images.length
  try {
    const key = attachmentDraftStorageKey(scope)
    if (images.length === 0) {
      store.removeItem(key)
      return 0
    }
    const kept: PersistedComposerImage[] = []
    let chars = 0
    for (const image of images) {
      if (chars + image.data.length > MAX_PERSISTED_ATTACHMENT_CHARS) continue
      kept.push(image)
      chars += image.data.length
    }
    if (kept.length === 0) {
      // 沒有任何一張放得下:清掉舊資料,避免回復到過期的舊附件。
      store.removeItem(key)
      return images.length
    }
    const draft: PersistedAttachmentDraft = { savedAt: Date.now(), images: kept }
    store.setItem(key, JSON.stringify(draft))
    return images.length - kept.length
  } catch {
    // 配額不足或 storage 不可用:降級為只存在記憶體,數量照實回報。
    return images.length
  }
}

/** 讀取附件草稿;不存在、過期、毀損都回傳 null 並順手清掉壞資料。 */
export function readAttachmentDraft(scope: string): AttachmentDraftReadResult | null {
  const store = storage()
  if (!store) return null
  try {
    const key = attachmentDraftStorageKey(scope)
    const raw = store.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') {
      store.removeItem(key)
      return null
    }
    const draft = parsed as PersistedAttachmentDraft
    if (typeof draft.savedAt !== 'number' || !Array.isArray(draft.images)) {
      store.removeItem(key)
      return null
    }
    if (Date.now() - draft.savedAt > ATTACHMENT_DRAFT_TTL_MS) {
      store.removeItem(key)
      return null
    }
    // 逐張驗證,壞的項目直接丟掉而不是讓整份草稿失效。
    const images = draft.images.filter((image): image is PersistedComposerImage => Boolean(
      image && typeof image === 'object'
      && typeof image.id === 'string' && typeof image.name === 'string'
      && typeof image.data === 'string' && typeof image.mimeType === 'string',
    ))
    if (images.length === 0) {
      store.removeItem(key)
      return null
    }
    return { images }
  } catch {
    return null
  }
}

export function clearAttachmentDraft(scope: string): void {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(attachmentDraftStorageKey(scope))
  } catch { /* storage 不可用 */ }
}
