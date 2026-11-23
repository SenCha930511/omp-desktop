// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'
import { groupModelsByProvider } from '../../src/hooks/useProviderCatalog'
import { I18nProvider, type ResolvedLocale } from '../../src/lib/i18n'
import type { PrimeContextUsage, PrimeModelDescriptor, PrimeProviderDescriptor, RuntimeInfo, SkillRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const models: PrimeModelDescriptor[] = [{
  key: 'provider/vision', provider: 'provider', id: 'vision', name: 'Vision', reasoning: true,
  input: ['text', 'image'], contextWindow: 100_000, maxTokens: 8_000,
  availableThinkingLevels: ['medium'], fastModeSupported: false, available: true,
}]
const providers: PrimeProviderDescriptor[] = [{
  id: 'provider', name: 'Provider', authMethod: 'api_key', configured: true,
  modelCount: 1, availableModelCount: 1,
}]
const modelsByProvider = groupModelsByProvider(models)

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  let id = 0
  vi.stubGlobal('crypto', { randomUUID: () => {
    id += 1
    return `image-${id}`
  } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderComposer(
  onSend = vi.fn(),
  imageInputSupported = true,
  busy = false,
  messageEnterAction: 'queue' | 'steer' = 'queue',
  contextUsage?: PrimeContextUsage,
  executingModel?: RuntimeInfo['executingModel'],
  harnessTokensPerSecond?: number,
  availableCommands?: RuntimeInfo['availableCommands'],
  callbacks: {
    onContinue?(deliverQueued: boolean): Promise<boolean>
    onStop?(): Promise<void> | void
    onOpenSessionTree?(): void
  } = {},
  fastOptions: {
    fast?: boolean
    fastSupported?: boolean
    fastActive?: boolean
    onFastChange?(value: boolean): void
    onFastRetry?(): void
    slow?: boolean
    slowSupported?: boolean
    slowScope?: RuntimeInfo['slowModeScope']
    onSlowChange?(value: boolean): void
    locale?: ResolvedLocale
  } = {},
) {
  const composer = <Composer
    busy={busy}
    model="provider/vision"
    effort="medium"
    modelsByProvider={modelsByProvider}
    providers={providers}
    reasoningLevels={['medium']}
    fast={fastOptions.fast ?? false}
    fastSupported={fastOptions.fastSupported ?? false}
    fastAvailable
    fastActive={fastOptions.fastActive}
    slow={fastOptions.slow}
    slowSupported={fastOptions.slowSupported}
    slowScope={fastOptions.slowScope}
    imageInputSupported={imageInputSupported}
    messageEnterAction={messageEnterAction}
    contextUsage={contextUsage}
    harnessTokensPerSecond={harnessTokensPerSecond}
    executingModel={executingModel}
    skills={[]}
    availableCommands={availableCommands}
    onModelChange={vi.fn()}
    onEffortChange={vi.fn()}
    onFastChange={fastOptions.onFastChange ?? vi.fn()}
    onFastRetry={fastOptions.onFastRetry}
    onSlowChange={fastOptions.onSlowChange}
    onSend={onSend}
    onContinue={callbacks.onContinue}
    onStop={callbacks.onStop ?? vi.fn()}
    onOpenSessionTree={callbacks.onOpenSessionTree}
  />
  act(() => root.render(fastOptions.locale
    ? <I18nProvider preference={fastOptions.locale}>{composer}</I18nProvider>
    : composer))
  return onSend
}

describe('Composer Fast retry', () => {
  const retryLabel = 'Retry Fast'

  it('retries the actual service tier without changing the enabled Fast preference', () => {
    const changeFast = vi.fn()
    const retryFast = vi.fn()
    renderComposer(vi.fn(), true, false, 'queue', undefined, undefined, undefined, undefined, {}, {
      fast: true, fastSupported: true, fastActive: false, onFastChange: changeFast, onFastRetry: retryFast,
    })

    const retry = container.querySelector<HTMLButtonElement>(`button[aria-label="${retryLabel}"]`)
    expect(retry).not.toBeNull()
    expect(retry?.title).toBe('Fast mode is enabled, but OMP is not using its priority service. Retry without changing your Fast preference.')
    expect(retry?.hasAttribute('aria-pressed')).toBe(false)
    act(() => retry!.click())
    expect(retryFast).toHaveBeenCalledTimes(1)
    expect(changeFast).not.toHaveBeenCalled()
  })

  it('keeps the Fast toggle independent from the retry command', () => {
    const changeFast = vi.fn()
    const retryFast = vi.fn()
    renderComposer(vi.fn(), true, false, 'queue', undefined, undefined, undefined, undefined, {}, {
      fast: true, fastSupported: true, fastActive: false, onFastChange: changeFast, onFastRetry: retryFast,
    })

    const toggle = container.querySelector<HTMLButtonElement>('.fast-mode-toggle[aria-pressed="true"]')!
    act(() => toggle.click())
    expect(changeFast).toHaveBeenCalledTimes(1)
    expect(changeFast).toHaveBeenCalledWith(false)
    expect(retryFast).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'active', fast: true, fastSupported: true, fastActive: true, retryAvailable: true },
    { label: 'unknown', fast: true, fastSupported: true, fastActive: undefined, retryAvailable: true },
    { label: 'preference off', fast: false, fastSupported: true, fastActive: false, retryAvailable: true },
    { label: 'unsupported', fast: true, fastSupported: false, fastActive: false, retryAvailable: true },
    { label: 'retry callback absent', fast: true, fastSupported: true, fastActive: false, retryAvailable: false },
  ] as const)('does not offer Retry when Fast is $label', ({ fast, fastSupported, fastActive, retryAvailable }) => {
    renderComposer(vi.fn(), true, false, 'queue', undefined, undefined, undefined, undefined, {}, {
      fast, fastSupported, fastActive, onFastRetry: retryAvailable ? vi.fn() : undefined,
    })

    expect(container.querySelector(`button[aria-label="${retryLabel}"]`)).toBeNull()
  })

  it.each([
    ['en', 'Retry Fast', 'Fast mode is enabled, but OMP is not using its priority service. Retry without changing your Fast preference.'],
    ['zh-TW', '重試快速模式', '已啟用快速模式，但 OMP 目前未使用優先服務。重試時不會變更快速模式偏好設定。'],
    ['zh-CN', '重试快速模式', '已启用快速模式，但 OMP 当前未使用优先服务。重试不会更改快速模式偏好设置。'],
  ] as const)('renders localized Retry text for %s', (locale, label, title) => {
    renderComposer(vi.fn(), true, false, 'queue', undefined, undefined, undefined, undefined, {}, {
      fast: true, fastSupported: true, fastActive: false, onFastRetry: vi.fn(), locale,
    })

    const retry = container.querySelector<HTMLButtonElement>('.fast-mode-retry')
    expect(retry?.getAttribute('aria-label')).toBe(label)
    expect(retry?.textContent).toContain(label)
    expect(retry?.getAttribute('title')).toBe(title)
  })
})

describe('Composer Slow controls', () => {
  it.each([
    ['en', 'Slow', 'global', 'Use OMP slow mode. This global preference persists across model switches and applies to every session and terminal using this provider.'],
    ['en', 'Slow', 'session', 'Use OMP slow mode for the current model family in this session only. Each model family has its own preference.'],
    ['zh-TW', '慢速', 'global', '使用 OMP 慢速模式。此全域偏好設定會跨模型切換保留，並套用於使用此提供者的所有工作階段與終端機。'],
    ['zh-TW', '慢速', 'session', '僅在此工作階段對目前模型系列使用 OMP 慢速模式；每個模型系列各有獨立偏好設定。'],
    ['zh-CN', '慢速', 'global', '使用 OMP 慢速模式。此全局偏好设置会跨模型切换保留，并应用于使用此提供商的所有会话和终端。'],
    ['zh-CN', '慢速', 'session', '仅在此会话中对当前模型系列使用 OMP 慢速模式；每个模型系列都有独立的偏好设置。'],
  ] as const)('renders localized %s Slow text and %s scope title', (locale, label, slowScope, title) => {
    const changeSlow = vi.fn()
    renderComposer(vi.fn(), true, false, 'queue', undefined, undefined, undefined, undefined, {}, {
      locale, slow: false, slowSupported: true, slowScope, onSlowChange: changeSlow,
    })

    const toggle = container.querySelector<HTMLButtonElement>('.slow-mode-toggle')
    expect(toggle?.textContent).toContain(label)
    expect(toggle?.getAttribute('aria-label')).toBe(label)
    expect(toggle?.getAttribute('title')).toBe(title)
    expect(toggle?.getAttribute('aria-pressed')).toBe('false')
    act(() => toggle!.click())
    expect(changeSlow).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('uses only authoritative enabled state for pressed styling and toggling off', () => {
    const changeSlow = vi.fn()
    renderComposer(vi.fn(), true, false, 'queue', undefined, undefined, undefined, undefined, {}, {
      slow: true, slowSupported: true, slowScope: 'global', onSlowChange: changeSlow,
    })
    const toggle = container.querySelector<HTMLButtonElement>('.slow-mode-toggle')!
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.classList.contains('is-active')).toBe(true)
    act(() => toggle.click())
    expect(changeSlow).toHaveBeenCalledExactlyOnceWith(false)
  })

  it.each([
    ['unsupported', { slow: false, slowSupported: false, slowScope: 'global' }],
    ['unknown support', { slow: false, slowScope: 'session' }],
    ['unknown enabled preference', { slowSupported: true, slowScope: 'global' }],
    ['unknown scope', { slow: false, slowSupported: true }],
  ] as const)('hides Slow when state is %s instead of inferring it from the model', (_label, slowOptions) => {
    const changeSlow = vi.fn()
    renderComposer(vi.fn(), true, false, 'queue', undefined, undefined, undefined, undefined, {}, {
      ...slowOptions, onSlowChange: changeSlow,
    })
    expect(container.querySelector('.slow-mode-toggle')).toBeNull()
    expect(changeSlow).not.toHaveBeenCalled()
  })

  it('hides Slow when its mutation callback is unavailable', () => {
    renderComposer(vi.fn(), true, false, 'queue', undefined, undefined, undefined, undefined, {}, {
      slow: false, slowSupported: true, slowScope: 'session',
    })
    expect(container.querySelector('.slow-mode-toggle')).toBeNull()
  })
})

function pngFile(name: string, read?: () => Promise<ArrayBuffer>): File {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const file = new File([bytes], name, { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', { value: read ?? (async () => bytes.buffer) })
  return file
}

function withTimeStamp<T extends Event>(event: T, timeStamp: number): T {
  Object.defineProperty(event, 'timeStamp', { configurable: true, value: timeStamp })
  return event
}

async function enterDraft(value: string, init: KeyboardEventInit = {}) {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }))
    await Promise.resolve()
  })
}

it('does not accept commands or close the command menu during IME composition', async () => {
  const send = renderComposer()
  const textarea = container.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => { setter.call(textarea, '/'); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(container.querySelector('[role="listbox"]')).not.toBeNull()
  act(() => textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  for (const key of ['ArrowDown', 'Enter', 'Escape']) act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
  expect(send).not.toHaveBeenCalled()
  expect(container.querySelector('[role="listbox"]')).not.toBeNull()
  expect(textarea.value).toBe('/')
  // Composition has ended; the shared IME guard still swallows the leaked
  // commit keys microseconds after compositionEnd, then normal Escape
  // handling resumes for deliberate presses.
  act(() => textarea.dispatchEvent(withTimeStamp(new CompositionEvent('compositionend', { bubbles: true }), 1000)))
  act(() => textarea.dispatchEvent(withTimeStamp(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }), 1005)))
  expect(container.querySelector('[role="listbox"]')).not.toBeNull()
  act(() => textarea.dispatchEvent(withTimeStamp(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }), 1200)))
  expect(container.querySelector('[role="listbox"]')).toBeNull()
})

function pastedPng(read?: () => Promise<ArrayBuffer>): File {
  return pngFile('pasted.png', read)
}

function sizedPng(name: string, size: number): File {
  const bytes = new Uint8Array(size)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const file = new File([bytes], name, { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
  return file
}

function dispatchPasteFiles(files: File[], text = ''): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      getData: (type: string) => type === 'text/plain' ? text : '',
    },
  })
  container.querySelector('textarea')?.dispatchEvent(event)
}

async function pasteFiles(files: File[], text = ''): Promise<void> {
  await act(async () => {
    dispatchPasteFiles(files, text)
    await Promise.resolve()
    await Promise.resolve()
  })
}

const paste = (file: File) => pasteFiles([file])

async function pickFiles(files: File[]): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await act(async () => {
    input?.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function dispatchDrag(type: string, target: Element, files: File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files, dropEffect: 'none' },
  })
  target.dispatchEvent(event)
  return event
}

async function dropFiles(files: File[]): Promise<void> {
  const composer = container.querySelector('.composer') as HTMLElement
  await act(async () => {
    dispatchDrag('dragenter', composer, files)
    dispatchDrag('dragover', composer, files)
    dispatchDrag('drop', composer, files)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Composer image ingestion', () => {
  it('previews and sends a pasted image through the prompt callback', async () => {
    const onSend = renderComposer(vi.fn(async () => undefined))
    await paste(pastedPng())

    expect(container.querySelector('.composer-attachment')?.textContent).toContain('pasted.png')
    await act(async () => {
      ;(container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(onSend).toHaveBeenCalledWith('[Attached image]', [{
      type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=',
    }], 'queue')
    expect(container.querySelector('.composer-attachment')).toBeNull()
  })

  it('shows an actionable rejection for a known text-only model', async () => {
    const onSend = renderComposer(vi.fn(), false)
    await paste(pastedPng())

    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('.composer-attachment')?.textContent).toContain('pasted.png')
    await act(async () => {
      ;(container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('does not accept images')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('waits for pending image reads and preserves mixed clipboard text', async () => {
    let resolveBuffer!: (value: ArrayBuffer) => void
    const file = pastedPng(() => new Promise<ArrayBuffer>((resolve) => { resolveBuffer = resolve }))
    const onSend = renderComposer(vi.fn(async () => undefined))
    await pasteFiles([file], 'clipboard note')

    await act(async () => { await Promise.resolve() })
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('clipboard note')
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true)
    expect(onSend).not.toHaveBeenCalled()

    await act(async () => {
      resolveBuffer(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false)
  })

  it('reports an older delayed read failure after a newer batch succeeds', async () => {
    let rejectOlder!: (reason: Error) => void
    const older = pngFile('older.png', () => new Promise<ArrayBuffer>((_resolve, reject) => { rejectOlder = reject }))
    renderComposer()

    await act(async () => {
      dispatchPasteFiles([older])
      dispatchPasteFiles([pngFile('newer.png')])
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('.composer-attachment')?.textContent).toContain('newer.png')
    expect(container.querySelector('[role="alert"]')).toBeNull()

    await act(async () => {
      rejectOlder(new Error('read failed'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not read the image')
    expect(container.querySelector('.composer-attachment')?.textContent).toContain('newer.png')
  })

  it('inserts mixed clipboard text at the caret instead of appending', async () => {
    renderComposer(vi.fn(async () => undefined))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(textarea, 'hello world')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    textarea.focus()
    textarea.setSelectionRange(5, 5)

    await pasteFiles([pastedPng()], ' pasted')

    expect(textarea.value).toBe('hello pasted world')
    expect(textarea.selectionStart).toBe('hello pasted'.length)
  })

  it('enforces the attachment count across concurrent paste completions', async () => {
    renderComposer()
    const files = Array.from({ length: 10 }, () => pastedPng())
    await act(async () => {
      dispatchPasteFiles(files.slice(0, 5))
      dispatchPasteFiles(files.slice(5))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelectorAll('.composer-attachment')).toHaveLength(5)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('up to 8 files')
  })

  it('restores the text and image draft when prompt admission fails', async () => {
    const onSend = renderComposer(vi.fn(async () => { throw new Error('rejected') }))
    await pasteFiles([pastedPng()], 'Keep this draft')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      ;(container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(onSend).toHaveBeenCalledOnce()
    expect(textarea.value).toBe('Keep this draft')
    expect(container.querySelector('.composer-attachment')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('restored')
  })

  it('merges submitted images with images attached while a failed send is pending', async () => {
    let rejectSend!: (reason: Error) => void
    const onSend = renderComposer(vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSend = reject })))
    await pickFiles([pngFile('submitted.png')])

    act(() => { (container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click() })
    expect(onSend).toHaveBeenCalledOnce()
    await pickFiles([pngFile('new-draft.png')])
    await act(async () => {
      rejectSend(new Error('rejected'))
      await Promise.resolve()
      await Promise.resolve()
    })

    const attachments = Array.from(container.querySelectorAll('.composer-attachment')).map((attachment) => attachment.textContent)
    expect(attachments).toHaveLength(2)
    expect(attachments.join(' ')).toContain('submitted.png')
    expect(attachments.join(' ')).toContain('new-draft.png')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('draft and images were restored')
  })

  it('reports submitted images omitted from failed-send restoration when new images fill the limit', async () => {
    let rejectSend!: (reason: Error) => void
    renderComposer(vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSend = reject })))
    await pickFiles([pngFile('submitted-1.png'), pngFile('submitted-2.png')])

    act(() => { (container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click() })
    await pickFiles(Array.from({ length: 7 }, (_, index) => pngFile(`new-${index + 1}.png`)))
    await act(async () => {
      rejectSend(new Error('rejected'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelectorAll('.composer-attachment')).toHaveLength(8)
    expect(container.textContent).toContain('submitted-1.png')
    expect(container.textContent).not.toContain('submitted-2.png')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('1 submitted image could not be restored because the attachment limits are full')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('8 files attached')
  })

  it('opens a general file picker from the add menu and attaches its selection', async () => {
    renderComposer()
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Choose files to attach"]')
    const click = vi.spyOn(input as HTMLInputElement, 'click')

    act(() => (container.querySelector('button[aria-label="Add context"]') as HTMLButtonElement).click())
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain('Add files')
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain('Commands')
    act(() => (Array.from(container.querySelectorAll<HTMLButtonElement>('.composer-menu button')).find((button) => button.textContent?.includes('Add files')) as HTMLButtonElement).click())
    expect(click).toHaveBeenCalledOnce()
    expect(input?.multiple).toBe(true)
    expect(input?.accept).toBe('')
    expect(container.querySelector('.composer-menu')).toBeNull()
    expect(container.querySelector('button[aria-label="Attach images"]')).toBeNull()

    await pickFiles([pastedPng()])
    expect(container.querySelector('.composer-attachment')?.textContent).toContain('pasted.png')
  })

  it('opens native skill commands from the add menu', () => {
    renderComposer(vi.fn(), true, false, 'queue', undefined, undefined, undefined, [{ name: 'skill:officecli', source: 'skill', description: 'Office documents' }])

    act(() => (container.querySelector('button[aria-label="Add context"]') as HTMLButtonElement).click())
    const skills = Array.from(container.querySelectorAll<HTMLButtonElement>('.composer-menu button')).find((button) => button.textContent?.includes('Skills'))
    expect(skills).toBeDefined()
    act(() => skills?.click())

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('/skill:')
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain('/skill:officecli')
  })

  it('closes the add menu from its trigger or an outside click', () => {
    renderComposer()
    const trigger = container.querySelector('button[aria-label="Add context"]') as HTMLButtonElement

    act(() => trigger.click())
    expect(container.querySelector('.composer-menu')).not.toBeNull()
    act(() => trigger.click())
    expect(container.querySelector('.composer-menu')).toBeNull()
    act(() => trigger.click())
    expect(container.querySelector('.composer-menu')).not.toBeNull()
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(container.querySelector('.composer-menu')).toBeNull()
  })

  it('attaches dropped images and keeps nested drag feedback stable', async () => {
    renderComposer()
    const composer = container.querySelector('.composer') as HTMLElement
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    act(() => {
      dispatchDrag('dragenter', composer, [pastedPng()])
      dispatchDrag('dragenter', textarea, [pastedPng()])
      dispatchDrag('dragleave', textarea, [pastedPng()])
    })
    expect(container.querySelector('.composer-drop-feedback')?.textContent).toContain('Drop files')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Drop files')

    await act(async () => {
      dispatchDrag('drop', composer, [pastedPng()])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('.composer-drop-feedback')).toBeNull()
    expect(container.querySelector('.composer-attachment')?.textContent).toContain('pasted.png')
  })

  it('stages mixed file types and rejects unsupported files when sending', async () => {
    const onSend = renderComposer()
    const unsupported = new File(['plain text'], 'notes.txt', { type: 'text/plain' })

    await pasteFiles([pastedPng(), unsupported], 'keep this text')

    expect(container.querySelectorAll('.composer-attachment')).toHaveLength(2)
    expect(container.textContent).toContain('notes.txt')
    await act(async () => {
      ;(container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('notes.txt cannot be sent')
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('keep this text')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shares the count limit across picker, paste, and drop and no longer caps image bytes', async () => {
    renderComposer()
    await pickFiles(Array.from({ length: 4 }, () => pastedPng()))
    await dropFiles(Array.from({ length: 5 }, () => pastedPng()))
    expect(container.querySelectorAll('.composer-attachment')).toHaveLength(4)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('up to 8 files')

    const removeButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.composer-attachment > button'))
    act(() => removeButtons.forEach((button) => { button.click() }))
    const largeImage = () => sizedPng('large.png', 700_000)
    await paste(largeImage())
    await pickFiles([largeImage()])
    expect(container.querySelectorAll('.composer-attachment')).toHaveLength(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps files removable when the current model cannot send them', async () => {
    renderComposer(vi.fn(), false)
    await pickFiles([pastedPng()])
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('.composer-attachment')?.textContent).toContain('pasted.png')
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Remove pasted.png"]')?.click())
    expect(container.querySelector('.composer-attachment')).toBeNull()
  })

  it('removes a chosen image and exposes accessible picker and attachment status labels', async () => {
    renderComposer()
    await pickFiles([pastedPng()])
    expect(container.querySelector('[role="status"]')?.textContent).toContain('1 file attached')

    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove pasted.png"]')
    expect(remove).not.toBeNull()
    act(() => remove?.click())
    expect(container.querySelector('.composer-attachment')).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toBe('')
    expect(container.querySelector('button[aria-label="Add context"]')?.getAttribute('title')).toBe('Add context')
  })

})


describe('Composer message delivery shortcuts', () => {
  it('queues with Enter and steers with Ctrl+Enter while OMP is working', async () => {
    const onSend = renderComposer(vi.fn(async () => undefined), true, true)
    await enterDraft('Queue this')
    await enterDraft('Steer with this', { ctrlKey: true })

    expect(onSend).toHaveBeenNthCalledWith(1, 'Queue this', [], 'queue')
    expect(onSend).toHaveBeenNthCalledWith(2, 'Steer with this', [], 'steer')
  })

  it('allows Ctrl+Enter steering while an earlier delivery callback is still pending', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { release = resolve })
    const onSend = renderComposer(vi.fn(() => pending), true, true)

    await enterDraft('Queue this')
    await enterDraft('Steer immediately', { ctrlKey: true })

    expect(onSend).toHaveBeenNthCalledWith(1, 'Queue this', [], 'queue')
    expect(onSend).toHaveBeenNthCalledWith(2, 'Steer immediately', [], 'steer')
    await act(async () => { release?.(); await pending })
  })

  it('uses the shared persisted Enter action regardless of the active harness', async () => {
    const onSend = renderComposer(vi.fn(async () => undefined), true, true, 'steer')
    await enterDraft('Steer this')
    await enterDraft('Queue this', { ctrlKey: true })
    await enterDraft('Keep editing', { shiftKey: true })

    expect(onSend).toHaveBeenNthCalledWith(1, 'Steer this', [], 'steer')
    expect(onSend).toHaveBeenNthCalledWith(2, 'Queue this', [], 'queue')
    expect(onSend).toHaveBeenCalledTimes(2)
  })
})

describe('Composer native continue and tree shortcuts', () => {
  it('uses queue delivery for busy empty Enter instead of stop or a prompt', async () => {
    const onContinue = vi.fn(async () => true)
    const onStop = vi.fn()
    const onSend = renderComposer(vi.fn(), true, true, 'queue', undefined, undefined, undefined, undefined, { onContinue, onStop })

    await act(async () => {
      container.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })

    expect(onContinue).toHaveBeenCalledExactlyOnceWith(true)
    expect(onStop).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('routes dot and c through idle resume and busy queue delivery without prompt text', async () => {
    const onContinue = vi.fn(async () => true)
    const onSend = renderComposer(vi.fn(), true, false, 'queue', undefined, undefined, undefined, undefined, { onContinue })
    await enterDraft('.')
    expect(onContinue).toHaveBeenLastCalledWith(false)

    renderComposer(onSend, true, true, 'queue', undefined, undefined, undefined, undefined, { onContinue })
    await enterDraft('c')
    expect(onContinue).toHaveBeenLastCalledWith(true)
    expect(onContinue).toHaveBeenCalledTimes(2)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps Ctrl+Enter as a literal follow-up rather than a continue command', async () => {
    const onContinue = vi.fn(async () => true)
    const onSend = renderComposer(vi.fn(async () => undefined), true, true, 'queue', undefined, undefined, undefined, undefined, { onContinue })

    await enterDraft('.', { ctrlKey: true })

    expect(onSend).toHaveBeenCalledExactlyOnceWith('.', [], 'steer')
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('restores the shorthand draft when the runtime does not accept continue', async () => {
    const onContinue = vi.fn(async () => false)
    const onSend = renderComposer(vi.fn(), true, false, 'queue', undefined, undefined, undefined, undefined, { onContinue })

    await enterDraft('.')

    expect(onContinue).toHaveBeenCalledExactlyOnceWith(false)
    expect(container.querySelector('textarea')).toHaveProperty('value', '.')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps busy Escape on stop and never routes it through continue or the tree', () => {
    const onContinue = vi.fn(async () => true)
    const onStop = vi.fn()
    const onOpenSessionTree = vi.fn()
    renderComposer(vi.fn(), true, true, 'queue', undefined, undefined, undefined, undefined, { onContinue, onStop, onOpenSessionTree })
    const textarea = container.querySelector('textarea')!

    act(() => textarea.dispatchEvent(withTimeStamp(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }), 1000)))
    act(() => textarea.dispatchEvent(withTimeStamp(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }), 1100)))

    expect(onStop).toHaveBeenCalledTimes(2)
    expect(onContinue).not.toHaveBeenCalled()
    expect(onOpenSessionTree).not.toHaveBeenCalled()
  })

  it('opens the existing tree for consecutive idle empty Escape presses within and at 500ms only', () => {
    const onStop = vi.fn()
    const onOpenSessionTree = vi.fn()
    renderComposer(vi.fn(), true, false, 'queue', undefined, undefined, undefined, undefined, { onStop, onOpenSessionTree })
    const textarea = container.querySelector('textarea')!
    const escapeAt = (timeStamp: number) => {
      act(() => textarea.dispatchEvent(withTimeStamp(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }), timeStamp)))
    }

    escapeAt(1000)
    expect(onOpenSessionTree).not.toHaveBeenCalled()
    escapeAt(1499)
    expect(onOpenSessionTree).toHaveBeenCalledTimes(1)
    escapeAt(2000)
    escapeAt(2500)
    expect(onOpenSessionTree).toHaveBeenCalledTimes(2)
    escapeAt(3000)
    escapeAt(3501)
    expect(onOpenSessionTree).toHaveBeenCalledTimes(2)
    expect(onStop).not.toHaveBeenCalled()
  })

  it('does not open the tree for modified escapes or a nonempty draft', () => {
    const onOpenSessionTree = vi.fn()
    const onSend = renderComposer(vi.fn(), true, false, 'queue', undefined, undefined, undefined, undefined, { onOpenSessionTree })
    const textarea = container.querySelector('textarea')!
    const escapeAt = (timeStamp: number, altKey = false) => {
      act(() => textarea.dispatchEvent(withTimeStamp(new KeyboardEvent('keydown', { key: 'Escape', altKey, bubbles: true, cancelable: true }), timeStamp)))
    }

    escapeAt(1000, true)
    escapeAt(1100)
    expect(onOpenSessionTree).not.toHaveBeenCalled()
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'keep editing')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    escapeAt(1200)
    escapeAt(1300)
    expect(onOpenSessionTree).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  })
})


describe('Composer submission lifecycle', () => {
  const setDraft = async (value: string) => {
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, value)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    return textarea
  }
  const pressEnter = async (textarea: HTMLTextAreaElement) => {
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  }

  it('keeps the textarea editable while a submission is starting', () => {
    act(() => root.render(<Composer
      busy={false} submitting model="provider/vision" effort="medium" modelsByProvider={modelsByProvider} providers={providers}
      reasoningLevels={['medium']} fast={false} fastSupported={false} fastAvailable imageInputSupported
      messageEnterAction="queue" skills={[]}
      onModelChange={vi.fn()} onEffortChange={vi.fn()} onFastChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()}
    />))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true)
  })

  it('guards double submission in the handler and refocuses after send resolves', async () => {
    let resolveSend!: () => void
    const onSend = vi.fn(() => new Promise<void>((resolve) => { resolveSend = resolve }))
    renderComposer(onSend)
    const textarea = await setDraft('First message')
    await pressEnter(textarea)
    // Typing and pressing Enter again while the first send is in flight must
    // not double-submit, because the textarea stays enabled.
    await setDraft('Second attempt')
    await pressEnter(textarea)
    expect(onSend).toHaveBeenCalledTimes(1)

    await act(async () => { resolveSend(); await Promise.resolve() })
    expect(document.activeElement).toBe(container.querySelector('textarea'))
  })
})

describe('Composer context usage and stop control', () => {
  it('shows the exact context usage in a filled dial before the send button', () => {
    renderComposer(vi.fn(), true, false, 'queue', { tokens: 50_000, contextWindow: 100_000, percent: 50 })

    const dial = container.querySelector<HTMLButtonElement>('.context-usage-dial')
    const actions = container.querySelector('.composer__actions')
    expect(dial?.textContent).toBe('50')
    expect(dial?.title).toBe('50,000 / 100,000 tokens')
    expect(dial?.getAttribute('aria-haspopup')).toBe('dialog')
    expect(dial?.style.getPropertyValue('--context-percent')).toBe('50%')
    expect(actions?.firstElementChild?.firstElementChild).toBe(dial)
    expect(dial?.parentElement?.nextElementSibling?.getAttribute('aria-label')).toBe('Start dictation')
    expect(dial?.parentElement?.nextElementSibling?.nextElementSibling?.getAttribute('aria-label')).toBe('Send message')
  })

  it('opens a usage popover from the dial and compacts from it', () => {
    const onSend = vi.fn()
    renderComposer(onSend, true, false, 'queue', { tokens: 50_000, contextWindow: 100_000, percent: 50 })
    const dial = container.querySelector<HTMLButtonElement>('.context-usage-dial')
    act(() => {
      dial?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const popover = container.querySelector('.context-popover')
    expect(popover?.textContent).toContain('50,000 / 100,000')
    expect(popover?.textContent).toContain('Compact context')

    const compact = container.querySelector<HTMLButtonElement>('.context-popover__compact')
    act(() => {
      compact?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSend).toHaveBeenCalledWith('/compact', [], 'queue')
    expect(container.querySelector('.context-popover')).toBeNull()
  })

  it('shows the harness-reported output rate in the usage popover', () => {
    renderComposer(vi.fn(), true, false, 'queue', { tokens: 50_000, contextWindow: 100_000, percent: 50 }, undefined, 212.64)
    const dial = container.querySelector<HTMLButtonElement>('.context-usage-dial')
    act(() => {
      dial?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const popover = container.querySelector('.context-popover')
    expect(popover?.textContent).toContain('Output speed')
    expect(popover?.textContent).toContain('212.6 tok/s')
  })

  it('shows unavailable usage honestly and uses a square stop icon', () => {
    renderComposer(vi.fn(), true, true, 'queue', { tokens: null, contextWindow: 100_000, percent: null })

    const dial = container.querySelector<HTMLElement>('.context-usage-dial')
    expect(dial?.textContent).toBe('—')
    expect(dial?.hasAttribute('aria-valuenow')).toBe(false)
    expect(dial?.title).toContain('unavailable')
    expect(container.querySelector('button[aria-label="Stop OMP"] .lucide-square')).not.toBeNull()
    expect(container.querySelector('.lucide-circle-stop')).toBeNull()
  })
})

describe('Composer fallback indicator', () => {
  it('shows the executing fallback without changing the selected model', () => {
    renderComposer(vi.fn(), true, false, 'queue', undefined, {
      provider: 'anthropic',
      id: 'claude-sonnet',
      label: 'anthropic/claude-sonnet',
      isFallback: true,
    })

    expect(container.querySelector<HTMLButtonElement>('.model-picker__trigger')?.getAttribute('aria-label')).toBe('Model: Vision')
    expect(container.querySelector('.model-fallback-chip')?.textContent).toContain('Running on anthropic/claude-sonnet')
    expect(container.querySelector('.model-fallback-chip')?.getAttribute('title')).toContain('Provider fallback')
  })
})

describe('Composer skill slash commands', () => {
  it('merges enabled user/project skills into / autocomplete and completes /skill:<name>', () => {
    const skills: SkillRecord[] = [
      { id: 's1', name: 'grilling', description: 'Grill the plan', kind: 'skill', location: 'user', enabled: true },
      { id: 's2', name: 'project helper', description: 'Project workflow', kind: 'skill', location: 'project', enabled: true },
      { id: 's3', name: 'disabled-skill', description: 'Hidden', kind: 'skill', location: 'user', enabled: false },
      { id: 's4', name: 'bundled-skill', description: 'Bundled', kind: 'skill', location: 'bundled', enabled: true },
      { id: 'e1', name: 'ext-tool', description: 'Extension', kind: 'extension', location: 'user', enabled: true },
    ]
    act(() =>
      root.render(
        <Composer
          busy={false}
          model="provider/vision"
          effort="medium"
          modelsByProvider={modelsByProvider}
          providers={providers}
          reasoningLevels={['medium']}
          fast={false}
          fastSupported={false}
          fastAvailable
          imageInputSupported
          messageEnterAction="queue"
          skills={skills}
          onModelChange={vi.fn()}
          onEffortChange={vi.fn()}
          onFastChange={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />,
      ),
    )

    const textarea = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(textarea, '/grill')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const options = [...container.querySelectorAll('[role="listbox"] [role="option"]')]
    expect(options.map((option) => option.textContent)).toEqual([expect.stringContaining('/skill:grilling')])
    expect(container.querySelector('[role="listbox"] .lucide-wand-sparkles')).not.toBeNull()

    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(textarea.value).toBe('/skill:grilling ')

    act(() => {
      setter.call(textarea, '/skill:')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const allSkills = [...container.querySelectorAll('[role="listbox"] [role="option"]')].map((option) => option.textContent)
    expect(allSkills.some((text) => text?.includes('/skill:grilling'))).toBe(true)
    expect(allSkills.some((text) => text?.includes('/skill:project-helper'))).toBe(true)
    expect(allSkills.some((text) => text?.includes('disabled-skill'))).toBe(false)
    expect(allSkills.some((text) => text?.includes('bundled-skill'))).toBe(false)
    expect(allSkills.some((text) => text?.includes('ext-tool'))).toBe(false)
  })
})

describe('Composer memoization', () => {
  const stableProps = {
    busy: false,
    model: 'provider/vision',
    effort: 'medium' as const,
    modelsByProvider,
    providers,
    reasoningLevels: ['medium' as const],
    fast: false,
    fastSupported: false,
    fastAvailable: true,
    imageInputSupported: true,
    messageEnterAction: 'queue' as const,
    skills: [],
    onModelChange: vi.fn(),
    onEffortChange: vi.fn(),
    onFastChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
  }

  it('does not re-render when a streaming parent re-renders with identical props', () => {
    // Composer's render body scans `skills` for enabled entries, so counting
    // those scans counts Composer renders.
    let renderProbes = 0
    const probedSkills = new Proxy([] as SkillRecord[], {
      get(target, key, receiver) {
        if (key === 'filter') renderProbes += 1
        return Reflect.get(target, key, receiver)
      },
    })
    let forceParentRender: () => void = () => undefined
    function Parent() {
      const [, setTick] = useState(0)
      forceParentRender = () => setTick((value) => value + 1)
      return <Composer {...stableProps} skills={probedSkills} />
    }

    act(() => root.render(<Parent />))
    const initialRenders = renderProbes
    expect(initialRenders).toBeGreaterThan(0)

    act(() => forceParentRender())
    act(() => forceParentRender())
    // memo(Composer) bails out for identical props: no further renders.
    expect(renderProbes).toBe(initialRenders)

    expect(container.querySelector('.model-picker__trigger')?.textContent).toContain('Vision')
  })
})
