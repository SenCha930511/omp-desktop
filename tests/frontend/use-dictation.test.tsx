// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DictationState, useDictation } from '../../src/hooks/useDictation'
import type { DesktopApi, VoiceTranscriptionProvider, VoiceTranscriptionRequest } from '../../src/types/api'
import { asMediaStream, asPeerConnection, deferred, FakeMediaStream, FakeMediaTrack, FakePeerConnection, flushPromises } from './webrtc-audio-fakes'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface DictationController {
  state: DictationState
  start: () => Promise<void>
  finish: () => Promise<string>
  cancel: () => void
}

interface HarnessProps {
  voice: DesktopApi['voice']
  provider: VoiceTranscriptionProvider
  onError: (message: string) => void
}

let current: DictationController | null = null

function Harness({ voice, provider, onError }: HarnessProps) {
  current = useDictation(voice, provider, onError)
  return <span data-state={current.state} />
}

function dictation(): DictationController {
  if (!current) throw new Error('Dictation harness is not rendered.')
  return current
}

class FakeAudioNode {
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()
}

class FakeAudioProcessor extends FakeAudioNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null

  process(samples: Float32Array): void {
    const event = { inputBuffer: { getChannelData: () => samples } } as unknown as AudioProcessingEvent
    this.onaudioprocess?.(event)
  }
}

class FakeAudioContext {
  readonly sampleRate: number
  readonly destination = {} as AudioDestinationNode
  readonly source = new FakeAudioNode()
  readonly processor = new FakeAudioProcessor()
  readonly sink = Object.assign(new FakeAudioNode(), { gain: { value: 1 } })
  readonly resume = vi.fn(async () => {})
  readonly close = vi.fn(async () => {})
  readonly createMediaStreamSource = vi.fn(() => this.source as unknown as MediaStreamAudioSourceNode)
  readonly createScriptProcessor = vi.fn(() => this.processor as unknown as ScriptProcessorNode)
  readonly createGain = vi.fn(() => this.sink as unknown as GainNode)

  constructor(sampleRate = 8_000) {
    this.sampleRate = sampleRate
  }
}

describe('useDictation', () => {
  let container: HTMLDivElement
  let root: Root
  let microphoneDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    microphoneDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    current = null
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    current = null
    if (microphoneDescriptor) Object.defineProperty(navigator, 'mediaDevices', microphoneDescriptor)
    else Reflect.deleteProperty(navigator, 'mediaDevices')
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function installMicrophone(stream: FakeMediaStream) {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => asMediaStream(stream)) },
    })
  }

  function installPeer(peer: FakePeerConnection): void {
    vi.stubGlobal('RTCPeerConnection', function PeerConnectionStub() {
      return asPeerConnection(peer)
    })
  }

  function installAudioContext(context: FakeAudioContext): void {
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return context as unknown as AudioContext
    })
  }

  function renderDictation(provider: VoiceTranscriptionProvider, voice: DesktopApi['voice'], onError: (message: string) => void): void {
    act(() => root.render(<Harness voice={voice} provider={provider} onError={onError} />))
  }

  it('keeps OpenAI live signaling, transcript completion, commit, and cleanup behavior', async () => {
    const track = new FakeMediaTrack()
    const stream = new FakeMediaStream([track])
    const peer = new FakePeerConnection()
    installMicrophone(stream)
    installPeer(peer)
    const createRealtimeCall = vi.fn(async () => 'answer-sdp')
    const transcribe = vi.fn(async (_request: VoiceTranscriptionRequest) => '')
    const voice = { createRealtimeCall, transcribe } as unknown as DesktopApi['voice']
    const onError = vi.fn()
    renderDictation('openai-live', voice, onError)

    await act(async () => dictation().start())
    expect(dictation().state).toBe('recording')
    expect(createRealtimeCall).toHaveBeenCalledWith({ mode: 'transcription', sdp: peer.offerSdp })
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer-sdp' })

    act(() => {
      peer.channel.message(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: ' ship' }))
      peer.channel.message(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: ' it ' }))
    })
    let transcript = ''
    await act(async () => {
      const finishing = dictation().finish()
      peer.channel.message(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed' }))
      transcript = await finishing
    })

    expect(transcript).toBe('ship it')
    expect(peer.channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    expect(transcribe).not.toHaveBeenCalled()
    expect(dictation().state).toBe('idle')
    expect(track.stop).toHaveBeenCalledOnce()
    expect(peer.channel.close).toHaveBeenCalledOnce()
    expect(peer.close).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith('')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels pending live signaling without applying a late answer or reporting an error', async () => {
    const track = new FakeMediaTrack()
    const stream = new FakeMediaStream([track])
    const peer = new FakePeerConnection()
    const answer = deferred<string>()
    installMicrophone(stream)
    installPeer(peer)
    const createRealtimeCall = vi.fn(() => answer.promise)
    const voice = { createRealtimeCall, transcribe: vi.fn() } as unknown as DesktopApi['voice']
    const onError = vi.fn()
    renderDictation('openai-live', voice, onError)

    let starting = Promise.resolve()
    act(() => { starting = dictation().start() })
    await act(flushPromises)
    expect(createRealtimeCall).toHaveBeenCalledOnce()
    act(() => dictation().cancel())
    answer.resolve('late-answer')
    await act(async () => starting)

    expect(dictation().state).toBe('idle')
    expect(peer.setRemoteDescription).not.toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(peer.channel.close).toHaveBeenCalledOnce()
    expect(peer.close).toHaveBeenCalledOnce()
    expect(onError.mock.calls).toEqual([['']])
  })

  it('retains the live completion deadline and closes the audio session on timeout', async () => {
    const track = new FakeMediaTrack()
    const stream = new FakeMediaStream([track])
    const peer = new FakePeerConnection()
    installMicrophone(stream)
    installPeer(peer)
    const voice = { createRealtimeCall: vi.fn(async () => 'answer-sdp'), transcribe: vi.fn() } as unknown as DesktopApi['voice']
    const onError = vi.fn()
    renderDictation('openai-live', voice, onError)
    await act(async () => dictation().start())

    let transcript = 'not-finished'
    await act(async () => {
      const finishing = dictation().finish()
      await vi.advanceTimersByTimeAsync(20_000)
      transcript = await finishing
    })

    expect(transcript).toBe('')
    expect(onError).toHaveBeenLastCalledWith('Realtime transcription timed out.')
    expect(track.stop).toHaveBeenCalledOnce()
    expect(peer.channel.close).toHaveBeenCalledOnce()
    expect(peer.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails a closed-channel finish synchronously without committing or leaving a timer', async () => {
    const track = new FakeMediaTrack()
    const stream = new FakeMediaStream([track])
    const peer = new FakePeerConnection()
    installMicrophone(stream)
    installPeer(peer)
    const voice = { createRealtimeCall: vi.fn(async () => 'answer-sdp'), transcribe: vi.fn() } as unknown as DesktopApi['voice']
    const onError = vi.fn()
    renderDictation('openai-live', voice, onError)
    await act(async () => dictation().start())
    peer.channel.close()

    let transcript = 'not-finished'
    await act(async () => { transcript = await dictation().finish() })

    expect(transcript).toBe('')
    expect(peer.channel.send).not.toHaveBeenCalled()
    expect(onError).toHaveBeenLastCalledWith('Realtime audio session is not connected.')
    expect(dictation().state).toBe('idle')
    expect(track.stop).toHaveBeenCalledOnce()
    expect(peer.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves batch WAV frames, provider selection, and audio-node teardown', async () => {
    const track = new FakeMediaTrack()
    const stream = new FakeMediaStream([track])
    const context = new FakeAudioContext()
    installMicrophone(stream)
    installAudioContext(context)
    const transcribe = vi.fn(async (_request: VoiceTranscriptionRequest) => ' recorded words ')
    const voice = { createRealtimeCall: vi.fn(), transcribe } as unknown as DesktopApi['voice']
    const onError = vi.fn()
    renderDictation('openai', voice, onError)
    await act(async () => dictation().start())

    act(() => context.processor.process(new Float32Array([0, 0.5, -0.5, 1])))
    let transcript = ''
    await act(async () => { transcript = await dictation().finish() })

    expect(transcript).toBe('recorded words')
    expect(transcribe).toHaveBeenCalledOnce()
    const request = transcribe.mock.calls[0]![0]
    expect(request.provider).toBe('openai')
    const view = new DataView(request.audio.buffer, request.audio.byteOffset, request.audio.byteLength)
    expect(String.fromCharCode(...request.audio.slice(0, 4))).toBe('RIFF')
    expect(view.getUint32(40, true)).toBe(8)
    expect([44, 46, 48, 50].map((offset) => view.getInt16(offset, true))).toEqual([0, 16_383, -16_384, 32_767])
    expect(context.sink.gain.value).toBe(0)
    expect(context.source.connect).toHaveBeenCalledWith(context.processor)
    expect(context.processor.disconnect).toHaveBeenCalledOnce()
    expect(context.source.disconnect).toHaveBeenCalledOnce()
    expect(context.sink.disconnect).toHaveBeenCalledOnce()
    expect(context.close).toHaveBeenCalledOnce()
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('rejects overflow beyond four minutes before calling a batch provider', async () => {
    const track = new FakeMediaTrack()
    const stream = new FakeMediaStream([track])
    const context = new FakeAudioContext(10)
    installMicrophone(stream)
    installAudioContext(context)
    const transcribe = vi.fn(async (_request: VoiceTranscriptionRequest) => 'unexpected')
    const voice = { createRealtimeCall: vi.fn(), transcribe } as unknown as DesktopApi['voice']
    const onError = vi.fn()
    renderDictation('local-whisper', voice, onError)
    await act(async () => dictation().start())

    act(() => context.processor.process(new Float32Array(2_401)))
    let transcript = 'not-finished'
    await act(async () => { transcript = await dictation().finish() })

    expect(transcript).toBe('')
    expect(onError).toHaveBeenLastCalledWith('Dictation is limited to four minutes per recording.')
    expect(transcribe).not.toHaveBeenCalled()
    expect(context.close).toHaveBeenCalledOnce()
    expect(track.stop).toHaveBeenCalledOnce()
  })
})
