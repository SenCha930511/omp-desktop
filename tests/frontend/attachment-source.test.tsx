// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { imageSource } from '../../src/components/transcript/attachment-part'
import type { MessagePart } from '../../src/types/api'

type ImagePart = Extract<MessagePart, { type: 'image' }>

const imagePart = (overrides: Partial<ImagePart> = {}): ImagePart => ({
  type: 'image',
  mimeType: 'image/png',
  data: 'iVBORw0KGgo=',
  ...overrides,
})

describe('image data URL', () => {
  it('builds the URL once per part object instead of re-copying the payload', () => {
    const replace = vi.spyOn(String.prototype, 'replace')
    try {
      const part = imagePart({ data: 'iVBO\nRw0K\r\nGgo=' })
      expect(imageSource(part)).toBe('data:image/png;base64,iVBORw0KGgo=')
      const afterFirst = replace.mock.calls.length
      expect(afterFirst).toBe(1)
      // A second render of the same part must not rescan/copy the payload.
      expect(imageSource(part)).toBe('data:image/png;base64,iVBORw0KGgo=')
      expect(replace.mock.calls.length).toBe(afterFirst)
    } finally {
      replace.mockRestore()
    }
  })

  it('skips the copy entirely for payloads without whitespace', () => {
    const replace = vi.spyOn(String.prototype, 'replace')
    try {
      expect(imageSource(imagePart())).toBe('data:image/png;base64,iVBORw0KGgo=')
      expect(replace).not.toHaveBeenCalled()
    } finally {
      replace.mockRestore()
    }
  })

  it('caches the unavailable result for truncated, empty, and unsupported payloads', () => {
    const truncated = imagePart({ dataTruncated: true })
    expect(imageSource(truncated)).toBeUndefined()
    expect(imageSource(truncated)).toBeUndefined()
    expect(imageSource(imagePart({ data: undefined }))).toBeUndefined()
    expect(imageSource(imagePart({ mimeType: 'image/svg+xml' }))).toBeUndefined()
    expect(imageSource(imagePart({ data: 'not base64!' }))).toBeUndefined()
  })
})
