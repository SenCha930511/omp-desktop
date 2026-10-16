import { Bot, LockKeyhole } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import type { SettingsSectionProps } from './contracts'

export function PrivacySettings(_props: SettingsSectionProps) {
  const { t } = useI18n()
  return (
    <>
      <header>
        <h1>{t('privacy.title')}</h1>
        <p>{t('privacy.description')}</p>
      </header>
      <section className="settings-group">
        <h2>{t('privacy.localData')}</h2>
        <div className="info-row">
          <LockKeyhole size={15} />
          <div>
            <strong>{t('privacy.localData.title')}</strong>
            <small>{t('privacy.localData.description')}</small>
          </div>
        </div>
      </section>
      <section className="settings-group">
        <h2>{t('privacy.agentRequests')}</h2>
        <div className="info-row">
          <Bot size={15} />
          <div>
            <strong>{t('privacy.agentRequests.title')}</strong>
            <small>{t('privacy.agentRequests.description')}</small>
          </div>
        </div>
      </section>
    </>
  )
}
