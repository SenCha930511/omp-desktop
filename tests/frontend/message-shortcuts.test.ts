import { describe, expect, it } from 'vitest'
import { messageActionForKey, type MessageShortcutEvent } from '../../src/lib/message-shortcuts'

const event = (overrides: Partial<MessageShortcutEvent> = {}): MessageShortcutEvent => ({
  key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...overrides,
})

describe('message shortcuts', () => {
  it('defaults Enter to queue and Ctrl+Enter to steer', () => {
    expect(messageActionForKey(event())).toBe('queue')
    expect(messageActionForKey(event({ ctrlKey: true }))).toBe('steer')
  })

  it('treats Cmd+Enter as the macOS alias for steering', () => {
    expect(messageActionForKey(event({ metaKey: true }))).toBe('steer')
    expect(messageActionForKey(event({ metaKey: true, ctrlKey: true }))).toBe('steer')
    expect(messageActionForKey(event({ metaKey: true, shiftKey: true }))).toBeNull()
  })

  it('swaps queue and steer for every harness when Enter is configured to steer', () => {
    expect(messageActionForKey(event(), 'steer')).toBe('steer')
    expect(messageActionForKey(event({ ctrlKey: true }), 'steer')).toBe('queue')
    expect(messageActionForKey(event({ metaKey: true }), 'steer')).toBe('queue')
  })

  // Phase 2 keeps the shipped Enter=queue / Ctrl+Enter=steer defaults until
  // the TUI-parity default swap ships with its settings migration; this pins
  // the boundary so the default cannot drift silently.
  it('keeps the pre-migration defaults stable for every enter action setting', () => {
    expect(messageActionForKey(event())).toBe('queue')
    expect(messageActionForKey(event(), 'queue')).toBe('queue')
    expect(messageActionForKey(event(), 'steer')).toBe('steer')
  })

  it('leaves newlines, composition, and unsupported modifiers alone', () => {
    expect(messageActionForKey(event({ shiftKey: true }))).toBeNull()
    expect(messageActionForKey(event({ isComposing: true }))).toBeNull()
    expect(messageActionForKey(event({ altKey: true }))).toBeNull()
    expect(messageActionForKey(event({ key: 'a' }))).toBeNull()
  })
})
