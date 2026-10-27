import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { clearAttachmentDraft, readAttachmentDraft, saveAttachmentDraft } from '@/lib/composer-attachment-draft'
import type { PromptImage } from '@/types/api'

const supportedImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const MAX_COMPOSER_FILE_COUNT = 8

export interface ComposerImage extends PromptImage {
  id: string
  name: string
  size: number
}

export interface ComposerUnsupportedFile {
  id: string
  name: string
  size: number
  mimeType: string
}

interface UseComposerImagesOptions {
  shortName: string
  /** Draft-store key of the workspace/session; attachments persist across composer remounts like draft text. */
  draftKey?: string
}

interface ComposerAttachmentStoreEntry {
  images: ComposerImage[]
  unsupportedFiles: ComposerUnsupportedFile[]
}

// The Composer remounts per session (its key changes in App), so pending
// attachments live in this module store keyed like the draft store: attached
// images survive the remount exactly like draft text survives via sessionStorage.
const composerAttachmentStore = new Map<string, ComposerAttachmentStoreEntry>()
const MAX_ATTACHMENT_STORE_KEYS = 8
const MAX_ATTACHMENT_STORE_IMAGE_CHARS = 32 * 1024 * 1024

function attachmentStoreChars(): number {
  let total = 0
  for (const entry of composerAttachmentStore.values()) for (const image of entry.images) total += image.data.length
  return total
}

function saveAttachmentStoreEntry(key: string, entry: ComposerAttachmentStoreEntry): void {
  composerAttachmentStore.delete(key)
  composerAttachmentStore.set(key, entry)
  // Least-recently-used eviction bounds the store's key count and total base64
  // payload. The just-saved entry always survives so persistence never fights
  // the live composer state, even when that entry alone exceeds the budget.
  while (composerAttachmentStore.size > MAX_ATTACHMENT_STORE_KEYS || (composerAttachmentStore.size > 1 && attachmentStoreChars() > MAX_ATTACHMENT_STORE_IMAGE_CHARS)) {
    const oldest = composerAttachmentStore.keys().next().value
    if (oldest === undefined) break
    composerAttachmentStore.delete(oldest)
  }
}

function base64FromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return window.btoa(binary)
}

function isFileDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

export function useComposerImages({ shortName, draftKey }: UseComposerImagesOptions) {
  const [images, setImages] = useState<ComposerImage[]>([])
  const [unsupportedFiles, setUnsupportedFiles] = useState<ComposerUnsupportedFile[]>([])
  const [error, setError] = useState('')
  // 圖片超出持久化預算而未寫入的數量;>0 時由 Composer 顯示「重啟後無法保留」警告,
  // 不可靜默遺失受控檔案。
  const [persistDropped, setPersistDropped] = useState(0)
  const [processing, setProcessing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const imagesRef = useRef<ComposerImage[]>([])
  const unsupportedFilesRef = useRef<ComposerUnsupportedFile[]>([])
  const pendingBatchesRef = useRef(0)
  const errorRevisionRef = useRef(0)
  const reservedCountRef = useRef(0)
  const dragDepthRef = useRef(0)
  const mountedRef = useRef(true)
  const draftKeyRef = useRef(draftKey)
  draftKeyRef.current = draftKey

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const updateError = useCallback((message: string) => {
    errorRevisionRef.current += 1
    setError(message)
  }, [])

  const ingest = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return
    const startingErrorRevision = errorRevisionRef.current
    if (imagesRef.current.length + unsupportedFilesRef.current.length + reservedCountRef.current + files.length > MAX_COMPOSER_FILE_COUNT) {
      updateError(`You can attach up to ${MAX_COMPOSER_FILE_COUNT} files.`)
      return
    }

    const imageFiles = files.filter((file) => supportedImageTypes.has(file.type.toLowerCase()))
    const otherFiles = files.filter((file) => !supportedImageTypes.has(file.type.toLowerCase()))
    if (otherFiles.length > 0) {
      const added = otherFiles.map((file, index): ComposerUnsupportedFile => ({
        id: crypto.randomUUID(),
        name: file.name || `Attached file ${index + 1}`,
        size: file.size,
        mimeType: file.type.toLowerCase() || 'application/octet-stream',
      }))
      const next = [...unsupportedFilesRef.current, ...added]
      unsupportedFilesRef.current = next
      setUnsupportedFiles(next)
      setError('')
    }
    if (imageFiles.length === 0) return


    reservedCountRef.current += imageFiles.length
    pendingBatchesRef.current += 1
    setProcessing(true)
    try {
      const added = await Promise.all(imageFiles.map(async (file, index): Promise<ComposerImage> => ({
        id: crypto.randomUUID(),
        name: file.name || `Attached image ${index + 1}`,
        size: file.size,
        type: 'image',
        mimeType: file.type.toLowerCase(),
        data: base64FromBuffer(await file.arrayBuffer()),
      })))
      if (!mountedRef.current) return
      const next = [...imagesRef.current, ...added]
      imagesRef.current = next
      setImages(next)
      if (errorRevisionRef.current === startingErrorRevision) setError('')
    } catch {
      if (mountedRef.current) updateError(`${shortName} could not read the image.`)
    } finally {
      reservedCountRef.current -= imageFiles.length
      pendingBatchesRef.current -= 1
      if (mountedRef.current && pendingBatchesRef.current === 0) setProcessing(false)
    }
  }, [shortName, updateError])

  const clear = useCallback(() => {
    const key = draftKeyRef.current
    if (key) {
      composerAttachmentStore.delete(key)
      // 成功送出後一併清掉持久化附件草稿,避免下一輪誤恢復舊圖片。
      clearAttachmentDraft(key)
    }
    imagesRef.current = []
    unsupportedFilesRef.current = []
    setImages([])
    setUnsupportedFiles([])
    setPersistDropped(0)
  }, [])

  const remove = useCallback((id: string) => {
    const nextImages = imagesRef.current.filter((image) => image.id !== id)
    const nextFiles = unsupportedFilesRef.current.filter((file) => file.id !== id)
    imagesRef.current = nextImages
    unsupportedFilesRef.current = nextFiles
    setImages(nextImages)
    setUnsupportedFiles(nextFiles)
    updateError('')
  }, [updateError])

  const restoreWithinLimits = useCallback((restored: ComposerImage[]) => {
    const current = imagesRef.current
    const currentIds = new Set(current.map((image) => image.id))
    let count = current.length + unsupportedFilesRef.current.length + reservedCountRef.current
    const accepted: ComposerImage[] = []
    let omitted = 0
    for (const image of restored) {
      if (currentIds.has(image.id)) continue
      if (count >= MAX_COMPOSER_FILE_COUNT) {
        omitted += 1
        continue
      }
      accepted.push(image)
      currentIds.add(image.id)
      count += 1
    }
    if (accepted.length > 0) {
      const next = [...accepted, ...current]
      imagesRef.current = next
      setImages(next)
    }
    return { restored: accepted.length, omitted }
  }, [])

  // On mount, bring back whatever the previous composer instance for this
  // draft key had attached. The restore rides the existing restoreWithinLimits
  // path so the file-count limit (and the "message was not sent, images
  // restored" failure flow) keeps working unchanged.
  useEffect(() => {
    const key = draftKeyRef.current
    if (!key) return
    const entry = composerAttachmentStore.get(key)
    if (entry) {
      composerAttachmentStore.delete(key)
      composerAttachmentStore.set(key, entry)
      const existingIds = new Set(unsupportedFilesRef.current.map((file) => file.id))
      const restoredFiles = entry.unsupportedFiles.filter((file) => !existingIds.has(file.id))
      if (restoredFiles.length > 0) {
        const next = [...unsupportedFilesRef.current, ...restoredFiles]
        unsupportedFilesRef.current = next
        setUnsupportedFiles(next)
      }
      restoreWithinLimits(entry.images)
    }
    // 跨重啟恢復:記憶體 store 只活到本次 app 生命週期,
    // 持久化附件草稿在重啟後補回圖片;過期/毀損已在讀取端降級為 null。
    // 與記憶體還原合併時依 id 去重,不會重複貼上同一張圖。
    if (imagesRef.current.length === 0) {
      const persisted = readAttachmentDraft(key)
      if (persisted) restoreWithinLimits(persisted.images.map((image) => ({ ...image, type: 'image' as const })))
    }
  }, [restoreWithinLimits])

  useEffect(() => {
    if (!draftKey) return
    if (images.length === 0 && unsupportedFiles.length === 0) {
      composerAttachmentStore.delete(draftKey)
      clearAttachmentDraft(draftKey)
      setPersistDropped(0)
      return
    }
    saveAttachmentStoreEntry(draftKey, { images, unsupportedFiles })
    // 持久化預算只算圖片本體;超量部分回報數量讓 UI 顯示「重啟後無法保留」。
    setPersistDropped(saveAttachmentDraft(draftKey, images))
  }, [draftKey, images, unsupportedFiles])

  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDragging(true)
  }, [])

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (dragDepthRef.current === 0) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragging(false)
  }, [])

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepthRef.current = 0
    setDragging(false)
    void ingest(Array.from(event.dataTransfer.files))
  }, [ingest])

  return {
    images,
    imagesRef,
    unsupportedFiles,
    unsupportedFilesRef,
    error,
    setError: updateError,
    persistDropped,
    processing,
    hasPending: () => pendingBatchesRef.current > 0,
    dragging,
    ingest,
    clear,
    remove,
    restoreWithinLimits,
    restoreAfterUnmount: (restored: ComposerImage[]) => {
      if (!draftKey) return
      const entry = composerAttachmentStore.get(draftKey)
      const current = entry?.images ?? []
      const ids = new Set(current.map((image) => image.id))
      const merged = [...restored.filter((image) => !ids.has(image.id)), ...current]
      saveAttachmentStoreEntry(draftKey, {
        images: merged,
        unsupportedFiles: entry?.unsupportedFiles ?? [],
      })
      // 元件已卸載,持久化鏡像要自己補;超量部分此時無 UI 可提示,交由下次掛載的
      // persist 效果重新計算並顯示。
      saveAttachmentDraft(draftKey, merged)
    },
    dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
