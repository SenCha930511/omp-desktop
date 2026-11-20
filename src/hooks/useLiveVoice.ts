import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import { string } from '@/lib/events/parse'
import type { DesktopApi, PrimeEventEnvelope } from '@/types/api'

/** Phases the harness reports through `live_phase` (upstream Live Voice rpc-types). */
export const LIVE_VOICE_PHASES = ['connecting', 'listening', 'working', 'speaking', 'muted', 'error'] as const
export type LiveVoicePhase = (typeof LIVE_VOICE_PHASES)[number]

export interface LiveTranscriptEntry {
  role: 'user' | 'assistant'
  /** Utterance index; `role` + `turn` is the harness merge key. */
  turn: number
  text: string
  /** True once the harness finalized the utterance; later frames replace it. */
  final: boolean
}

export interface LiveVoiceController {
  phase: LiveVoicePhase | null
  inputLevel: number
  outputLevel: number
  transcript: readonly LiveTranscriptEntry[]
  /** Command or harness failure text; cleared on the next start. */
  error: string | null
  /** True while a start/stop command is in flight. */
  busy: boolean
  start(): Promise<void>
  stop(): Promise<void>
}

interface LiveVoiceState {
  phase: LiveVoicePhase | null
  inputLevel: number
  outputLevel: number
  transcript: LiveTranscriptEntry[]
  error: string | null
}

const INITIAL_STATE: LiveVoiceState = { phase: null, inputLevel: 0, outputLevel: 0, transcript: [], error: null }

const LIVE_EVENT_TYPES: ReadonlySet<string> = new Set(['live_phase', 'live_levels', 'live_transcript', 'live_end'])
const PHASES: ReadonlySet<string> = new Set(LIVE_VOICE_PHASES)

/** Levels arrive pre-clamped from the main process; re-clamp so a malformed frame can never overflow the bar. */
function level(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function upsertTranscript(entries: LiveTranscriptEntry[], next: LiveTranscriptEntry): LiveTranscriptEntry[] {
  const index = entries.findIndex((entry) => entry.role === next.role && entry.turn === next.turn)
  if (index < 0) return [...entries, next]
  return entries.map((entry, position) => (position === index ? next : entry))
}

/**
 * Host microphone/speaker live voice over the OMP `live_start`/`live_stop`
 * protocol. The main process already whitelists and clamps the `live_*`
 * frames; this hook owns the per-runtime view: phase, the throttled input and
 * output levels, and the merged transcript (last frame per role+turn wins).
 * WebRTC (`live_connect`) is deliberately out of scope.
 */
export function useLiveVoice(bridge: DesktopApi | null, runtimeId: string | null): LiveVoiceController {
  const [state, setState] = useState<LiveVoiceState>(INITIAL_STATE)
  const [busy, setBusy] = useState(false)
  // A live session belongs to one runtime; the effect below drops the stale
  // view when the workspace attaches a different one.
  const runtimeRef = useRef(runtimeId)
  runtimeRef.current = runtimeId
  const busyRef = useRef(false)

  useEffect(() => {
    setState(INITIAL_STATE)
  }, [runtimeId])

  useEffect(() => {
    if (!bridge || !runtimeId) return
    return bridge.agent.onEvent((envelope: PrimeEventEnvelope) => {
      if (envelope.runtimeId !== runtimeRef.current) return
      const { event } = envelope
      if (!LIVE_EVENT_TYPES.has(String(event.type))) return
      if (event.type === 'live_phase') {
        const phase = string(event.phase)
        if (!phase || !PHASES.has(phase)) return
        setState((current) => ({ ...current, phase: phase as LiveVoicePhase }))
        return
      }
      if (event.type === 'live_levels') {
        setState((current) => ({ ...current, inputLevel: level(event.input), outputLevel: level(event.output) }))
        return
      }
      if (event.type === 'live_transcript') {
        const role = event.role
        const turn = event.turn
        const text = string(event.text)
        if (role !== 'user' && role !== 'assistant') return
        if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0 || text === undefined) return
        setState((current) => ({ ...current, transcript: upsertTranscript(current.transcript, { role, turn, text, final: event.final === true }) }))
        return
      }
      // live_end arrives exactly once per session; a harness failure carries
      // its reason and successful ends carry none.
      setState({ ...INITIAL_STATE, error: string(event.error) ?? null })
    })
  }, [bridge, runtimeId])

  const start = useCallback(async () => {
    const target = runtimeRef.current
    if (!bridge || !target || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    // A new session never inherits the previous transcript or levels.
    setState(INITIAL_STATE)
    try {
      const response = await bridge.agent.command(target, { type: 'live_start' })
      if (response?.success !== true) throw new Error(string(response?.error) ?? 'Live voice failed to start')
    } catch (error: unknown) {
      setState((current) => ({ ...current, error: errorMessage(error) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [bridge])

  const stop = useCallback(async () => {
    const target = runtimeRef.current
    if (!bridge || !target || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const response = await bridge.agent.command(target, { type: 'live_stop' })
      if (response?.success !== true) throw new Error(string(response?.error) ?? 'Live voice failed to stop')
      // Older harness builds only acknowledge the command without a trailing
      // live_end, so the local view settles here as well.
      setState((current) => ({ ...current, phase: null, inputLevel: 0, outputLevel: 0 }))
    } catch (error: unknown) {
      setState((current) => ({ ...current, error: errorMessage(error) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [bridge])

  return useMemo(() => ({ ...state, busy, start, stop }), [state, busy, start, stop])
}
