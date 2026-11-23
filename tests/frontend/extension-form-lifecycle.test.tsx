// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useExtensionUi, type PendingExtensionUi } from '../../src/hooks/useExtensionUi'
import type { ExtensionUiResponse } from '../../src/components/ExtensionUiModal'
import { MAX_EXTENSION_FORM_CHOICE_CHARS, type DesktopApi, type RuntimeInfo, type SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface ExtensionUiApi {
  extensionUi: PendingExtensionUi | null
  showExtensionUi(runtimeId: string, event: Record<string, unknown>): void
  respondToExtensionUi(response: ExtensionUiResponse, expectedPending?: PendingExtensionUi): Promise<void>
}

let container: HTMLDivElement
let root: Root
let commandMock: Mock<(runtimeId: string, command: Record<string, unknown>) => Promise<Record<string, unknown>>>
let reportErrorMock: Mock<(error: unknown) => void>
let api: ExtensionUiApi
let stableBridge: DesktopApi
let stableSessionsRef: { current: Map<string, string> }

function Harness(): null {
  api = useExtensionUi({
    bridge: stableBridge,
    activeRuntimeId: 'runtime-a',
    runtimeSessionsRef: stableSessionsRef,
    setSessions: ((_update: React.SetStateAction<SessionRecord[]>) => undefined) as React.Dispatch<React.SetStateAction<SessionRecord[]>>,
    setRuntime: ((_update: React.SetStateAction<RuntimeInfo | null>) => undefined) as React.Dispatch<React.SetStateAction<RuntimeInfo | null>>,
    reportError: reportErrorMock,
  })
  return null
}

function formFrame(id: string, name = 'answer', timeout?: number): Record<string, unknown> {
  return {
    type: 'extension_ui_request', id, method: 'form',
    html: `<label>Answer<input name="${name}" required></label><input type="hidden" name="origin" value="${id}">`,
    ...(timeout === undefined ? {} : { timeout }),
  }
}

function confirmFrame(id: string): Record<string, unknown> {
  return { type: 'extension_ui_request', id, method: 'confirm', title: 'Next?', message: 'Continue' }
}

function cancelFrame(targetId: string): Record<string, unknown> {
  return { type: 'extension_ui_request', id: 'cancel-event', method: 'cancel', targetId }
}

function show(event: Record<string, unknown>): void {
  act(() => { api.showExtensionUi('runtime-a', event) })
}

function currentPending(): PendingExtensionUi {
  if (!api.extensionUi) throw new Error('no pending extension request')
  return api.extensionUi
}

function responses(): Array<Record<string, unknown>> {
  return commandMock.mock.calls.map((call) => call[1])
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  commandMock = vi.fn<(runtimeId: string, command: Record<string, unknown>) => Promise<Record<string, unknown>>>().mockResolvedValue({})
  reportErrorMock = vi.fn<(error: unknown) => void>()
  stableBridge = { agent: { command: commandMock } } as unknown as DesktopApi
  stableSessionsRef = { current: new Map<string, string>() }
  act(() => { root.render(createElement(Harness)) })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.documentElement.lang = ''
})

describe('native form lifecycle and transport gate', () => {
  it('sends exactly type, id and normalized data with a null-prototype data object', async () => {
    show(formFrame('form-wire'))
    const pending = currentPending()
    await act(async () => {
      await api.respondToExtensionUi({ data: { answer: '  exact value  ', origin: 'forged-hidden-is-overwritten' } }, pending)
    })
    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith('runtime-a', {
      type: 'extension_ui_response', id: 'form-wire', data: { answer: '  exact value  ', origin: 'form-wire' },
    })
    const command = responses()[0]
    expect(command).not.toHaveProperty('cancelled')
    expect(command).not.toHaveProperty('timedOut')
    expect(Object.getPrototypeOf(command.data)).toBeNull()
    expect(api.extensionUi).toBeNull()
  })

  it('rejects malformed direct hook data before advancing or cancelling the next dialog', async () => {
    show(formFrame('form-invalid'))
    show(confirmFrame('queued-confirm'))
    const pending = currentPending()
    await act(async () => {
      await api.respondToExtensionUi({ data: { answer: '', secretUnknown: 'do-not-log-this-secret' } }, pending)
    })
    expect(commandMock).not.toHaveBeenCalled()
    expect(currentPending()).toBe(pending)
    expect(currentPending().request.id).toBe('form-invalid')
    expect(reportErrorMock).toHaveBeenCalledTimes(1)
    expect(String(reportErrorMock.mock.calls[0][0])).not.toContain('do-not-log-this-secret')

    await act(async () => { await api.respondToExtensionUi({ data: { answer: 'corrected' } }, pending) })
    expect(responses()).toEqual([{ type: 'extension_ui_response', id: 'form-invalid', data: { answer: 'corrected', origin: 'form-invalid' } }])
    expect(api.extensionUi?.request.id).toBe('queued-confirm')
  })

  it('rejects an oversized normalized array choice before transport and allows correction without leaking its value', async () => {
    show({ type: 'extension_ui_request', id: 'choice-limit', method: 'form', html: '<fieldset><legend>Features</legend><label>Alpha<input type="checkbox" name="features" value="alpha"></label><label>Beta<input type="checkbox" name="features" value="beta"></label></fieldset>' })
    const pending = currentPending()
    const oversized = `${'array-secret-marker'}${'x'.repeat(MAX_EXTENSION_FORM_CHOICE_CHARS)}`
    await act(async () => {
      await api.respondToExtensionUi({ data: { features: ['alpha', oversized] } }, pending)
    })
    expect(commandMock).not.toHaveBeenCalled()
    expect(currentPending()).toBe(pending)
    expect(reportErrorMock).toHaveBeenCalledTimes(1)
    expect(String(reportErrorMock.mock.calls[0][0])).not.toContain('array-secret-marker')

    await act(async () => {
      await api.respondToExtensionUi({ data: { features: ['alpha'] } }, pending)
    })
    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith('runtime-a', {
      type: 'extension_ui_response', id: 'choice-limit', data: { features: ['alpha'] },
    })
    expect(api.extensionUi).toBeNull()
  })

  it('keeps malformed response shapes on the current form without synthesizing required answers', async () => {
    show(formFrame('form-shape'))
    const pending = currentPending()
    await act(async () => { await api.respondToExtensionUi({ data: null }, pending) })
    await act(async () => { await api.respondToExtensionUi({ value: 'not-form-data' }, pending) })
    expect(commandMock).not.toHaveBeenCalled()
    expect(currentPending()).toBe(pending)
    expect(reportErrorMock).toHaveBeenCalledTimes(2)
  })

  it('uses plain cancelled with no data and advances the existing queue', async () => {
    show(formFrame('form-cancel'))
    show(confirmFrame('confirm-after-cancel'))
    const pending = currentPending()
    await act(async () => { await api.respondToExtensionUi({ cancelled: true }, pending) })
    expect(responses()).toEqual([{ type: 'extension_ui_response', id: 'form-cancel', cancelled: true }])
    expect(api.extensionUi?.request.id).toBe('confirm-after-cancel')
  })

  it('times out forms with cancelled and timedOut only at their declared timeout and never sends data', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    show(formFrame('form-timeout', 'answer', 20_000))
    act(() => { vi.advanceTimersByTime(19_999) })
    expect(commandMock).not.toHaveBeenCalled()
    expect(api.extensionUi?.request.id).toBe('form-timeout')
    act(() => { vi.advanceTimersByTime(1) })
    expect(responses()).toEqual([{ type: 'extension_ui_response', id: 'form-timeout', cancelled: true, timedOut: true }])
    expect(api.extensionUi).toBeNull()
  })

  it('surfaces a bounded parser reason and safely cancels an unusable form frame', () => {
    show({ type: 'extension_ui_request', id: 'bad-form', method: 'form', html: '   ' })
    expect(api.extensionUi).toBeNull()
    expect(responses()).toEqual([{ type: 'extension_ui_response', id: 'bad-form', cancelled: true }])
    expect(reportErrorMock).toHaveBeenCalledTimes(1)
    expect(String(reportErrorMock.mock.calls[0][0])).toContain('missing html')
  })

  it('does not apply the ask fallback timeout to a timeoutless form', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    show(formFrame('form-no-timeout'))
    act(() => { vi.advanceTimersByTime(120_000) })
    expect(commandMock).not.toHaveBeenCalled()
    expect(api.extensionUi?.request.id).toBe('form-no-timeout')
  })

  it('ignores delayed responses, cancels and timer closures from a copied request id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    show(formFrame('reused-id', 'first', 5_000))
    const first = currentPending()
    const oldTimerCallback = timeoutSpy.mock.calls.at(-1)?.[0]
    if (typeof oldTimerCallback !== 'function') throw new Error('first form timer not captured')

    await act(async () => { await api.respondToExtensionUi({ cancelled: true }, first) })
    show(formFrame('reused-id', 'second', 5_000))
    const second = currentPending()
    expect(second).not.toBe(first)
    expect(responses()).toEqual([{ type: 'extension_ui_response', id: 'reused-id', cancelled: true }])

    await act(async () => { await api.respondToExtensionUi({ cancelled: true }, first) })
    await act(async () => { await api.respondToExtensionUi({ data: { first: 'stale-secret', origin: 'stale' } }, first) })
    act(() => { oldTimerCallback() })
    expect(responses()).toEqual([{ type: 'extension_ui_response', id: 'reused-id', cancelled: true }])
    expect(currentPending()).toBe(second)

    await act(async () => { await api.respondToExtensionUi({ data: { second: 'fresh', origin: 'forged' } }, second) })
    expect(responses()).toEqual([
      { type: 'extension_ui_response', id: 'reused-id', cancelled: true },
      { type: 'extension_ui_response', id: 'reused-id', data: { second: 'fresh', origin: 'reused-id' } },
    ])
    expect(api.extensionUi).toBeNull()
  })

  it('preserves duplicate-frame suppression and native cancellation without a second answer', async () => {
    show(formFrame('form-duplicate'))
    show(formFrame('form-duplicate'))
    const pending = currentPending()
    await act(async () => { await api.respondToExtensionUi({ data: { answer: 'once' } }, pending) })
    expect(responses()).toHaveLength(1)
    expect(api.extensionUi).toBeNull()

    show(formFrame('native-cancelled'))
    show(confirmFrame('after-native-cancel'))
    show(cancelFrame('native-cancelled'))
    expect(api.extensionUi?.request.id).toBe('after-native-cancel')
    await act(async () => { await api.respondToExtensionUi({ cancelled: true }) })
    expect(responses()).toEqual([
      { type: 'extension_ui_response', id: 'form-duplicate', data: { answer: 'once', origin: 'form-duplicate' } },
      { type: 'extension_ui_response', id: 'after-native-cancel', cancelled: true },
    ])
  })
})
