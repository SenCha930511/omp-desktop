// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Composer } from '../../src/components/Composer'
import type { WordPredictionAgent } from '../../src/hooks/useWordPrediction'
import { readComposerDraft } from '../../src/lib/composer-draft'
import { translate } from '../../src/lib/i18n'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Command = WordPredictionAgent['command']
type CommandMock = Mock<Command>
type Response = Record<string, unknown>

interface ViewOptions {
  agent: WordPredictionAgent
  runtimeId?: string
  sessionId?: string | null
  draftKey?: string
  busy?: boolean
  onStop?(): void
  onSend?(): void
  restoreRequest?: { id: number; text: string }
}

let container: HTMLDivElement
let root: Root
const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
let resizeObserverInstance: ResizeObserverMock | null = null
let observedElement: Element | null = null
let resizeObserverObserveCount = 0
let resizeObserverDisconnectCount = 0

class ResizeObserverMock {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverInstance = this
  }

  observe(target: Element) {
    observedElement = target
    resizeObserverObserveCount += 1
  }

  unobserve() {}

  disconnect() {
    resizeObserverDisconnectCount += 1
  }

  resize() {
    this.callback([], this)
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  resizeObserverInstance = null
  observedElement = null
  resizeObserverObserveCount = 0
  resizeObserverDisconnectCount = 0
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  window.sessionStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function view({
  agent,
  runtimeId = 'runtime-1',
  sessionId = 'session-1',
  draftKey = 'synthetic-project:synthetic-session',
  busy = false,
  onStop = vi.fn(),
  onSend = vi.fn(),
  restoreRequest,
}: ViewOptions) {
  return <Composer
    busy={busy}
    model="synthetic/model"
    effort="medium"
    modelsByProvider={new Map()}
    providers={[]}
    reasoningLevels={['medium']}
    fast={false}
    fastSupported={false}
    fastAvailable={false}
    imageInputSupported
    skills={[]}
    runtimeId={runtimeId}
    wordPredictionAgent={agent}
    wordPredictionSessionId={sessionId}
    draftKey={draftKey}
    restoreRequest={restoreRequest}
    onModelChange={vi.fn()}
    onEffortChange={vi.fn()}
    onFastChange={vi.fn()}
    onSend={onSend}
    onStop={onStop}
  />
}

function renderView(options: ViewOptions) {
  act(() => root.render(view(options)))
  return container.querySelector<HTMLTextAreaElement>('.composer-input > textarea')!
}

function changeValue(textarea: HTMLTextAreaElement, value: string, cursor = value.length) {
  act(() => {
    if (document.activeElement !== textarea) textarea.focus()
    valueSetter.call(textarea, value)
    textarea.setSelectionRange(cursor, cursor)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function advanceDebounce() {
  await act(async () => vi.advanceTimersByTimeAsync(300))
}

async function resolve(response: PromiseWithResolvers<Response>, value: Response) {
  await act(async () => {
    response.resolve(value)
    await response.promise
  })
}

function success(suffix: string | null): Response {
  return { success: true, command: 'predict_word', data: { suffix } }
}

function agentWith(command: CommandMock): WordPredictionAgent {
  return { command }
}

function feedback(command: CommandMock) {
  return command.mock.calls.map(([, body]) => body).filter((body) => body.type === 'predict_word_feedback')
}

function ghost() {
  return container.querySelector<HTMLElement>('.composer-ghost-text__suffix')
}

async function showGhost(command: CommandMock, response: PromiseWithResolvers<Response>, text = 'hello', suffix = ' world', options: Partial<ViewOptions> = {}) {
  const textarea = renderView({ agent: options.agent ?? agentWith(command), ...options })
  changeValue(textarea, text)
  await advanceDebounce()
  await resolve(response, success(suffix))
  return textarea
}

describe('Composer optional native word prediction', () => {
  it('stays inactive unless the full prediction identity and persistent draft scope are supplied', async () => {
    const command = vi.fn<Command>()
    const textarea = renderView({ agent: agentWith(command), sessionId: null })

    changeValue(textarea, 'synthetic draft')
    await advanceDebounce()

    expect(command).not.toHaveBeenCalled()
    expect(ghost()).toBeNull()
    expect(textarea.getAttribute('aria-autocomplete')).toBe('list')
  })

  it('requests the exact synthetic UTF-16 draft and renders only the suffix without augmenting the real draft', async () => {
    const response = Promise.withResolvers<Response>()
    const command = vi.fn<Command>(() => response.promise)
    const textarea = await showGhost(command, response, 'hello 😀', ' next')

    expect(command).toHaveBeenCalledExactlyOnceWith('runtime-1', { type: 'predict_word', text: 'hello 😀', cursor: 8 })
    expect(ghost()?.textContent).toBe(' next')
    expect(container.querySelector('.composer-ghost-text')?.getAttribute('aria-hidden')).toBe('true')
    expect(textarea.value).toBe('hello 😀')
    expect(textarea.getAttribute('aria-autocomplete')).toBe('inline')
    const hintId = textarea.getAttribute('aria-describedby')
    expect(hintId).toBeTruthy()
    expect(document.getElementById(hintId!)?.textContent).toBe('Suggestion available; Tab to insert.')
    expect(document.getElementById(hintId!)?.getAttribute('aria-live')).toBeNull()
    expect(readComposerDraft('synthetic-project:synthetic-session')?.text).toBe('hello 😀')
  })

  it('resynchronizes mirror dimensions on textarea resize and disconnects its observer', async () => {
    const response = Promise.withResolvers<Response>()
    const command = vi.fn<Command>(() => response.promise)
    const textarea = renderView({ agent: agentWith(command) })
    let width = 320
    let height = 90
    Object.defineProperties(textarea, {
      clientWidth: { configurable: true, get: () => width },
      clientHeight: { configurable: true, get: () => height },
    })
    changeValue(textarea, 'hello')
    await advanceDebounce()
    await resolve(response, success(' world'))

    const mirror = container.querySelector<HTMLElement>('.composer-ghost-text')!
    expect(mirror.style.width).toBe('320px')
    expect(mirror.style.height).toBe('90px')
    expect(observedElement).toBe(textarea)
    expect(resizeObserverObserveCount).toBe(1)

    width = 480
    height = 132
    act(() => resizeObserverInstance?.resize())

    expect(mirror.style.width).toBe('480px')
    expect(mirror.style.height).toBe('132px')
    await act(async () => root.unmount())
    expect(resizeObserverDisconnectCount).toBe(1)
    root = createRoot(container)
  })

  it.each([
    ['null suffix', success(null)],
    ['empty suffix', success('')],
    ['malformed suffix', { success: true, data: { suffix: 42 } }],
    ['oversized suffix', success('x'.repeat(4097))],
  ])('treats a %s as no ghost and no feedback', async (_label, result) => {
    const response = Promise.withResolvers<Response>()
    const command = vi.fn<Command>(() => response.promise)
    const textarea = renderView({ agent: agentWith(command) })
    changeValue(textarea, 'hello')
    await advanceDebounce()
    await resolve(response, result)

    expect(ghost()).toBeNull()
    expect(feedback(command)).toEqual([])
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('suppresses transport rejection without retrying or displaying an error', async () => {
    const command = vi.fn<Command>(async () => {
      throw new Error('synthetic native failure')
    })
    const textarea = renderView({ agent: agentWith(command) })
    changeValue(textarea, 'hello')
    await advanceDebounce()

    expect(command).toHaveBeenCalledTimes(1)
    expect(ghost()).toBeNull()
    expect(container.querySelector('.composer-ghost-text')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps only the newest draft queued while one prediction is running', async () => {
    const first = Promise.withResolvers<Response>()
    const second = Promise.withResolvers<Response>()
    const responses = [first, second]
    let responseIndex = 0
    const command = vi.fn<Command>(() => responses[responseIndex++].promise)
    const textarea = renderView({ agent: agentWith(command) })

    changeValue(textarea, 'hello')
    await advanceDebounce()
    expect(command).toHaveBeenCalledTimes(1)
    changeValue(textarea, 'hello newer')
    await advanceDebounce()
    expect(command).toHaveBeenCalledTimes(1)

    await resolve(first, success(' stale'))
    expect(command).toHaveBeenCalledTimes(2)
    expect(command.mock.calls[1][1]).toEqual({ type: 'predict_word', text: 'hello newer', cursor: 11 })
    expect(ghost()).toBeNull()
    await resolve(second, success(' current'))

    expect(ghost()?.textContent).toBe(' current')
    expect(textarea.value).toBe('hello newer')
  })

  it('discards a stale response on runtime and session owner changes without feedback', async () => {
    const response = Promise.withResolvers<Response>()
    const command = vi.fn<Command>(() => response.promise)
    const agent = agentWith(command)
    const textarea = renderView({ agent, runtimeId: 'runtime-old', sessionId: 'session-old', draftKey: 'synthetic:old' })
    changeValue(textarea, 'old synthetic draft')
    await advanceDebounce()

    act(() => root.render(view({ agent, runtimeId: 'runtime-new', sessionId: 'session-new', draftKey: 'synthetic:new' })))
    await resolve(response, success(' stale'))

    expect(ghost()).toBeNull()
    expect(feedback(command)).toEqual([])
    expect(container.querySelector('textarea')?.getAttribute('aria-autocomplete')).toBe('list')
  })

  it('accepts through unmodified Tab exactly once at the original coordinates and persists only the accepted value', async () => {
    const response = Promise.withResolvers<Response>()
    const command = vi.fn<Command>((_runtimeId, body) => body.type === 'predict_word' ? response.promise : Promise.resolve({ success: true }))
    const textarea = await showGhost(command, response)

    let prevented = false
    await act(async () => {
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      prevented = !textarea.dispatchEvent(event)
    })

    expect(prevented).toBe(true)
    expect(textarea.value).toBe('hello world')
    expect(textarea.selectionStart).toBe(11)
    expect(textarea.selectionEnd).toBe(11)
    expect(ghost()).toBeNull()
    expect(feedback(command)).toEqual([{ type: 'predict_word_feedback', text: 'hello', cursor: 5, suggestion: ' world', accepted: true }])
    expect(readComposerDraft('synthetic-project:synthetic-session')?.text).toBe('hello world')
    act(() => textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true })))
    expect(feedback(command)).toHaveLength(1)
  })

  it.each([
    ['ordinary Tab without a ghost', { key: 'Tab' }, false],
    ['Shift Tab', { key: 'Tab', shiftKey: true }, true],
    ['Ctrl Tab', { key: 'Tab', ctrlKey: true }, true],
    ['Meta Tab', { key: 'Tab', metaKey: true }, true],
    ['Alt Tab', { key: 'Tab', altKey: true }, true],
  ])('preserves %s navigation', async (_label, init, withGhost) => {
    const response = Promise.withResolvers<Response>()
    const command = vi.fn<Command>(() => response.promise)
    const textarea = withGhost ? await showGhost(command, response) : renderView({ agent: agentWith(command) })

    let prevented = false
    act(() => {
      prevented = !textarea.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }))
    })

    expect(prevented).toBe(false)
    expect(feedback(command)).toEqual([])
    expect(textarea.value).toBe(withGhost ? 'hello' : '')
  })

  it('rejects exactly once for a genuine edit using the shown original snapshot, deduplicated across keyup', async () => {
    const response = Promise.withResolvers<Response>()
    const command = vi.fn<Command>((_runtimeId, body) => body.type === 'predict_word' ? response.promise : Promise.resolve({ success: true }))
    const textarea = await showGhost(command, response)

    changeValue(textarea, 'hello!')
    act(() => textarea.dispatchEvent(new KeyboardEvent('keyup', { key: '!', bubbles: true })))

    expect(feedback(command)).toEqual([{ type: 'predict_word_feedback', text: 'hello', cursor: 5, suggestion: ' world', accepted: false }])
    expect(ghost()).toBeNull()
    expect(textarea.value).toBe('hello!')
  })

  it.each([
    ['caret-only movement', 2, 2],
    ['full selection changes', 0, 5],
  ])('invalidates silently for %s', async (_label, start, end) => {
    const response = Promise.withResolvers<Response>()
    const command = vi.fn<Command>(() => response.promise)
    const textarea = await showGhost(command, response)

    act(() => {
      textarea.setSelectionRange(start, end)
      textarea.dispatchEvent(new Event('select', { bubbles: true }))
      document.dispatchEvent(new Event('selectionchange'))
    })

    expect(ghost()).toBeNull()
    expect(feedback(command)).toEqual([])
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => textarea.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not treat blur or Escape as a rejection and preserves busy Escape stop behavior', async () => {
    const response = Promise.withResolvers<Response>()
    const command = vi.fn<Command>(() => response.promise)
    const onStop = vi.fn()
    const textarea = renderView({ agent: agentWith(command), busy: true, onStop })
    textarea.focus()
    changeValue(textarea, 'hello')
    await advanceDebounce()
    await resolve(response, success(' world'))

    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))

    expect(onStop).toHaveBeenCalledTimes(1)
    expect(ghost()).toBeNull()
    expect(feedback(command)).toEqual([])
    act(() => textarea.blur())
    expect(feedback(command)).toEqual([])
  })

  it('hides a visible prediction on blur without rejection', async () => {
    const response = Promise.withResolvers<Response>()
    const command = vi.fn<Command>(() => response.promise)
    const textarea = await showGhost(command, response)

    act(() => textarea.blur())

    expect(ghost()).toBeNull()
    expect(feedback(command)).toEqual([])
  })

  it('clears during IME composition without feedback or prediction until composition commit', async () => {
    const response = Promise.withResolvers<Response>()
    const command = vi.fn<Command>(() => response.promise)
    const textarea = await showGhost(command, response)

    act(() => textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    expect(ghost()).toBeNull()
    changeValue(textarea, '你好')
    await advanceDebounce()
    expect(command).toHaveBeenCalledTimes(1)
    expect(feedback(command)).toEqual([])

    act(() => textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '好' })))
    await advanceDebounce()
    expect(command).toHaveBeenCalledTimes(2)
    expect(command.mock.calls[1][1]).toEqual({ type: 'predict_word', text: '你好', cursor: 2 })
  })

  it('silently removes a ghost before paint for restore and setRangeText replacements', async () => {
    const response = Promise.withResolvers<Response>()
    const command = vi.fn<Command>(() => response.promise)
    const agent = agentWith(command)
    await showGhost(command, response, 'hello', ' world', { agent })

    act(() => root.render(view({ agent, restoreRequest: { id: 1, text: 'restored synthetic text' } })))

    expect(container.querySelector('.composer-ghost-text')).toBeNull()
    expect(container.querySelector('textarea')?.value).toBe('hello\n\nrestored synthetic text')
    expect(feedback(command)).toEqual([])

    const restored = container.querySelector<HTMLTextAreaElement>('textarea')!
    act(() => restored.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true })))
    expect(restored.value).toContain('\n')
    expect(feedback(command)).toEqual([])
  })

  it('invalidates silently on submit-clear and unmount without leaving timers or feedback', async () => {
    const response = Promise.withResolvers<Response>()
    const command = vi.fn<Command>(() => response.promise)
    const onSend = vi.fn()
    const textarea = await showGhost(command, response, 'hello', ' world', { onSend })

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe('')
    expect(ghost()).toBeNull()
    expect(feedback(command)).toEqual([])
    await act(async () => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
    expect(feedback(command)).toEqual([])
    root = createRoot(container)
  })
})

describe('registered word prediction accessibility text', () => {
  it.each([
    ['en', 'Suggestion available; Tab to insert.'],
    ['zh-TW', '有可用建議；按 Tab 插入。'],
    ['zh-CN', '有可用建议；按 Tab 插入。'],
  ] as const)('uses the %s catalog entry', (locale, expected) => {
    expect(translate(locale, 'composer.wordPredictionHint')).toBe(expected)
  })
})
