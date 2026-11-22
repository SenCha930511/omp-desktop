import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS } from '@/lib/data'
import {
  confirmedPanelSettings,
  PANEL_SETTING_KEYS,
  type PanelSettingKey,
} from '@/lib/settings-state'
import type { AppSettings, InspectorTab, DesktopApi } from '@/types/api'

interface UseAppSettingsOptions {
  bridge: DesktopApi | null
  reportError(error: unknown): void
}

export const INSPECTOR_OPEN_TABS_KEY = 'omp-desktop.inspector-open-tabs'
export const INSPECTOR_ACTIVE_TAB_KEY = 'omp-desktop.inspector-active-tab'

const PERSISTENT_INSPECTOR_TABS: readonly InspectorTab[] = ['changes', 'browser', 'files', 'agents', 'tasks']

const isPersistentInspectorTab = (value: unknown): value is InspectorTab =>
  typeof value === 'string' && PERSISTENT_INSPECTOR_TABS.includes(value as InspectorTab)

export function readInitialInspectorTabs(): InspectorTab[] {
  if (typeof window === 'undefined') return ['changes']
  try {
    const raw = window.localStorage.getItem(INSPECTOR_OPEN_TABS_KEY)
    if (raw === null) return ['changes']
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return ['changes']
    const valid: InspectorTab[] = []
    for (const item of parsed) {
      if (isPersistentInspectorTab(item) && !valid.includes(item)) valid.push(item)
    }
    return valid
  } catch {
    return ['changes']
  }
}

export function readInitialActiveTab(openTabs: InspectorTab[]): InspectorTab {
  if (typeof window === 'undefined') return openTabs[0] ?? 'changes'
  const stored = window.localStorage.getItem(INSPECTOR_ACTIVE_TAB_KEY)
  if (isPersistentInspectorTab(stored) && openTabs.includes(stored)) return stored
  return openTabs[0] ?? 'changes'
}

export function useAppSettings({ bridge, reportError }: UseAppSettingsOptions) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [initialized, setInitialized] = useState(!bridge)
  const [sidebarOpen, setSidebarOpenState] = useState(true)
  const [inspectorOpen, setInspectorOpenState] = useState(true)
  const [inspectorOpenTabs, setInspectorOpenTabs] = useState<InspectorTab[]>(readInitialInspectorTabs)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(() => readInitialActiveTab(inspectorOpenTabs))
  const [inspectorTabRevision, setInspectorTabRevision] = useState(0)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const confirmedSettingsRef = useRef(settings)
  const settingsMutationRef = useRef(0)
  const settingsQueueRef = useRef<Promise<void>>(Promise.resolve())
  const transientPanelKeysRef = useRef<Set<PanelSettingKey>>(new Set())
  // The checkout catalog is served by the main process, which reads the
  // confirmed settings. The optimistic renderer value can refresh before that
  // write lands, so a confirmed strategy change bumps this revision and the
  // catalog effect runs again.
  const [checkoutStrategyRevision, setCheckoutStrategyRevision] = useState(0)

  const setSidebarOpen = useCallback((value: boolean) => {
    transientPanelKeysRef.current.add('sidebarOpen')
    setSidebarOpenState(value)
  }, [])
  const setInspectorOpen = useCallback((value: boolean) => {
    transientPanelKeysRef.current.add('inspectorOpen')
    setInspectorOpenState(value)
  }, [])

  const applySettings = useCallback((next: AppSettings, panelPatch: Partial<AppSettings>) => {
    settingsRef.current = next
    setSettings(next)
    if ('sidebarOpen' in panelPatch) setSidebarOpenState(next.sidebarOpen)
    if ('inspectorOpen' in panelPatch) setInspectorOpenState(next.inspectorOpen)
  }, [])

  const takeConfirmedPanelPatch = useCallback((next: AppSettings) => {
    const keys = PANEL_SETTING_KEYS.filter((key) => !transientPanelKeysRef.current.has(key))
    transientPanelKeysRef.current.clear()
    return confirmedPanelSettings(next, keys)
  }, [])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const mutation = ++settingsMutationRef.current
    const previous = settingsRef.current
    for (const key of PANEL_SETTING_KEYS) if (key in patch) transientPanelKeysRef.current.delete(key)
    applySettings({ ...previous, ...patch }, patch)
    if (!bridge) {
      confirmedSettingsRef.current = settingsRef.current
      transientPanelKeysRef.current.clear()
      return
    }
    const operation = settingsQueueRef.current.catch(() => undefined).then(async () => {
      const saved = await bridge.settings.update(patch)
      const previousStrategy = confirmedSettingsRef.current.checkoutStrategy
      confirmedSettingsRef.current = saved
      if (settingsMutationRef.current === mutation) applySettings(saved, takeConfirmedPanelPatch(saved))
      if (saved.checkoutStrategy !== previousStrategy) setCheckoutStrategyRevision((revision) => revision + 1)
    })
    settingsQueueRef.current = operation.catch(() => undefined)
    try {
      await operation
    } catch (error) {
      if (settingsMutationRef.current === mutation) applySettings(confirmedSettingsRef.current, takeConfirmedPanelPatch(confirmedSettingsRef.current))
      reportError(error)
    }
  }, [applySettings, bridge, reportError, takeConfirmedPanelPatch])

  const reconcileExternalSettings = useCallback(async <T extends { settings: AppSettings }>(
    operation: () => Promise<T | null>,
  ): Promise<T | null> => {
    // Start the external transaction only after locally queued settings have
    // persisted, so its returned snapshot cannot predate them.
    await settingsQueueRef.current
    const revision = settingsMutationRef.current
    const result = await operation()
    if (!result) return null
    const previousStrategy = confirmedSettingsRef.current.checkoutStrategy
    confirmedSettingsRef.current = result.settings
    if (result.settings.checkoutStrategy !== previousStrategy) setCheckoutStrategyRevision((revision) => revision + 1)
    // A new optimistic mutation started while the external operation ran.
    // Keep it visible; its queued result will become the next authority.
    if (settingsMutationRef.current === revision) {
      transientPanelKeysRef.current.clear()
      applySettings(result.settings, result.settings)
    }
    return result
  }, [applySettings])

  useEffect(() => {
    if (!bridge) {
      setInitialized(true)
      return
    }
    setInitialized(false)
    let cancelled = false
    const startupRevision = settingsMutationRef.current
    void bridge.settings.get().then((value) => {
      if (cancelled || settingsMutationRef.current !== startupRevision) return
      confirmedSettingsRef.current = value
      applySettings(value, value)
    }).catch((error) => { if (!cancelled) reportError(error) }).finally(() => {
      if (!cancelled) setInitialized(true)
    })
    return () => { cancelled = true }
  }, [applySettings, bridge, reportError])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = (theme: 'light' | 'dark') => {
      document.documentElement.dataset.theme = theme
      void bridge?.app?.setTitleBarTheme?.(theme)?.catch(() => undefined)
    }
    applyTheme(settings.theme === 'system' ? media.matches ? 'dark' : 'light' : settings.theme)
    document.documentElement.classList.toggle('reduce-motion', settings.reduceMotion)
    document.documentElement.dataset.accent = settings.accentColor
    const sync = () => {
      if (settings.theme === 'system') applyTheme(media.matches ? 'dark' : 'light')
    }
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [bridge, settings.accentColor, settings.reduceMotion, settings.theme])

  useEffect(() => {
    const persistedTabs = inspectorOpenTabs.filter((tab) => tab !== 'sidechat')
    window.localStorage.setItem(INSPECTOR_OPEN_TABS_KEY, JSON.stringify(persistedTabs))
    if (inspectorTab !== 'sidechat' && persistedTabs.includes(inspectorTab)) {
      window.localStorage.setItem(INSPECTOR_ACTIVE_TAB_KEY, inspectorTab)
    } else if (persistedTabs.length === 0) {
      window.localStorage.removeItem(INSPECTOR_ACTIVE_TAB_KEY)
    }
  }, [inspectorOpenTabs, inspectorTab])

  const ensureInspectorTabOpen = useCallback((tab: InspectorTab) => {
    setInspectorOpenTabs((current) => (current.includes(tab) ? current : [...current, tab]))
    setInspectorTab(tab)
    setInspectorTabRevision((value) => value + 1)
  }, [])

  const selectInspectorTab = useCallback((tab: InspectorTab) => {
    ensureInspectorTabOpen(tab)
  }, [ensureInspectorTabOpen])

  const closeInspectorTab = useCallback((tab: InspectorTab) => {
    setInspectorOpenTabs((current) => {
      const index = current.indexOf(tab)
      if (index === -1) return current
      const next = current.filter((item) => item !== tab)
      setInspectorTab((active) => {
        if (active !== tab) return active
        return next[Math.min(index, next.length - 1)] ?? 'changes'
      })
      return next
    })
  }, [])

  const closeOtherInspectorTabs = useCallback((tab: InspectorTab) => {
    setInspectorOpenTabs((current) => (current.includes(tab) ? [tab] : current))
    setInspectorTab(tab)
  }, [])

  const reorderInspectorTabs = useCallback((sourceTab: InspectorTab, targetTab: InspectorTab) => {
    if (sourceTab === targetTab) return
    setInspectorOpenTabs((current) => {
      const sourceIndex = current.indexOf(sourceTab)
      const targetIndex = current.indexOf(targetTab)
      if (sourceIndex === -1 || targetIndex === -1) return current
      const next = [...current]
      const [moved] = next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, moved)
      return next
    })
  }, [])

  return {
    settings,
    initialized,
    checkoutStrategyRevision,
    sidebarOpen,
    setSidebarOpen,
    inspectorOpen,
    setInspectorOpen,
    inspectorOpenTabs,
    inspectorTab,
    inspectorTabRevision,
    selectInspectorTab,
    ensureInspectorTabOpen,
    closeInspectorTab,
    closeOtherInspectorTabs,
    reorderInspectorTabs,
    updateSettings,
    reconcileExternalSettings,
  }
}
