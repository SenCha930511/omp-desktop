import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import type { LocalePreference } from '@/types/api'
import type { Message } from '@/i18n/define'
import { coreFragment } from '@/i18n/keys/core'
import { sidebarFragment } from '@/i18n/keys/sidebar'
import { workbenchFragment } from '@/i18n/keys/workbench'
import { transcriptFragment } from '@/i18n/keys/transcript'
import { settingsFragment } from '@/i18n/keys/settings'
import { panelsFragment } from '@/i18n/keys/panels'

type MessageValues = Record<string, string | number>

const englishCatalog = {
  ...coreFragment.en,
  ...sidebarFragment.en,
  ...workbenchFragment.en,
  ...transcriptFragment.en,
  ...settingsFragment.en,
  ...panelsFragment.en,
} satisfies Record<string, Message>

export type MessageKey = keyof typeof englishCatalog
export type ResolvedLocale = 'en' | 'zh-CN' | 'zh-TW'

const simplifiedChineseCatalog: Partial<Record<MessageKey, Message>> = {
  ...coreFragment['zh-CN'],
  ...sidebarFragment['zh-CN'],
  ...workbenchFragment['zh-CN'],
  ...transcriptFragment['zh-CN'],
  ...settingsFragment['zh-CN'],
  ...panelsFragment['zh-CN'],
}

const traditionalChineseCatalog: Partial<Record<MessageKey, Message>> = {
  ...coreFragment['zh-TW'],
  ...sidebarFragment['zh-TW'],
  ...workbenchFragment['zh-TW'],
  ...transcriptFragment['zh-TW'],
  ...settingsFragment['zh-TW'],
  ...panelsFragment['zh-TW'],
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages.length ? navigator.languages : [navigator.language]
}

export function resolveLocale(preference: LocalePreference, languages: readonly string[] = browserLanguages()): ResolvedLocale {
  if (preference !== 'system') return preference
  for (const language of languages) {
    const normalized = language.toLowerCase()
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
    if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-sg' || normalized === 'zh-hans' || normalized.startsWith('zh-hans-')) return 'zh-CN'
    if (normalized === 'zh-tw' || normalized === 'zh-hk' || normalized === 'zh-mo' || normalized === 'zh-hant' || normalized.startsWith('zh-hant-')) return 'zh-TW'
  }
  return 'en'
}

export function translate(locale: ResolvedLocale, key: MessageKey, values: MessageValues = {}): string {
  const catalog = locale === 'zh-CN' ? simplifiedChineseCatalog : locale === 'zh-TW' ? traditionalChineseCatalog : undefined
  const translated = catalog?.[key]
  const message = translated ?? englishCatalog[key]
  const template = typeof message === 'string'
    ? message
    : message[new Intl.PluralRules(locale).select(Number(values.count)) === 'one' ? 'one' : 'other']
  return Object.entries(values).reduce((result, [name, value]) => result.split(`{${name}}`).join(String(value)), template)
}

interface I18nContextValue {
  locale: ResolvedLocale
  t(key: MessageKey, values?: MessageValues): string
}

const I18nContext = createContext<I18nContextValue>({ locale: 'en', t: (key, values) => translate('en', key, values) })

export function I18nProvider({ preference, children }: { preference: LocalePreference; children: ReactNode }) {
  const locale = resolveLocale(preference)
  const value = useMemo<I18nContextValue>(() => ({ locale, t: (key, values) => translate(locale, key, values) }), [locale])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}
