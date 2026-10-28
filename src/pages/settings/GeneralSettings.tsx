import { useI18n } from '@/lib/i18n'
import type { AppSettings } from '@/types/api'
import type { SettingsSectionProps } from './contracts'
import { SettingsToggle } from './SettingsToggle'

export function GeneralSettings({ settings, onUpdate, platform }: SettingsSectionProps & { platform: NodeJS.Platform }) {
  const { t } = useI18n()
  return (
    <>
      <header>
        <h1>{t('general.title')}</h1>
        <p>{t('general.description')}</p>
      </header>
      <section className="settings-group">
        <h2>{t('general.window')}</h2>
        <label className="settings-row">
          <span><strong>{t('general.density.label')}</strong><small>{t('general.density.description')}</small></span>
          <select aria-label={t('general.density.label')} value={settings.conversationDensity} onChange={(event) => {
            const conversationDensity = event.target.value
            if (conversationDensity === 'compact' || conversationDensity === 'comfortable') void onUpdate({ conversationDensity })
          }}>
            <option value="comfortable">{t('general.density.comfortable')}</option>
            <option value="compact">{t('general.density.compact')}</option>
          </select>
        </label>
        <SettingsToggle
          checked={settings.sidebarOpen}
          onChange={(sidebarOpen) => {
            void onUpdate({ sidebarOpen })
          }}
          label={t('general.sidebar.label')}
          description={t('general.sidebar.description')}
        />
        <SettingsToggle
          checked={settings.inspectorOpen}
          onChange={(inspectorOpen) => {
            void onUpdate({ inspectorOpen })
          }}
          label={t('general.inspector.label')}
          description={t('general.inspector.description')}
        />
        <SettingsToggle
          checked={settings.showFileChangesPopup}
          onChange={(showFileChangesPopup) => {
            void onUpdate({ showFileChangesPopup })
          }}
          label={t('general.fileChanges.label')}
          description={t('general.fileChanges.description')}
        />
      </section>
      {platform === 'darwin' ? (
        <section className="settings-group">
          <h2>{t('general.startup')}</h2>
          <SettingsToggle
            checked={settings.keepRunningInBackground}
            onChange={(keepRunningInBackground) => {
              void onUpdate({ keepRunningInBackground })
            }}
            label={t('general.background.label')}
            description={t('general.background.description')}
          />
          <SettingsToggle
            checked={settings.launchAtLogin}
            onChange={(launchAtLogin) => {
              void onUpdate({ launchAtLogin })
            }}
            label={t('general.launchAtLogin.label')}
            description={t('general.launchAtLogin.description')}
          />
        </section>
      ) : null}
      <section className="settings-group">
        <h2>{t('general.sessionDefaults')}</h2>
        <label className="settings-row">
          <span>
            <strong>{t('general.checkout.label')}</strong>
            <small>{t('general.checkout.description')}</small>
          </span>
          <select
            value={settings.checkoutStrategy}
            onChange={(event) => {
              const checkoutStrategy = event.target.value
              if (checkoutStrategy === 'worktree' || checkoutStrategy === 'branch') void onUpdate({ checkoutStrategy })
            }}
          >
            <option value="worktree">{t('general.checkout.worktrees')}</option>
            <option value="branch">{t('general.checkout.branches')}</option>
          </select>
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('general.idleSessions.label')}</strong>
            <small>{t('general.idleSessions.description')}</small>
          </span>
          <select
            aria-label={t('general.idleSessions.label')}
            value={String(settings.idleSessionMinutes)}
            onChange={(event) => {
              void onUpdate({ idleSessionMinutes: Number(event.target.value) as AppSettings['idleSessionMinutes'] })
            }}
          >
            <option value="5">{t('general.idleSessions.minutes', { count: 5 })}</option>
            <option value="15">{t('general.idleSessions.minutes', { count: 15 })}</option>
            <option value="30">{t('general.idleSessions.minutes', { count: 30 })}</option>
            <option value="0">{t('general.idleSessions.never')}</option>
          </select>
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('general.inspectorTab.label')}</strong>
            <small>{t('general.inspectorTab.description')}</small>
          </span>
          <select
            value={settings.defaultInspectorTab}
            onChange={(event) => {
              void onUpdate({ defaultInspectorTab: event.target.value as AppSettings['defaultInspectorTab'] })
            }}
          >
            <option value="summary">{t('general.inspectorTab.summary')}</option>
            <option value="changes">{t('general.inspectorTab.changes')}</option>
            <option value="browser">{t('general.inspectorTab.browser')}</option>
            <option value="files">{t('general.inspectorTab.files')}</option>
          </select>
        </label>
      </section>
    </>
  )
}
