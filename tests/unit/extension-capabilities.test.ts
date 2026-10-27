import { describe, expect, it } from 'vitest'
import {
  classifyUnhandledExtensionUiFrame,
  EXTENSION_CAPABILITIES,
} from '../../src/lib/extension-capabilities'

describe('extension capability registry', () => {
  it('has unique ids and complete entries', () => {
    const ids = EXTENSION_CAPABILITIES.map((capability) => capability.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const capability of EXTENSION_CAPABILITIES) {
      expect(capability.surface.trim().length).toBeGreaterThan(0)
      expect(capability.presentation.trim().length).toBeGreaterThan(0)
      // Upstream evidence: packages/coding-agent-relative path:line reference.
      expect(capability.upstream).toMatch(/^src\/[^:]+\.ts:\d+$/)
      expect(['supported', 'degraded', 'unsupported']).toContain(capability.status)
    }
  })

  it('covers every upstream RPC wire dialog method as supported', () => {
    const supported = new Set(EXTENSION_CAPABILITIES.filter((capability) => capability.status === 'supported').map((capability) => capability.id))
    for (const id of ['dialog-select', 'dialog-confirm', 'dialog-input', 'dialog-editor', 'dialog-ask', 'dialog-cancel']) {
      expect(supported.has(id), `missing supported dialog capability ${id}`).toBe(true)
    }
  })

  it('covers the fire-and-forget presentation surfaces', () => {
    const byId = new Map(EXTENSION_CAPABILITIES.map((capability) => [capability.id, capability]))
    expect(byId.get('notify')?.status).toBe('supported')
    expect(byId.get('status')?.status).toBe('supported')
    expect(byId.get('widget-lines')?.status).toBe('supported')
    expect(byId.get('open-url')?.status).toBe('supported')
    expect(byId.get('window-title')?.status).toBe('unsupported')
  })

  it('marks terminal-only surfaces as explicitly unsupported rather than absent', () => {
    const byId = new Map(EXTENSION_CAPABILITIES.map((capability) => [capability.id, capability]))
    for (const id of ['custom-component', 'register-shortcut', 'composer-shape', 'thinking-renderer', 'terminal-input', 'editor-component']) {
      expect(byId.get(id)?.status, `${id} must be explicitly listed as unsupported`).toBe('unsupported')
    }
  })
})

describe('classifyUnhandledExtensionUiFrame', () => {
  it('flags setTitle as a known unsupported fire-and-forget method', () => {
    expect(classifyUnhandledExtensionUiFrame({ type: 'extension_ui_request', id: 't1', method: 'setTitle', title: 'hello' })).toEqual({
      id: 'unsupported:setTitle',
      method: 'setTitle',
      kind: 'knownUnsupported',
      requestId: 't1',
    })
  })

  it('flags novel methods as unknown and keeps the request id for answering', () => {
    expect(classifyUnhandledExtensionUiFrame({ type: 'extension_ui_request', id: 'x1', method: 'holoDeck', data: 1 })).toEqual({
      id: 'unknown:holoDeck',
      method: 'holoDeck',
      kind: 'unknown',
      requestId: 'x1',
    })
  })

  it('omits the request id when it is missing or oversized', () => {
    expect(classifyUnhandledExtensionUiFrame({ type: 'extension_ui_request', method: 'holoDeck' })).toEqual({
      id: 'unknown:holoDeck',
      method: 'holoDeck',
      kind: 'unknown',
    })
    expect(classifyUnhandledExtensionUiFrame({ type: 'extension_ui_request', id: 'x'.repeat(201), method: 'holoDeck' })).toEqual({ id: 'unknown:holoDeck', method: 'holoDeck', kind: 'unknown' })
  })

  it('ignores frames that are not extension UI requests or lack a method', () => {
    expect(classifyUnhandledExtensionUiFrame({ type: 'message_end', method: 'setTitle' })).toBeUndefined()
    expect(classifyUnhandledExtensionUiFrame({ type: 'extension_ui_request', id: 'a' })).toBeUndefined()
    expect(classifyUnhandledExtensionUiFrame({ type: 'extension_ui_request', id: 'a', method: 42 })).toBeUndefined()
    expect(classifyUnhandledExtensionUiFrame({ type: 'extension_ui_request', id: 'a', method: '  ' })).toBeUndefined()
  })

  it('never flags methods that are routed elsewhere (cancel, notify)', () => {
    expect(classifyUnhandledExtensionUiFrame({ type: 'extension_ui_request', id: 'a', method: 'cancel', targetId: 'b' })).toBeUndefined()
    expect(classifyUnhandledExtensionUiFrame({ type: 'extension_ui_request', id: 'a', method: 'notify', message: 'hi' })).toBeUndefined()
  })
})
