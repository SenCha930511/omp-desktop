import { useCallback, useEffect, useRef, useState } from 'react'
import { WebRtcAudioSession } from '@/lib/webrtc-audio-session'
import type { DesktopApi, VoiceTranscriptionProvider } from '@/types/api'

export type DictationState = 'idle' | 'connecting' | 'recording' | 'transcribing'

interface BatchCapture {
  kind: 'batch'
  stream: MediaStream
  context: AudioContext
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  sink: GainNode
  chunks: Float32Array[]
  frames: number
  sampleRate: number
  overflowed: boolean
}

interface LiveCapture {
  kind: 'live'
  session: WebRtcAudioSession
  transcript: string
  completed?: (value: string) => void
  failed?: (error: Error) => void
}

type Capture = BatchCapture | LiveCapture
const MAX_RECORDING_SECONDS = 4 * 60

function stopTracks(stream: MediaStream | null): void {
  if (!stream) return
  for (const track of stream.getTracks()) track.stop()
}

function closeCapture(capture: Capture | null): void {
  if (!capture) return
  if (capture.kind === 'live') {
    capture.session.close()
    return
  }
  stopTracks(capture.stream)
  capture.processor.disconnect()
  capture.source.disconnect()
  capture.sink.disconnect()
  void capture.context.close().catch(() => undefined)
}

function encodeWav(chunks: Float32Array[], frames: number, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + frames * 2)
  const view = new DataView(buffer)
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  write(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); write(8, 'WAVE')
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, frames * 2, true)
  let offset = 44
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index] ?? 0))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return new Uint8Array(buffer)
}

function receiveLiveMessage(capture: LiveCapture, data: string): void {
  let payload: unknown
  try { payload = JSON.parse(data) } catch { return }
  if (!payload || typeof payload !== 'object') return
  const message = payload as Record<string, unknown>
  if (message.type === 'conversation.item.input_audio_transcription.delta' && typeof message.delta === 'string') capture.transcript += message.delta
  if (message.type === 'conversation.item.input_audio_transcription.completed') capture.completed?.(typeof message.transcript === 'string' ? message.transcript : capture.transcript)
  if (message.type === 'error') capture.failed?.(new Error('Realtime transcription failed.'))
}

export function useDictation(voice: DesktopApi['voice'] | null | undefined, provider: VoiceTranscriptionProvider, onError: (message: string) => void) {
  const [state, setState] = useState<DictationState>('idle')
  const captureRef = useRef<Capture | null>(null)
  const generationRef = useRef(0)

  const cancel = useCallback(() => {
    generationRef.current += 1
    const capture = captureRef.current
    captureRef.current = null
    if (capture?.kind === 'live') capture.failed?.(new Error('Dictation cancelled.'))
    closeCapture(capture)
    setState('idle')
  }, [])

  useEffect(() => cancel, [cancel])

  const start = useCallback(async () => {
    if (!voice || state !== 'idle') return
    const generation = ++generationRef.current
    setState('connecting')
    onError('')
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let capture: Capture | null = null
    try {
      if (provider === 'openai-live') {
        const live: LiveCapture = { kind: 'live', session: new WebRtcAudioSession(), transcript: '' }
        capture = live
        captureRef.current = live
        const connected = await live.session.connect({
          exchangeSdp: (sdp) => voice.createRealtimeCall({ mode: 'transcription', sdp }),
          onMessage: (data) => receiveLiveMessage(live, data),
        })
        if (!connected || generation !== generationRef.current || captureRef.current !== live) {
          live.session.close()
          return
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
        if (generation !== generationRef.current) { stopTracks(stream); return }
        context = new AudioContext()
        await context.resume()
        if (generation !== generationRef.current) {
          stopTracks(stream)
          void context.close().catch(() => undefined)
          return
        }
        const source = context.createMediaStreamSource(stream)
        const processor = context.createScriptProcessor(4_096, 1, 1)
        const sink = context.createGain()
        sink.gain.value = 0
        const batch: BatchCapture = { kind: 'batch', stream, context, source, processor, sink, chunks: [], frames: 0, sampleRate: context.sampleRate, overflowed: false }
        capture = batch
        processor.onaudioprocess = (event) => {
          const samples = event.inputBuffer.getChannelData(0)
          if (batch.frames + samples.length > batch.sampleRate * MAX_RECORDING_SECONDS) { batch.overflowed = true; return }
          batch.chunks.push(new Float32Array(samples))
          batch.frames += samples.length
        }
        source.connect(processor); processor.connect(sink); sink.connect(context.destination)
        captureRef.current = batch
      }
      if (generation === generationRef.current) setState('recording')
    } catch (error) {
      if (!capture) {
        stopTracks(stream)
        if (context) void context.close().catch(() => undefined)
      }
      if (generation === generationRef.current) {
        closeCapture(capture)
        captureRef.current = null
        setState('idle')
        onError(error instanceof Error ? error.message : 'Could not start microphone capture.')
      }
    }
  }, [onError, provider, state, voice])

  const finish = useCallback(async (): Promise<string> => {
    const capture = captureRef.current
    if (!voice || !capture || state !== 'recording') return ''
    const generation = generationRef.current
    const isCurrent = () => generation === generationRef.current && captureRef.current === capture
    setState('transcribing')
    try {
      if (capture.kind === 'live') {
        const { promise: result, resolve, reject } = Promise.withResolvers<string>()
        const timer = window.setTimeout(() => reject(new Error('Realtime transcription timed out.')), 20_000)
        capture.completed = (text) => { window.clearTimeout(timer); resolve(text) }
        capture.failed = (error) => { window.clearTimeout(timer); reject(error) }
        try {
          capture.session.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
        } catch (error) {
          capture.failed(error instanceof Error ? error : new Error('Realtime transcription is not connected.'))
        }
        const transcript = await result
        return isCurrent() ? transcript.trim() : ''
      }
      if (capture.overflowed) throw new Error('Dictation is limited to four minutes per recording.')
      if (capture.frames === 0) return ''
      if (provider === 'openai-live') throw new Error('The transcription provider changed while recording.')
      const audio = encodeWav(capture.chunks, capture.frames, capture.sampleRate)
      const transcript = await voice.transcribe({ provider, audio })
      return isCurrent() ? transcript.trim() : ''
    } catch (error) {
      if (isCurrent()) onError(error instanceof Error ? error.message : 'Could not transcribe the recording.')
      return ''
    } finally {
      if (captureRef.current === capture) captureRef.current = null
      closeCapture(capture)
      if (generation === generationRef.current) setState('idle')
    }
  }, [onError, provider, state, voice])

  return { state, start, finish, cancel }
}
