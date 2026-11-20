import { memo } from 'react'
import type { LiveTranscriptEntry, LiveVoicePhase } from '@/hooks/useLiveVoice'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { Modal } from './ui'
import './live-voice.css'

const PHASE_KEYS: Record<LiveVoicePhase | 'idle', MessageKey> = {
  idle: 'liveVoice.phase.idle',
  connecting: 'liveVoice.phase.connecting',
  listening: 'liveVoice.phase.listening',
  working: 'liveVoice.phase.working',
  speaking: 'liveVoice.phase.speaking',
  muted: 'liveVoice.phase.muted',
  error: 'liveVoice.phase.error',
}

const ROLE_KEYS: Record<LiveTranscriptEntry['role'], MessageKey> = {
  user: 'liveVoice.role.user',
  assistant: 'liveVoice.role.assistant',
}

export interface LiveVoicePanelProps {
  phase: LiveVoicePhase | null
  inputLevel: number
  outputLevel: number
  transcript: readonly LiveTranscriptEntry[]
  error: string | null
  busy: boolean
  /** False before the session has a runtime: starting would have nothing to talk to. */
  ready?: boolean
  onStart(): void | Promise<void>
  onStop(): void | Promise<void>
  onClose(): void
}

function LevelBar({ label, value }: { label: string; value: number }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div className="live-voice__level-row">
      <span className="live-voice__level-label">{label}</span>
      <div
        className="live-voice__level"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span className="live-voice__level-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

/**
 * Host microphone/speaker live voice (OMP `live_start`/`live_stop`). The App
 * owns the hook and the open state; this panel only renders the session view.
 * Closing the dialog stops an active session so the harness never keeps the
 * microphone open behind a dismissed panel.
 */
export const LiveVoicePanel = memo(function LiveVoicePanel({
  phase,
  inputLevel,
  outputLevel,
  transcript,
  error,
  busy,
  ready = true,
  onStart,
  onStop,
  onClose,
}: LiveVoicePanelProps) {
  const { t } = useI18n()
  const active = phase !== null
  const dismiss = () => {
    if (active) void onStop()
    onClose()
  }
  return (
    <Modal
      title={t('liveVoice.title')}
      onClose={dismiss}
      footer={
        <button
          type="button"
          className="button button--primary"
          disabled={busy || (!active && !ready)}
          onClick={() => {
            if (active) void onStop()
            else void onStart()
          }}
        >
          {active ? t('liveVoice.stop') : t('liveVoice.start')}
        </button>
      }
    >
      <div className="live-voice">
        <div className="live-voice__status">
          <span className="live-voice__phase" data-phase={phase ?? 'idle'} role="status">
            {t(PHASE_KEYS[phase ?? 'idle'])}
          </span>
          <span className="live-voice__hint">{t(ready || active ? 'liveVoice.hint' : 'liveVoice.needsRuntime')}</span>
        </div>
        <div className="live-voice__levels">
          <LevelBar label={t('liveVoice.inputLevel')} value={inputLevel} />
          <LevelBar label={t('liveVoice.outputLevel')} value={outputLevel} />
        </div>
        <div className="live-voice__transcript" role="log" aria-label={t('liveVoice.transcript')}>
          {transcript.length === 0 ? (
            <p className="live-voice__empty">{t('liveVoice.empty')}</p>
          ) : (
            transcript.map((entry) => (
              <div
                key={`${entry.role}:${entry.turn}`}
                className="live-voice__entry"
                data-role={entry.role}
                data-final={entry.final ? 'true' : 'false'}
              >
                <span className="live-voice__entry-role">{t(ROLE_KEYS[entry.role])}</span>
                <p className="live-voice__entry-text">{entry.text}</p>
              </div>
            ))
          )}
        </div>
        {error ? (
          <p className="live-voice__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  )
})
