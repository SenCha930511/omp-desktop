import { Brain, Check, ChevronDown, Search, Zap } from 'lucide-react'
import { memo, type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import type { PrimeModelDescriptor, PrimeModelPresetRecord, PrimeProviderDescriptor } from '@/types/api'

interface ModelPickerProps {
  value: string
  modelsByProvider: ReadonlyMap<string, PrimeModelDescriptor[]>
  providers: PrimeProviderDescriptor[]
  onChange(value: string): void
  /** Harness model presets surfaced from the harness config. */
  presets?: PrimeModelPresetRecord[]
  onSwitchPreset?(preset: PrimeModelPresetRecord): void
  onSavePreset?(name: string): void
}

interface ModelGroup {
  provider: PrimeProviderDescriptor
  models: PrimeModelDescriptor[]
}

export const ModelPicker = memo(function ModelPicker({ value, modelsByProvider, providers, onChange, presets = [], onSwitchPreset, onSavePreset }: ModelPickerProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [saveName, setSaveName] = useState('')
  // null, not a string sentinel: harness catalogs are user-authored, so a
  // provider whose id is literally "all" must still filter to itself.
  const [providerFilter, setProviderFilter] = useState<string | null>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const groups = useMemo<ModelGroup[]>(
    () => providers.filter((provider) => (modelsByProvider.get(provider.id)?.length ?? 0) > 0).map((provider) => ({ provider, models: modelsByProvider.get(provider.id) ?? [] })),
    [modelsByProvider, providers],
  )
  const selected = useMemo(() => groups.flatMap((group) => group.models).find((model) => model.key === value), [groups, value])
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return groups.flatMap((group) => {
      if (providerFilter !== null && providerFilter !== group.provider.id) return []
      const providerText = `${group.provider.name} ${group.provider.id}`.toLocaleLowerCase()
      const models = needle ? group.models.filter((model) => `${model.name} ${model.id} ${model.key} ${providerText}`.toLocaleLowerCase().includes(needle)) : group.models
      return models.length ? [{ provider: group.provider, models }] : []
    })
  }, [groups, providerFilter, query])
  const visibleModels = useMemo(() => visibleGroups.flatMap((group) => group.models), [visibleGroups])
  const navigableModels = useMemo(() => visibleModels.filter((model) => model.available), [visibleModels])
  // Presets ride the query but never the provider filter — a preset spans
  // providers, so hiding it behind one would be wrong.
  const visiblePresets = useMemo(() => {
    if (!onSwitchPreset || providerFilter !== null) return []
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return presets
    return presets.filter((preset) => `${preset.name} ${Object.keys(preset.modelRoles).join(' ')} ${Object.values(preset.modelRoles).join(' ')}`.toLocaleLowerCase().includes(needle))
  }, [presets, providerFilter, query, onSwitchPreset])
  const presetNavKey = (preset: PrimeModelPresetRecord) => `preset:${preset.name}`
  const navigableKeys = useMemo(() => [...navigableModels.map((model) => model.key), ...visiblePresets.map(presetNavKey)], [visiblePresets, navigableModels])
  // The open reset reads the catalog through a ref: a background catalog
  // refresh must not wipe a query the user is still typing.
  const catalogRef = useRef({ groups, selected })
  catalogRef.current = { groups, selected }

  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const choose = (model: PrimeModelDescriptor | undefined) => {
    if (!model?.available) return
    onChange(model.key)
    close(true)
  }
  const moveActive = (direction: 1 | -1) => {
    if (!navigableKeys.length) return
    const current = navigableKeys.indexOf(activeKey ?? '')
    const next = current < 0 ? (direction > 0 ? 0 : navigableKeys.length - 1) : (current + direction + navigableKeys.length) % navigableKeys.length
    setActiveKey(navigableKeys[next])
  }

  useEffect(() => {
    if (!open) return
    const { groups: openGroups, selected: openSelected } = catalogRef.current
    setQuery('')
    setProviderFilter(null)
    setActiveKey(openSelected?.available ? openSelected.key : (openGroups.flatMap((group) => group.models).find((model) => model.available)?.key ?? null))
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [open])

  useEffect(() => {
    if (!open) return
    if (!navigableKeys.includes(activeKey ?? '')) setActiveKey(navigableKeys[0] ?? null)
  }, [activeKey, navigableKeys, open])

  useEffect(() => {
    if (!open || !activeKey) return
    document.getElementById(`${listId}-${activeKey}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeKey, listId, open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveActive(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(-1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveKey(navigableKeys[0] ?? null)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveKey(navigableKeys.at(-1) ?? null)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const preset = activeKey ? visiblePresets.find((candidate) => presetNavKey(candidate) === activeKey) : undefined
      if (preset && onSwitchPreset) {
        onSwitchPreset(preset)
        close(true)
        return
      }
      choose(navigableModels.find((model) => model.key === activeKey))
    }
    // Escape is owned by the popover container so it also dismisses from the
    // provider filters and the options, matching the native select it replaces.
  }

  const resultCount = visibleModels.length + visiblePresets.length
  return (
    <div className="model-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="permissions-chip model-picker__trigger"
        aria-label={t('modelPicker.selected', { name: selected?.name ?? t('modelPicker.none') })}
        title={selected?.name ?? t('modelPicker.none')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={!groups.length}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <Brain size={14} />
        <span>{selected?.name ?? t('modelPicker.none')}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="model-picker__popover"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            close(true)
          }}
          onBlur={(event) => {
            // Tabbing past the filters must dismiss like the native select did.
            // A null relatedTarget means focus left the document entirely (app
            // switch), which keeps the popover and the typed query alive.
            const next = event.relatedTarget
            if (next instanceof Node && !rootRef.current?.contains(next)) close()
          }}
        >
          <div className="model-picker__search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              role="combobox"
              aria-label={t('modelPicker.search')}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeKey ? `${listId}-${activeKey}` : undefined}
              placeholder={t('modelPicker.search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            <span className="model-picker__count" aria-live="polite">
              <span aria-hidden="true">{resultCount}</span>
              <span className="sr-only">{t('modelPicker.listed', { count: visibleModels.length })}{visiblePresets.length ? ` · ${t('modelPicker.presetCount', { count: visiblePresets.length })}` : ''}</span>
            </span>
          </div>
          <div className="model-picker__providers" role="group" aria-label={t('modelPicker.filterByProvider')}>
            <button type="button" className={providerFilter === null ? 'is-active' : ''} aria-pressed={providerFilter === null} onClick={() => setProviderFilter(null)}>
              {t('modelPicker.all')}
            </button>
            {groups.map(({ provider }) => (
              <button
                type="button"
                key={provider.id}
                className={providerFilter === provider.id ? 'is-active' : ''}
                aria-pressed={providerFilter === provider.id}
                onClick={() => setProviderFilter(provider.id)}
              >
                {provider.name}
              </button>
            ))}
          </div>
          <div className="model-picker__results" id={listId} role="listbox" aria-label={t('modelPicker.models')}>
            {visibleGroups.map(({ provider, models }) => (
              <div className="model-picker__group" role="group" aria-label={provider.name} key={provider.id}>
                <div className="model-picker__group-heading">
                  <span>{provider.name}</span>
                  <small>{provider.configured ? t('modelPicker.modelCount', { count: models.length }) : t('modelPicker.notConnected')}</small>
                </div>
                {models.map((candidate) => {
                  const isSelected = candidate.key === value
                  const isActive = candidate.key === activeKey
                  return (
                    <button
                      type="button"
                      tabIndex={-1}
                      role="option"
                      id={`${listId}-${candidate.key}`}
                      key={candidate.key}
                      aria-selected={isSelected}
                      aria-disabled={!candidate.available}
                      className={`model-picker__option${isSelected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}
                      onMouseMove={() => {
                        if (candidate.available) setActiveKey(candidate.key)
                      }}
                      onClick={() => choose(candidate)}
                    >
                      <span className="model-picker__check">{isSelected ? <Check size={13} /> : null}</span>
                      <span className="model-picker__identity">
                        <strong>{candidate.name}</strong>
                        <small>{candidate.id}</small>
                      </span>
                      {!candidate.available ? <span className="model-picker__availability">{t('modelPicker.connect')}</span> : null}
                    </button>
                  )
                })}
              </div>
            ))}
            {visiblePresets.length > 0 ? (
              <div className="model-picker__group model-picker__group--presets" role="group" aria-label={t('modelPicker.presets')}>
                <div className="model-picker__group-heading">
                  <span>{t('modelPicker.presets')}</span>
                  <small>{t('modelPicker.presetCount', { count: visiblePresets.length })}</small>
                </div>
                {visiblePresets.map((preset) => {
                  const isActive = presetNavKey(preset) === activeKey
                  const roles = Object.keys(preset.modelRoles).length
                  return (
                    <button
                      type="button"
                      tabIndex={-1}
                      role="option"
                      id={`${listId}-${presetNavKey(preset)}`}
                      key={preset.name}
                      aria-selected={false}
                      aria-label={t('modelPicker.presetSwitch', { name: preset.name })}
                      className={`model-picker__option model-picker__option--preset${isActive ? ' is-active' : ''}`}
                      onMouseMove={() => setActiveKey(presetNavKey(preset))}
                      onClick={() => { onSwitchPreset?.(preset); close(true) }}
                    >
                      <span className="model-picker__check"><Zap size={13} /></span>
                      <span className="model-picker__identity">
                        <strong>{preset.name}</strong>
                        <small>{preset.modelRoles.default ?? t('modelPicker.presetRoles', { count: roles })}{preset.defaultThinkingLevel && !preset.modelRoles.default?.endsWith(`:${preset.defaultThinkingLevel}`) ? ` · ${preset.defaultThinkingLevel}` : ''}</small>
                      </span>
                    </button>
                  )
                })}
                {onSavePreset ? (
                  <div className="model-picker__preset-save">
                    <input
                      value={saveName}
                      maxLength={64}
                      placeholder={t('modelPicker.presetSavePlaceholder')}
                      aria-label={t('modelPicker.presetSavePlaceholder')}
                      onChange={(event) => setSaveName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        const name = saveName.trim()
                        if (!name) return
                        onSavePreset(name)
                        setSaveName('')
                      }}
                    />
                    <button
                      type="button"
                      className="button"
                      disabled={!saveName.trim()}
                      onClick={() => { const name = saveName.trim(); if (!name) return; onSavePreset(name); setSaveName('') }}
                    >
                      {t('modelPicker.presetSave')}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {!resultCount ? <div className="model-picker__empty">{query.trim() ? t('modelPicker.emptySearch') : t('modelPicker.emptyProvider')}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
})
