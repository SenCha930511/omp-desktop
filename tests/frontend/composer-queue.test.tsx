// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('composer queue tray', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows queued messages with acknowledged send and independent editing', async () => {
    const onSend = vi.fn()
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    const queued = { id: 'queue-1', text: 'run tests', intent: 'queue' as const }
    act(() => root.render(<Composer
      busy
      submitting={false}
      loading={false}
      disabled={false}
      model="auto"
      effort="medium"
      modelsByProvider={new Map()}
      providers={[]}
      reasoningLevels={['medium']}
      fast={false}
      fastSupported={false}
      fastAvailable={false}
      imageInputSupported={true}
      messageEnterAction="queue"
      skills={[]}
      queuedMessages={[queued]}
      onDeleteQueuedMessage={onDelete}
      onEditQueuedMessage={onEdit}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onFastChange={vi.fn()}
      onSend={onSend}
      onStop={vi.fn()}
    />))

    const tray = container.querySelector('.composer-queue')
    expect(tray?.querySelectorAll('.composer-queue__item')).toHaveLength(1)
    expect(tray?.textContent).toContain('run tests')
    expect(tray?.nextElementSibling?.classList.contains('composer')).toBe(true)
    const actions = [...(tray?.querySelectorAll<HTMLButtonElement>('.composer-queue__action') ?? [])]
    expect(actions.map((action) => action.title)).toEqual([
      'Send queued message immediately',
      'Edit queued message',
      'Delete queued message',
    ])

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label^="Send queued message immediately"]')?.click())
    expect(onDelete).toHaveBeenCalledWith(queued)
    expect(onSend).toHaveBeenCalledWith('run tests', [], 'steer')

    onDelete.mockClear()
    onSend.mockRejectedValueOnce(new Error('offline'))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label^="Send queued message immediately"]')?.click())
    expect(onDelete).not.toHaveBeenCalled()

    const composerTextarea = container.querySelector<HTMLTextAreaElement>('.composer textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(composerTextarea, 'keep this draft')
      composerTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Edit queued message"]')?.click())
    expect(onEdit).not.toHaveBeenCalled()
    expect(composerTextarea.value).toBe('keep this draft')
    expect(container.querySelector<HTMLTextAreaElement>('.composer-queue textarea')?.value).toBe('run tests')
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Save"]')?.click())
    expect(onEdit).toHaveBeenCalledWith(queued)
    expect(composerTextarea.value).toBe('keep this draft')

    act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Delete queued message"]')?.click())
    expect(onDelete).toHaveBeenCalledWith(queued)
  })

  it('delegates queue admission to the owner and ignores repeated clicks while pending', async () => {
    let resolveDelivery!: () => void
    const onSendQueuedMessage = vi.fn(() => new Promise<void>((resolve) => { resolveDelivery = resolve }))
    const onSend = vi.fn()
    const onDelete = vi.fn()
    const queued = { id: 'reserved', text: 'one delivery', intent: 'queue' as const }
    act(() => root.render(<Composer
      busy model="auto" effort="medium" modelsByProvider={new Map()} providers={[]} reasoningLevels={['medium']}
      fast={false} fastSupported={false} fastAvailable={false} imageInputSupported skills={[]}
      queuedMessages={[queued]} onSendQueuedMessage={onSendQueuedMessage} onDeleteQueuedMessage={onDelete}
      onModelChange={vi.fn()} onEffortChange={vi.fn()} onFastChange={vi.fn()} onSend={onSend} onStop={vi.fn()}
    />))
    const send = container.querySelector<HTMLButtonElement>('[aria-label^="Send queued message immediately"]')!
    act(() => { send.click(); send.click() })
    expect(onSendQueuedMessage).toHaveBeenCalledExactlyOnceWith(queued)
    expect(onSend).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
    await act(async () => resolveDelivery())
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('shows messages held by a count-only harness queue', () => {
    act(() => root.render(<Composer
      busy
      submitting={false}
      loading={false}
      disabled={false}
      model="auto"
      effort="medium"
      modelsByProvider={new Map()}
      providers={[]}
      reasoningLevels={['medium']}
      fast={false}
      fastSupported={false}
      fastAvailable={false}
      agentName="OMP"
      imageInputSupported={true}
      skills={[]}
      harnessQueuedMessageCount={2}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onFastChange={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
    />))

    const tray = container.querySelector('.composer-queue')
    expect(tray?.querySelector('.composer-queue__header strong')?.textContent).toBe('2')
    expect(tray?.textContent).toContain('OMP is holding 2 messages for the next turn.')
  })

  it('lists each message the harness holds when previews are available', () => {
    act(() => root.render(<Composer
      busy
      submitting={false}
      loading={false}
      disabled={false}
      model="auto"
      effort="medium"
      modelsByProvider={new Map()}
      providers={[]}
      reasoningLevels={['medium']}
      fast={false}
      fastSupported={false}
      fastAvailable={false}
      agentName="OMP"
      imageInputSupported={true}
      skills={[]}
      harnessQueuedMessageCount={3}
      harnessQueuedPreviews={['tighten the login flow', 'add a regression test']}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onFastChange={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
    />))

    const tray = container.querySelector('.composer-queue')
    const held = [...(tray?.querySelectorAll('.composer-queue__item--harness') ?? [])]
    expect(held).toHaveLength(3)
    expect(held[0]?.textContent).toContain('tighten the login flow')
    expect(held[1]?.textContent).toContain('add a regression test')
    // Previews beyond the known count stay hidden; a shortfall keeps the
    // count-only line for the rest.
    expect(held[2]?.textContent).toContain('OMP is holding 1 message for the next turn.')
  })

  it('replaces the stop button with the queue-send while a draft exists', () => {
    const onSend = vi.fn()
    const onStop = vi.fn()
    act(() => root.render(<Composer
      busy
      submitting={false}
      loading={false}
      disabled={false}
      model="auto"
      effort="medium"
      modelsByProvider={new Map()}
      providers={[]}
      reasoningLevels={['medium']}
      fast={false}
      fastSupported={false}
      fastAvailable={false}
      imageInputSupported={true}
      messageEnterAction="queue"
      skills={[]}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onFastChange={vi.fn()}
      onSend={onSend}
      onStop={onStop}
    />))

    const steerButton = () => container.querySelector<HTMLButtonElement>('.composer__actions .send-button:not(.send-button--stop)')
    const stopButton = () => container.querySelector<HTMLButtonElement>('.composer__actions .send-button--stop')
    // Empty draft while busy: only the stop control.
    expect(stopButton()).not.toBeNull()
    expect(steerButton()).toBeNull()

    // Typing swaps in the idle-styled queue-send in its place.
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(textarea, 'follow-up')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(stopButton()).toBeNull()
    expect(steerButton()).not.toBeNull()
    act(() => steerButton()!.click())
    expect(onSend).toHaveBeenCalledWith('follow-up', [], 'queue')
    expect(onStop).not.toHaveBeenCalled()

    // The draft cleared on submit: the stop control returns.
    expect(stopButton()).not.toBeNull()
    expect(steerButton()).toBeNull()
  })

})
