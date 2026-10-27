import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PRIME_THINKING_LEVELS } from '@/types/api'
import type { HarnessId, PrimeModelCatalog, PrimeModelDescriptor, PrimeThinkingLevel, PrimeEffortSelector, DesktopApi, RuntimeInfo, SessionRecord, UsageLimitState } from '@/types/api'

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
}

/** The composer's provider-catalog view and runtime mutation surface. */
export interface ProviderCatalog {
  model: string
  effort: PrimeEffortSelector
  fast: boolean
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
  changeModel(modelKey: string): void
  changeEffort(value: PrimeEffortSelector): void
  changeFast(enabled: boolean): void
}

export function useProviderCatalog({ bridge, ready = true, harness = 'omp', runtime, activeSession, lastSelectedModel = '', defaultEffort = 'medium', rememberModel, syncRuntime, reportError }: UseProviderCatalogOptions): ProviderCatalog {
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
  useLayoutEffect(() => { runtimeIdRef.current = runtime?.runtimeId })

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
      pendingSelectionsRef.current.delete(sessionKey)
      const runtimeModel = catalog.models.find((candidate) => candidate.provider === runtime.model?.provider && candidate.id === runtime.model?.id && isUsable(candidate))
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
    queueRuntimeMutation(
      runtime.runtimeId,
      async () => { await bridge.agent.command(runtime.runtimeId, { type: 'set_service_tier', serviceTier: enabled ? 'priority' : 'default' }) },
      () => updateFast(previous),
    )
  }, [bridge, queueRuntimeMutation, runtime, updateFast])

  const resolvedAutoEffort = effort !== 'auto' || runtime?.autoThinkingResolved !== true ? undefined : PRIME_THINKING_LEVELS.find((level) => level === runtime.thinkingLevel)

  const resolveSelection = async () => {
    const next = catalog ?? (bridge && ready ? await bridge.providers.catalog(false, harness) : null)
    const selected = next?.models.find((candidate) => candidate.key === modelRef.current && isUsable(candidate)) ?? fallbackModel(next)
    if (next) setCatalogFor(harness, next)
    const resolvedModel = selected?.key ?? ''
    const resolvedEffort = supportsEffort(selected, effortRef.current) ? effortRef.current : selected?.reasoning ? 'auto' : selected?.availableThinkingLevels[0] ?? 'off'
    const resolvedFast = Boolean(selected?.fastModeSupported && fastRef.current)
    updateModel(resolvedModel)
    updateEffort(resolvedEffort)
    updateFast(resolvedFast)
    return { model: resolvedModel, effort: resolvedEffort, fast: resolvedFast }
  }

  return {
    model, effort, fast,
    usageLimit: runtime?.usageLimit,
    catalog, selectedModel, reasoningLevels, resolvedAutoEffort, modelsByProvider,
    refresh, resolveSelection, changeModel, changeEffort, changeFast,
  }
}
