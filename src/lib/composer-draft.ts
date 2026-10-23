export interface ComposerDraftSnapshot {
  text: string
  model?: string
  effort?: string
  fast?: boolean
}

const LEGACY_COMPOSER_DRAFT_KEY = 'omp-desktop.composer-draft'
const COMPOSER_DRAFT_PREFIX = 'omp-desktop.composer-draft.v2:'

export function composerDraftStorageKey(scope: string): string {
  return `${COMPOSER_DRAFT_PREFIX}${scope}`
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
      return
    }
    window.sessionStorage.setItem(key, JSON.stringify(next))
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

export function clearComposerDraft(scope: string): void {
  try {
    window.sessionStorage.removeItem(composerDraftStorageKey(scope))
    window.sessionStorage.removeItem(LEGACY_COMPOSER_DRAFT_KEY)
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
