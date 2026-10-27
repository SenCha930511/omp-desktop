// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'
import type { MessagePart } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type PromoteOutcome = { promoted: boolean } | null

type RemoveOutcome = { removed: boolean; images?: MessagePart[]; imagesDropped?: boolean } | null

const imagePart: MessagePart = { type: 'image', data: 'aWNvbQ==', mimeType: 'image/png' }
function baseProps(overrides: Partial<ComponentProps<typeof Composer>> = {}): ComponentProps<typeof Composer> {
  return {
    busy: true,
    model: 'auto',
    effort: 'medium',
    modelsByProvider: new Map(),
    providers: [],
    reasoningLevels: ['medium'],
    fast: false,
    fastSupported: false,
    fastAvailable: false,
    imageInputSupported: true,
    skills: [],
    onModelChange: vi.fn(),
    onEffortChange: vi.fn(),
    onFastChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  }
}

describe('composer harness queue controls', () => {
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

  const harnessItems = () => [...container.querySelectorAll<HTMLElement>('.composer-queue__item--harness')]
  const actionTitles = (item: Element) => [...item.querySelectorAll<HTMLButtonElement>('.composer-queue__action')].map((action) => action.title)
  const actionByLabel = (prefix: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('.composer-queue__action')].find((action) => action.getAttribute('aria-label')?.startsWith(prefix))
  const textarea = () => container.querySelector<HTMLTextAreaElement>('.composer textarea')!
  const itemStatus = (item: Element) => item.querySelector('small[role="status"]')?.textContent ?? ''

  it('renders typed previews in engine order with queue-aware controls', () => {
    act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      harnessQueuedMessageCount: 2,
      harnessQueuedPreviews: [
        { message: 'tighten the login flow', queue: 'steering' },
        { message: 'add a regression test', queue: 'followUp' },
      ],
      onRemoveHarnessQueuedMessage: vi.fn(),
      onPromoteHarnessQueuedMessage: vi.fn(),
    })} />))

    const items = harnessItems()
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('tighten the login flow')
    expect(items[1]?.textContent).toContain('add a regression test')
    // Steering rows offer reclaim and delete; promotion targets follow-ups only.
    expect(actionTitles(items[0]!)).toEqual(['Reclaim queued message to the composer', 'Delete queued message'])
    expect(actionTitles(items[1]!)).toEqual(['Reclaim queued message to the composer', 'Promote follow-up to the steering queue', 'Delete queued message'])
  })

  it('remove delegates to the native RPC once with exact arguments and follows the refreshed queue', async () => {
    let resolveRemoval!: (value: RemoveOutcome) => void
    const onRemove = vi.fn(() => new Promise<RemoveOutcome>((resolve) => { resolveRemoval = resolve }))
    const onSend = vi.fn()
    const render = (previews: Array<{ message: string; queue: 'steering' | 'followUp' }>, count: number) => act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      harnessQueuedMessageCount: count,
      harnessQueuedPreviews: previews,
      onRemoveHarnessQueuedMessage: onRemove,
      onSend,
    })} />))
    render([
      { message: 'tighten the login flow', queue: 'steering' },
      { message: 'add a regression test', queue: 'followUp' },
    ], 2)

    const remove = actionByLabel('Delete queued message: tighten the login flow')!
    await act(async () => { remove.click(); remove.click() })
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledWith('tighten the login flow', 'steering')
    expect(onSend).not.toHaveBeenCalled()

    await act(async () => resolveRemoval({ removed: true }))
    // The authoritative runtime snapshot drops the row; the display follows it.
    render([{ message: 'add a regression test', queue: 'followUp' }], 1)
    const items = harnessItems()
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent).toContain('add a regression test')
  })

  it('an unconfirmed removal keeps the item, reports neutrally, and blocks blind retries until a refresh', async () => {
    const onRemove = vi.fn(() => Promise.resolve(null))
    const onReclaim = vi.fn()
    const render = (previews: Array<{ message: string; queue: 'steering' | 'followUp' }>) => act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      harnessQueuedMessageCount: previews.length,
      harnessQueuedPreviews: previews,
      onRemoveHarnessQueuedMessage: onRemove,
      onReclaimHarnessQueuedMessage: onReclaim,
    })} />))
    render([{ message: 'tighten the login flow', queue: 'steering' }])

    await act(async () => actionByLabel('Delete queued message: tighten the login flow')!.click())
    expect(onRemove).toHaveBeenCalledTimes(1)
    const items = harnessItems()
    expect(items).toHaveLength(1)
    // Transport outcome unknown: no claim the message is still held or gone.
    expect(itemStatus(items[0]!)).toBe('Queue removal could not be confirmed. Refresh before retrying.')
    expect(textarea().value).toBe('')

    // No blind retry: the unconfirmed row's controls stay inert.
    await act(async () => actionByLabel('Reclaim queued message to the composer: tighten the login flow')!.click())
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onReclaim).not.toHaveBeenCalled()
    expect(actionByLabel('Delete queued message: tighten the login flow')!.disabled).toBe(true)

    // A refreshed runtime snapshot re-arms the controls.
    render([{ message: 'tighten the login flow', queue: 'steering' }])
    expect(itemStatus(harnessItems()[0]!)).toBe('')
    expect(actionByLabel('Delete queued message: tighten the login flow')!.disabled).toBe(false)
  })

  it('a removed:false race reports neutrally and follows the authoritative refresh', async () => {
    const onRemove = vi.fn(() => Promise.resolve<RemoveOutcome>({ removed: false }))
    const onReclaim = vi.fn()
    const render = (previews: Array<{ message: string; queue: 'steering' | 'followUp' }>) => act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      harnessQueuedMessageCount: previews.length,
      harnessQueuedPreviews: previews,
      onRemoveHarnessQueuedMessage: onRemove,
      onReclaimHarnessQueuedMessage: onReclaim,
    })} />))
    render([{ message: 'tighten the login flow', queue: 'steering' }])

    await act(async () => actionByLabel('Delete queued message: tighten the login flow')!.click())
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(harnessItems()).toHaveLength(1)
    // Not-found is not proof the engine still holds it; keep the claim neutral.
    expect(itemStatus(harnessItems()[0]!)).toBe('The queue item is no longer available. Refresh the queue.')
    expect(textarea().value).toBe('')
    expect(onReclaim).not.toHaveBeenCalled()

    // The refreshed authoritative state may drop the row entirely.
    render([])
    expect(harnessItems()).toHaveLength(0)
  })

  it('reclaim returns text and images into an empty draft without sending', async () => {
    const onRemove = vi.fn(() => Promise.resolve<RemoveOutcome>({ removed: true, images: [imagePart] }))
    const onSend = vi.fn()
    const onReclaim = vi.fn()
    act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      draftKey: 'harness-queue-empty-draft',
      harnessQueuedMessageCount: 1,
      harnessQueuedPreviews: [{ message: 'fix the logo', queue: 'steering' }],
      onRemoveHarnessQueuedMessage: onRemove,
      onReclaimHarnessQueuedMessage: onReclaim,
      onSend,
    })} />))

    await act(async () => actionByLabel('Reclaim queued message to the composer: fix the logo')!.click())
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledWith('fix the logo', 'steering')
    // Reclaim never resends: the content only comes back as an editable draft.
    expect(onSend).not.toHaveBeenCalled()
    expect(onReclaim).not.toHaveBeenCalled()
    expect(textarea().value).toBe('fix the logo')
    expect(container.querySelectorAll('.composer-attachment')).toHaveLength(1)
  })

  it('reclaim never overwrites a nonempty draft and defers to a pending local row', async () => {
    const onRemove = vi.fn(() => Promise.resolve<RemoveOutcome>({ removed: true, images: [imagePart] }))
    const onSend = vi.fn()
    const onReclaim = vi.fn()
    act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      draftKey: 'harness-queue-occupied-draft',
      harnessQueuedMessageCount: 1,
      harnessQueuedPreviews: [{ message: 'fix the logo', queue: 'followUp' }],
      onRemoveHarnessQueuedMessage: onRemove,
      onReclaimHarnessQueuedMessage: onReclaim,
      onSend,
    })} />))

    const composerTextarea = textarea()
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(composerTextarea, 'keep this draft')
      composerTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => actionByLabel('Reclaim queued message to the composer: fix the logo')!.click())
    expect(onRemove).toHaveBeenCalledWith('fix the logo', 'followUp')
    expect(textarea().value).toBe('keep this draft')
    expect(container.querySelectorAll('.composer-attachment')).toHaveLength(0)
    // The occupied draft keeps its place; the reclaimed message becomes an
    // unaccepted local item the owner must place explicitly.
    expect(onReclaim).toHaveBeenCalledTimes(1)
    expect(onReclaim).toHaveBeenCalledWith('fix the logo', 'followUp', [imagePart])
    expect(onSend).not.toHaveBeenCalled()
  })

  it('an unconfirmed reclaim keeps the item with a neutral error and touches no draft', async () => {
    const onRemove = vi.fn(() => Promise.resolve(null))
    act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      harnessQueuedMessageCount: 1,
      harnessQueuedPreviews: [{ message: 'fix the logo', queue: 'steering' }],
      onRemoveHarnessQueuedMessage: onRemove,
      onReclaimHarnessQueuedMessage: vi.fn(),
    })} />))

    await act(async () => actionByLabel('Reclaim queued message to the composer: fix the logo')!.click())
    expect(harnessItems()).toHaveLength(1)
    expect(itemStatus(harnessItems()[0]!)).toBe('Queue removal could not be confirmed. Refresh before retrying.')
    expect(textarea().value).toBe('')
  })

  it('reclaim surfaces dropped images instead of losing them silently as plain text', async () => {
    const onRemove = vi.fn(() => Promise.resolve<RemoveOutcome>({ removed: true, images: [imagePart] }))
    act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      imageInputSupported: false,
      harnessQueuedMessageCount: 1,
      harnessQueuedPreviews: [{ message: 'fix the logo', queue: 'steering' }],
      onRemoveHarnessQueuedMessage: onRemove,
    })} />))

    await act(async () => actionByLabel('Reclaim queued message to the composer: fix the logo')!.click())
    expect(textarea().value).toBe('fix the logo')
    expect(container.querySelectorAll('.composer-attachment')).toHaveLength(0)
    const error = container.querySelector('.composer-attachment-error')
    expect(error?.textContent).toContain('OMP could not re-attach 1 image from the reclaimed message.')
  })

  it('remove and reclaim share one in-flight guard per message', async () => {
    let resolveRemoval!: (value: RemoveOutcome) => void
    const onRemove = vi.fn(() => new Promise<RemoveOutcome>((resolve) => { resolveRemoval = resolve }))
    act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      harnessQueuedMessageCount: 1,
      harnessQueuedPreviews: [{ message: 'fix the logo', queue: 'steering' }],
      onRemoveHarnessQueuedMessage: onRemove,
      onReclaimHarnessQueuedMessage: vi.fn(),
    })} />))

    await act(async () => {
      actionByLabel('Delete queued message: fix the logo')!.click()
      actionByLabel('Reclaim queued message to the composer: fix the logo')!.click()
    })
    expect(onRemove).toHaveBeenCalledTimes(1)
    await act(async () => resolveRemoval({ removed: true }))
    expect(textarea().value).toBe('')
  })

  it('promote targets follow-ups once and reports a visible neutral failure', async () => {
    let resolvePromotion!: (value: PromoteOutcome) => void
    const onPromote = vi.fn(() => new Promise<PromoteOutcome>((resolve) => { resolvePromotion = resolve }))
    const render = (onPromoteHarnessQueuedMessage: (message: string) => Promise<PromoteOutcome>) => act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      harnessQueuedMessageCount: 1,
      harnessQueuedPreviews: [{ message: 'add a regression test', queue: 'followUp' }],
      onPromoteHarnessQueuedMessage: onPromoteHarnessQueuedMessage,
    })} />))
    render(onPromote)

    const promote = actionByLabel('Promote follow-up to the steering queue: add a regression test')!
    await act(async () => { promote.click(); promote.click() })
    expect(onPromote).toHaveBeenCalledTimes(1)
    expect(onPromote).toHaveBeenCalledWith('add a regression test')

    await act(async () => resolvePromotion({ promoted: false }))
    let items = harnessItems()
    expect(items).toHaveLength(1)
    expect(itemStatus(items[0]!)).toBe('OMP could not promote that message.')
    expect(actionByLabel('Promote follow-up to the steering queue: add a regression test')!.disabled).toBe(true)

    // A refreshed snapshot re-arms; an unreachable runtime fails the same way.
    const onPromoteUnreachable = vi.fn(() => Promise.resolve(null))
    render(onPromoteUnreachable)
    expect(actionByLabel('Promote follow-up to the steering queue: add a regression test')!.disabled).toBe(false)
    await act(async () => actionByLabel('Promote follow-up to the steering queue: add a regression test')!.click())
    expect(onPromoteUnreachable).toHaveBeenCalledTimes(1)
    items = harnessItems()
    expect(items).toHaveLength(1)
    expect(itemStatus(items[0]!)).toBe('OMP could not promote that message.')
  })

  it('a stale reclaim resolution cannot overwrite a draft after the session switched', async () => {
    let resolveRemoval!: (value: RemoveOutcome) => void
    const onRemove = vi.fn(() => new Promise<RemoveOutcome>((resolve) => { resolveRemoval = resolve }))
    const onReclaim = vi.fn()
    const render = (draftKey: string) => act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      draftKey,
      harnessQueuedMessageCount: 1,
      harnessQueuedPreviews: [{ message: 'fix the logo', queue: 'steering' }],
      onRemoveHarnessQueuedMessage: onRemove,
      onReclaimHarnessQueuedMessage: onReclaim,
    })} />))
    render('harness-queue-stale-before')

    await act(async () => actionByLabel('Reclaim queued message to the composer: fix the logo')!.click())
    expect(onRemove).toHaveBeenCalledTimes(1)

    // The workspace switched sessions while the RPC was in flight.
    render('harness-queue-stale-after')
    const composerTextarea = textarea()
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(composerTextarea, 'new session draft')
      composerTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => resolveRemoval({ removed: true, images: [imagePart] }))
    expect(textarea().value).toBe('new session draft')
    expect(container.querySelectorAll('.composer-attachment')).toHaveLength(0)
    expect(onReclaim).not.toHaveBeenCalled()
  })

  it('a stale reclaim resolution cannot overwrite the draft after the runtime switched under the same session', async () => {
    let resolveRemoval!: (value: RemoveOutcome) => void
    const onRemove = vi.fn(() => new Promise<RemoveOutcome>((resolve) => { resolveRemoval = resolve }))
    const onReclaim = vi.fn()
    const render = (queueRuntimeId: string) => act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      draftKey: 'harness-queue-same-session',
      queueRuntimeId,
      harnessQueuedMessageCount: 1,
      harnessQueuedPreviews: [{ message: 'fix the logo', queue: 'steering' }],
      onRemoveHarnessQueuedMessage: onRemove,
      onReclaimHarnessQueuedMessage: onReclaim,
    })} />))
    render('runtime-before')

    await act(async () => actionByLabel('Reclaim queued message to the composer: fix the logo')!.click())
    expect(onRemove).toHaveBeenCalledTimes(1)

    // Same draft key, different attached runtime: the resolution is stale.
    render('runtime-after')
    const composerTextarea = textarea()
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(composerTextarea, 'meanwhile typed')
      composerTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => resolveRemoval({ removed: true }))
    expect(textarea().value).toBe('meanwhile typed')
    expect(onReclaim).not.toHaveBeenCalled()
  })

  it('keeps the count-only explanation without fabricating controls', () => {
    act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      harnessQueuedMessageCount: 2,
      onRemoveHarnessQueuedMessage: vi.fn(),
      onPromoteHarnessQueuedMessage: vi.fn(),
    })} />))

    const tray = container.querySelector('.composer-queue')!
    expect(tray.textContent).toContain('OMP is holding 2 messages for the next turn.')
    expect(tray.querySelectorAll('.composer-queue__action')).toHaveLength(0)
  })

  it('threads the engine imagesDropped flag through reclaim instead of losing it silently', async () => {
    const onRemove = vi.fn(() => Promise.resolve<RemoveOutcome>({ removed: true, images: [imagePart], imagesDropped: true }))
    const onReclaim = vi.fn()
    act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      draftKey: 'harness-queue-images-dropped-pending',
      harnessQueuedMessageCount: 1,
      harnessQueuedPreviews: [{ message: 'fix the logo', queue: 'followUp' }],
      onRemoveHarnessQueuedMessage: onRemove,
      onReclaimHarnessQueuedMessage: onReclaim,
    })} />))
    const composerTextarea = textarea()
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(composerTextarea, 'keep this draft')
      composerTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => actionByLabel('Reclaim queued message to the composer: fix the logo')!.click())
    // The pending row receives the transport-loss flag so the owner can keep
    // the loss visible; the renderer never guesses it from missing images.
    expect(onReclaim).toHaveBeenCalledWith('fix the logo', 'followUp', [imagePart], true)

    // Empty draft with nothing re-attachable: the engine-side loss surfaces
    // as a visible error instead of a silent plain-text-only reclaim.
    const onRemoveEmpty = vi.fn(() => Promise.resolve<RemoveOutcome>({ removed: true, images: [], imagesDropped: true }))
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(composerTextarea, '')
      composerTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => root.render(<Composer {...baseProps({
      agentName: 'OMP',
      draftKey: 'harness-queue-images-dropped-draft',
      harnessQueuedMessageCount: 1,
      harnessQueuedPreviews: [{ message: 'fix the logo', queue: 'steering' }],
      onRemoveHarnessQueuedMessage: onRemoveEmpty,
    })} />))
    await act(async () => actionByLabel('Reclaim queued message to the composer: fix the logo')!.click())
    expect(textarea().value).toBe('fix the logo')
    expect(container.querySelector('.composer-attachment-error')?.textContent).toContain('OMP could not bring back every image from the reclaimed message.')
  })
})
