import { describe, expect, it } from 'vitest'
import { resolveLocale, translate } from '../../src/lib/i18n'

describe('i18n', () => {
  it('detects Simplified and Traditional Chinese system locales separately', () => {
    expect(resolveLocale('system', ['zh-CN'])).toBe('zh-CN')
    expect(resolveLocale('system', ['zh-Hans-US'])).toBe('zh-CN')
    expect(resolveLocale('system', ['zh-TW', 'en-US'])).toBe('zh-TW')
    expect(resolveLocale('system', ['zh-Hant-US'])).toBe('zh-TW')
    expect(resolveLocale('system', ['zh-HK'])).toBe('zh-TW')
    expect(resolveLocale('system', ['fr-FR', 'zh-SG'])).toBe('zh-CN')
  })

  it('uses the first supported system locale in preference order', () => {
    expect(resolveLocale('system', ['en-US', 'bg-US', 'zh-Hans-US'])).toBe('en')
    expect(resolveLocale('system', ['zh-Hans-US', 'en-US'])).toBe('zh-CN')
    expect(resolveLocale('system', ['en-US', 'zh-Hant-TW'])).toBe('en')
  })

  it('honors an explicit locale preference over the system locale', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en')
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(resolveLocale('zh-TW', ['en-US'])).toBe('zh-TW')
  })

  it('interpolates values, selects plural forms, and falls back to English', () => {
    expect(translate('en', 'appearance.language.available', { count: 1 })).toBe('1 language available')
    expect(translate('en', 'appearance.language.available', { count: 2 })).toBe('2 languages available')
    expect(translate('zh-CN', 'appearance.language.available', { count: 2 })).toBe('支持 2 种语言')
    expect(translate('zh-TW', 'appearance.language.available', { count: 2 })).toBe('支援 2 種語言')
    expect(translate('zh-TW', 'settings.terminal')).toBe('終端機')
    expect(translate('zh-TW', 'common.reload')).toBe('Reload OMP Desktop')
  })
})
