// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'
import { useDictation } from '../../src/hooks/useDictation'

vi.mock('../../src/hooks/useDictation', () => ({ useDictation: vi.fn() }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const start = vi.fn()
const finish = vi.fn()
const cancel = vi.fn()
const voice = {} as never

function composerProps(overrides: Record<string, unknown> = {}) {
  return {
    busy: false,
    model: 'auto',
    effort: 'medium' as const,
    modelsByProvider: new Map(),
    providers: [],
    reasoningLevels: ['medium' as const],
    fast: false,
    fastSupported: false,
    fastAvailable: false,
    imageInputSupported: true,
    skills: [],
    voice,
    transcriptionProvider: 'openai-live' as const,
    onModelChange: vi.fn(),
    onEffortChange: vi.fn(),
    onFastChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  }
}

describe('composer dictation controls', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    start.mockReset(); finish.mockReset(); cancel.mockReset()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('places an idle microphone between context usage and Send', () => {
    vi.mocked(useDictation).mockReturnValue({ state: 'idle', start, finish, cancel })
    act(() => root.render(<Composer {...composerProps()} />))
    const actions = container.querySelector('.composer__actions')!
    expect([...actions.querySelectorAll(':scope > .composer-context > button, :scope > button')].map((element) => element.getAttribute('aria-label'))).toEqual(['Context usage', 'Start dictation', 'Send message'])
  })

  it('turns context into cancel and the microphone into stop while recording', () => {
    vi.mocked(useDictation).mockReturnValue({ state: 'recording', start, finish, cancel })
    act(() => root.render(<Composer {...composerProps()} />))
    const cancelButton = container.querySelector<HTMLButtonElement>('[aria-label="Cancel dictation"]')!
    expect(container.querySelector('[aria-label="Stop and transcribe dictation"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Transcribe and send message"]')).not.toBeNull()
    act(() => cancelButton.click())
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('transcribes, inserts, and sends when Send is clicked during recording', async () => {
    finish.mockResolvedValue('ship the voice feature')
    const onSend = vi.fn().mockResolvedValue(undefined)
    vi.mocked(useDictation).mockReturnValue({ state: 'recording', start, finish, cancel })
    act(() => root.render(<Composer {...composerProps({ onSend })} />))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Transcribe and send message"]')?.click())
    expect(finish).toHaveBeenCalledOnce()
    expect(onSend).toHaveBeenCalledWith('ship the voice feature', [], 'queue')
  })
})
