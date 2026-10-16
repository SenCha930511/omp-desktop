import { Keyboard } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import type { SettingsSectionProps } from './contracts'
import { DraftSettingField } from './DraftSettingField'
import { terminalShellValidation } from './draft-state'
import { SettingsToggle } from './SettingsToggle'

export function TerminalSettings({ settings, onUpdate, platform = 'darwin' }: SettingsSectionProps & { platform?: NodeJS.Platform }) {
  const { t } = useI18n()
  return (
    <>
      <header>
        <h1>{t('terminal.title')}</h1>
        <p>{t('terminal.description')}</p>
      </header>
      <section className="settings-group">
        <h2>{t('terminal.shell')}</h2>
        <DraftSettingField
          id="terminal-shell"
          label={t('terminal.shell.label')}
          description={t('terminal.shell.description')}
          committedValue={settings.terminalShell}
          validate={(value) => terminalShellValidation(value, t)}
          onCommit={(terminalShell) => onUpdate({ terminalShell })}
          className="mono"
        />
        <SettingsToggle
          checked={settings.terminalOpen}
          onChange={(terminalOpen) => {
            void onUpdate({ terminalOpen })
          }}
          label={t('terminal.open.label')}
          description={t('terminal.open.description')}
        />
      </section>
      <section className="settings-group">
        <h2>{t('terminal.shortcut')}</h2>
        <div className="shortcut-row">
          <span>
            <Keyboard size={14} />
            {t('terminal.shortcut.toggle')}
          </span>
          <kbd>{shortcutLabel(platform, ['Primary', 'J'])}</kbd>
        </div>
      </section>
    </>
  )
}
