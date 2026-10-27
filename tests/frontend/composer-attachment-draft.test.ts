// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureLocalStorage } from './storage-fixture'
import {
  ATTACHMENT_DRAFT_TTL_MS,
  attachmentDraftStorageKey,
  clearAttachmentDraft,
  MAX_PERSISTED_ATTACHMENT_CHARS,
  readAttachmentDraft,
  saveAttachmentDraft,
  type PersistedComposerImage,
} from '../../src/lib/composer-attachment-draft'

function image(overrides: Partial<PersistedComposerImage> & { id: string }): PersistedComposerImage {
  return {
    name: `${overrides.id}.png`,
    size: 4,
    mimeType: 'image/png',
    data: 'aGk=',
    ...overrides,
  }
}

beforeEach(ensureLocalStorage)
afterEach(() => window.localStorage.clear())

describe('attachmentDraftStorageKey', () => {
  it('prefixes the scope with the v1 namespace', () => {
    expect(attachmentDraftStorageKey('omp:session:/work')).toBe('omp-desktop.composer-attachments.v1:omp:session:/work')
  })
})

describe('saveAttachmentDraft', () => {
  it('persists images so a later read returns them verbatim', () => {
    const images = [image({ id: 'one' }), image({ id: 'two', name: 'second.jpg', mimeType: 'image/jpeg', data: 'bGk=' })]
    expect(saveAttachmentDraft('scope', images)).toBe(0)
    expect(readAttachmentDraft('scope')).toEqual({ images })
  })

  it('treats an empty draft as a clear and reports nothing dropped', () => {
    saveAttachmentDraft('scope', [image({ id: 'one' })])
    expect(saveAttachmentDraft('scope', [])).toBe(0)
    expect(readAttachmentDraft('scope')).toBeNull()
    expect(window.localStorage.getItem(attachmentDraftStorageKey('scope'))).toBeNull()
  })

  it('keeps leading images inside the base64 budget and reports the dropped tail', () => {
    const big = image({ id: 'big', data: 'x'.repeat(MAX_PERSISTED_ATTACHMENT_CHARS - 10), size: MAX_PERSISTED_ATTACHMENT_CHARS - 10 })
    const small = image({ id: 'small', data: 'y'.repeat(20) })
    expect(saveAttachmentDraft('scope', [big, small])).toBe(1)
    expect(readAttachmentDraft('scope')).toEqual({ images: [big] })
  })

  it('keeps an image that exactly fills the budget', () => {
    const exact = image({ id: 'exact', data: 'x'.repeat(MAX_PERSISTED_ATTACHMENT_CHARS) })
    expect(saveAttachmentDraft('scope', [exact])).toBe(0)
    expect(readAttachmentDraft('scope')).toEqual({ images: [exact] })
  })

  it('clears the old draft when no image fits instead of restoring stale attachments', () => {
    saveAttachmentDraft('scope', [image({ id: 'old' })])
    const oversized = image({ id: 'huge', data: 'x'.repeat(MAX_PERSISTED_ATTACHMENT_CHARS + 1) })
    expect(saveAttachmentDraft('scope', [oversized])).toBe(1)
    expect(readAttachmentDraft('scope')).toBeNull()
  })

  it('reports every image as dropped when storage writes fail (quota)', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    const throwing: Storage = {
      ...window.localStorage,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError')
      },
    }
    Object.defineProperty(window, 'localStorage', { configurable: true, value: throwing })
    try {
      expect(saveAttachmentDraft('scope', [image({ id: 'a' }), image({ id: 'b' })])).toBe(2)
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original)
      else Reflect.deleteProperty(window, 'localStorage')
    }
  })
})

describe('readAttachmentDraft', () => {
  it('returns null when nothing was saved', () => {
    expect(readAttachmentDraft('missing')).toBeNull()
  })

  it('returns null on unparseable JSON', () => {
    window.localStorage.setItem(attachmentDraftStorageKey('scope'), '{oops')
    expect(readAttachmentDraft('scope')).toBeNull()
  })

  it('removes and rejects drafts that are not objects', () => {
    window.localStorage.setItem(attachmentDraftStorageKey('scope'), '123')
    expect(readAttachmentDraft('scope')).toBeNull()
    expect(window.localStorage.getItem(attachmentDraftStorageKey('scope'))).toBeNull()
  })

  it('removes drafts with the wrong shape', () => {
    window.localStorage.setItem(attachmentDraftStorageKey('scope'), JSON.stringify({ savedAt: 'soon', images: [] }))
    expect(readAttachmentDraft('scope')).toBeNull()
    expect(window.localStorage.getItem(attachmentDraftStorageKey('scope'))).toBeNull()
  })

  it('removes expired drafts past the TTL', () => {
    const key = attachmentDraftStorageKey('scope')
    window.localStorage.setItem(key, JSON.stringify({ savedAt: Date.now() - ATTACHMENT_DRAFT_TTL_MS - 1, images: [image({ id: 'stale' })] }))
    expect(readAttachmentDraft('scope')).toBeNull()
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it('drops malformed image entries but keeps the valid ones', () => {
    const good = image({ id: 'good' })
    window.localStorage.setItem(attachmentDraftStorageKey('scope'), JSON.stringify({
      savedAt: Date.now(),
      images: [null, 'not-an-image', { id: 'half', name: 'half.png', data: 'aGk=' }, good],
    }))
    expect(readAttachmentDraft('scope')).toEqual({ images: [good] })
  })

  it('clears the draft when every stored image entry is malformed', () => {
    const key = attachmentDraftStorageKey('scope')
    window.localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), images: [null, { id: 7 }] }))
    expect(readAttachmentDraft('scope')).toBeNull()
    expect(window.localStorage.getItem(key)).toBeNull()
  })
})

describe('clearAttachmentDraft', () => {
  it('removes the persisted draft for the scope', () => {
    saveAttachmentDraft('scope', [image({ id: 'one' })])
    clearAttachmentDraft('scope')
    expect(readAttachmentDraft('scope')).toBeNull()
  })
})

describe('storage unavailable', () => {
  it('degrades gracefully when localStorage access itself throws', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied')
      },
    })
    try {
      expect(saveAttachmentDraft('scope', [image({ id: 'a' })])).toBe(1)
      expect(readAttachmentDraft('scope')).toBeNull()
      expect(() => clearAttachmentDraft('scope')).not.toThrow()
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original)
      else Reflect.deleteProperty(window, 'localStorage')
    }
  })
})
