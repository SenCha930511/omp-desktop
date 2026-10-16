import { CircleHelp } from 'lucide-react'
import { OmpMark } from '@/components/ui'
import { useI18n } from '@/lib/i18n'
import type { AppMeta } from '@/types/api'

interface AboutSettingsProps {
  meta?: AppMeta | null
  onOpenDocs(): void
}

export function AboutSettings({ meta, onOpenDocs }: AboutSettingsProps) {
  const { t } = useI18n()
  return (
    <>
      <header>
        <h1>{t('about.title')}</h1>
        <p>{t('about.description')}</p>
      </header>
      <section className="about-card">
        <OmpMark size={48} />
        <div>
          <h2>OMP Desktop</h2>
          <p>{t('about.version', { version: meta?.version ?? '0.1.0' })}</p>
        </div>
      </section>
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
