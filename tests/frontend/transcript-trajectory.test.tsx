// @vitest-environment jsdom

import './jsdom-storage'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractTrajectoryTurns, TranscriptTrajectory } from '../../src/components/TranscriptTrajectory'
import { I18nProvider } from '../../src/lib/i18n'
import type { TranscriptMessage } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function userMsg(id: string, text: string, timestamp = '2026-11-22T01:22:00.000Z'): TranscriptMessage {
  return { id, role: 'user', timestamp, parts: text ? [{ type: 'text', text }] : [] }
}

function assistantMsg(id: string, parts: TranscriptMessage['parts'], streaming = false): TranscriptMessage {
  return { id, role: 'assistant', streaming, parts }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('extractTrajectoryTurns', () => {
  it('pairs each user turn with its latest assistant reply and strips markdown', () => {
    const messages: TranscriptMessage[] = [
      userMsg('u1', '## Check **build** [script](https://example.com) `ok`'),
      assistantMsg('a1', [{ type: 'thinking', text: 'pondering' }, { type: 'toolCall', name: 'bash' }]),
      assistantMsg('a2', [{ type: 'text', text: '**First** reply done with `vitest`.' }]),
      { id: 'marker', role: 'user', kind: 'steer-read-marker', parts: [{ type: 'text', text: 'ignored' }] },
      userMsg('u2', 'Second prompt'),
      assistantMsg('a3', [{ type: 'text', text: 'Working on it…' }], true),
    ]

    const turns = extractTrajectoryTurns(messages)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      id: 'u1',
      messageIndex: 0,
      prompt: 'Check build script ok',
      reply: 'First reply done with vitest.',
      hasActivity: true,
      streaming: false,
    })
    expect(turns[1]).toMatchObject({
      id: 'u2',
      messageIndex: 4,
      prompt: 'Second prompt',
      reply: 'Working on it…',
      streaming: true,
    })
  })

  it('captures image-only prompts and activity without text replies', () => {
    const messages: TranscriptMessage[] = [
      { id: 'img-turn', role: 'user', parts: [{ type: 'image', mimeType: 'image/png' }] },
      assistantMsg('a-tools', [{ type: 'toolCall', name: 'read_file' }]),
      userMsg('empty-turn', '   '),
      userMsg('text-turn', 'Real prompt'),
    ]

    const turns = extractTrajectoryTurns(messages)
    expect(turns.map((turn) => turn.id)).toEqual(['img-turn', 'text-turn'])
    expect(turns[0]).toMatchObject({ prompt: '', hasImagePrompt: true, reply: '', hasActivity: true })
  })
  it('reuses unchanged history turns when only the streaming reply grows', () => {
    const messages: TranscriptMessage[] = [
      userMsg('u1', 'First question'),
      assistantMsg('a1', [{ type: 'text', text: 'First answer' }]),
      userMsg('u2', 'Second question'),
      assistantMsg('a2', [{ type: 'text', text: 'Partial' }], true),
    ]
    const first = extractTrajectoryTurns(messages)
    const streamed = [...messages.slice(0, -1), assistantMsg('a2', [{ type: 'text', text: 'Partial answer' }], true)]
    const second = extractTrajectoryTurns(streamed, first)

    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(second[1]?.reply).toBe('Partial answer')
  })
})

describe('TranscriptTrajectory component', () => {
  it('renders nothing when there are fewer than two user turns', async () => {
    const scrollRef = createRef<HTMLDivElement>()
    await act(async () => {
      root.render(
        <I18nProvider preference="en">
          <div ref={scrollRef} />
          <TranscriptTrajectory messages={[userMsg('u1', 'Only one'), assistantMsg('a1', [{ type: 'text', text: 'Reply' }])]} scrollRef={scrollRef} onJumpToIndex={vi.fn()} />
        </I18nProvider>,
      )
    })

    expect(container.querySelector('.transcript-trajectory')).toBeNull()
  })

  it('renders a dot rail, shows preview card on focus/hover, and jumps on click', async () => {
    const scrollRef = createRef<HTMLDivElement>()
    const onJumpToIndex = vi.fn()
    const messages: TranscriptMessage[] = [
      userMsg('u1', 'First question', '2026-11-22T01:10:00.000Z'),
      assistantMsg('a1', [{ type: 'text', text: 'Answer one' }]),
      userMsg('u2', 'Second question', '2026-11-22T01:22:00.000Z'),
      assistantMsg('a2', [{ type: 'toolCall', name: 'bash' }], true),
    ]

    await act(async () => {
      root.render(
        <I18nProvider preference="en">
          <div ref={scrollRef}>
            <div data-message-id="u1" />
            <div data-message-id="u2" />
          </div>
          <TranscriptTrajectory messages={messages} scrollRef={scrollRef} onJumpToIndex={onJumpToIndex} />
        </I18nProvider>,
      )
    })

    const dots = [...container.querySelectorAll<HTMLButtonElement>('.trajectory-dot')]
    expect(dots).toHaveLength(2)
    expect(dots[1]?.classList.contains('is-streaming')).toBe(true)
    expect(container.querySelector('.trajectory-card')).toBeNull()

    await act(async () => {
      dots[0]?.focus()
    })

    const card = container.querySelector<HTMLElement>('.trajectory-card')
    expect(card).not.toBeNull()
    expect(card?.querySelector('.trajectory-card__prompt')?.textContent).toBe('First question')
    expect(card?.querySelector('.trajectory-card__reply')?.textContent).toBe('Answer one')
    expect(card?.querySelector('.trajectory-card__counter')?.textContent).toBe('1 of 2')

    await act(async () => {
      dots[0]?.click()
    })

    expect(onJumpToIndex).toHaveBeenCalledWith(0, 'u1')
    expect(dots[0]?.getAttribute('aria-current')).toBe('location')

    await act(async () => {
      dots[1]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(container.querySelector('.trajectory-card__reply')?.textContent).toBe('Responding…')
    expect(container.querySelector('.trajectory-card__counter')?.textContent).toBe('2 of 2')

    await act(async () => {
      container.querySelector('.transcript-trajectory')?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    })
    expect(container.querySelector('.trajectory-card')).toBeNull()
  })

  it('uses dense spacing and localizes labels for long conversations', async () => {
    const scrollRef = createRef<HTMLDivElement>()
    const messages: TranscriptMessage[] = []
    for (let index = 0; index < 30; index++) {
      messages.push(userMsg(`u-${index}`, `Turn ${index + 1}`))
      messages.push(assistantMsg(`a-${index}`, [{ type: 'toolCall', name: 'bash' }]))
    }

    await act(async () => {
      root.render(
        <I18nProvider preference="zh-TW">
          <div ref={scrollRef} />
          <TranscriptTrajectory messages={messages} scrollRef={scrollRef} onJumpToIndex={vi.fn()} />
        </I18nProvider>,
      )
    })

    const rail = container.querySelector('.trajectory-rail')
    expect(rail?.classList.contains('is-dense')).toBe(true)
    const dots = container.querySelectorAll<HTMLButtonElement>('.trajectory-dot')
    expect(dots).toHaveLength(30)

    await act(async () => {
      dots[29]?.focus()
    })
    expect(container.querySelector('.trajectory-card__reply')?.textContent).toBe('無文字回覆')
    expect(container.querySelector('.trajectory-card__counter')?.textContent).toBe('30 / 30')
  })
})
