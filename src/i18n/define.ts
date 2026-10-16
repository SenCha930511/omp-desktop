/**
 * Shared vocabulary for the locale catalogs. Each surface of the UI owns one
 * fragment file under src/i18n/keys/ so independent changes never conflict.
 * `en` is the complete source of truth (and must keep the exact user-facing
 * English text the tests assert); the Chinese variants are partial and fall
 * back to English key-by-key at runtime. The generic infers only the key
 * union so localized values stay freely typed as Message while their keys are
 * still checked against the English fragment.
 */
export type Message = string | { one: string; other: string }

export function defineCatalogFragment<const Keys extends string>(fragment: { en: Record<Keys, Message>; 'zh-TW'?: Partial<Record<Keys, Message>>; 'zh-CN'?: Partial<Record<Keys, Message>> }) {
  return fragment
}
