import { CircleHelp, Download } from 'lucide-react'
import { useState } from 'react'
import { updateConfirmCopy, updateControlCopy } from '@/components/Sidebar'
import { Modal, OmpMark } from '@/components/ui'
import { useI18n } from '@/lib/i18n'
import type { AppMeta, AppUpdateState, LatestReleaseCheck } from '@/types/api'

interface AboutSettingsProps {
  meta?: AppMeta | null
  updateState?: AppUpdateState | null
  onUpdateAction?(): void | Promise<void>
  onCheckLatestRelease?(): Promise<LatestReleaseCheck>
  onOpenExternal?(url: string): Promise<boolean> | void
  onOpenDocs(): void
}

type LatestReleaseStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'checked'; result: LatestReleaseCheck }
  | { status: 'error' }

export function AboutSettings({ meta, updateState, onUpdateAction, onCheckLatestRelease, onOpenExternal, onOpenDocs }: AboutSettingsProps) {
  const { t } = useI18n()
  const [confirmUpdate, setConfirmUpdate] = useState(false)
  const [latestRelease, setLatestRelease] = useState<LatestReleaseStatus>({ status: 'idle' })
  const copy = updateState ? updateControlCopy(updateState, t) : null
  const needsInstallConfirm = updateState?.phase === 'available' || updateState?.phase === 'downloaded'
  const unsupported = updateState?.phase === 'unsupported'
  const canCheckLatest = Boolean(unsupported && onCheckLatestRelease)
  const checkedNewer = latestRelease.status === 'checked' && latestRelease.result.newer
  const checkBusy = latestRelease.status === 'checking' || updateState?.phase === 'checking' || updateState?.phase === 'downloading'
  const buttonLabel = latestRelease.status === 'checking'
    ? t('sidebar.update.checkingLabel')
    : checkedNewer
      ? t('about.update.openReleasePage')
      : copy?.label ?? ''
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
              {unsupported && latestRelease.status === 'checked' ? (
                <small className="about-update-latest">{latestRelease.result.newer
                  ? t('about.update.latestAvailable', { version: latestRelease.result.latestVersion })
                  : t('about.update.latestUpToDate', { version: latestRelease.result.latestVersion })}
                </small>
              ) : null}
              {unsupported && latestRelease.status === 'error' ? (
                <small className="about-update-latest">{t('about.update.latestCheckFailed')}</small>
              ) : null}
            </span>
            {onUpdateAction || canCheckLatest ? (
              <button
                className="button"
                type="button"
                disabled={checkBusy}
                onClick={() => {
                  if (needsInstallConfirm) { setConfirmUpdate(true); return }
                  if (canCheckLatest && onCheckLatestRelease) {
                    if (checkedNewer && latestRelease.status === 'checked') { void onOpenExternal?.(latestRelease.result.url); return }
                    setLatestRelease({ status: 'checking' })
                    void onCheckLatestRelease()
                      .then((result) => setLatestRelease({ status: 'checked', result }))
                      .catch(() => setLatestRelease({ status: 'error' }))
                    return
                  }
                  void onUpdateAction?.()
                }}
              >
                {updateState.phase === 'available' || updateState.phase === 'downloaded' || checkedNewer ? <><Download size={13} /> {buttonLabel}</> : buttonLabel}
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
