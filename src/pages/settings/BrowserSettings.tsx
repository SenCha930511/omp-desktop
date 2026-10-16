import { RotateCcw } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import type { SettingsSectionProps } from './contracts'
import { DraftSettingField } from './DraftSettingField'
import { browserHomeValidation, normalizeBrowserHome } from './draft-state'
import { SettingsToggle } from './SettingsToggle'

interface BrowserSettingsProps extends SettingsSectionProps {
  onRequestReset(): void
}

export function BrowserSettings({ settings, onUpdate, onRequestReset }: BrowserSettingsProps) {
  const { t } = useI18n()
  return (
    <>
      <header>
        <h1>{t('browser.title')}</h1>
        <p>{t('browser.description')}</p>
      </header>
      <section className="settings-group">
        <h2>{t('browser.startup')}</h2>
        <DraftSettingField
          id="browser-home"
          label={t('browser.home.label')}
          description={t('browser.home.description')}
          committedValue={settings.browserHome}
          validate={(value) => browserHomeValidation(value, t)}
          normalize={normalizeBrowserHome}
          onCommit={(browserHome) => onUpdate({ browserHome })}
        />
        <SettingsToggle
          checked={settings.browserAskForDownloads}
          onChange={(browserAskForDownloads) => {
            void onUpdate({ browserAskForDownloads })
          }}
          label={t('browser.downloads.label')}
          description={t('browser.downloads.description')}
        />
      </section>
      <section className="settings-group">
        <h2>{t('browser.data')}</h2>
        <div className="danger-row">
          <span>
            <strong>{t('browser.clear.label')}</strong>
            <small>{t('browser.clear.description')}</small>
          </span>
          <button type="button" className="button" onClick={onRequestReset}>
            <RotateCcw size={13} /> {t('browser.clear.button')}
          </button>
        </div>
      </section>
    </>
  )
}
