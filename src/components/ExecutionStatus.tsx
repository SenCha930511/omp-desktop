import { Check, Circle, CircleAlert, LoaderCircle, MessageCircleQuestion, Square } from 'lucide-react'
import { useI18n, type MessageKey } from '@/lib/i18n'
import type { ExecutionPhase, ExecutionState } from '@/lib/execution-state'
import { formatWorkedDuration, LiveElapsed } from './transcript/timeline'
import './execution-status.css'

export const EXECUTION_LABELS = {
  unknown: 'execution.unknown',
  idle: 'execution.idle', starting: 'execution.starting', thinking: 'execution.thinking', running: 'execution.running',
  waiting: 'execution.waiting', compacting: 'execution.compacting', completed: 'execution.completed', failed: 'execution.failed', cancelled: 'execution.cancelled',
} satisfies Record<ExecutionPhase, MessageKey>

export function ExecutionStatus({ state, compact = false }: { state: ExecutionState; compact?: boolean }) {
  const { t } = useI18n()
  const active = ['starting', 'thinking', 'running', 'compacting'].includes(state.phase)
  const end = state.until === undefined ? undefined : typeof state.until === 'number' ? state.until : Date.parse(state.until)
  const start = state.since === undefined ? undefined : typeof state.since === 'number' ? state.since : Date.parse(state.since)
  const icon = state.phase === 'waiting' ? <MessageCircleQuestion size={13} /> : state.phase === 'failed' ? <CircleAlert size={13} />
    : state.phase === 'completed' ? <Check size={13} /> : state.phase === 'cancelled' ? <Square size={11} /> : active ? <LoaderCircle size={13} className="is-spinning" /> : <Circle size={10} />
  return <div className={`execution-status is-${state.phase} ${compact ? 'is-compact' : ''}`}>
    <span className="execution-status__phase" role="status" aria-live="polite">{icon}<span>{t(EXECUTION_LABELS[state.phase])}</span></span>
    {state.detail && <span className="execution-status__detail" title={state.detail}>{state.detail}</span>}
    {!compact && state.since !== undefined && (active || state.phase === 'waiting'
      ? <LiveElapsed since={state.since} />
      : start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end) ? <span className="live-elapsed">{formatWorkedDuration(end - start)}</span> : null)}
  </div>
}
