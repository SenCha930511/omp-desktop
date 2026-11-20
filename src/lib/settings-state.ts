import type { AppSettings } from '@/types/api'

export interface PanelSettings {
  sidebarOpen: boolean
  inspectorOpen: boolean
}

export type PanelSettingKey = keyof PanelSettings

export const PANEL_SETTING_KEYS: PanelSettingKey[] = ['sidebarOpen', 'inspectorOpen']

export function confirmedPanelSettings(
  settings: AppSettings,
  keys: Iterable<PanelSettingKey> = PANEL_SETTING_KEYS,
): Partial<PanelSettings> {
  const panels: Partial<PanelSettings> = {}
  for (const key of keys) panels[key] = settings[key]
  return panels
}
