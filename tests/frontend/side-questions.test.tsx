// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SideChatPanel } from '../../src/components/SideChatPanel'
import { isTopicRunning, useSideQuestions, type SideQuestionsController } from '../../src/hooks/useSideQuestions'
import type { DesktopApi, PrimeEventEnvelope } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const NOW = 1_792_500_000_000

const topic = (overrides: Record<string, unknown> = {}) => ({
  id: 'topic-1',
  question: 'What is this file?',
  answer: '',
  status: 'running',
  createdAt: NOW,
  updatedAt: NOW,
  followUps: [] as unknown[],
  ...overrides,
})

interface BridgeHarness {
  bridge: DesktopApi
  command: ReturnType<typeof vi.fn>
  emit: (envelope: PrimeEventEnvelope) => void
}

function makeBridge(): BridgeHarness {
  let eventSink: ((envelope: PrimeEventEnvelope) => void) | null = null
  const command = vi.fn(async (_runtimeId: string, cmd: { type: string }) => {
    if (cmd.type === 'side_question_history') return { success: true, data: { records: [topic()] } }
    if (cmd.type === 'side_question') return { success: true, data: { record: topic({ id: 'topic-2', question: 'New question?' }) } }
    if (cmd.type === 'side_question_cancel') return { success: true, data: { cancelled: true } }
    return { success: false, error: `unexpected ${cmd.type}` }
  })
  const bridge = {
    agent: {
      command,
      onEvent: (callback: (envelope: PrimeEventEnvelope) => void) => {
        eventSink = callback
        return () => { eventSink = null }
      },
    },
  } as unknown as DesktopApi
  return { bridge, command, emit: (envelope) => eventSink?.(envelope) }
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

function HookProbe({ bridge, sessionId, runtimeId, expose }: { bridge: DesktopApi; sessionId: string; runtimeId: string; expose: (controller: SideQuestionsController) => void }) {
  const controller = useSideQuestions(bridge, sessionId, runtimeId)
  expose(controller)
  return null
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useSideQuestions', () => {
  it('probes support without seeding history and surfaces streamed deltas on the latest turn', async () => {
    const { bridge, emit } = makeBridge()
    let controller: SideQuestionsController | null = null
    let renderCount = 0
    await act(async () => {
      root.render(<HookProbe bridge={bridge} sessionId="session-1" runtimeId="runtime-1" expose={(value) => { controller = value; renderCount += 1 }} />)
    })
    await flush()

    // The probe is only a capability check: past topics stay hidden so a
    // reopened panel never resurrects what a close cleared.
    const session = controller!.session('session-1')
    expect(session.supported).toBe(true)
    expect(session.topics).toHaveLength(0)

    await act(async () => {
      emit({ runtimeId: 'runtime-1', event: { type: 'side_question_record', topic: topic() } })
    })
    expect(controller!.session('session-1').topics).toHaveLength(1)
    expect(renderCount).toBeGreaterThan(0)

    await act(async () => {
      emit({ runtimeId: 'runtime-1', event: { type: 'side_question_delta', topicId: 'topic-1', delta: 'A config ' } })
      emit({ runtimeId: 'runtime-1', event: { type: 'side_question_delta', topicId: 'topic-1', delta: 'file.' } })
    })
    expect(controller!.session('session-1').live['topic-1']).toBe('A config file.')

    await act(async () => {
      emit({ runtimeId: 'runtime-1', event: { type: 'side_question_record', topic: topic({ answer: 'A config file.', status: 'complete' }) } })
    })
    const finished = controller!.session('session-1')
    expect(finished.live['topic-1']).toBeUndefined()
    expect(finished.topics[0]?.status).toBe('complete')
    expect(isTopicRunning(finished.topics[0]!)).toBe(false)
  })

  it('clears visible topics but keeps the support probe result', async () => {
    const { bridge, emit } = makeBridge()
    let controller: SideQuestionsController | null = null
    await act(async () => {
      root.render(<HookProbe bridge={bridge} sessionId="session-1" runtimeId="runtime-1" expose={(value) => { controller = value }} />)
    })
    await flush()
    await act(async () => {
      emit({ runtimeId: 'runtime-1', event: { type: 'side_question_record', topic: topic() } })
    })
    expect(controller!.session('session-1').topics).toHaveLength(1)

    await act(async () => {
      controller!.clear('session-1')
    })
    const cleared = controller!.session('session-1')
    expect(cleared.topics).toHaveLength(0)
    expect(cleared.live).toEqual({})
    expect(cleared.activeTopicId).toBeNull()
    expect(cleared.supported).toBe(true)
  })

  it('marks unsupported when the probe fails so the UI stays hidden', async () => {
    const { bridge, command } = makeBridge()
    command.mockResolvedValue({ success: false, error: 'Unknown command get_btw_history' })
    let controller: SideQuestionsController | null = null
    await act(async () => {
      root.render(<HookProbe bridge={bridge} sessionId="session-1" runtimeId="runtime-1" expose={(value) => { controller = value }} />)
    })
    await flush()
    expect(controller!.session('session-1').supported).toBe(false)
  })

  it('asks with topicId for follow-ups and adopts the returned record', async () => {
    const harness = makeBridge()
    let controller: SideQuestionsController | null = null
    await act(async () => {
      root.render(<HookProbe bridge={harness.bridge} sessionId="session-1" runtimeId="runtime-1" expose={(value) => { controller = value }} />)
    })
    await flush()

    let answered = false
    await act(async () => {
      answered = await controller!.ask('session-1', '  New question?  ', 'topic-1')
    })
    expect(answered).toBe(true)
    expect(harness.command).toHaveBeenCalledWith('runtime-1', { type: 'side_question', question: 'New question?', topicId: 'topic-1' })
    const session = controller!.session('session-1')
    expect(session.topics.map((entry) => entry.id)).toContain('topic-2')
    expect(session.activeTopicId).toBe('topic-2')

    await act(async () => {
      await controller!.cancel('session-1', 'topic-2')
    })
    expect(harness.command).toHaveBeenCalledWith('runtime-1', { type: 'side_question_cancel', topicId: 'topic-2' })
  })

  it('surfaces a harness rejection with the harness message', async () => {
    const { bridge, command } = makeBridge()
    let controller: SideQuestionsController | null = null
    await act(async () => {
      root.render(<HookProbe bridge={bridge} sessionId="session-1" runtimeId="runtime-1" expose={(value) => { controller = value }} />)
    })
    await flush()
    command.mockResolvedValueOnce({ success: false, error: 'A /btw question is still running; cancel it first' })
    let message = ''
    await act(async () => {
      try {
        await controller!.ask('session-1', 'Third?')
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
    })
    expect(message).toContain('still running')
    expect(controller!.session('session-1').sending).toBe(false)
  })
})

describe('side chat panel', () => {
  const topicLocked = topic({ status: 'complete', answer: 'It is the build config.' })

  function renderPanel(stateOverrides: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
    const onAsk = vi.fn()
    const onCancel = vi.fn()
    const onSelectTopic = vi.fn()
    const state = { supported: true, topics: [topicLocked], live: {}, activeTopicId: 'topic-1', sending: false, ...stateOverrides }
    act(() => {
      root.render(
        <SideChatPanel
          state={state as never}
          hasSession={true}
          onAsk={onAsk}
          onCancel={onCancel}
          onSelectTopic={onSelectTopic}
          onClose={() => undefined}
          {...props}
        />,
      )
    })
    return { onAsk, onCancel, onSelectTopic }
  }

  it('renders turns with the question bubble and the markdown answer', () => {
    renderPanel()
    expect(container.querySelector('.side-chat__bubble')?.textContent).toBe('What is this file?')
    expect(container.querySelector('.side-chat__answer')?.textContent).toContain('It is the build config.')
    expect(container.querySelector('.side-chat__status')).toBeNull()
  })

  it('shows stalled status pills without an answer body', () => {
    renderPanel({ topics: [topic({ status: 'cancelled', answer: '' })] })
    expect(container.querySelector('.side-chat__status')?.textContent).toBe('Cancelled')
  })

  it('sends drafts with the active topic id and swaps the send button for cancel while running', () => {
    const idle = renderPanel()
    const input = container.querySelector('.side-chat__input') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    act(() => {
      setter?.call(input, ' and its sibling?')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const sendButton = container.querySelector('button[aria-label="Send question"]') as HTMLButtonElement
    expect(sendButton.disabled).toBe(false)
    act(() => {
      sendButton.click()
    })
    expect(idle.onAsk).toHaveBeenCalledWith('and its sibling?', 'topic-1')
  })

  it('offers cancel instead of send while a question runs, scoped to the active topic', () => {
    const running = renderPanel({ topics: [topic()] })
    const send = container.querySelector('button[aria-label="Send question"]')
    expect(send).toBeNull()
    const cancel = container.querySelector('button[aria-label="Cancel question"]') as HTMLButtonElement
    expect(cancel).not.toBeNull()
    act(() => {
      cancel.click()
    })
    expect(running.onCancel).toHaveBeenCalledWith('topic-1')
  })

  it('switches topics through the picker including back to a blank draft', () => {
    const { onSelectTopic } = renderPanel()
    const picker = container.querySelector('.side-chat__topic-select select') as HTMLSelectElement
    expect(picker).not.toBeNull()
    expect(picker.value).toBe('topic-1')
    act(() => {
      picker.value = ''
      picker.dispatchEvent(new Event('input', { bubbles: true }))
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onSelectTopic).toHaveBeenCalledWith(null)
  })

  it('shows the guidance state when no session is live', () => {
    renderPanel({}, { hasSession: false })
    expect(container.textContent).toContain('Open a work session to ask side questions.')
    expect((container.querySelector('.side-chat__input') as HTMLTextAreaElement).disabled).toBe(true)
  })
})
