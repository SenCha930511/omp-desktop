import { LoaderCircle, RotateCcw } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { useI18n } from '@/lib/i18n'
import { compactionSyncPendingStore } from '@/lib/compaction-sync-state'

type RetryPhase = 'idle' | 'retrying' | 'failed' | 'synced'

/**
 * Inline retry on a pending-synchronization compaction divider: one explicit
 * user tap re-reads the runtime's authoritative state. Success is reflected
 * by the runtime_state snapshot clearing the pending store (the transient
 * note only shows if that event lags); failure keeps sync_pending, shows the
 * error inline — the TurnRecovery pattern — and never retries on its own.
 */
export function CompactionSyncRetry() {
  const { t } = useI18n()
  const pending = useSyncExternalStore(compactionSyncPendingStore.subscribe, compactionSyncPendingStore.getSnapshot)
  const [phase, setPhase] = useState<RetryPhase>('idle')
  if (!pending) return null
  const bridge = typeof window !== 'undefined' && typeof window.desktop !== 'undefined' ? window.desktop : undefined
  const retry = async () => {
    if (!bridge || phase === 'retrying') return
    setPhase('retrying')
    try {
      await bridge.agent.refreshState(pending.runtimeId)
      setPhase('synced')
    } catch {
      setPhase('failed')
    }
  }
  if (phase === 'synced') return <span className="compaction-sync-retry__note" role="status">{t('transcript.compaction.syncRetrySynced')}</span>
  return (
    <span className="compaction-sync-retry">
      <button
        type="button"
        className="compaction-sync-retry__button"
        disabled={!bridge || phase === 'retrying'}
        title={bridge ? t('transcript.compaction.syncRetryAria') : t('transcript.compaction.syncRetryDesktopOnly')}
        onClick={() => void retry()}
      >
        {phase === 'retrying' ? <LoaderCircle size={11} className="spin" aria-hidden="true" /> : <RotateCcw size={11} aria-hidden="true" />}
        {phase === 'retrying' ? t('transcript.compaction.syncRetrying') : t('transcript.compaction.syncRetry')}
      </button>
      {phase === 'failed' ? <span className="compaction-sync-retry__error" role="status">{t('transcript.compaction.syncRetryFailed')}</span> : null}
    </span>
  )
}
