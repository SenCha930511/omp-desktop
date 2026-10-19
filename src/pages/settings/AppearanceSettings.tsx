import { Check, Laptop, Moon, Sun } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { type MessageKey, useI18n } from '@/lib/i18n'
import type { AccentColor, InterfaceFontScale, LocalePreference, ThemeMode } from '@/types/api'
import { ACCENT_COLORS } from '@/types/api'
import type { SettingsSectionProps } from './contracts'
import { SettingsToggle } from './SettingsToggle'

const themes: Array<{ id: ThemeMode; label: MessageKey; icon: typeof Sun }> = [
  { id: 'system', label: 'appearance.theme.system', icon: Laptop },
  { id: 'light', label: 'appearance.theme.light', icon: Sun },
  { id: 'dark', label: 'appearance.theme.dark', icon: Moon },
]

/** Swatch previews use each accent's light-theme token so the circle matches
 * the hue it applies; the labels localize. */
const ACCENT_SWATCHES: Record<AccentColor, { hex: string; label: MessageKey }> = {
  prime: { hex: '#5f4bd3', label: 'appearance.accent.prime' },
  blue: { hex: '#2563eb', label: 'appearance.accent.blue' },
  teal: { hex: '#0d9488', label: 'appearance.accent.teal' },
  green: { hex: '#1e8e3e', label: 'appearance.accent.green' },
  orange: { hex: '#ea580c', label: 'appearance.accent.orange' },
  pink: { hex: '#db2777', label: 'appearance.accent.pink' },
}

const fontScales: Array<{ value: InterfaceFontScale; label: MessageKey }> = [
  { value: 105, label: 'appearance.text.smaller' },
  { value: 110, label: 'appearance.text.default' },
  { value: 115, label: 'appearance.text.larger' },
]

const locales: Array<{ value: LocalePreference; label: MessageKey }> = [
  { value: 'system', label: 'appearance.language.system' },
  { value: 'en', label: 'appearance.language.english' },
  { value: 'zh-CN', label: 'appearance.language.chinese' },
  { value: 'zh-TW', label: 'appearance.language.chineseTraditional' },
]

/** Arrow/Home/End movement inside a radio group selects as it moves. */
function nextScaleIndex(key: string, current: number, count: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

export function AppearanceSettings({ settings, onUpdate }: SettingsSectionProps) {
  const { t } = useI18n()
  const selectedScale = Math.max(
    0,
    fontScales.findIndex((option) => option.value === settings.interfaceFontScale),
  )
  const onScaleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextScaleIndex(event.key, selectedScale, fontScales.length)
    if (next === null) return
    event.preventDefault()
    const target = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]
    target?.focus()
    void onUpdate({ interfaceFontScale: fontScales[next].value })
  }
  return (
    <>
      <header>
        <h1>{t('appearance.title')}</h1>
        <p>{t('appearance.description')}</p>
      </header>
      <section className="settings-group">
        <h2>{t('appearance.theme.title')}</h2>
        <div className="theme-options">
          {themes.map((item) => {
            const Icon = item.icon
            return (
              <button
                type="button"
                key={item.id}
                className={settings.theme === item.id ? 'is-active' : ''}
                onClick={() => {
                  void onUpdate({ theme: item.id })
                }}
              >
                <span>
                  <Icon size={17} />
                </span>
                <strong>{t(item.label)}</strong>
                {settings.theme === item.id ? <Check size={13} /> : null}
              </button>
            )
          })}
        </div>
      </section>
      <section className="settings-group">
        <h2>{t('appearance.accent.title')}</h2>
        <div className="settings-row">
          <span>
            <strong>{t('appearance.accent.title')}</strong>
            <small>{t('appearance.accent.description')}</small>
          </span>
          <div className="accent-options" role="radiogroup" aria-label={t('appearance.accent.aria')}>
            {ACCENT_COLORS.map((color) => (
              <button
                type="button"
                key={color}
                role="radio"
                aria-checked={settings.accentColor === color}
                aria-label={t(ACCENT_SWATCHES[color].label)}
                title={t(ACCENT_SWATCHES[color].label)}
                className={settings.accentColor === color ? 'is-active' : ''}
                onClick={() => {
                  void onUpdate({ accentColor: color })
                }}
              >
                <span className="accent-swatch" style={{ backgroundColor: ACCENT_SWATCHES[color].hex }} />
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="settings-group">
        <h2>{t('appearance.language.title')}</h2>
        <label className="settings-row">
          <span>
            <strong>{t('appearance.language.label')}</strong>
            <small>
              {t('appearance.language.description')} {t('appearance.language.available', { count: locales.length - 1 })}
            </small>
          </span>
          <select
            value={settings.locale}
            onChange={(event) => {
              void onUpdate({ locale: event.target.value as LocalePreference })
            }}
          >
            {locales.map((locale) => (
              <option key={locale.value} value={locale.value}>
                {t(locale.label)}
              </option>
            ))}
          </select>
        </label>
      </section>
      <section className="settings-group">
        <h2>{t('appearance.text.title')}</h2>
        <div className="settings-row settings-row--text-size">
          <span>
            <strong>{t('appearance.text.label')}</strong>
            <small>{t('appearance.text.description')}</small>
          </span>
          <div className="text-size-options" role="radiogroup" aria-label={t('appearance.text.aria')} onKeyDown={onScaleKeyDown}>
            {fontScales.map((option, index) => (
              <button
                type="button"
                key={option.value}
                role="radio"
                aria-checked={settings.interfaceFontScale === option.value}
                tabIndex={index === selectedScale ? 0 : -1}
                className={settings.interfaceFontScale === option.value ? 'is-active' : ''}
                onClick={() => {
                  void onUpdate({ interfaceFontScale: option.value })
                }}
              >
                {t(option.label)}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="settings-group">
        <h2>{t('appearance.motion.title')}</h2>
        <SettingsToggle
          checked={settings.reduceMotion}
          onChange={(reduceMotion) => {
            void onUpdate({ reduceMotion })
          }}
          label={t('appearance.motion.reduce')}
          description={t('appearance.motion.description')}
        />
      </section>
    </>
  )
}
