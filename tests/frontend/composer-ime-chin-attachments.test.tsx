// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'
import { SideChatPanel } from '../../src/components/SideChatPanel'
import { groupModelsByProvider } from '../../src/hooks/useProviderCatalog'
import type { SideQuestionSessionState } from '../../src/hooks/useSideQuestions'
import { IME_POST_COMPOSITION_GUARD_MS, isImeComposingOrGuarded, splitAttachmentFileName } from '../../src/lib/message-shortcuts'
import type { PrimeModelDescriptor, PrimeProviderDescriptor } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const models: PrimeModelDescriptor[] = [
  {
    key: 'provider/vision',
    provider: 'provider',
    id: 'vision',
    name: 'Vision',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 100_000,
    maxTokens: 8_000,
    availableThinkingLevels: ['medium'],
    fastModeSupported: false,
    available: true,
  },
]

const providers: PrimeProviderDescriptor[] = [
  {
    id: 'provider',
    name: 'Provider',
    authMethod: 'api_key',
    configured: true,
    modelCount: 1,
    availableModelCount: 1,
    enabled: true,
  },
]

const modelsByProvider = groupModelsByProvider(models)

function pngFile(name: string): File {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const file = new File([bytes], name, { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
  return file
}

function textFile(name: string): File {
  return new File(['hello'], name, { type: 'text/plain' })
}

function withTimeStamp<T extends Event>(event: T, timeStamp: number): T {
  Object.defineProperty(event, 'timeStamp', { configurable: true, value: timeStamp })
  return event
}

describe('isImeComposingOrGuarded', () => {
  it('guards active composition states and keyCode 229', () => {
    expect(isImeComposingOrGuarded({ key: 'Enter' }, true, null)).toBe(true)
    expect(isImeComposingOrGuarded({ key: 'Enter', isComposing: true }, false, null)).toBe(true)
    expect(isImeComposingOrGuarded({ key: 'Enter', keyCode: 229 }, false, null)).toBe(true)
    expect(isImeComposingOrGuarded({ key: 'Enter', isComposing: false, keyCode: 13 }, false, null)).toBe(false)
  })

  it('guards Enter and Escape within 500ms after compositionEnd and allows after 500ms', () => {
    expect(IME_POST_COMPOSITION_GUARD_MS).toBe(500)
    expect(isImeComposingOrGuarded({ key: 'Enter', timeStamp: 1000 }, false, 1000)).toBe(true)
    expect(isImeComposingOrGuarded({ key: 'Enter', timeStamp: 1499 }, false, 1000)).toBe(true)
    expect(isImeComposingOrGuarded({ key: 'Escape', timeStamp: 1250 }, false, 1000)).toBe(true)
    expect(isImeComposingOrGuarded({ key: 'Enter', timeStamp: 1500 }, false, 1000)).toBe(false)
    expect(isImeComposingOrGuarded({ key: 'Escape', timeStamp: 1650 }, false, 1000)).toBe(false)
    expect(isImeComposingOrGuarded({ key: 'a', timeStamp: 1100 }, false, 1000)).toBe(false)
  })
})

describe('splitAttachmentFileName', () => {
  it('returns short file names untouched while separating stem and extension', () => {
    expect(splitAttachmentFileName('pasted.png')).toEqual({
      display: 'pasted.png',
      stem: 'pasted',
      ext: '.png',
      truncated: false,
    })
    expect(splitAttachmentFileName('README')).toEqual({
      display: 'README',
      stem: 'README',
      ext: '',
      truncated: false,
    })
  })

  it('middle-truncates long file names while preserving stem + ext and locking extensions', () => {
    const png = splitAttachmentFileName('screenshot-2026-10-21-long-name-2.png')
    expect(png.truncated).toBe(true)
    expect(png.stem).toBe('screenshot-2026-10-21-long-name-2')
    expect(png.ext).toBe('.png')
    expect(`${png.stem}${png.ext}`).toBe('screenshot-2026-10-21-long-name-2.png')
    expect(png.display).toContain('…')
    expect(png.display.endsWith('-2.png')).toBe(true)

    const tarGz = splitAttachmentFileName('archive-backup-2026-10-21-full.tar.gz')
    expect(tarGz.truncated).toBe(true)
    expect(tarGz.stem).toBe('archive-backup-2026-10-21-full')
    expect(tarGz.ext).toBe('.tar.gz')
    expect(tarGz.display).toContain('…')
    expect(tarGz.display.endsWith('.tar.gz')).toBe(true)
  })
})

describe('Composer and SideChatPanel IME guard & attachment rendering', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    let id = 0
    vi.stubGlobal('crypto', {
      randomUUID: () => {
        id += 1
        return `attachment-${id}`
      },
    })
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

  it('blocks post-composition Enter and Escape within 500ms in Composer and sends after 500ms', () => {
    const onSend = vi.fn(async () => undefined)
    act(() => {
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
          fastAvailable={false}
          imageInputSupported
          skills={[]}
          onModelChange={vi.fn()}
          onEffortChange={vi.fn()}
          onFastChange={vi.fn()}
          onSend={onSend}
          onStop={vi.fn()}
        />,
      )
    })

    const textarea = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(textarea, '你好世界')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    act(() => {
      textarea.dispatchEvent(withTimeStamp(new CompositionEvent('compositionstart', { bubbles: true }), 1000))
      textarea.dispatchEvent(withTimeStamp(new CompositionEvent('compositionend', { bubbles: true }), 1200))
    })

    // Enter at +150ms (< 500ms) after compositionend must be ignored
    act(() => {
      vi.advanceTimersByTime(150)
      textarea.dispatchEvent(withTimeStamp(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }), 1350))
    })
    expect(onSend).not.toHaveBeenCalled()

    // Enter at +500ms (>= 500ms) after compositionend submits normally
    act(() => {
      vi.advanceTimersByTime(350)
      textarea.dispatchEvent(withTimeStamp(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }), 1700))
    })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith('你好世界', [], 'queue')
  })

  it('blocks post-composition Enter and keyCode 229 in SideChatPanel within 500ms and sends after 500ms', () => {
    const onAsk = vi.fn()
    const state: SideQuestionSessionState = {
      supported: true,
      sending: false,
      activeTopicId: null,
      topics: [],
      live: {},
    }

    act(() => {
      root.render(
        <SideChatPanel
          state={state}
          hasSession
          onAsk={onAsk}
          onCancel={vi.fn()}
          onSelectTopic={vi.fn()}
          onClose={vi.fn()}
        />,
      )
    })

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea.side-chat__input')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(textarea, '請問這段程式碼的作用？')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // keyCode 229 must be ignored even if isComposing is false
    act(() => {
      const imeKeyEvent = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })
      textarea.dispatchEvent(withTimeStamp(imeKeyEvent, 2000))
    })
    expect(onAsk).not.toHaveBeenCalled()

    // Post-composition Enter within 500ms must be ignored
    act(() => {
      textarea.dispatchEvent(withTimeStamp(new CompositionEvent('compositionstart', { bubbles: true }), 2100))
      textarea.dispatchEvent(withTimeStamp(new CompositionEvent('compositionend', { bubbles: true }), 2200))
      vi.advanceTimersByTime(200)
      textarea.dispatchEvent(withTimeStamp(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }), 2400))
    })
    expect(onAsk).not.toHaveBeenCalled()

    // Enter after 500ms submits the side question
    act(() => {
      vi.advanceTimersByTime(350)
      textarea.dispatchEvent(withTimeStamp(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }), 2750))
    })
    expect(onAsk).toHaveBeenCalledTimes(1)
    expect(onAsk).toHaveBeenCalledWith('請問這段程式碼的作用？', undefined)
  })

  it('renders attachment stem and locked extension spans while preserving full textContent and aria-label', async () => {
    act(() => {
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
          fastAvailable={false}
          imageInputSupported
          skills={[]}
          onModelChange={vi.fn()}
          onEffortChange={vi.fn()}
          onFastChange={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />,
      )
    })

    const longImageName = 'screenshot-2026-10-21-long-name-2.png'
    const longFileName = 'archive-backup-2026-10-21-full.tar.gz'
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [pngFile(longImageName), textFile(longFileName)],
    })

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const attachments = container.querySelectorAll<HTMLElement>('.composer-attachment')
    expect(attachments).toHaveLength(2)

    expect(attachments[0].getAttribute('title')).toBe(longImageName)
    expect(attachments[0].querySelector('.composer-attachment__stem')?.textContent).toBe('screenshot-2026-10-21-long-name-2')
    expect(attachments[0].querySelector('.composer-attachment__ext')?.textContent).toBe('.png')
    expect(attachments[0].querySelector('.composer-attachment__name')?.textContent).toBe(longImageName)
    expect(attachments[0].querySelector(`button[aria-label="Remove ${longImageName}"]`)).not.toBeNull()

    expect(attachments[1].getAttribute('title')).toBe(longFileName)
    expect(attachments[1].querySelector('.composer-attachment__stem')?.textContent).toBe('archive-backup-2026-10-21-full')
    expect(attachments[1].querySelector('.composer-attachment__ext')?.textContent).toBe('.tar.gz')
    expect(attachments[1].querySelector('.composer-attachment__name')?.textContent).toBe(longFileName)
    expect(attachments[1].querySelector(`button[aria-label="Remove ${longFileName}"]`)).not.toBeNull()
  })
})
