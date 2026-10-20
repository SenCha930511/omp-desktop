import { CircleHelp, Download } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { updateConfirmCopy, updateControlCopy } from '@/components/Sidebar'
import { Modal, OmpMark } from '@/components/ui'
import { useI18n } from '@/lib/i18n'
import type { AppMeta, AppUpdateState } from '@/types/api'

interface AboutSettingsProps {
  meta?: AppMeta | null
  updateState?: AppUpdateState | null
  onUpdateAction?(): void | Promise<void>
  onOpenDocs(): void
}

export function AboutSettings({ meta, updateState, onUpdateAction, onOpenDocs }: AboutSettingsProps) {
  const { t } = useI18n()
  const [confirmUpdate, setConfirmUpdate] = useState(false)
  const [manualChecking, setManualChecking] = useState(false)
  const manualCheckTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (manualCheckTimerRef.current !== null) window.clearTimeout(manualCheckTimerRef.current)
  }, [])
  const copy = updateState ? updateControlCopy(updateState, t) : null
  const needsInstallConfirm = updateState?.phase === 'available' || updateState?.phase === 'downloaded'
  const checkBusy = manualChecking || updateState?.phase === 'checking' || updateState?.phase === 'downloading'
  const buttonLabel = manualChecking ? t('sidebar.update.checkingLabel') : copy?.label ?? ''
  return (
    <>
      <header>
        <h1>{t('about.title')}</h1>
      </header>
      <section className="about-card">
        <OmpMark size={48} />
        <div>
          <h2>OMP Desktop</h2>
          <p>{t('about.version', { version: meta?.version ?? '0.1.0' })}</p>
        </div>
      </section>
      {updateState && copy ? (
        <section className="settings-group">
          <div className="settings-row">
            <span>
              <strong>{t('about.update.title')}</strong>
              <small>{copy.title}</small>
            </span>
            {onUpdateAction ? (
              <button
                className="button"
                type="button"
                disabled={checkBusy}
                onClick={() => {
                  if (needsInstallConfirm) setConfirmUpdate(true)
                  else {
                    if (updateState.phase === 'unsupported') {
                      setManualChecking(true)
                      if (manualCheckTimerRef.current !== null) window.clearTimeout(manualCheckTimerRef.current)
                      manualCheckTimerRef.current = window.setTimeout(() => {
                        manualCheckTimerRef.current = null
                        setManualChecking(false)
                      }, 500)
                    }
                    void onUpdateAction()
                  }
                }}
              >
                {updateState.phase === 'available' || updateState.phase === 'downloaded' ? <><Download size={13} /> {buttonLabel}</> : buttonLabel}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
      {confirmUpdate && updateState ? (
        <Modal
          title={updateConfirmCopy(updateState, t).title}
          onClose={() => setConfirmUpdate(false)}
          footer={
            <>
              <button type="button" className="button" onClick={() => setConfirmUpdate(false)}>{t('sidebar.no')}</button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => {
                  setConfirmUpdate(false)
                  void onUpdateAction?.()
                }}
              >
                {t('sidebar.yes')}
              </button>
            </>
          }
        >
          <p>{updateConfirmCopy(updateState, t).body}</p>
        </Modal>
      ) : null}
      <section className="settings-group">
        <div className="settings-row">
          <span>
            <strong>{t('about.platform')}</strong>
            <small>{meta?.platform ?? 'macOS'}</small>
          </span>
        </div>
        <div className="settings-row">
          <span>
            <strong>{t('about.homeDir')}</strong>
            <small className="mono">{meta?.homeDir ?? '—'}</small>
          </span>
        </div>
        <div className="settings-row">
          <span>
            <strong>{t('about.docs')}</strong>
          </span>
          <button className="button" type="button" onClick={onOpenDocs}>
            <CircleHelp size={13} /> {t('about.openDocs')}
          </button>
        </div>
      </section>
    </>
  )
}
