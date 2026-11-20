// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveVoicePanel, type LiveVoicePanelProps } from '../../src/components/LiveVoicePanel'
import { useLiveVoice, type LiveVoiceController } from '../../src/hooks/useLiveVoice'
import type { DesktopApi, PrimeEventEnvelope } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface BridgeHarness {
  bridge: DesktopApi
  command: ReturnType<typeof vi.fn>
  emit: (envelope: PrimeEventEnvelope) => void
}

function makeBridge(command = vi.fn(async (_runtimeId: string, _commandBody: Record<string, unknown>) => ({ success: true }))): BridgeHarness {
  let eventSink: ((envelope: PrimeEventEnvelope) => void) | null = null
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
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.querySelectorAll('.modal-backdrop').forEach((node) => { node.remove() })
  container.remove()
  vi.restoreAllMocks()
})

function mountHook(bridge: DesktopApi | null, runtimeId: string | null) {
  let controller!: LiveVoiceController
  function Probe({ bridge: nextBridge, runtimeId: nextRuntimeId }: { bridge: DesktopApi | null; runtimeId: string | null }) {
    controller = useLiveVoice(nextBridge, nextRuntimeId)
    return null
  }
  const render = (nextBridge = bridge, nextRuntimeId = runtimeId) => act(() => root.render(<Probe bridge={nextBridge} runtimeId={nextRuntimeId} />))
  render()
  return { get controller() { return controller }, render }
}

const frame = (type: string, extra: Record<string, unknown> = {}, runtimeId = 'runtime-1'): PrimeEventEnvelope => ({ runtimeId, event: { type, ...extra } })

describe('useLiveVoice', () => {
  it('sends live_start and live_stop on the active runtime', async () => {
    const { bridge, command } = makeBridge()
    const probe = mountHook(bridge, 'runtime-1')
    await act(async () => { await probe.controller.start() })
    await act(async () => { await probe.controller.stop() })
    expect(command.mock.calls).toEqual([
      ['runtime-1', { type: 'live_start' }],
      ['runtime-1', { type: 'live_stop' }],
    ])
    expect(probe.controller.busy).toBe(false)
    expect(probe.controller.error).toBeNull()
  })

  it('stays inert without a live runtime', async () => {
    const { bridge, command } = makeBridge()
    const probe = mountHook(bridge, null)
    await act(async () => { await probe.controller.start() })
    expect(command).not.toHaveBeenCalled()
    expect(probe.controller.phase).toBeNull()
  })

  it('tracks phase, levels, and the merged transcript for its own runtime only', async () => {
    const { bridge, emit } = makeBridge()
    const probe = mountHook(bridge, 'runtime-1')

    await act(async () => {
      emit(frame('live_phase', { phase: 'listening' }))
      emit(frame('live_levels', { input: 0.42, output: 1.7 }))
      emit(frame('live_transcript', { role: 'user', turn: 0, text: 'Hello there', final: true }))
      emit(frame('live_transcript', { role: 'assistant', turn: 0, text: 'Hi', final: false }))
      emit(frame('live_transcript', { role: 'assistant', turn: 0, text: 'Hi, how can I help?', final: true }))
    })
    expect(probe.controller.phase).toBe('listening')
    expect(probe.controller.inputLevel).toBeCloseTo(0.42)
    // The main process clamps levels; the hook re-clamps malformed frames.
    expect(probe.controller.outputLevel).toBe(1)
    expect(probe.controller.transcript).toEqual([
      { role: 'user', turn: 0, text: 'Hello there', final: true },
      { role: 'assistant', turn: 0, text: 'Hi, how can I help?', final: true },
    ])

    await act(async () => {
      // Another runtime and unrelated event types never leak into the view.
      emit(frame('live_phase', { phase: 'speaking' }, 'runtime-2'))
      emit(frame('agent_start'))
      emit(frame('live_transcript', { role: 'system', turn: 0, text: 'ignored', final: true }))
      emit(frame('live_phase', { phase: 'bogus' }))
    })
    expect(probe.controller.phase).toBe('listening')
    expect(probe.controller.transcript).toHaveLength(2)
  })

  it('resets the transcript and levels on start and on live_end', async () => {
    const { bridge, emit } = makeBridge()
    const probe = mountHook(bridge, 'runtime-1')
    await act(async () => {
      emit(frame('live_phase', { phase: 'speaking' }))
      emit(frame('live_levels', { input: 0.9, output: 0.8 }))
      emit(frame('live_transcript', { role: 'assistant', turn: 0, text: 'First session', final: true }))
    })

    await act(async () => { await probe.controller.start() })
    expect(probe.controller.phase).toBeNull()
    expect(probe.controller.inputLevel).toBe(0)
    expect(probe.controller.outputLevel).toBe(0)
    expect(probe.controller.transcript).toEqual([])

    await act(async () => {
      emit(frame('live_phase', { phase: 'listening' }))
      emit(frame('live_levels', { input: 0.5, output: 0.25 }))
      emit(frame('live_transcript', { role: 'user', turn: 1, text: 'Second session', final: true }))
      emit(frame('live_end'))
    })
    expect(probe.controller.phase).toBeNull()
    expect(probe.controller.inputLevel).toBe(0)
    expect(probe.controller.outputLevel).toBe(0)
    expect(probe.controller.transcript).toEqual([])
    expect(probe.controller.error).toBeNull()
  })

  it('surfaces the live_end failure reason', async () => {
    const { bridge, emit } = makeBridge()
    const probe = mountHook(bridge, 'runtime-1')
    await act(async () => { emit(frame('live_end', { error: 'microphone permission denied' })) })
    expect(probe.controller.error).toBe('microphone permission denied')
    expect(probe.controller.phase).toBeNull()
  })

  it('surfaces rejected and thrown commands in error without a phase', async () => {
    const rejected = makeBridge(vi.fn(async () => ({ success: false, error: 'live voice unavailable' })))
    const first = mountHook(rejected.bridge, 'runtime-1')
    await act(async () => { await first.controller.start() })
    expect(first.controller.error).toBe('live voice unavailable')
    expect(first.controller.phase).toBeNull()

    const thrown = makeBridge(vi.fn(async () => { throw new Error('runtime exited') }))
    const second = mountHook(thrown.bridge, 'runtime-1')
    await act(async () => { await second.controller.stop() })
    expect(second.controller.error).toBe('runtime exited')
    expect(second.controller.busy).toBe(false)
  })

  it('clears the previous error when a new session starts', async () => {
    const { bridge, emit } = makeBridge()
    const probe = mountHook(bridge, 'runtime-1')
    await act(async () => { emit(frame('live_end', { error: 'dropped call' })) })
    expect(probe.controller.error).toBe('dropped call')
    await act(async () => { await probe.controller.start() })
    expect(probe.controller.error).toBeNull()
  })

  it('drops the stale view when the runtime changes', async () => {
    const { bridge, emit } = makeBridge()
    const probe = mountHook(bridge, 'runtime-1')
    await act(async () => {
      emit(frame('live_phase', { phase: 'listening' }))
      emit(frame('live_transcript', { role: 'user', turn: 0, text: 'Old runtime', final: true }))
    })
    await probe.render(bridge, 'runtime-2')
    expect(probe.controller.phase).toBeNull()
    expect(probe.controller.transcript).toEqual([])
  })
})

function renderPanel(overrides: Partial<LiveVoicePanelProps> = {}) {
  const onStart = vi.fn()
  const onStop = vi.fn()
  const onClose = vi.fn()
  const props: LiveVoicePanelProps = {
    phase: null,
    inputLevel: 0,
    outputLevel: 0,
    transcript: [],
    error: null,
    busy: false,
    onStart,
    onStop,
    onClose,
    ...overrides,
  }
  act(() => root.render(<LiveVoicePanel {...props} />))
  return { props, onStart, onStop, onClose }
}

const liveVoiceElement = () => {
  const element = document.querySelector<HTMLElement>('.live-voice')
  if (!element) throw new Error('live voice panel not rendered')
  return element
}

const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy()
  act(() => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('LiveVoicePanel', () => {
  it('renders the idle state and starts a session', () => {
    const { onStart, onStop } = renderPanel()
    expect(document.querySelector('[role="dialog"] .modal__header h2')?.textContent).toBe('Live voice')
    expect(liveVoiceElement().querySelector('.live-voice__phase')?.textContent).toBe('Not started')
    expect(liveVoiceElement().querySelector('.live-voice__empty')?.textContent).toContain('The conversation appears here')
    click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Start live voice'))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
  })

  it('disables starting before the session has a runtime', () => {
    renderPanel({ ready: false })
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Start live voice')
    expect(button?.hasAttribute('disabled')).toBe(true)
    expect(liveVoiceElement().querySelector('.live-voice__hint')?.textContent).toContain('Send a message in this session')
  })

  it('shows the phase, levels, transcript, and error of a running session', () => {
    renderPanel({
      phase: 'speaking',
      inputLevel: 0.64,
      outputLevel: 0.2,
      transcript: [
        { role: 'user', turn: 0, text: 'What changed today?', final: true },
        { role: 'assistant', turn: 0, text: 'Three files', final: false },
      ],
      error: 'output device unavailable',
    })
    expect(liveVoiceElement().querySelector('.live-voice__phase')?.textContent).toBe('Speaking')
    const levels = [...liveVoiceElement().querySelectorAll('[role="progressbar"]')]
    expect(levels.map((level) => [level.getAttribute('aria-label'), level.getAttribute('aria-valuenow')])).toEqual([
      ['Microphone level', '64'],
      ['Speaker level', '20'],
    ])
    const entries = [...liveVoiceElement().querySelectorAll('.live-voice__entry')]
    expect(entries.map((entry) => [entry.getAttribute('data-role'), entry.getAttribute('data-final'), entry.querySelector('p')?.textContent])).toEqual([
      ['user', 'true', 'What changed today?'],
      ['assistant', 'false', 'Three files'],
    ])
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('output device unavailable')
  })

  it('stops a running session from the footer action', () => {
    const { onStart, onStop } = renderPanel({ phase: 'listening' })
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Stop live voice')
    expect(button).toBeTruthy()
    click(button)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('disables the action while a command is in flight', () => {
    renderPanel({ phase: 'connecting', busy: true })
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Stop live voice')
    expect(button?.hasAttribute('disabled')).toBe(true)
  })

  it('stops the session when the panel is dismissed while active', () => {
    const { onStop, onClose } = renderPanel({ phase: 'listening' })
    click(document.querySelector('.modal__header button[aria-label="Close"]'))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes without a stop command when no session is active', () => {
    const { onStop, onClose } = renderPanel()
    click(document.querySelector('.modal__header button[aria-label="Close"]'))
    expect(onStop).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
