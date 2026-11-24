import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { resolveLocale, translate, useI18n, type Translate } from '@/lib/i18n'
import type { ComposerSelection } from '@/lib/workspace'
import { PRIME_THINKING_LEVELS } from '@/types/api'
import type { HarnessId, LocalePreference, PrimeModelCatalog, PrimeModelDescriptor, PrimeThinkingLevel, PrimeEffortSelector, DesktopApi, RuntimeInfo, SessionRecord, SlowModeScope, UsageLimitState } from '@/types/api'

/** Stable fallback identities so consumers can memoize on prop equality. */
const DEFAULT_REASONING_LEVELS: PrimeThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function isUsable(candidate: PrimeModelDescriptor): boolean {
  return candidate.available
}

/** Resolve a session's persisted model against the catalog, matching either the model id or the full key. */
function findSessionModel(catalog: PrimeModelCatalog, session: Pick<SessionRecord, 'model' | 'provider'> | undefined): PrimeModelDescriptor | undefined {
  if (!session?.provider || !session.model) return undefined
  return catalog.models.find((candidate) => candidate.provider === session.provider && (candidate.id === session.model || candidate.key === session.model) && isUsable(candidate))
    ?? catalog.models.find((candidate) => candidate.id === session.model && isUsable(candidate))
}

interface PendingSelection { model: string; effort: PrimeEffortSelector }

function supportsEffort(model: PrimeModelDescriptor | undefined, effort: string): effort is PrimeEffortSelector {
  return Boolean(model && (effort === 'auto' ? model.reasoning : model.availableThinkingLevels.includes(effort as PrimeThinkingLevel)))
}

export function groupModelsByProvider(models: readonly PrimeModelDescriptor[] | undefined): Map<string, PrimeModelDescriptor[]> {
  const grouped = new Map<string, PrimeModelDescriptor[]>()
  for (const model of models ?? []) {
    const bucket = grouped.get(model.provider)
    if (bucket) bucket.push(model)
    else grouped.set(model.provider, [model])
  }
  return grouped
}

export interface CatalogSelection extends ComposerSelection {
  provider?: string
  id?: string
}

/**
 * The single place that decides "what selection is in force": the composer's
 * current model/effort/fast resolved against a catalog, falling back to the
 * given descriptor. Pure — it never writes composer state.
 */
export function resolveCatalogSelection(
  catalog: PrimeModelCatalog | null | undefined,
  current: ComposerSelection,
  fallback: PrimeModelDescriptor | undefined,
): CatalogSelection {
  const selected = catalog?.models.find((candidate) => candidate.key === current.model && isUsable(candidate)) ?? fallback
  return {
    model: selected?.key ?? '',
    provider: selected?.provider,
    id: selected?.id,
    effort: supportsEffort(selected, current.effort) ? current.effort : selected?.reasoning ? 'auto' : selected?.availableThinkingLevels[0] ?? 'off',
    fast: Boolean(selected?.fastModeSupported && current.fast),
  }
}

interface UseProviderCatalogOptions {
  bridge: DesktopApi | null
  /** Prevent startup work before the persisted harness selection is loaded. */
  ready?: boolean
  /** Harness whose model catalog is shown; catalogs are cached per harness. */
  harness?: HarnessId
  runtime: RuntimeInfo | null
  /** Active session metadata if available. */
  activeSession?: SessionRecord
  /** Persisted per-harness model preference. */
  lastSelectedModel?: string
  /** Initial effort for sessions that carry no explicit choice. */
  defaultEffort?: PrimeEffortSelector
  rememberModel?(modelKey: string): void
  syncRuntime(runtimeId: string): Promise<void>
  reportError(error: unknown): void
  /** App-level locale override; this hook is called above I18nProvider. */
  localePreference?: LocalePreference
}

/** The composer's provider-catalog view and runtime mutation surface. */
export interface ProviderCatalog {
  model: string
  effort: PrimeEffortSelector
  /** Requested fast setting. */
  fast: boolean
  /** Actual provider state; absent until OMP explicitly reports it. */
  fastActive?: boolean
  /** Authoritative slow preference and native write target; no optimistic mirror. */
  slow: boolean | undefined
  slowSupported: boolean | undefined
  slowScope: SlowModeScope | undefined
  /** 帳號限流狀態(low_priority/wrap_up);顯示之避免誤判為 app bug。 */
  usageLimit: UsageLimitState | undefined
  catalog: PrimeModelCatalog | null
  selectedModel: PrimeModelDescriptor | undefined
  reasoningLevels: PrimeEffortSelector[]
  /** The concrete level OMP resolved while the selection stays `auto`. */
  resolvedAutoEffort: PrimeEffortSelector | undefined
  modelsByProvider: ReadonlyMap<string, PrimeModelDescriptor[]>
  refresh(force?: boolean): Promise<void>
  resolveSelection?(): Promise<Pick<ProviderCatalog, 'model' | 'effort' | 'fast'>>
  /** Read-only view of the selection resolveSelection would apply; null until a usable model is known. */
  peekSelection?(): ComposerSelection | null
  /**
   * Apply the composer selection to a ready runtime before a prompt. Sends only
   * the differing commands, then one authoritative refresh; returns the
   * refreshed snapshot. Never writes composer state.
   */
  alignRuntime?(runtime: RuntimeInfo): Promise<RuntimeInfo>
  changeModel(modelKey: string): void
  changeEffort(value: PrimeEffortSelector): void
  changeFast(enabled: boolean): void
  /** Request native slow mode, then adopt only the refreshed get_state result. */
  changeSlow(enabled: boolean): void
  /** Re-arm the selected fast setting only after OMP explicitly reports it inactive. */
  retryFast(): void
}

export function useProviderCatalog({ bridge, ready = true, harness = 'omp', localePreference, runtime, activeSession, lastSelectedModel = '', defaultEffort = 'medium', rememberModel, syncRuntime, reportError }: UseProviderCatalogOptions): ProviderCatalog {
  const { t: providerT } = useI18n()
  const overrideLocale = localePreference === undefined ? undefined : resolveLocale(localePreference)
  const t = useMemo<Translate>(
    () => overrideLocale === undefined ? providerT : (key, values) => translate(overrideLocale, key, values),
    [overrideLocale, providerT],
  )
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<PrimeEffortSelector>(defaultEffort)
  const [fast, setFast] = useState(false)
  // Per-harness cache: switching back to a harness shows its last catalog
  // immediately while the background refresh updates it.
  const [catalogs, setCatalogs] = useState<Partial<Record<HarnessId, PrimeModelCatalog>>>({})
  const catalog = catalogs[harness] ?? null
  const setCatalogFor = useCallback((target: HarnessId, next: PrimeModelCatalog) => {
    setCatalogs((current) => ({ ...current, [target]: next }))
  }, [])
  const modelRef = useRef(model)
  const effortRef = useRef(effort)
  const fastRef = useRef(fast)
  const mutationRevisionRef = useRef(0)
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const runtimeIdRef = useRef(runtime?.runtimeId)
  const latestRuntimeRef = useRef(runtime)
  useLayoutEffect(() => {
    runtimeIdRef.current = runtime?.runtimeId
    latestRuntimeRef.current = runtime
  })

  const updateModel = useCallback((value: string) => { modelRef.current = value; setModel(value) }, [])
  const updateEffort = useCallback((value: PrimeEffortSelector) => { effortRef.current = value; setEffort(value) }, [])
  const updateFast = useCallback((value: boolean) => { fastRef.current = value; setFast(value) }, [])

  const queueRuntimeMutation = useCallback((
    runtimeId: string,
    command: () => Promise<void>,
    rollback: () => void,
  ) => {
    const revision = ++mutationRevisionRef.current
    mutationQueueRef.current = mutationQueueRef.current.then(async () => {
      try {
        await command()
      } catch (error) {
        if (mutationRevisionRef.current === revision && runtimeIdRef.current === runtimeId) {
          rollback()
          try { await syncRuntime(runtimeId) } catch (syncError) { reportError(syncError) }
        }
        reportError(error)
        return
      }
      if (mutationRevisionRef.current === revision && runtimeIdRef.current === runtimeId) {
        try { await syncRuntime(runtimeId) } catch (error) { reportError(error) }
      }
    })
  }, [reportError, syncRuntime])

  useEffect(() => () => {
    mutationRevisionRef.current += 1
    runtimeIdRef.current = undefined
    latestRuntimeRef.current = null
  }, [])

  const refresh = useCallback(async (force = false) => {
    if (!bridge || !ready) return
    const target = harness
    setCatalogFor(target, await bridge.providers.catalog(force, target))
  }, [bridge, harness, ready, setCatalogFor])

  const rememberSelection = useCallback((value: string) => {
    if (value && value !== lastSelectedModel) rememberModel?.(value)
  }, [lastSelectedModel, rememberModel])
  const rememberSelectionRef = useRef(rememberSelection)
  useLayoutEffect(() => { rememberSelectionRef.current = rememberSelection })

  const firstUsableModel = useCallback((nextCatalog: PrimeModelCatalog | null | undefined) => (
    nextCatalog?.models.find((candidate) => candidate.available)
  ), [])

  const fallbackModel = useCallback((nextCatalog: PrimeModelCatalog | null | undefined) => {
    if (nextCatalog) {
      const sessionModel = findSessionModel(nextCatalog, activeSession)
      if (sessionModel) return sessionModel
    }
    return nextCatalog?.models.find((candidate) => candidate.key === lastSelectedModel && candidate.available)
      ?? firstUsableModel(nextCatalog)
  }, [activeSession, firstUsableModel, lastSelectedModel])

  const selectedModel = useMemo<PrimeModelDescriptor | undefined>(() => {
    return catalog?.models.find((candidate) => candidate.key === model && candidate.available)
  }, [catalog, model])
  const reasoningLevels = useMemo<PrimeEffortSelector[]>(() => {
    const levels = selectedModel?.availableThinkingLevels ?? runtime?.availableThinkingLevels ?? DEFAULT_REASONING_LEVELS
    const autoSupported = selectedModel ? selectedModel.reasoning : levels.some((level) => level !== 'off')
    return autoSupported ? ['auto', ...levels] : levels
  }, [selectedModel, runtime?.availableThinkingLevels])
  // Group once per catalog identity so the composer's <option> tree can memoize.
  const modelsByProvider = useMemo(() => groupModelsByProvider(catalog?.models), [catalog?.models])

  useEffect(() => {
    if (reasoningLevels.includes(effort)) return
    updateEffort(reasoningLevels.includes(defaultEffort) ? defaultEffort : reasoningLevels.includes('medium') ? 'medium' : reasoningLevels[0] ?? 'off')
  }, [effort, reasoningLevels, defaultEffort, updateEffort])

  useEffect(() => {
    if (!bridge || !ready) return
    let cancelled = false
    const target = harness
    void bridge.providers.catalog(false, target).then((next) => { if (!cancelled) setCatalogFor(target, next) }).catch(reportError)
    return () => { cancelled = true }
  }, [bridge, harness, ready, reportError, setCatalogFor])

  // The composer's selection belongs to one harness's catalog. Clear the old
  // harness before resolving the new harness's remembered or first model.
  const previousHarnessRef = useRef(harness)
  useEffect(() => {
    if (previousHarnessRef.current === harness) return
    previousHarnessRef.current = harness
    updateModel('')
    updateFast(false)
  }, [harness, updateFast, updateModel])

  useEffect(() => {
    if (!catalog) return
    const current = catalog.models.find((candidate) => candidate.key === modelRef.current && candidate.available)
    if (current) return
    const fallback = fallbackModel(catalog)
    updateModel(fallback?.key ?? '')
    if (fallback) rememberSelection(fallback.key)
    if (!fallback?.fastModeSupported) updateFast(false)
  }, [catalog, fallbackModel, harness, rememberSelection, updateFast, updateModel])

  // Selections made while a session has no live runtime are only local state,
  // so they are parked per session (new tabs share the '' key) until a runtime
  // reports them back or the user returns to that tab.
  const pendingSelectionsRef = useRef(new Map<string, PendingSelection>())
  const sessionKey = activeSession?.id ?? ''
  const sessionKeyRef = useRef(sessionKey)
  useLayoutEffect(() => { sessionKeyRef.current = sessionKey })
  // Starts undefined so the first render with a catalog counts as a switch and
  // restores the initial session's effort as well as its model.
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!catalog) return
    const sessionChanged = activeSessionIdRef.current !== activeSession?.id
    activeSessionIdRef.current = activeSession?.id

    // Precedence: live runtime, then the tab's unsent selection, then the
    // session's persisted metadata. The latter two only apply when the tab
    // changes so a catalog refresh cannot revert what the user picked.
    if (runtime?.model?.provider && runtime.model.id) {
      const pending = pendingSelectionsRef.current.get(sessionKey)
      const pendingModel = pending && catalog.models.find((candidate) => candidate.key === pending.model && isUsable(candidate))
      const runtimeModel = catalog.models.find((candidate) => candidate.provider === runtime.model?.provider && candidate.id === runtime.model?.id && isUsable(candidate))
      const pendingEffortDiffers = Boolean(pending && pendingModel
        && supportsEffort(pendingModel, pending.effort)
        && (runtime.configuredThinkingLevel ?? runtime.thinkingLevel) !== pending.effort)
      if (pending && pendingModel && !runtime.isStreaming && (!runtimeModel || runtimeModel.key !== pendingModel.key || pendingEffortDiffers)) {
        if (modelRef.current !== pendingModel.key) updateModel(pendingModel.key)
        if (supportsEffort(pendingModel, pending.effort) && effortRef.current !== pending.effort) updateEffort(pending.effort)
        return
      }
      pendingSelectionsRef.current.delete(sessionKey)
      if (runtimeModel) {
        if (modelRef.current !== runtimeModel.key) updateModel(runtimeModel.key)
        rememberSelectionRef.current(runtimeModel.key)
      }
      const selector = runtime.configuredThinkingLevel ?? runtime.thinkingLevel
      if (selector && supportsEffort(runtimeModel, selector)) {
        if (effortRef.current !== selector) updateEffort(selector)
      }
      return
    }
    if (!sessionChanged) return

    const pending = pendingSelectionsRef.current.get(sessionKey)
    const pendingModel = pending && catalog.models.find((candidate) => candidate.key === pending.model && isUsable(candidate))
    if (pending && pendingModel) {
      if (modelRef.current !== pendingModel.key) updateModel(pendingModel.key)
      if (supportsEffort(pendingModel, pending.effort) && effortRef.current !== pending.effort) updateEffort(pending.effort)
      return
    }

    const sessionModel = findSessionModel(catalog, activeSession)
    if (sessionModel && modelRef.current !== sessionModel.key) updateModel(sessionModel.key)
    if (activeSession?.thinkingLevel && supportsEffort(sessionModel, activeSession.thinkingLevel)) {
      if (effortRef.current !== activeSession.thinkingLevel) updateEffort(activeSession.thinkingLevel)
      return
    }
    // A session without a saved level opens at the configured default.
    const effectiveModel = sessionModel ?? catalog.models.find((candidate) => candidate.key === modelRef.current)
    if (supportsEffort(effectiveModel, defaultEffort) && effortRef.current !== defaultEffort) updateEffort(defaultEffort)
  }, [activeSession, catalog, defaultEffort, runtime?.model?.id, runtime?.model?.provider, runtime?.thinkingLevel, runtime?.configuredThinkingLevel, sessionKey, updateEffort, updateModel])

  // Scoped to the runtime's reported tier so a catalog refresh cannot revert
  // an optimistic fast-mode toggle that the runtime has not confirmed yet.
  useEffect(() => {
    if (!runtime) return
    updateFast(runtime.serviceTier === 'priority')
  }, [runtime?.runtimeId, runtime?.serviceTier, updateFast])


  const changeModel = useCallback((nextModelKey: string) => {
    const previous = { model: modelRef.current, effort: effortRef.current, fast: fastRef.current }
    const nextModel = catalog?.models.find((candidate) => candidate.key === nextModelKey)
    const nextEffort = nextModel && !supportsEffort(nextModel, effortRef.current)
      ? supportsEffort(nextModel, defaultEffort) ? defaultEffort : nextModel.availableThinkingLevels.includes('medium') ? 'medium' : nextModel.availableThinkingLevels[0] ?? 'off'
      : effortRef.current
    updateModel(nextModelKey)
    updateEffort(nextEffort)
    if (!nextModel?.fastModeSupported) updateFast(false)
    if (!bridge || !runtime || !nextModel) {
      if (nextModel) {
        pendingSelectionsRef.current.set(sessionKeyRef.current, { model: nextModelKey, effort: nextEffort })
        rememberSelection(nextModelKey)
      }
      return
    }
    // A live runtime now owns the selection; its mutation queue is the source
    // of truth, so an older parked choice must not come back on a later render.
    pendingSelectionsRef.current.delete(sessionKeyRef.current)
    queueRuntimeMutation(
      runtime.runtimeId,
      async () => {
        await bridge.agent.command(runtime.runtimeId, { type: 'set_model', provider: nextModel.provider, modelId: nextModel.id })
        await bridge.agent.command(runtime.runtimeId, { type: 'set_thinking_level', level: nextEffort })
        rememberSelectionRef.current(nextModelKey)
      },
      () => { updateModel(previous.model); updateEffort(previous.effort); updateFast(previous.fast) },
    )
  }, [bridge, catalog?.models, queueRuntimeMutation, rememberSelection, runtime, updateEffort, updateFast, updateModel])

  const changeEffort = useCallback((nextEffort: PrimeEffortSelector) => {
    const previous = effortRef.current
    updateEffort(nextEffort)
    if (!bridge || !runtime) {
      pendingSelectionsRef.current.set(sessionKeyRef.current, { model: modelRef.current, effort: nextEffort })
      return
    }
    // A live runtime now owns the selection; its mutation queue is the source
    // of truth, so an older parked choice must not come back on a later render.
    pendingSelectionsRef.current.delete(sessionKeyRef.current)
    queueRuntimeMutation(
      runtime.runtimeId,
      async () => { await bridge.agent.command(runtime.runtimeId, { type: 'set_thinking_level', level: nextEffort }) },
      () => updateEffort(previous),
    )
  }, [bridge, queueRuntimeMutation, runtime, updateEffort])

  const changeFast = useCallback((enabled: boolean) => {
    const previous = fastRef.current
    updateFast(enabled)
    if (!bridge || !runtime) return
    // A live runtime now owns the selection; its mutation queue is the source
    // of truth, so an older parked choice must not come back on a later render.
    pendingSelectionsRef.current.delete(sessionKeyRef.current)
    const authorizedRuntimeId = runtime.runtimeId
    const authorizedServiceTier = runtime.serviceTier
    const authorizedProvider = runtime.model?.provider
    const authorizedModelId = runtime.model?.id
    queueRuntimeMutation(
      authorizedRuntimeId,
      async () => {
        // Fast is session-scoped. Reauthorize against the latest model and
        // preference when this queued click actually executes; a preceding
        // model/session mutation may have replaced its original target.
        const current = latestRuntimeRef.current
        if (
          !current
          || current.runtimeId !== authorizedRuntimeId
          || current.serviceTier !== authorizedServiceTier
          || current.model?.provider !== authorizedProvider
          || current.model?.id !== authorizedModelId
        ) {
          reportError(new Error(t('composer.fastReviewRetry')))
          return
        }
        await bridge.agent.command(authorizedRuntimeId, { type: 'set_service_tier', serviceTier: enabled ? 'priority' : 'default' })
        // The response and syncRuntime's published snapshot are not a state
        // refresh. Fetch the actual active tier once before reattaching the UI.
        await bridge.agent.refreshState(authorizedRuntimeId)
      },
      () => updateFast(previous),
    )
  }, [bridge, queueRuntimeMutation, reportError, runtime, t, updateFast])

  const changeSlow = useCallback((enabled: boolean) => {
    if (!bridge || !runtime) return
    // Both the current preference and its native consequence must be known.
    // In particular, never offer an enable that might unexpectedly write
    // provider-wide persisted config. Unsupported enabling is guarded here;
    // the validated pure RPC command retains OMP's documented disable no-op.
    if (runtime.slowModeSupported !== true || typeof runtime.slowModeEnabled !== 'boolean') return
    if (runtime.slowModeScope !== 'global' && runtime.slowModeScope !== 'session') return
    const authorizedRuntimeId = runtime.runtimeId
    const authorizedEnabled = runtime.slowModeEnabled
    const authorizedScope = runtime.slowModeScope
    const authorizedProvider = runtime.model?.provider
    const authorizedModelId = runtime.model?.id
    queueRuntimeMutation(
      authorizedRuntimeId,
      async () => {
        // A preceding model mutation in this same primary queue may have
        // changed a session-scoped click into a provider-wide write. The
        // latest authoritative props, not the captured tooltip, remain the
        // authorization boundary at actual execution time.
        const current = latestRuntimeRef.current
        if (
          !current
          || current.runtimeId !== authorizedRuntimeId
          || current.slowModeSupported !== true
          || current.slowModeEnabled !== authorizedEnabled
          || current.slowModeScope !== authorizedScope
          || current.model?.provider !== authorizedProvider
          || current.model?.id !== authorizedModelId
        ) {
          reportError(new Error(t('composer.slowReviewRetry')))
          return
        }
        await bridge.agent.command(authorizedRuntimeId, { type: 'set_slow_mode', enabled })
        // An acknowledgement says nothing about the resulting preference.
        // This is the sole extra get_state: queueRuntimeMutation's sync only
        // reattaches the already-published snapshot, it does not refresh it.
        await bridge.agent.refreshState(authorizedRuntimeId)
      },
      // No optimistic preference exists to roll back. Errors keep the last
      // authoritative flags; queueRuntimeMutation also reports refresh errors.
      () => undefined,
    )
  }, [bridge, queueRuntimeMutation, reportError, runtime, t])

  const retryFast = useCallback(() => {
    if (!bridge || !runtime || !fastRef.current || runtime.serviceTierActive !== false) return
    queueRuntimeMutation(
      runtime.runtimeId,
      async () => { await bridge.agent.command(runtime.runtimeId, { type: 'set_service_tier', serviceTier: 'priority' }) },
      // Retrying does not change the preference or optimistic actual state.
      () => undefined,
    )
  }, [bridge, queueRuntimeMutation, runtime])

  const resolvedAutoEffort = effort !== 'auto' || runtime?.autoThinkingResolved !== true ? undefined : PRIME_THINKING_LEVELS.find((level) => level === runtime.thinkingLevel)

  const currentSelection = (): ComposerSelection => ({ model: modelRef.current, effort: effortRef.current, fast: fastRef.current })

  const resolveSelection = async () => {
    const next = catalog ?? (bridge && ready ? await bridge.providers.catalog(false, harness) : null)
    const selection = resolveCatalogSelection(next, currentSelection(), fallbackModel(next))
    if (next) setCatalogFor(harness, next)
    updateModel(selection.model)
    updateEffort(selection.effort)
    updateFast(selection.fast)
    return { model: selection.model, effort: selection.effort, fast: selection.fast }
  }

  // Read-only counterpart of resolveSelection: no catalog fetch, no state
  // write, and no fallback selection until a catalog actually offers a model.
  const peekSelection = useCallback((): ComposerSelection | null => {
    if (!catalog) return null
    const selection = resolveCatalogSelection(catalog, currentSelection(), fallbackModel(catalog))
    return selection.model ? { model: selection.model, effort: selection.effort, fast: selection.fast } : null
  }, [catalog, fallbackModel])

  const alignRuntime = useCallback(async (runtime: RuntimeInfo): Promise<RuntimeInfo> => {
    if (!bridge) throw new Error('No desktop bridge is available to align the runtime.')
    // A streaming runtime owns the live turn: mutating its model mid-stream
    // would change the turn that is already running.
    if (runtime.isStreaming) return runtime
    const runtimeId = runtime.runtimeId
    const aligned = Promise.withResolvers<RuntimeInfo>()
    // The same queue the composer's own mutations use: a prompt can never
    // overtake a model/effort/fast request the user just issued. Resolve the
    // selection inside the queued task so a later user change wins.
    mutationQueueRef.current = mutationQueueRef.current.then(async () => {
      try {
        const next = catalog ?? (ready ? await bridge.providers.catalog(false, harness) : null)
        const selection = resolveCatalogSelection(next, currentSelection(), fallbackModel(next))
        const current = latestRuntimeRef.current?.runtimeId === runtimeId ? latestRuntimeRef.current : runtime
        const commands: Record<string, unknown>[] = []
        if (selection.provider !== undefined && selection.id !== undefined
          && (current.model?.provider !== selection.provider || current.model?.id !== selection.id)) {
          commands.push({ type: 'set_model', provider: selection.provider, modelId: selection.id })
        }
        // `auto` is a per-turn policy, not a level to compare against.
        if (selection.effort !== 'auto' && (current.configuredThinkingLevel ?? current.thinkingLevel) !== selection.effort) {
          commands.push({ type: 'set_thinking_level', level: selection.effort })
        }
        if (selection.fast && current.fastModeSupported === true && current.serviceTier !== 'priority') {
          commands.push({ type: 'set_service_tier', serviceTier: 'priority' })
        }
        if (commands.length === 0) {
          aligned.resolve(current)
          return
        }
        for (const command of commands) await bridge.agent.command(runtimeId, command)
        aligned.resolve(await bridge.agent.refreshState(runtimeId))
      } catch (error) {
        // The caller owns reporting: a failed alignment fails the prompt.
        aligned.reject(error)
      }
    })
    return aligned.promise
  }, [bridge, catalog, fallbackModel, harness, ready])

  return {
    model, effort, fast,
    fastActive: runtime?.serviceTierActive,
    slow: runtime?.slowModeEnabled,
    slowSupported: runtime?.slowModeSupported,
    slowScope: runtime?.slowModeScope,
    usageLimit: runtime?.usageLimit,
    catalog, selectedModel, reasoningLevels, resolvedAutoEffort, modelsByProvider,
    refresh, resolveSelection, peekSelection, alignRuntime, changeModel, changeEffort, changeFast, changeSlow, retryFast,
  }
}
