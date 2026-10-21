import type { MessageEnterAction, PromptDeliveryIntent } from '@/types/api'

export interface MessageShortcutEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
}

export function messageActionForKey(event: MessageShortcutEvent, enterAction: MessageEnterAction = 'queue'): PromptDeliveryIntent | null {
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey) return null
  // Cmd+Enter is the macOS-native alias for Ctrl+Enter. The modifier always
  // selects the opposite action so the two shortcuts remain swappable.
  if (event.ctrlKey || event.metaKey) return enterAction === 'queue' ? 'steer' : 'queue'
  return enterAction
}

export const IME_POST_COMPOSITION_GUARD_MS = 500

export interface ImeGuardEvent {
  key: string
  isComposing?: boolean
  keyCode?: number
  timeStamp?: number
}

export function isImeComposingOrGuarded(event: ImeGuardEvent, composingRefValue: boolean, lastCompositionEndAt: number | null): boolean {
  if (composingRefValue || event.isComposing === true || event.keyCode === 229) return true
  if (
    (event.key === 'Enter' || event.key === 'Escape') &&
    lastCompositionEndAt !== null &&
    typeof event.timeStamp === 'number' &&
    event.timeStamp >= lastCompositionEndAt &&
    event.timeStamp - lastCompositionEndAt < IME_POST_COMPOSITION_GUARD_MS
  ) {
    return true
  }
  return false
}

export interface SplitAttachmentFileName {
  display: string
  stem: string
  ext: string
  truncated: boolean
}

const COMPOUND_EXT_RE = /(\.(?:tar\.(?:gz|bz2|xz|zst)|d\.ts))$/i

export function splitAttachmentFileName(name: string, maxLength = 20): SplitAttachmentFileName {
  let stem = name
  let ext = ''
  const compoundMatch = COMPOUND_EXT_RE.exec(name)
  if (compoundMatch && compoundMatch.index > 0) {
    stem = name.slice(0, compoundMatch.index)
    ext = compoundMatch[1]
  } else {
    const lastDot = name.lastIndexOf('.')
    if (lastDot > 0 && lastDot < name.length - 1) {
      stem = name.slice(0, lastDot)
      ext = name.slice(lastDot)
    }
  }

  if (name.length <= maxLength) {
    return { display: name, stem, ext, truncated: false }
  }

  const availableStem = Math.max(4, maxLength - ext.length - 1)
  const tailLength = Math.min(4, Math.max(3, Math.floor(availableStem / 4)))
  const headLength = Math.max(1, availableStem - tailLength)

  if (stem.length <= headLength + tailLength) {
    return { display: name, stem, ext, truncated: false }
  }

  const display = `${stem.slice(0, headLength)}…${stem.slice(-tailLength)}${ext}`
  return { display, stem, ext, truncated: true }
}
