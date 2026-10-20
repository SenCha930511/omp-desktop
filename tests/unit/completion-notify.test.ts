import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldNotifyCompletion, showCompletionNotification } from '../../src/lib/completion-notify'

describe('completion notifications', () => {
  const original = globalThis.Notification

  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => {
    globalThis.Notification = original
    vi.unstubAllGlobals()
  })

  it('notifies only while the document is hidden or unfocused', () => {
    vi.stubGlobal('document', { hidden: false, hasFocus: () => true })
    expect(shouldNotifyCompletion()).toBe(false)
    vi.stubGlobal('document', { hidden: true, hasFocus: () => true })
    expect(shouldNotifyCompletion()).toBe(true)
    vi.stubGlobal('document', { hidden: false, hasFocus: () => false })
    expect(shouldNotifyCompletion()).toBe(true)
  })

  it('constructs a Notification when the platform supports it', () => {
    const ctor = vi.fn()
    vi.stubGlobal('Notification', ctor)
    showCompletionNotification('Task complete', 'Refactor finished')
    expect(ctor).toHaveBeenCalledWith('Task complete', { body: 'Refactor finished', silent: false })
  })

  it('stays silent when the platform lacks notifications or construction throws', () => {
    vi.stubGlobal('Notification', undefined)
    expect(() => showCompletionNotification('Task complete', 'Refactor finished')).not.toThrow()
    vi.stubGlobal('Notification', () => { throw new Error('blocked') })
    expect(() => showCompletionNotification('Task complete', 'Refactor finished')).not.toThrow()
  })
})
