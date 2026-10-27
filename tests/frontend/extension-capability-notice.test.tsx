// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ExtensionUiPresentation } from '../../src/components/ExtensionUiPresentation'
import { useExtensionUi } from '../../src/hooks/useExtensionUi'
import type { DesktopApi, RuntimeInfo, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type ExtensionUiApi = ReturnType<typeof useExtensionUi>

let container: HTMLDivElement
let root: Root
let commandMock: Mock<(runtimeId: string, command: Record<string, unknown>) => Promise<Record<string, unknown>>>
let reportErrorMock: Mock<(error: unknown) => void>
let api: ExtensionUiApi
let stableBridge: DesktopApi
let stableSessionsRef: { current: Map<string, string> }

function Harness() {
  api = useExtensionUi({
    bridge: stableBridge,
    activeRuntimeId: 'runtime-a',
    runtimeSessionsRef: stableSessionsRef,
    setSessions: ((_update: React.SetStateAction<SessionRecord[]>) => undefined) as React.Dispatch<React.SetStateAction<SessionRecord[]>>,
    setRuntime: ((_update: React.SetStateAction<RuntimeInfo | null>) => undefined) as React.Dispatch<React.SetStateAction<RuntimeInfo | null>>,
    reportError: reportErrorMock,
  })
  return (
    <ExtensionUiPresentation
      status={api.extensionStatus}
      widgets={api.extensionWidgets}
      editorText={api.editorTextUpdate}
      openUrl={api.openUrlRequest}
      capabilityNotices={api.extensionCapabilityNotices}
      onDismissCapabilityNotice={api.dismissCapabilityNotice}
    />
  )
}

function responseCommands(): Array<Record<string, unknown>> {
  return commandMock.mock.calls
    .filter((call) => (call[1] as Record<string, unknown>).type === 'extension_ui_response')
    .map((call) => call[1] as Record<string, unknown>)
}

function noticeTexts(): string[] {
  return Array.from(container.querySelectorAll('.extension-presentation__notice > span')).map((node) => node.textContent ?? '')
}

function show(event: Record<string, unknown>): void {
  act(() => { api.showExtensionUi('runtime-a', event) })
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
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

describe('unsupported extension capability notices', () => {
  it('surfaces setTitle as an explicit unsupported badge instead of dropping it', () => {
    show({ type: 'extension_ui_request', id: 't1', method: 'setTitle', title: 'my session' })
    expect(noticeTexts()).toEqual(['Unsupported extension update: setTitle'])
    // Fire-and-forget: no response is ever sent for a known presentation method.
    expect(responseCommands()).toEqual([])
    expect(api.extensionUi).toBeNull()
  })

  it('surfaces an unknown method as unrecognized and answers it cancelled', () => {
    show({ type: 'extension_ui_request', id: 'u1', method: 'holoDeck', scene: 'bridge' })
    expect(noticeTexts()).toEqual(['Unrecognized extension update: holoDeck'])
    // Unknown methods may be dialogs a newer OMP awaits; the cancelled answer
    // unblocks it and is ignored upstream when nothing is pending.
    expect(responseCommands()).toEqual([{ type: 'extension_ui_response', id: 'u1', cancelled: true }])
  })

  it('dedupes repeat notices for the same method while keeping one entry per distinct method', () => {
    show({ type: 'extension_ui_request', id: 't1', method: 'setTitle', title: 'one' })
    show({ type: 'extension_ui_request', id: 't2', method: 'setTitle', title: 'two' })
    show({ type: 'extension_ui_request', id: 'u1', method: 'holoDeck' })
    expect(noticeTexts()).toEqual(['Unsupported extension update: setTitle', 'Unrecognized extension update: holoDeck'])
  })

  it('lets the user dismiss a notice', () => {
    show({ type: 'extension_ui_request', id: 't1', method: 'setTitle', title: 'my session' })
    const dismiss = container.querySelector<HTMLButtonElement>('.extension-presentation__notice-dismiss')
    expect(dismiss).not.toBeNull()
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss extension notice')
    act(() => { dismiss!.click() })
    expect(noticeTexts()).toEqual([])
    expect(container.querySelector('.extension-presentation__notices')).toBeNull()
  })

  it('keeps supported dialog frames on the 3.5/3.6 path without a badge', () => {
    show({ type: 'extension_ui_request', id: 'q1', method: 'select', title: 'Pick a channel', options: ['Stable', 'Beta'] })
    expect(api.extensionUi?.request.id).toBe('q1')
    expect(noticeTexts()).toEqual([])
    expect(responseCommands()).toEqual([])
  })

  it('keeps supported presentation frames badge-free and applies them', () => {
    show({ type: 'extension_ui_request', id: 's1', method: 'setStatus', statusKey: 'build', statusText: 'compiling' })
    expect(noticeTexts()).toEqual([])
    expect(container.querySelector('.extension-presentation__status strong')?.textContent).toBe('build')
    expect(container.querySelector('.extension-presentation__status-item span:last-child')?.textContent).toBe('compiling')
  })

  it('caps the notice list so a chatty upstream method cannot flood the composer area', () => {
    for (let index = 0; index < 12; index++) {
      show({ type: 'extension_ui_request', id: `m${index}`, method: `novelMethod${index}` })
    }
    expect(noticeTexts()).toHaveLength(8)
    // The oldest notices were evicted; the newest remain.
    expect(noticeTexts()[7]).toBe('Unrecognized extension update: novelMethod11')
  })
})
