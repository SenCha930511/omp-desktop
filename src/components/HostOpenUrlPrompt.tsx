import { useI18n } from '@/lib/i18n'
import type { HostAuthorizationSnapshot } from '@/types/api'
import { Modal } from './ui'

interface HostOpenUrlPromptProps {
  snapshot: HostAuthorizationSnapshot
  busy?: boolean
  onDecision(decision: 'approve' | 'deny'): void
}

export function HostOpenUrlPrompt({ snapshot, busy = false, onDecision }: HostOpenUrlPromptProps) {
  const { t } = useI18n()
  const pending = snapshot.pending
  if (!pending) return null

  return (
    <Modal
      title={t('hostAuth.openUrl.title')}
      onClose={() => {
        if (!busy) onDecision('deny')
      }}
      footer={
        <>
          <button type="button" className="button" disabled={busy} onClick={() => onDecision('deny')}>
            {t('hostAuth.openUrl.deny')}
          </button>
          <button type="button" className="button button--primary" disabled={busy} autoFocus onClick={() => onDecision('approve')}>
            {t('hostAuth.openUrl.approve')}
          </button>
        </>
      }
    >
      <p className="modal-intro">{t('hostAuth.openUrl.body')}</p>
      <div className="host-auth-url">
        <code>{pending.url}</code>
      </div>
    </Modal>
  )
}
