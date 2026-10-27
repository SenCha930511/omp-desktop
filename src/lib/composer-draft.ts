export interface ComposerDraftSnapshot {
  text: string
  model?: string
  effort?: string
  fast?: boolean
  /** 持久化鏡像的寫入時間;sessionStorage 快速路徑不帶。 */
  savedAt?: number
}

const LEGACY_COMPOSER_DRAFT_KEY = 'omp-desktop.composer-draft'
const COMPOSER_DRAFT_PREFIX = 'omp-desktop.composer-draft.v2:'
// 跨重啟鏡像(2.8):sessionStorage 只活到本次 app 生命週期,重啟會整份消失;
// localStorage 鏡像讓待送輸入在重啟後仍可恢復,但設有效期與大小上限做安全降級。
const COMPOSER_DRAFT_PERSISTENT_PREFIX = 'omp-desktop.composer-draft.persistent.v1:'
/** 文字草稿有效期限;過期視為遺失並清掉佔位。 */
export const COMPOSER_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 超過此長度的文字不寫持久化鏡像(避免佔滿 localStorage 配額),僅保留 sessionStorage。 */
export const MAX_PERSISTED_DRAFT_TEXT_CHARS = 128 * 1024

export function composerDraftStorageKey(scope: string): string {
  return `${COMPOSER_DRAFT_PREFIX}${scope}`
}

function composerDraftPersistentKey(scope: string): string {
  return `${COMPOSER_DRAFT_PERSISTENT_PREFIX}${scope}`
}

/** Model, effort, and fast mode ride along with typed text; alone they are not a draft. */
function emptyDraft(snapshot: ComposerDraftSnapshot): boolean {
  return !snapshot.text
}

/** Snapshot the composer's current DOM value so a crash-and-reload keeps the draft. */
export function saveComposerDraftFromDom(): void {
  try {
    const textarea = document.querySelector<HTMLTextAreaElement>('.composer textarea')
    if (textarea?.value) {
      const scope = textarea.dataset.draftScope
      if (scope) saveComposerDraft(scope, { text: textarea.value })
      else window.sessionStorage.setItem(LEGACY_COMPOSER_DRAFT_KEY, textarea.value)
    }
  } catch { /* storage unavailable */ }
}

export function saveComposerDraft(scope: string, snapshot: ComposerDraftSnapshot): void {
  try {
    const key = composerDraftStorageKey(scope)
    const previous = readComposerDraft(scope)
    const next: ComposerDraftSnapshot = {
      text: snapshot.text,
      model: snapshot.model || previous?.model,
      effort: snapshot.effort ?? previous?.effort,
      fast: snapshot.fast ?? previous?.fast,
    }
    if (emptyDraft(next)) {
      window.sessionStorage.removeItem(key)
      try {
        window.localStorage.removeItem(composerDraftPersistentKey(scope))
      } catch { /* storage unavailable */ }
      return
    }
    window.sessionStorage.setItem(key, JSON.stringify(next))
    // 持久化鏡像:超大文字安全降級為不鏡像,靜默失敗(配額)也不影響 sessionStorage 草稿。
    try {
      if (next.text.length <= MAX_PERSISTED_DRAFT_TEXT_CHARS) {
        window.localStorage.setItem(composerDraftPersistentKey(scope), JSON.stringify({ ...next, savedAt: Date.now() }))
      }
    } catch { /* 配額不足或 storage 不可用 */ }
  } catch { /* storage unavailable */ }
}

export function readComposerDraft(scope: string): ComposerDraftSnapshot | null {
  try {
    const raw = window.sessionStorage.getItem(composerDraftStorageKey(scope))
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && typeof (parsed as ComposerDraftSnapshot).text === 'string') {
        return parsed as ComposerDraftSnapshot
      }
    }
  } catch { /* storage unavailable */ }
  // sessionStorage 已消失(例如整個 app 重啟):改從持久化鏡像恢復,成功則回填快速路徑。
  const mirrored = readPersistedComposerDraft(scope)
  if (mirrored) {
    try {
      window.sessionStorage.setItem(composerDraftStorageKey(scope), JSON.stringify({ text: mirrored.text, model: mirrored.model, effort: mirrored.effort, fast: mirrored.fast }))
    } catch { /* storage unavailable */ }
    return mirrored
  }
  try {
    const legacy = window.sessionStorage.getItem(LEGACY_COMPOSER_DRAFT_KEY)
    if (!legacy) return null
    // Claim a pre-scoping crash snapshot once, so subsequent sessions stay isolated.
    window.sessionStorage.setItem(composerDraftStorageKey(scope), JSON.stringify({ text: legacy }))
    window.sessionStorage.removeItem(LEGACY_COMPOSER_DRAFT_KEY)
    return { text: legacy }
  } catch {
    return null
  }
}

function readPersistedComposerDraft(scope: string): ComposerDraftSnapshot | null {
  try {
    const key = composerDraftPersistentKey(scope)
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as ComposerDraftSnapshot).text !== 'string' || !(parsed as ComposerDraftSnapshot).text) {
      window.localStorage.removeItem(key)
      return null
    }
    const snapshot = parsed as ComposerDraftSnapshot
    if (typeof snapshot.savedAt !== 'number' || Date.now() - snapshot.savedAt > COMPOSER_DRAFT_TTL_MS) {
      window.localStorage.removeItem(key)
      return null
    }
    return snapshot
  } catch {
    return null
  }
}

export function clearComposerDraft(scope: string): void {
  try {
    window.sessionStorage.removeItem(composerDraftStorageKey(scope))
    window.sessionStorage.removeItem(LEGACY_COMPOSER_DRAFT_KEY)
  } catch { /* storage unavailable */ }
  try {
    window.localStorage.removeItem(composerDraftPersistentKey(scope))
  } catch { /* storage unavailable */ }
}

/** Read and clear a preserved crash draft; returns '' when none exists. */
export function takeComposerDraft(): string {
  try {
    const draft = window.sessionStorage.getItem(LEGACY_COMPOSER_DRAFT_KEY) ?? ''
    if (draft) window.sessionStorage.removeItem(LEGACY_COMPOSER_DRAFT_KEY)
    return draft
  } catch { return '' }
}
