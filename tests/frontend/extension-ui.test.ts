// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ExtensionUiModal } from '../../src/components/ExtensionUiModal'
import { useExtensionUi, pendingExtensionUiForRuntime, type PendingExtensionUi } from '../../src/hooks/useExtensionUi'
import {
  parseExtensionUiCancel,
  parseExtensionUiFrame,
  parseExtensionUiPresentation,
  parseExtensionUiRejection,
  parseExtensionUiRequest,
  type ExtensionUiRequest,
} from '../../src/lib/extension-ui'
import type { DesktopApi, RuntimeInfo, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const LONG_APPROVAL_TITLE = [
  'Allow tool: bash',
  'Reason: run build',
  'Arguments:',
  'rm -rf dist && npm run build',
  ...Array.from({ length: 400 }, (_, index) => `output line ${index}: ${'x'.repeat(120)}`),
].join('\n')

// Shape verified against upstream v18.13.1 RpcAskDialogQuestion / rpc-mode.ts
// requestRpcAskDialog: no title on the wire; the parser synthesizes one.
const ASK_FRAME: Record<string, unknown> = {
  type: 'extension_ui_request',
  id: 'ui_9',
  method: 'ask',
  timeout: 30_000,
  questions: [
    { id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], recommended: 1 },
    {
      id: 'features',
      question: 'Which features?',
      header: 'Features',
      options: [
        { label: 'Auth', description: 'Login and sessions' },
        { label: 'Billing', preview: 'invoice preview text' },
      ],
      multi: true,
    },
  ],
}

const ASK_REQUEST: ExtensionUiRequest = {
  method: 'ask',
  id: 'ui_9',
  title: 'Which database?',
  timeout: 30_000,
  questions: [
    { id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], recommended: 1 },
    {
      id: 'features',
      question: 'Which features?',
      header: 'Features',
      options: [
        { label: 'Auth', description: 'Login and sessions' },
        { label: 'Billing', preview: 'invoice preview text' },
      ],
      multi: true,
    },
  ],
}

describe('extension UI request parsing', () => {
  it('accepts a bounded multiple-choice request', () => {
    expect(parseExtensionUiRequest({
      type: 'extension_ui_request',
      id: 'question-1',
      method: 'select',
      title: 'Choose a release channel',
      options: ['Stable', 'Beta'],
      timeout: 30_000,
    })).toEqual({
      method: 'select',
      id: 'question-1',
      title: 'Choose a release channel',
      options: ['Stable', 'Beta'],
      timeout: 30_000,
    })
  })

  it('unwraps a grouped ask_user question marker for the questionnaire UI', () => {
    expect(parseExtensionUiRequest({
      type: 'extension_ui_request',
      id: 'question-1',
      method: 'select',
      title: 'Pick a framework',
      options: ['__prime_ask_user__group-1:0:2', 'React', 'Vue'],
    })).toEqual({
      method: 'select',
      id: 'question-1',
      title: 'Pick a framework',
      options: ['React', 'Vue'],
      questionnaire: { groupId: 'group-1', index: 0, total: 2 },
    })
  })

  it('rejects malformed or oversized options', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: [] })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: ['ok', 42] })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: ['x'.repeat(501)] })).toBeUndefined()
  })

  it('supports confirm and text input requests', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm', title: 'Continue?', message: 'This will deploy.' })).toMatchObject({ method: 'confirm', id: 'confirm-1', title: 'Continue?', message: 'This will deploy.' })
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'input-1', method: 'input', title: 'Name', placeholder: 'Project name' })).toMatchObject({ method: 'input', id: 'input-1', title: 'Name', placeholder: 'Project name' })
  })

  it('rejects requests that are not extension UI requests or lack an id, title, or method', () => {
    expect(parseExtensionUiRequest({ type: 'message_end', id: 'x', method: 'input', title: 'Name' })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', method: 'input', title: 'Name' })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'input', title: '   ' })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', title: 'Name', method: 7 })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', title: 'Name', method: 'progress' })).toBeUndefined()
  })

  it('drops out-of-range timeouts instead of the whole request', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'input', title: 'Name', timeout: 0 })).toEqual({ method: 'input', id: 'x', title: 'Name', placeholder: undefined, timeout: undefined })
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'input', title: 'Name', timeout: 25 * 60 * 60 * 1_000 })).toMatchObject({ timeout: undefined })
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'input', title: 'Name', timeout: '30000' })).toMatchObject({ timeout: undefined })
  })

  it('treats an unusable questionnaire marker as a plain option', () => {
    const request = (marker: string) => parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: [marker, 'Stable'] })
    expect(request('__prime_ask_user__group-1:0')).toMatchObject({ options: ['__prime_ask_user__group-1:0', 'Stable'] })
    expect(request('__prime_ask_user__:0:2')).toMatchObject({ options: ['__prime_ask_user__:0:2', 'Stable'] })
    expect(request('__prime_ask_user__group 1:0:2')).toMatchObject({ options: ['__prime_ask_user__group 1:0:2', 'Stable'] })
    expect(request('__prime_ask_user__group-1:1:1')).toMatchObject({ options: ['__prime_ask_user__group-1:1:1', 'Stable'] })
    expect(request('__prime_ask_user__group-1:0:6')).toMatchObject({ options: ['__prime_ask_user__group-1:0:6', 'Stable'] })
    expect(request('__prime_ask_user__group-1:0.5:2')).toMatchObject({ options: ['__prime_ask_user__group-1:0.5:2', 'Stable'] })
  })

  it('rejects a questionnaire marker with no visible options left', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: ['__prime_ask_user__group-1:0:2'] })).toBeUndefined()
  })

  it('rejects a confirm request without a message and an input request with an unusable placeholder', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'confirm', title: 'Continue?' })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'input', title: 'Name', placeholder: 42 })).toBeUndefined()
  })

  it('accepts an editor request with a bounded prefill', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'editor-1', method: 'editor', title: 'Edit the plan', prefill: 'step one' })).toEqual({ method: 'editor', id: 'editor-1', title: 'Edit the plan', prefill: 'step one' })
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'editor-1', method: 'editor', title: 'Edit the plan' })).toEqual({ method: 'editor', id: 'editor-1', title: 'Edit the plan', prefill: undefined })
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'editor-1', method: 'editor', title: 'Edit the plan', prefill: 'x'.repeat(32_001) })).toBeUndefined()
  })

  it('keeps a long approval prompt complete instead of silently dropping it', () => {
    expect(LONG_APPROVAL_TITLE.length).toBeGreaterThan(50_000)
    const request = parseExtensionUiRequest({
      type: 'extension_ui_request',
      id: 'approval-1',
      method: 'select',
      title: LONG_APPROVAL_TITLE,
      options: ['Approve', 'Deny'],
    })
    expect(request).toMatchObject({ method: 'select', id: 'approval-1' })
    expect(request?.title).toBe(LONG_APPROVAL_TITLE)
  })

  it('parses aligned select option descriptions and drops unusable ones', () => {
    expect(parseExtensionUiRequest({
      type: 'extension_ui_request',
      id: 'x',
      method: 'select',
      title: 'Pick',
      options: ['Stable', 'Beta'],
      optionDetails: [{ description: 'Tested release' }, {}],
    })).toMatchObject({ options: ['Stable', 'Beta'], optionDetails: [{ description: 'Tested release' }, {}] })
    // Misaligned or malformed details are dropped; the options stay actionable.
    const misaligned = parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: ['Stable', 'Beta'], optionDetails: [{ description: 'Only one' }] })
    expect(misaligned?.method === 'select' ? misaligned.optionDetails : 'present').toBeUndefined()
    const nonArray = parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: ['Stable', 'Beta'], optionDetails: 'nope' })
    expect(nonArray?.method === 'select' ? nonArray.optionDetails : 'present').toBeUndefined()
    const invalidDescription = parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: ['Stable', 'Beta'], optionDetails: [{ description: 7 }, {}] })
    expect(invalidDescription?.method === 'select' ? invalidDescription.optionDetails : 'present').toBeUndefined()
  })

  it('parses upstream cancel frames by target id', () => {
    expect(parseExtensionUiCancel({ type: 'extension_ui_request', id: '999', method: 'cancel', targetId: 'ui_1' })).toEqual({ method: 'cancel', targetId: 'ui_1' })
    expect(parseExtensionUiCancel({ type: 'extension_ui_request', id: '999', method: 'cancel' })).toBeUndefined()
    expect(parseExtensionUiCancel({ type: 'extension_ui_request', id: '999', method: 'cancel', targetId: '' })).toBeUndefined()
    expect(parseExtensionUiCancel({ type: 'extension_ui_request', id: '999', method: 'select', targetId: 'ui_1' })).toBeUndefined()
    expect(parseExtensionUiCancel({ type: 'message_end', method: 'cancel', targetId: 'ui_1' })).toBeUndefined()
  })

  it('reports actionable requests that cannot be rendered as explicit rejections', () => {
    // Oversized title on an otherwise valid select.
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'x'.repeat(200_001), options: ['Approve', 'Deny'] })).toMatchObject({ id: 'x', method: 'select' })
    // Missing title.
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'confirm', message: 'Continue?' })).toMatchObject({ id: 'x', method: 'confirm' })
    // Confirm without a message.
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'confirm', title: 'Continue?' })).toMatchObject({ id: 'x', method: 'confirm' })
    // Oversize option.
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: ['x'.repeat(501)] })).toMatchObject({ id: 'x', method: 'select' })
    // Too many options.
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: Array.from({ length: 33 }, (_, index) => `option-${index}`) })).toMatchObject({ id: 'x', method: 'select' })
    // The upstream `ask` dialog method cannot be rendered by the GUI.
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'ask', questions: [] })).toMatchObject({ id: 'x', method: 'ask' })
    // Editor with an oversize prefill.
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'editor', title: 'Edit', prefill: 'x'.repeat(32_001) })).toMatchObject({ id: 'x', method: 'editor' })
  })

  it('does not reject presentation frames, unknown methods, or frames without an id', () => {
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'notify', message: 'hi' })).toBeUndefined()
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'setStatus', status: 'busy' })).toBeUndefined()
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'setWidget', widget: [] })).toBeUndefined()
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'setTitle', title: 'TUI title' })).toBeUndefined()
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'set_editor_text', text: 'x' })).toBeUndefined()
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'open_url', url: 'https://example.com' })).toBeUndefined()
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', method: 'select', title: 'Pick', options: ['a'] })).toBeUndefined()
    expect(parseExtensionUiRejection({ type: 'message_end', id: 'x', method: 'select', title: 'Pick', options: ['a'] })).toBeUndefined()
  })

  it('exposes one frame parser that agrees with the request and rejection views', () => {
    const ok = parseExtensionUiFrame({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: ['a'] })
    expect(ok).toMatchObject({ status: 'ok' })
    const rejected = parseExtensionUiFrame({ type: 'extension_ui_request', id: 'x', method: 'ask', questions: [] })
    expect(rejected).toMatchObject({ status: 'rejected' })
    expect(parseExtensionUiFrame({ type: 'message_end' })).toBeUndefined()
    expect(parseExtensionUiFrame({ type: 'extension_ui_request', id: 'x', method: 'notify', message: 'hi' })).toBeUndefined()
  })
})


describe('pending extension UI ownership', () => {
  it('retains background requests until their runtime becomes active', () => {
    const foreground: PendingExtensionUi = {
      runtimeId: 'runtime-a',
      request: { method: 'confirm', id: 'foreground', title: 'Continue?', message: 'Proceed' },
    }
    const background: PendingExtensionUi = {
      runtimeId: 'runtime-b',
      request: { method: 'input', id: 'background', title: 'Answer' },
    }
    const pending = new Map([
      [foreground.runtimeId, foreground],
      [background.runtimeId, background],
    ])

    expect(pendingExtensionUiForRuntime(pending, 'runtime-a')).toBe(foreground)
    expect(pendingExtensionUiForRuntime(pending, 'runtime-b')).toBe(background)
    expect(pendingExtensionUiForRuntime(pending, 'runtime-missing')).toBeNull()
    expect(pendingExtensionUiForRuntime(pending)).toBeNull()
  })
})


interface HarnessOptions {
  activeRuntimeId?: string
}

type ExtensionUiApi = ReturnType<typeof useExtensionUi>

let container: HTMLDivElement
let root: Root
let commandMock: Mock<(runtimeId: string, command: Record<string, unknown>) => Promise<Record<string, unknown>>>
let stopMock: Mock<(runtimeId: string) => Promise<boolean>>
let reportErrorMock: Mock<(error: unknown) => void>
let api: ExtensionUiApi
let activeRuntimeId: string
let stableBridge: DesktopApi
let stableSessionsRef: { current: Map<string, string> }

function Harness(): null {
  api = useExtensionUi({
    bridge: stableBridge,
    activeRuntimeId,
    runtimeSessionsRef: stableSessionsRef,
    setSessions: ((_update: React.SetStateAction<SessionRecord[]>) => undefined) as React.Dispatch<React.SetStateAction<SessionRecord[]>>,
    setRuntime: ((_update: React.SetStateAction<RuntimeInfo | null>) => undefined) as React.Dispatch<React.SetStateAction<RuntimeInfo | null>>,
    reportError: reportErrorMock,
  })
  return null
}

function renderHarness(options: HarnessOptions = {}): void {
  activeRuntimeId = options.activeRuntimeId ?? 'runtime-a'
  act(() => { root.render(createElement(Harness)) })
}

function show(runtimeId: string, event: Record<string, unknown>): void {
  act(() => { api.showExtensionUi(runtimeId, event) })
}

function selectEvent(id: string, title: string, options: string[]): Record<string, unknown> {
  return { type: 'extension_ui_request', id, method: 'select', title, options }
}

function confirmEvent(id: string): Record<string, unknown> {
  return { type: 'extension_ui_request', id, method: 'confirm', title: 'Continue?', message: 'Proceed' }
}

function cancelEvent(targetId: string): Record<string, unknown> {
  return { type: 'extension_ui_request', id: '999', method: 'cancel', targetId }
}

function cancelCommands(): Array<Record<string, unknown>> {
  return commandMock.mock.calls.filter((call) => (call[1] as Record<string, unknown>).type === 'extension_ui_response')
    .map((call) => call[1] as Record<string, unknown>)
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  commandMock = vi.fn<(runtimeId: string, command: Record<string, unknown>) => Promise<Record<string, unknown>>>().mockResolvedValue({})
  stopMock = vi.fn<(runtimeId: string) => Promise<boolean>>().mockResolvedValue(true)
  reportErrorMock = vi.fn<(error: unknown) => void>()
  stableBridge = { agent: { command: commandMock, stop: stopMock } } as unknown as DesktopApi
  stableSessionsRef = { current: new Map<string, string>() }
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

describe('extension UI request lifecycle', () => {
  it('answers a user cancellation with the cancelled request id and keeps the runtime alive', async () => {
    renderHarness()
    show('runtime-a', selectEvent('q1', 'Pick a channel', ['Stable', 'Beta']))
    expect(api.extensionUi?.request.id).toBe('q1')

    await act(async () => { await api.respondToExtensionUi({ cancelled: true }) })

    expect(stopMock).not.toHaveBeenCalled()
    expect(cancelCommands()).toEqual([{ type: 'extension_ui_response', id: 'q1', cancelled: true }])
    expect(api.extensionUi).toBeNull()
    // The hook stays usable for later requests from the same runtime.
    show('runtime-a', selectEvent('q2', 'Pick again', ['Yes', 'No']))
    expect(api.extensionUi?.request.id).toBe('q2')
  })

  it('delivers a select answer for the pending request id', async () => {
    renderHarness()
    show('runtime-a', selectEvent('q1', 'Pick a channel', ['Stable', 'Beta']))
    await act(async () => { await api.respondToExtensionUi({ value: 'Stable' }) })
    expect(commandMock.mock.calls[0]).toEqual(['runtime-a', { type: 'extension_ui_response', id: 'q1', value: 'Stable' }])
    expect(stopMock).not.toHaveBeenCalled()
  })

  it('closes the matching request when upstream cancels it and never answers it afterwards', async () => {
    renderHarness()
    show('runtime-a', selectEvent('q1', 'Pick a channel', ['Stable', 'Beta']))
    show('runtime-a', cancelEvent('q1'))

    expect(api.extensionUi).toBeNull()
    expect(commandMock).not.toHaveBeenCalled()
    expect(stopMock).not.toHaveBeenCalled()

    // A late answer for the cancelled request is rejected, not delivered.
    await act(async () => { await api.respondToExtensionUi({ value: 'Stable' }) })
    expect(commandMock).not.toHaveBeenCalled()
  })

  it('removes only the cancelled question of a questionnaire and keeps the rest answerable', async () => {
    renderHarness()
    show('runtime-a', selectEvent('g0', 'First?', ['__prime_ask_user__group-1:0:2', 'A1', 'A2']))
    show('runtime-a', selectEvent('g1', 'Second?', ['__prime_ask_user__group-1:1:2', 'B1', 'B2']))
    expect(api.extensionUi?.request).toMatchObject({ method: 'questionnaire', complete: true })

    show('runtime-a', cancelEvent('g0'))
    expect(api.extensionUi?.request).toMatchObject({ method: 'questionnaire', questions: [{ id: 'g1' }] })

    await act(async () => { await api.respondToExtensionUi({ values: { g1: JSON.stringify({ answer: 'B1', answerSource: 'option' }) } }) })
    expect(cancelCommands()).toEqual([{ type: 'extension_ui_response', id: 'g1', value: JSON.stringify({ answer: 'B1', answerSource: 'option' }) }])
  })

  it('queues concurrent questions instead of overwriting them', async () => {
    renderHarness()
    show('runtime-a', selectEvent('q1', 'First question', ['One', 'Two']))
    show('runtime-a', confirmEvent('q2'))

    // The first request stays visible; the second is retained, not dropped.
    expect(api.extensionUi?.request.id).toBe('q1')
    expect(commandMock).not.toHaveBeenCalled()
    expect(stopMock).not.toHaveBeenCalled()

    await act(async () => { await api.respondToExtensionUi({ value: 'One' }) })
    expect(commandMock.mock.calls[0]).toEqual(['runtime-a', { type: 'extension_ui_response', id: 'q1', value: 'One' }])

    // The queued question appears once the first is resolved.
    expect(api.extensionUi?.request).toMatchObject({ method: 'confirm', id: 'q2' })
    await act(async () => { await api.respondToExtensionUi({ confirmed: true }) })
    expect(commandMock.mock.calls[1]).toEqual(['runtime-a', { type: 'extension_ui_response', id: 'q2', confirmed: true }])
    expect(api.extensionUi).toBeNull()
  })

  it('keeps grouping ask_user questionnaire questions that arrive while another dialog is showing', async () => {
    renderHarness()
    show('runtime-a', confirmEvent('blocking'))
    show('runtime-a', selectEvent('g0', 'First?', ['__prime_ask_user__group-1:0:2', 'A1', 'A2']))
    show('runtime-a', selectEvent('g1', 'Second?', ['__prime_ask_user__group-1:1:2', 'B1', 'B2']))

    await act(async () => { await api.respondToExtensionUi({ confirmed: true }) })
    expect(commandMock.mock.calls[0]).toEqual(['runtime-a', { type: 'extension_ui_response', id: 'blocking', confirmed: true }])
    expect(api.extensionUi?.request).toMatchObject({ method: 'questionnaire', id: 'group-1', complete: true })
    const questionnaire = api.extensionUi?.request.method === 'questionnaire' ? api.extensionUi.request : undefined
    expect(questionnaire?.questions.map((question) => question.id)).toEqual(['g0', 'g1'])
  })

  it('cancels and reports an actionable request that cannot be rendered', () => {
    renderHarness()
    show('runtime-a', { type: 'extension_ui_request', id: 'huge', method: 'select', title: 'x'.repeat(200_001), options: ['Approve', 'Deny'] })
    expect(api.extensionUi).toBeNull()
    expect(cancelCommands()).toEqual([{ type: 'extension_ui_response', id: 'huge', cancelled: true }])
    expect(reportErrorMock).toHaveBeenCalledTimes(1)
  })

  it('ignores upstream cancel frames for unknown requests', () => {
    renderHarness()
    show('runtime-a', selectEvent('q1', 'Pick a channel', ['Stable', 'Beta']))
    show('runtime-a', cancelEvent('unknown-id'))
    expect(api.extensionUi?.request.id).toBe('q1')
    expect(commandMock).not.toHaveBeenCalled()
  })

  it('keeps background runtime requests independent', () => {
    renderHarness({ activeRuntimeId: 'runtime-a' })
    show('runtime-a', selectEvent('q1', 'Foreground', ['One', 'Two']))
    show('runtime-b', selectEvent('q2', 'Background', ['Three', 'Four']))
    expect(api.extensionUi?.request.id).toBe('q1')
    expect(pendingExtensionUiForRuntime(new Map([['runtime-b', { runtimeId: 'runtime-b', request: { method: 'select', id: 'q2', title: 'Background', options: ['Three', 'Four'] } }]]), 'runtime-b')).toMatchObject({ runtimeId: 'runtime-b' })
  })
})


describe('extension UI modal long content', () => {
  it('renders a long approval prompt completely inside a scrollable region', async () => {
    const onRespond = vi.fn()
    await act(async () => {
      root.render(createElement(ExtensionUiModal, { request: { method: 'select', id: 'approval-1', title: LONG_APPROVAL_TITLE, options: ['Approve', 'Deny'] }, onRespond }))
    })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    // The header summarizes instead of blowing up the fixed-height modal header.
    const header = dialog?.querySelector('.modal__header h2')
    expect(header?.textContent).toContain('Allow tool: bash')
    expect((header?.textContent ?? '').length).toBeLessThan(200)
    // The complete content stays readable in a bounded scrollable region.
    const scrollRegion = dialog?.querySelector<HTMLElement>('.extension-question__long')
    expect(scrollRegion).not.toBeNull()
    expect(scrollRegion?.textContent).toContain('output line 399:')
    const option = dialog?.querySelector<HTMLButtonElement>('[role="option"]')
    expect(option?.textContent).toContain('Approve')
  })

  it('renders select option descriptions when provided', async () => {
    const onRespond = vi.fn()
    await act(async () => {
      root.render(createElement(ExtensionUiModal, { request: { method: 'select', id: 'd1', title: 'Pick a channel', options: ['Stable', 'Beta'], optionDetails: [{ description: 'Tested release' }, {}] }, onRespond }))
    })
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    expect(options[0]?.textContent).toContain('Tested release')
    expect(options[1]?.textContent).not.toContain('Tested release')
    expect(options[1]?.textContent).toContain('Beta')
  })

  it('keeps short request rendering unchanged', async () => {
    const onRespond = vi.fn()
    await act(async () => {
      root.render(createElement(ExtensionUiModal, { request: { method: 'confirm', id: 'c1', title: 'Continue?', message: 'Proceed with deployment.' }, onRespond }))
    })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.querySelector('.modal__header h2')?.textContent).toBe('Continue?')
    expect(dialog?.textContent).toContain('Proceed with deployment.')
  })
})

describe('extension UI ask dialog parsing', () => {
  it('parses a native ask request with labels, descriptions, previews, multi, and recommended', () => {
    expect(parseExtensionUiRequest(ASK_FRAME)).toMatchObject({
      method: 'ask',
      id: 'ui_9',
      timeout: 30_000,
      title: 'Which database?',
      questions: [
        { id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], recommended: 1 },
        {
          id: 'features',
          question: 'Which features?',
          header: 'Features',
          options: [{ label: 'Auth', description: 'Login and sessions' }, { label: 'Billing', preview: 'invoice preview text' }],
          multi: true,
        },
      ],
    })
  })

  it('uses the first question header as the modal title when present', () => {
    const request = parseExtensionUiRequest({
      ...ASK_FRAME,
      questions: [{ id: 'q', question: 'Q?', header: 'Setup', options: [{ label: 'A' }] }],
    })
    expect(request).toMatchObject({ method: 'ask', title: 'Setup' })
  })

  it('rejects invalid ask requests as explicit rejections instead of dropping them', () => {
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'ask' })).toMatchObject({ id: 'x', method: 'ask' })
    expect(parseExtensionUiRejection({ type: 'extension_ui_request', id: 'x', method: 'ask', questions: [] })).toMatchObject({ id: 'x', method: 'ask' })
    expect(parseExtensionUiRejection({
      type: 'extension_ui_request',
      id: 'x',
      method: 'ask',
      questions: [
        { id: 'q', question: 'Q?', options: [{ label: 'A' }] },
        { id: 'q', question: 'Q2?', options: [{ label: 'B' }] },
      ],
    })).toMatchObject({ id: 'x', method: 'ask' })
    expect(parseExtensionUiRejection({
      type: 'extension_ui_request',
      id: 'x',
      method: 'ask',
      questions: [{ id: 'q', question: 'Q?', options: [{ description: 'no label' }] }],
    })).toMatchObject({ id: 'x', method: 'ask' })
    expect(parseExtensionUiRejection({
      type: 'extension_ui_request',
      id: 'x',
      method: 'ask',
      questions: [{ id: 'q', question: 'Q?', options: [{ label: 'A' }], recommended: 1 }],
    })).toMatchObject({ id: 'x', method: 'ask' })
    expect(parseExtensionUiRejection({
      type: 'extension_ui_request',
      id: 'x',
      method: 'ask',
      questions: [{ id: 'q', question: 'Q?', options: [{ label: 'A' }], multi: 'yes' }],
    })).toMatchObject({ id: 'x', method: 'ask' })
  })

  it('keeps a valid ask request out of the rejection path', () => {
    expect(parseExtensionUiRejection(ASK_FRAME)).toBeUndefined()
  })
})

describe('extension UI presentation parsing', () => {
  it('parses status updates and treats missing text as a clear', () => {
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n1', method: 'setStatus', statusKey: 'build', statusText: 'running' }))
      .toEqual({ update: { kind: 'status', statusKey: 'build', statusText: 'running' } })
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n2', method: 'setStatus', statusKey: 'build' }))
      .toEqual({ update: { kind: 'status', statusKey: 'build', statusText: undefined } })
  })

  it('parses widget updates with strict placement and treats missing lines as a clear', () => {
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n1', method: 'setWidget', widgetKey: 'todo', widgetLines: ['- a', '- b'], widgetPlacement: 'aboveEditor' }))
      .toEqual({ update: { kind: 'widget', widgetKey: 'todo', widgetLines: ['- a', '- b'], widgetPlacement: 'aboveEditor' } })
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n2', method: 'setWidget', widgetKey: 'todo' }))
      .toEqual({ update: { kind: 'widget', widgetKey: 'todo', widgetLines: undefined } })
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n3', method: 'setWidget', widgetKey: 'todo', widgetLines: ['a'], widgetPlacement: 'middle' }))
      .toMatchObject({ rejection: { method: 'setWidget' } })
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n4', method: 'setWidget', widgetKey: 'k', widgetLines: ['a', 7] }))
      .toMatchObject({ rejection: { method: 'setWidget' } })
  })

  it('parses editor text updates with a bound', () => {
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n1', method: 'set_editor_text', text: 'draft' }))
      .toEqual({ update: { kind: 'editorText', text: 'draft' } })
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n2', method: 'set_editor_text', text: 'x'.repeat(32_001) }))
      .toMatchObject({ rejection: { method: 'set_editor_text' } })
  })

  it('parses open url requests validating http and https only', () => {
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n1', method: 'open_url', url: 'https://example.com/auth', launchUrl: 'http://127.0.0.1:8945/callback', instructions: 'Open to log in' }))
      .toEqual({ update: { kind: 'openUrl', url: 'https://example.com/auth', launchUrl: 'http://127.0.0.1:8945/callback', instructions: 'Open to log in' } })
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n2', method: 'open_url', url: 'javascript:alert(1)' }))
      .toMatchObject({ rejection: { method: 'open_url' } })
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n3', method: 'open_url', url: 'file:///etc/passwd' }))
      .toMatchObject({ rejection: { method: 'open_url' } })
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n4', method: 'open_url', url: 'https://example.com/auth', launchUrl: 'javascript:alert(1)' }))
      .toMatchObject({ rejection: { method: 'open_url' } })
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n5', method: 'open_url', url: 'not a url' }))
      .toMatchObject({ rejection: { method: 'open_url' } })
  })

  it('ignores frames that are not presentation updates', () => {
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'hi' })).toBeUndefined()
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n2', method: 'cancel', targetId: 'ui_1' })).toBeUndefined()
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n3', method: 'select', title: 'Pick', options: ['a'] })).toBeUndefined()
    expect(parseExtensionUiPresentation({ type: 'message_end' })).toBeUndefined()
  })

  it('rejects malformed presentation frames with a reason', () => {
    expect(parseExtensionUiPresentation({ type: 'extension_ui_request', id: 'n1', method: 'setStatus', statusText: 'x' }))
      .toMatchObject({ rejection: { method: 'setStatus' } })
  })
})

describe('extension UI ask lifecycle', () => {
  it('shows an ask request and answers it with the exact answers payload', async () => {
    renderHarness()
    show('runtime-a', ASK_FRAME)
    expect(api.extensionUi?.request).toMatchObject({ method: 'ask', id: 'ui_9' })

    await act(async () => {
      await api.respondToExtensionUi({ answers: [
        { id: 'db', selectedOptions: ['Postgres'] },
        { id: 'features', selectedOptions: ['Auth', 'Billing'] },
      ] })
    })

    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith('runtime-a', {
      type: 'extension_ui_response',
      id: 'ui_9',
      answers: [
        { id: 'db', selectedOptions: ['Postgres'] },
        { id: 'features', selectedOptions: ['Auth', 'Billing'] },
      ],
    })
    expect(stopMock).not.toHaveBeenCalled()
  })

  it('cancels an ask request by request id and keeps the runtime alive', async () => {
    renderHarness()
    show('runtime-a', ASK_FRAME)
    expect(api.extensionUi?.request).toMatchObject({ method: 'ask', id: 'ui_9' })
    await act(async () => { await api.respondToExtensionUi({ cancelled: true }) })
    expect(stopMock).not.toHaveBeenCalled()
    expect(cancelCommands()).toEqual([{ type: 'extension_ui_response', id: 'ui_9', cancelled: true }])
  })

  it('closes an ask request on upstream cancel without ever answering it', async () => {
    renderHarness()
    show('runtime-a', ASK_FRAME)
    show('runtime-a', cancelEvent('ui_9'))
    expect(api.extensionUi).toBeNull()
    expect(commandMock).not.toHaveBeenCalled()
    await act(async () => { await api.respondToExtensionUi({ cancelled: true }) })
    expect(commandMock).not.toHaveBeenCalled()
  })

  it('queues an ask request behind another dialog', async () => {
    renderHarness()
    show('runtime-a', confirmEvent('blocking'))
    show('runtime-a', ASK_FRAME)
    expect(api.extensionUi?.request.id).toBe('blocking')
    await act(async () => { await api.respondToExtensionUi({ confirmed: true }) })
    expect(api.extensionUi?.request).toMatchObject({ method: 'ask', id: 'ui_9' })
  })

  it('cancels the ask request and reports a clear error when an answers payload is invalid', async () => {
    renderHarness()
    show('runtime-a', ASK_FRAME)
    expect(api.extensionUi?.request).toMatchObject({ method: 'ask', id: 'ui_9' })
    await act(async () => {
      await api.respondToExtensionUi({ answers: [{ id: 'db', selectedOptions: ['NotAnOption'] }] })
    })
    expect(cancelCommands()).toEqual([{ type: 'extension_ui_response', id: 'ui_9', cancelled: true }])
    expect(reportErrorMock).toHaveBeenCalledTimes(1)
    expect(api.extensionUi).toBeNull()
  })

  it('rejects a single-select answer carrying both an option and custom input', async () => {
    renderHarness()
    show('runtime-a', ASK_FRAME)
    expect(api.extensionUi?.request).toMatchObject({ method: 'ask', id: 'ui_9' })
    await act(async () => {
      await api.respondToExtensionUi({ answers: [
        { id: 'db', selectedOptions: ['Postgres'], customInput: 'DuckDB' },
        { id: 'features', selectedOptions: [] },
      ] })
    })
    expect(cancelCommands()).toEqual([{ type: 'extension_ui_response', id: 'ui_9', cancelled: true }])
    expect(reportErrorMock).toHaveBeenCalledTimes(1)
  })

  it('answers a timed-out ask request with cancelled and timedOut so OMP applies its recommended fallback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      renderHarness()
      show('runtime-a', { ...ASK_FRAME, timeout: 30_000 })
      expect(api.extensionUi?.request).toMatchObject({ method: 'ask', id: 'ui_9' })
      act(() => { vi.advanceTimersByTime(30_000) })
      expect(commandMock).toHaveBeenCalledTimes(1)
      expect(commandMock).toHaveBeenCalledWith('runtime-a', { type: 'extension_ui_response', id: 'ui_9', cancelled: true, timedOut: true })
      expect(api.extensionUi).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps plain cancelled for select dialog timeouts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      renderHarness()
      show('runtime-a', { type: 'extension_ui_request', id: 'q1', method: 'select', title: 'Pick', options: ['A', 'B'], timeout: 30_000 })
      act(() => { vi.advanceTimersByTime(30_000) })
      expect(commandMock).toHaveBeenCalledTimes(1)
      expect(commandMock).toHaveBeenCalledWith('runtime-a', { type: 'extension_ui_response', id: 'q1', cancelled: true })
    } finally {
      vi.useRealTimers()
    }
  })
})

function statusEvent(statusKey: string, statusText?: string): Record<string, unknown> {
  return { type: 'extension_ui_request', id: 'n1', method: 'setStatus', statusKey, ...(statusText === undefined ? {} : { statusText }) }
}

function widgetEvent(widgetKey: string, widgetLines?: string[]): Record<string, unknown> {
  return { type: 'extension_ui_request', id: 'n1', method: 'setWidget', widgetKey, ...(widgetLines === undefined ? {} : { widgetLines }) }
}

function editorTextEvent(text: string): Record<string, unknown> {
  return { type: 'extension_ui_request', id: 'n1', method: 'set_editor_text', text }
}

function openUrlEvent(url: string): Record<string, unknown> {
  return { type: 'extension_ui_request', id: 'n1', method: 'open_url', url }
}

describe('extension UI presentation state', () => {
  it('derives status entries for the active runtime and removes cleared keys', () => {
    renderHarness()
    show('runtime-a', statusEvent('build', 'running'))
    expect(api.extensionStatus).toEqual([{ key: 'build', text: 'running' }])
    show('runtime-a', statusEvent('tests', 'passing'))
    expect(api.extensionStatus).toEqual([{ key: 'build', text: 'running' }, { key: 'tests', text: 'passing' }])
    show('runtime-a', statusEvent('build'))
    expect(api.extensionStatus).toEqual([{ key: 'tests', text: 'passing' }])
  })

  it('keeps background runtime status out of the active view', () => {
    renderHarness()
    show('runtime-b', statusEvent('build', 'running'))
    expect(api.extensionStatus).toEqual([])
  })

  it('derives widget lines and removes cleared widgets', () => {
    renderHarness()
    show('runtime-a', { type: 'extension_ui_request', id: 'n1', method: 'setWidget', widgetKey: 'todo', widgetLines: ['- a', '- b'], widgetPlacement: 'aboveEditor' })
    expect(api.extensionWidgets).toEqual([{ key: 'todo', lines: ['- a', '- b'], placement: 'aboveEditor' }])
    show('runtime-a', widgetEvent('todo'))
    expect(api.extensionWidgets).toEqual([])
  })

  it('exposes editor text updates without applying them and supports consume and dismiss', () => {
    renderHarness()
    show('runtime-a', editorTextEvent('draft text'))
    expect(api.editorTextUpdate).toEqual({ runtimeId: 'runtime-a', text: 'draft text' })
    act(() => { api.consumeEditorTextUpdate() })
    expect(api.editorTextUpdate).toBeNull()
    show('runtime-a', editorTextEvent('second'))
    expect(api.editorTextUpdate).toEqual({ runtimeId: 'runtime-a', text: 'second' })
    act(() => { api.dismissEditorTextUpdate() })
    expect(api.editorTextUpdate).toBeNull()
  })

  it('exposes editor text and status only for the active runtime', () => {
    renderHarness()
    show('runtime-a', editorTextEvent('draft a'))
    show('runtime-b', editorTextEvent('draft b'))
    show('runtime-b', statusEvent('tests', 'passing'))
    expect(api.editorTextUpdate).toEqual({ runtimeId: 'runtime-a', text: 'draft a' })
    expect(api.extensionStatus).toEqual([])
    renderHarness({ activeRuntimeId: 'runtime-b' })
    expect(api.editorTextUpdate).toEqual({ runtimeId: 'runtime-b', text: 'draft b' })
    expect(api.extensionStatus).toEqual([{ key: 'tests', text: 'passing' }])
  })

  it('exposes validated open url requests and supports dismissal', () => {
    renderHarness()
    show('runtime-a', { type: 'extension_ui_request', id: 'n1', method: 'open_url', url: 'https://example.com/auth', launchUrl: 'http://127.0.0.1:8945/cb', instructions: 'Log in' })
    expect(api.openUrlRequest).toEqual({ runtimeId: 'runtime-a', url: 'https://example.com/auth', launchUrl: 'http://127.0.0.1:8945/cb', instructions: 'Log in' })
    act(() => { api.dismissOpenUrlRequest() })
    expect(api.openUrlRequest).toBeNull()
  })

  it('rejects unsafe open url frames with a visible error', () => {
    renderHarness()
    show('runtime-a', openUrlEvent('javascript:alert(1)'))
    expect(api.openUrlRequest).toBeNull()
    expect(reportErrorMock).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed presentation frames with a visible error', () => {
    renderHarness()
    show('runtime-a', { type: 'extension_ui_request', id: 'n1', method: 'setStatus', statusText: 'x' })
    expect(api.extensionStatus).toEqual([])
    expect(reportErrorMock).toHaveBeenCalledTimes(1)
  })

  it('clears presentation state only for the cleared runtime', () => {
    renderHarness()
    show('runtime-a', statusEvent('build', 'running'))
    show('runtime-a', editorTextEvent('draft'))
    show('runtime-a', openUrlEvent('https://example.com/auth'))
    show('runtime-b', statusEvent('tests', 'passing'))
    act(() => { api.clearExtensionUi('runtime-a') })
    expect(api.extensionStatus).toEqual([])
    expect(api.editorTextUpdate).toBeNull()
    expect(api.openUrlRequest).toBeNull()
    renderHarness({ activeRuntimeId: 'runtime-b' })
    expect(api.extensionStatus).toEqual([{ key: 'tests', text: 'passing' }])
  })

  it('does not send anything for presentation frames', () => {
    renderHarness()
    show('runtime-a', statusEvent('build', 'running'))
    show('runtime-a', editorTextEvent('draft'))
    show('runtime-a', openUrlEvent('https://example.com/auth'))
    expect(commandMock).not.toHaveBeenCalled()
    expect(stopMock).not.toHaveBeenCalled()
  })
})

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  button.focus()
  await act(async () => { button.click() })
}

function askQuestionBlocks(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.extension-ask__question'))
}

function askSubmitButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.modal__footer button'))
    .find((element) => element.textContent?.includes('Submit'))
  if (!button) throw new Error('ask submit button not rendered')
  return button
}

describe('extension UI ask modal', () => {
  it('renders questions, headers, descriptions, recommended badge, and collapsed previews', async () => {
    const onRespond = vi.fn()
    await act(async () => { root.render(createElement(ExtensionUiModal, { request: ASK_REQUEST, onRespond })) })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Which database?')
    expect(dialog?.textContent).toContain('Features')
    expect(dialog?.textContent).toContain('Login and sessions')
    expect(document.querySelectorAll('.extension-ask__recommended')).toHaveLength(1)
    expect(dialog?.textContent).not.toContain('invoice preview text')
    const previewToggle = document.querySelector<HTMLButtonElement>('.extension-ask__preview-toggle')
    expect(previewToggle).not.toBeNull()
    await clickButton(previewToggle!)
    expect(dialog?.textContent).toContain('invoice preview text')
  })

  it('builds answers with exact labels in question order and gates submit on single-select answers', async () => {
    const onRespond = vi.fn()
    await act(async () => { root.render(createElement(ExtensionUiModal, { request: ASK_REQUEST, onRespond })) })
    const blocks = askQuestionBlocks()
    expect(blocks).toHaveLength(2)
    const dbOptions = Array.from(blocks[0].querySelectorAll<HTMLButtonElement>('[role="option"]'))
    const featureOptions = Array.from(blocks[1].querySelectorAll<HTMLButtonElement>('[role="option"]'))
    expect(askSubmitButton().disabled).toBe(true)
    await clickButton(dbOptions[0])
    expect(askSubmitButton().disabled).toBe(false)
    await clickButton(featureOptions[0])
    await clickButton(featureOptions[1])
    await clickButton(askSubmitButton())
    expect(onRespond).toHaveBeenCalledWith({
      answers: [
        { id: 'db', selectedOptions: ['Postgres'] },
        { id: 'features', selectedOptions: ['Auth', 'Billing'] },
      ],
    })
  })

  it('toggles multi-select options off and allows an empty multi answer', async () => {
    const onRespond = vi.fn()
    await act(async () => { root.render(createElement(ExtensionUiModal, { request: ASK_REQUEST, onRespond })) })
    const blocks = askQuestionBlocks()
    const dbOptions = Array.from(blocks[0].querySelectorAll<HTMLButtonElement>('[role="option"]'))
    const featureOptions = Array.from(blocks[1].querySelectorAll<HTMLButtonElement>('[role="option"]'))
    await clickButton(dbOptions[0])
    await clickButton(featureOptions[0])
    await clickButton(featureOptions[0])
    await clickButton(askSubmitButton())
    expect(onRespond).toHaveBeenCalledWith({
      answers: [
        { id: 'db', selectedOptions: ['Postgres'] },
        { id: 'features', selectedOptions: [] },
      ],
    })
  })

  it('keeps single-select answers exclusive with custom input in both directions', async () => {
    const onRespond = vi.fn()
    await act(async () => { root.render(createElement(ExtensionUiModal, { request: ASK_REQUEST, onRespond })) })
    const blocks = askQuestionBlocks()
    const dbOptions = Array.from(blocks[0].querySelectorAll<HTMLButtonElement>('[role="option"]'))
    const customInputs = Array.from(document.querySelectorAll<HTMLInputElement>('.extension-ask__custom input'))
    expect(customInputs).toHaveLength(2)
    await clickButton(dbOptions[0])
    setInputValue(customInputs[0], '  DuckDB  ')
    expect(dbOptions[0].getAttribute('aria-selected')).toBe('false')
    await clickButton(askSubmitButton())
    expect(onRespond).toHaveBeenCalledWith({
      answers: [
        { id: 'db', selectedOptions: [], customInput: 'DuckDB' },
        { id: 'features', selectedOptions: [] },
      ],
    })
  })

  it('clears custom input when a single-select option is chosen', async () => {
    const onRespond = vi.fn()
    await act(async () => { root.render(createElement(ExtensionUiModal, { request: ASK_REQUEST, onRespond })) })
    const blocks = askQuestionBlocks()
    const dbOptions = Array.from(blocks[0].querySelectorAll<HTMLButtonElement>('[role="option"]'))
    const customInputs = Array.from(document.querySelectorAll<HTMLInputElement>('.extension-ask__custom input'))
    setInputValue(customInputs[0], 'DuckDB')
    await clickButton(dbOptions[0])
    expect(customInputs[0].value).toBe('')
    await clickButton(askSubmitButton())
    expect(onRespond).toHaveBeenCalledWith({
      answers: [
        { id: 'db', selectedOptions: ['Postgres'] },
        { id: 'features', selectedOptions: [] },
      ],
    })
  })

  it('allows custom input alongside multi-select options', async () => {
    const onRespond = vi.fn()
    await act(async () => { root.render(createElement(ExtensionUiModal, { request: ASK_REQUEST, onRespond })) })
    const blocks = askQuestionBlocks()
    const dbOptions = Array.from(blocks[0].querySelectorAll<HTMLButtonElement>('[role="option"]'))
    const featureOptions = Array.from(blocks[1].querySelectorAll<HTMLButtonElement>('[role="option"]'))
    const customInputs = Array.from(document.querySelectorAll<HTMLInputElement>('.extension-ask__custom input'))
    await clickButton(dbOptions[0])
    setInputValue(customInputs[1], 'also add SSO')
    await clickButton(featureOptions[0])
    await clickButton(askSubmitButton())
    expect(onRespond).toHaveBeenCalledWith({
      answers: [
        { id: 'db', selectedOptions: ['Postgres'] },
        { id: 'features', selectedOptions: ['Auth'], customInput: 'also add SSO' },
      ],
    })
  })
})
