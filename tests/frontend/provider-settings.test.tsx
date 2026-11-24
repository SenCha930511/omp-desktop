// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProviderCatalog, useProviderCatalog } from '../../src/hooks/useProviderCatalog'
import { ProviderSettings } from '../../src/pages/settings/ProviderSettings'
import type { LocalePreference, PrimeModelCatalog, DesktopApi, RuntimeInfo } from '../../src/types/api'

const model = {
  key: 'openai-codex/gpt-5.6', provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true,
  input: ['text'] as const, contextWindow: 400_000, maxTokens: 128_000,
  availableThinkingLevels: ['low', 'medium', 'high'] as const, fastModeSupported: true, available: true,
}
const catalog: PrimeModelCatalog = {
  primeVersion: '0.7.0',
  refreshedAt: '2026-08-06T00:00:00.000Z',
  models: [
    { ...model, key: 'anthropic/claude-sonnet', provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet', input: [...model.input], availableThinkingLevels: ['low', 'high'] },
    { ...model, key: 'openai-codex/gpt-5.5', id: 'gpt-5.5', name: 'GPT-5.5', input: [...model.input], availableThinkingLevels: ['low', 'high'] },
    { ...model, input: [...model.input], availableThinkingLevels: [...model.availableThinkingLevels] },
  ],
  providers: [
    { id: 'anthropic', name: 'Anthropic', authMethod: 'api_key', configured: false, modelCount: 14, availableModelCount: 0 },
    { id: 'openai-codex', name: 'ChatGPT Plus/Pro', authMethod: 'oauth', configured: true, authSource: 'stored', modelCount: 8, availableModelCount: 8 },
  ],
}
const runtime: RuntimeInfo = {
  runtimeId: 'runtime-1', harness: 'omp', cwd: '/tmp/project', isStreaming: false,
  model: { provider: model.provider, id: model.id, name: model.name },
  thinkingLevel: 'medium', serviceTier: 'default',
}
const noop = async () => undefined
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function render(node: ReactNode) {
  await act(async () => { root.render(node) })
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label))
  if (!match) throw new Error(`Button not found: ${label}`)
  return match as HTMLButtonElement
}

async function click(element: HTMLElement) {
  await act(async () => { element.click() })
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, resolve, reject }
}

describe('provider settings behavior and accessibility', () => {
  it('exposes the provider and model catalogue without visibility toggles', async () => {
    await render(<ProviderSettings catalog={catalog} onOpenDocs={() => undefined} />)

    expect(container.textContent).toContain('2 providers · 3 models')
    expect(container.textContent).toContain('ChatGPT Plus/Pro')
    expect(container.textContent).toContain('Anthropic')
    const providerRows = [...container.querySelectorAll('.provider-row')]
    expect(providerRows[0]?.textContent).toContain('Anthropic')
    expect(providerRows[1]?.textContent).toContain('ChatGPT Plus/Pro')
    expect(button('Credential setup')).toBeTruthy()
    // Provider visibility management is gone: no toolbar, no per-row switches.
    expect(container.querySelector('.provider-heading-actions')).toBeNull()
    expect(container.querySelectorAll('.provider-row input[type="checkbox"]')).toHaveLength(0)

    expect(container.textContent).toContain('OMP catalogue')

    await click(button('Models'))
    expect(container.textContent).toContain('GPT-5.6')
    expect(container.textContent).toContain('GPT-5.5')
    expect(container.textContent).toContain('Claude Sonnet')
    expect(container.querySelector('input[aria-label="Search models"]')).not.toBeNull()
    const groups = [...container.querySelectorAll('.provider-model-group')]
    expect(groups).toHaveLength(2)
    expect(groups[0]?.querySelector('.provider-model-group__heading')?.textContent).toContain('Anthropic')
    expect(groups[0]?.querySelector('.provider-model-group__heading')?.textContent).toContain('1 models')
    expect(groups[1]?.querySelector('.provider-model-group__heading')?.textContent).toContain('ChatGPT Plus/Pro')
    expect(groups[1]?.querySelector('.provider-model-group__heading')?.textContent).toContain('2 models')
    const openAiModels = [...groups[1]!.querySelectorAll('.provider-model-row')]
    expect(openAiModels[0]?.textContent).toContain('GPT-5.5')
    expect(openAiModels[1]?.textContent).toContain('GPT-5.6')
    expect(container.querySelectorAll('.provider-model-row input[type="checkbox"]')).toHaveLength(0)
    const openAiHeader = groups[1]!.querySelector<HTMLButtonElement>('.provider-model-group__heading')
    const openAiContent = groups[1]!.querySelector<HTMLElement>('.provider-model-group__models')
    expect(openAiHeader?.getAttribute('aria-expanded')).toBe('true')
    expect(openAiContent?.hidden).toBe(false)
    await click(openAiHeader!)
    expect(openAiHeader?.getAttribute('aria-expanded')).toBe('false')
    expect(openAiContent?.hidden).toBe(true)
    await click(openAiHeader!)
    expect(openAiHeader?.getAttribute('aria-expanded')).toBe('true')
    expect(openAiContent?.hidden).toBe(false)
  })
  it('filters providers and models by the search query', async () => {
    await render(<ProviderSettings catalog={catalog} onOpenDocs={() => undefined} />)

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search providers"]')
    expect(search).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'anthropic')
      search!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect([...container.querySelectorAll('.provider-row')]).toHaveLength(1)
    expect(container.textContent).not.toContain('No providers match your search.')
  })
})

describe('provider runtime mutations', () => {
  it('resolves model and supported effort together before the initial catalog arrives', async () => {
    const pending = deferred<PrimeModelCatalog>()
    const bridge = { providers: { catalog: vi.fn(() => pending.promise) } } as unknown as DesktopApi
    const reportError = vi.fn()
    let value!: ProviderCatalog
    function Harness() {
      value = useProviderCatalog({ bridge, runtime: null, defaultEffort: 'medium', syncRuntime: noop, reportError })
      return null
    }
    act(() => root.render(<Harness />))
    expect(value.model).toBe('')
    const selection = value.resolveSelection!()
    await act(async () => {
      pending.resolve({ ...catalog, models: [{ ...model, input: [...model.input], availableThinkingLevels: ['low', 'high'], fastModeSupported: false }] })
      expect(await selection).toEqual({ model: model.key, effort: 'auto', fast: false })
    })
  })

  function mountCatalogHook(options: {
    command: DesktopApi['agent']['command']
    runtime?: RuntimeInfo | null
    syncRuntime?: (runtimeId: string) => Promise<void>
    refreshState?: DesktopApi['agent']['refreshState']
    reportError?: (error: unknown) => void
    localePreference?: LocalePreference
  }) {
    let value: ProviderCatalog | undefined
    const initialRuntime = options.runtime === undefined ? runtime : options.runtime
    const catalogMock = vi.fn().mockResolvedValue(catalog)
    const refreshState = options.refreshState ?? vi.fn().mockResolvedValue(initialRuntime)
    const bridge = {
      agent: { command: options.command, refreshState },
      providers: {
        catalog: catalogMock,
      },
    } as unknown as DesktopApi
    const syncRuntime = options.syncRuntime ?? vi.fn().mockResolvedValue(undefined)
    const reportError = options.reportError ?? vi.fn()
    function Harness({ currentRuntime = initialRuntime }: { currentRuntime?: RuntimeInfo | null }) {
      value = useProviderCatalog({ bridge, runtime: currentRuntime, syncRuntime, reportError, localePreference: options.localePreference })
      return null
    }
    return render(<Harness />).then(() => ({
      get value() { return value! },
      catalogMock,
      refreshState,
      syncRuntime,
      reportError,
      updateRuntime: (nextRuntime: RuntimeInfo | null) => render(<Harness currentRuntime={nextRuntime} />),
    }))
  }

  it('serializes rapid reasoning changes and rolls back/synchronizes the latest rejection', async () => {
    const first = deferred<Record<string, unknown>>()
    const second = deferred<Record<string, unknown>>()
    const command = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const hook = await mountCatalogHook({ command })

    act(() => { hook.value.changeEffort('low'); hook.value.changeEffort('high') })
    await act(async () => { await Promise.resolve() })
    expect(command).toHaveBeenCalledTimes(1)
    expect(hook.value.effort).toBe('high')

    await act(async () => { first.resolve({}); await first.promise; await Promise.resolve() })
    expect(command).toHaveBeenCalledTimes(2)
    expect(hook.syncRuntime).not.toHaveBeenCalled()

    await act(async () => { second.reject(new Error('thinking rejected')); try { await second.promise } catch { /* expected */ }; await Promise.resolve() })
    expect(hook.value.effort).toBe('low')
    expect(hook.syncRuntime).toHaveBeenCalledWith('runtime-1')
    expect(hook.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'thinking rejected' }))
  })

  it('rolls model state back and synchronizes after a rejected model command', async () => {
    const rejected = deferred<Record<string, unknown>>()
    const command = vi.fn().mockReturnValueOnce(rejected.promise)
    const hook = await mountCatalogHook({ command })

    act(() => hook.value.changeModel('openai-codex/gpt-5.5'))
    expect(hook.value.model).toBe('openai-codex/gpt-5.5')
    await act(async () => { rejected.reject(new Error('model rejected')); try { await rejected.promise } catch { /* expected */ }; await Promise.resolve() })

    expect(hook.value.model).toBe('openai-codex/gpt-5.6')
    expect(hook.value.effort).toBe('medium')
    expect(hook.syncRuntime).toHaveBeenCalledWith('runtime-1')
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('keeps an optimistic fast-mode toggle across a catalog refresh', async () => {
    const hook = await mountCatalogHook({ command: vi.fn().mockResolvedValue({}) })
    await act(async () => { await Promise.resolve() })

    act(() => hook.value.changeFast(true))
    expect(hook.value.fast).toBe(true)

    // A refresh returns a new catalog object; the runtime's stale serviceTier must not revert the toggle.
    hook.catalogMock.mockResolvedValue({ ...catalog })
    await act(async () => { await hook.value.refresh(true) })

    expect(hook.value.fast).toBe(true)
  })

  it('refreshes authoritative Fast state exactly once before reattaching the UI', async () => {
    const acknowledged = deferred<Record<string, unknown>>()
    const refreshed = deferred<RuntimeInfo>()
    const order: string[] = []
    const command = vi.fn().mockImplementation(() => { order.push('command'); return acknowledged.promise })
    const refreshState = vi.fn().mockImplementation(() => { order.push('refresh'); return refreshed.promise })
    const syncRuntime = vi.fn().mockImplementation(async () => { order.push('sync') })
    const hook = await mountCatalogHook({ command, refreshState, syncRuntime })

    act(() => hook.value.changeFast(true))
    await act(async () => { await Promise.resolve() })
    expect(command).toHaveBeenCalledExactlyOnceWith('runtime-1', { type: 'set_service_tier', serviceTier: 'priority' })
    expect(hook.value.fast).toBe(true)
    expect(hook.refreshState).not.toHaveBeenCalled()

    await act(async () => { acknowledged.resolve({ success: true }); await acknowledged.promise; await Promise.resolve() })
    expect(hook.refreshState).toHaveBeenCalledExactlyOnceWith('runtime-1')
    expect(hook.syncRuntime).not.toHaveBeenCalled()
    expect(hook.value.fastActive).toBeUndefined()

    await act(async () => {
      refreshed.resolve({ ...runtime, serviceTier: 'priority', serviceTierActive: false })
      await refreshed.promise
      await Promise.resolve()
    })
    await hook.updateRuntime({ ...runtime, serviceTier: 'priority', serviceTierActive: false })
    expect(hook.value.fast).toBe(true)
    expect(hook.value.fastActive).toBe(false)
    expect(order).toEqual(['command', 'refresh', 'sync'])
    expect(hook.syncRuntime).toHaveBeenCalledExactlyOnceWith('runtime-1')
  })

  it('rolls an optimistic Fast toggle back and reports an authoritative refresh failure', async () => {
    const acknowledged = deferred<Record<string, unknown>>()
    const refreshRejected = deferred<RuntimeInfo>()
    const hook = await mountCatalogHook({
      command: vi.fn().mockReturnValueOnce(acknowledged.promise),
      refreshState: vi.fn().mockReturnValueOnce(refreshRejected.promise),
    })

    act(() => hook.value.changeFast(true))
    await act(async () => { acknowledged.resolve({ success: true }); await acknowledged.promise; await Promise.resolve() })
    expect(hook.refreshState).toHaveBeenCalledExactlyOnceWith('runtime-1')
    await act(async () => {
      refreshRejected.reject(new Error('fast state refresh rejected'))
      try { await refreshRejected.promise } catch { /* expected */ }
      await Promise.resolve()
    })

    expect(hook.value.fast).toBe(false)
    expect(hook.syncRuntime).toHaveBeenCalledExactlyOnceWith('runtime-1')
    expect(hook.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'fast state refresh rejected' }))
  })

  it.each([
    ['runtime generation', { runtimeId: 'runtime-2' }, undefined],
    ['model identity', { model: { provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet' } }, undefined],
    ['Fast preference', { serviceTier: 'priority' }, undefined],
    ['Fast preference in zh-TW', { serviceTier: 'priority' }, 'zh-TW'],
  ] as const)('does not issue a queued Fast command after the authorized %s changes', async (_label, patch, localePreference) => {
    const thinkingChanged = deferred<Record<string, unknown>>()
    const command = vi.fn().mockReturnValueOnce(thinkingChanged.promise)
    const hook = await mountCatalogHook({ command, localePreference })
    act(() => {
      hook.value.changeEffort('low')
      hook.value.changeFast(true)
    })
    await act(async () => { await Promise.resolve() })
    expect(command).toHaveBeenCalledExactlyOnceWith('runtime-1', { type: 'set_thinking_level', level: 'low' })

    await hook.updateRuntime({ ...runtime, ...patch })
    await act(async () => {
      thinkingChanged.resolve({ success: true })
      await thinkingChanged.promise
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(command).toHaveBeenCalledTimes(1)
    expect(hook.refreshState).not.toHaveBeenCalled()
    expect(hook.reportError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: localePreference === 'zh-TW'
        ? '要求執行前，模型或快速偏好設定已變更。請檢查目前的快速狀態後再試一次。'
        : 'The model or Fast preference changed before the request ran. Review the current Fast state and try again.',
    }))
  })

  it('rolls the fast preference back when its request is rejected', async () => {
    const rejected = deferred<Record<string, unknown>>()
    const command = vi.fn().mockReturnValueOnce(rejected.promise)
    const hook = await mountCatalogHook({ command })
    await act(async () => { await Promise.resolve() })

    act(() => hook.value.changeFast(true))
    expect(hook.value.fast).toBe(true)
    await act(async () => {
      rejected.reject(new Error('fast rejected'))
      try { await rejected.promise } catch { /* expected */ }
      await Promise.resolve()
    })

    expect(command).toHaveBeenCalledExactlyOnceWith('runtime-1', { type: 'set_service_tier', serviceTier: 'priority' })
    expect(hook.value.fast).toBe(false)
    expect(hook.value.fastActive).toBeUndefined()
    expect(hook.syncRuntime).toHaveBeenCalledExactlyOnceWith('runtime-1')
    expect(hook.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'fast rejected' }))
  })

  it('retries an explicitly inactive fast selection once without inventing active state', async () => {
    const requested = deferred<Record<string, unknown>>()
    const command = vi.fn().mockReturnValueOnce(requested.promise)
    const hook = await mountCatalogHook({
      command,
      runtime: { ...runtime, serviceTier: 'priority', serviceTierActive: false },
    })

    expect(hook.value.fast).toBe(true)
    expect(hook.value.fastActive).toBe(false)
    act(() => hook.value.retryFast())
    await act(async () => { await Promise.resolve() })

    expect(command).toHaveBeenCalledExactlyOnceWith('runtime-1', { type: 'set_service_tier', serviceTier: 'priority' })
    expect(hook.value.fast).toBe(true)
    expect(hook.value.fastActive).toBe(false)
    expect(hook.syncRuntime).not.toHaveBeenCalled()

    await act(async () => { requested.resolve({}); await requested.promise; await Promise.resolve() })
    expect(command).toHaveBeenCalledTimes(1)
    expect(hook.value.fastActive).toBe(false)
    expect(hook.syncRuntime).toHaveBeenCalledExactlyOnceWith('runtime-1')
  })

  it('keeps the fast preference after a retry request fails', async () => {
    const rejected = deferred<Record<string, unknown>>()
    const command = vi.fn().mockReturnValueOnce(rejected.promise)
    const hook = await mountCatalogHook({
      command,
      runtime: { ...runtime, serviceTier: 'priority', serviceTierActive: false },
    })

    act(() => hook.value.retryFast())
    await act(async () => {
      await Promise.resolve()
      rejected.reject(new Error('retry rejected'))
      try { await rejected.promise } catch { /* expected */ }
      await Promise.resolve()
    })

    expect(command).toHaveBeenCalledExactlyOnceWith('runtime-1', { type: 'set_service_tier', serviceTier: 'priority' })
    expect(hook.value.fast).toBe(true)
    expect(hook.value.fastActive).toBe(false)
    expect(hook.syncRuntime).toHaveBeenCalledExactlyOnceWith('runtime-1')
    expect(hook.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'retry rejected' }))
  })

  it('does not retry when actual fast state is unknown, already active, or preference is off', async () => {
    const command = vi.fn().mockResolvedValue({})
    const unknown = await mountCatalogHook({ command, runtime: { ...runtime, serviceTier: 'priority' } })
    expect(unknown.value.fastActive).toBeUndefined()

    act(() => unknown.value.retryFast())
    await act(async () => { await Promise.resolve() })
    expect(command).not.toHaveBeenCalled()
    expect(unknown.syncRuntime).not.toHaveBeenCalled()

    const active = await mountCatalogHook({ command, runtime: { ...runtime, serviceTier: 'priority', serviceTierActive: true } })
    act(() => active.value.retryFast())
    await act(async () => { await Promise.resolve() })
    expect(command).not.toHaveBeenCalled()
    expect(active.value.fastActive).toBe(true)

    const disabled = await mountCatalogHook({ command, runtime: { ...runtime, serviceTier: 'default', serviceTierActive: false } })
    act(() => disabled.value.retryFast())
    await act(async () => { await Promise.resolve() })
    expect(command).not.toHaveBeenCalled()
    expect(disabled.value.fast).toBe(false)
  })

  it('sends one exact slow command and refreshes authoritative state once before reattaching the UI', async () => {
    const acknowledged = deferred<Record<string, unknown>>()
    const refreshed = deferred<RuntimeInfo>()
    const slowRuntime: RuntimeInfo = { ...runtime, slowModeSupported: true, slowModeEnabled: false, slowModeScope: 'session' }
    const order: string[] = []
    const command = vi.fn().mockImplementation(() => { order.push('command'); return acknowledged.promise })
    const refreshState = vi.fn().mockImplementation(() => { order.push('refresh'); return refreshed.promise })
    const syncRuntime = vi.fn().mockImplementation(async () => { order.push('sync') })
    const hook = await mountCatalogHook({ command, refreshState, syncRuntime, runtime: slowRuntime })

    act(() => hook.value.changeSlow(true))
    await act(async () => { await Promise.resolve() })
    expect(hook.value.slow).toBe(false)
    expect(command).toHaveBeenCalledExactlyOnceWith('runtime-1', { type: 'set_slow_mode', enabled: true })
    expect(hook.refreshState).not.toHaveBeenCalled()

    await act(async () => { acknowledged.resolve({ success: true, data: { enabled: true } }); await acknowledged.promise; await Promise.resolve() })
    expect(hook.value.slow).toBe(false)
    expect(hook.refreshState).toHaveBeenCalledExactlyOnceWith('runtime-1')
    expect(hook.syncRuntime).not.toHaveBeenCalled()

    await act(async () => {
      refreshed.resolve({ ...slowRuntime, slowModeEnabled: true })
      await refreshed.promise
      await Promise.resolve()
    })
    expect(order).toEqual(['command', 'refresh', 'sync'])
    expect(hook.syncRuntime).toHaveBeenCalledExactlyOnceWith('runtime-1')
  })

  it('aborts a queued session Slow enable when a preceding model change produces global scope', async () => {
    const modelChanged = deferred<Record<string, unknown>>()
    const command = vi.fn()
      .mockReturnValueOnce(modelChanged.promise)
      .mockResolvedValue({})
    const slowRuntime: RuntimeInfo = { ...runtime, slowModeSupported: true, slowModeEnabled: false, slowModeScope: 'session' }
    const hook = await mountCatalogHook({ command, runtime: slowRuntime, localePreference: 'zh-TW' })

    act(() => {
      hook.value.changeModel('openai-codex/gpt-5.5')
      hook.value.changeSlow(true)
    })
    await act(async () => { await Promise.resolve() })
    expect(command).toHaveBeenCalledExactlyOnceWith('runtime-1', {
      type: 'set_model', provider: 'openai-codex', modelId: 'gpt-5.5',
    })

    // The authoritative props move to a different model and write target
    // before the primary queue reaches the click-time session-scoped request.
    const changedRuntime: RuntimeInfo = {
      ...slowRuntime,
      model: { provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet' },
      slowModeScope: 'global',
    }
    await hook.updateRuntime(changedRuntime)
    await act(async () => {
      modelChanged.resolve({ success: true })
      await modelChanged.promise
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(command.mock.calls.map(([, request]) => request)).toEqual([
      { type: 'set_model', provider: 'openai-codex', modelId: 'gpt-5.5' },
      { type: 'set_thinking_level', level: 'low' },
    ])
    expect(hook.refreshState).not.toHaveBeenCalled()
    expect(hook.value.slow).toBe(false)
    expect(hook.reportError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: '要求執行前，模型、慢速偏好設定或慢速範圍已變更。請檢查目前的慢速狀態後再試一次。',
    }))
  })

  it.each([
    ['reported enabled preference', { slowModeEnabled: true }],
    ['absent enabled preference', { slowModeEnabled: undefined }],
    ['absent scope', { slowModeScope: undefined }],
    ['changed scope', { slowModeScope: 'global' }],
    ['absent support', { slowModeSupported: undefined }],
    ['model identity', { model: { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' } }],
  ] as const)('does not let changed %s bypass queued Slow authorization', async (_label, patch) => {
    const thinkingChanged = deferred<Record<string, unknown>>()
    const command = vi.fn().mockReturnValueOnce(thinkingChanged.promise)
    const slowRuntime: RuntimeInfo = { ...runtime, slowModeSupported: true, slowModeEnabled: false, slowModeScope: 'session' }
    const hook = await mountCatalogHook({ command, runtime: slowRuntime })
    act(() => {
      hook.value.changeEffort('low')
      hook.value.changeSlow(true)
    })
    await act(async () => { await Promise.resolve() })
    expect(command).toHaveBeenCalledExactlyOnceWith('runtime-1', { type: 'set_thinking_level', level: 'low' })

    await hook.updateRuntime({ ...slowRuntime, ...patch })
    await act(async () => {
      thinkingChanged.resolve({ success: true })
      await thinkingChanged.promise
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(command).toHaveBeenCalledTimes(1)
    expect(hook.refreshState).not.toHaveBeenCalled()
    expect(hook.reportError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: 'The model, Slow preference, or Slow scope changed before the request ran. Review the current Slow state and try again.',
    }))
  })

  it('does not optimistically change slow preference when its command or authoritative refresh fails', async () => {
    const slowRuntime: RuntimeInfo = { ...runtime, slowModeSupported: true, slowModeEnabled: false, slowModeScope: 'global' }
    const rejected = deferred<Record<string, unknown>>()
    const hook = await mountCatalogHook({ command: vi.fn().mockReturnValueOnce(rejected.promise), runtime: slowRuntime })
    act(() => hook.value.changeSlow(true))
    expect(hook.value.slow).toBe(false)
    await act(async () => {
      rejected.reject(new Error('slow rejected'))
      try { await rejected.promise } catch { /* expected */ }
      await Promise.resolve()
    })
    expect(hook.value.slow).toBe(false)
    expect(hook.refreshState).not.toHaveBeenCalled()
    expect(hook.syncRuntime).toHaveBeenCalledExactlyOnceWith('runtime-1')
    expect(hook.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'slow rejected' }))

    const acknowledged = deferred<Record<string, unknown>>()
    const refreshRejected = deferred<RuntimeInfo>()
    const refreshFailure = await mountCatalogHook({
      command: vi.fn().mockReturnValueOnce(acknowledged.promise),
      refreshState: vi.fn().mockReturnValueOnce(refreshRejected.promise),
      runtime: slowRuntime,
    })
    act(() => refreshFailure.value.changeSlow(true))
    await act(async () => { acknowledged.resolve({ success: true }); await acknowledged.promise; await Promise.resolve() })
    await act(async () => {
      refreshRejected.reject(new Error('slow state refresh rejected'))
      try { await refreshRejected.promise } catch { /* expected */ }
      await Promise.resolve()
    })
    expect(refreshFailure.value.slow).toBe(false)
    expect(refreshFailure.refreshState).toHaveBeenCalledExactlyOnceWith('runtime-1')
    expect(refreshFailure.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'slow state refresh rejected' }))
  })

  it.each([
    ['unsupported', { slowModeSupported: false, slowModeEnabled: false, slowModeScope: 'session' }],
    ['unknown support', { slowModeEnabled: false, slowModeScope: 'session' }],
    ['unknown enabled preference', { slowModeSupported: true, slowModeScope: 'global' }],
    ['unknown scope', { slowModeSupported: true, slowModeEnabled: false }],
  ] as const)('does not mutate slow mode when native facts are %s', async (_label, fields) => {
    const command = vi.fn().mockResolvedValue({})
    const hook = await mountCatalogHook({ command, runtime: { ...runtime, ...fields } })
    act(() => hook.value.changeSlow(true))
    await act(async () => { await Promise.resolve() })
    expect(command).not.toHaveBeenCalled()
    expect(hook.refreshState).not.toHaveBeenCalled()
  })

  it('does not reattach or synthesize slow state after the runtime generation changes', async () => {
    const acknowledged = deferred<Record<string, unknown>>()
    const slowRuntime: RuntimeInfo = { ...runtime, slowModeSupported: true, slowModeEnabled: false, slowModeScope: 'session' }
    const hook = await mountCatalogHook({ command: vi.fn().mockReturnValueOnce(acknowledged.promise), runtime: slowRuntime })
    act(() => hook.value.changeSlow(true))
    await hook.updateRuntime({ ...slowRuntime, runtimeId: 'runtime-2' })
    await act(async () => { acknowledged.resolve({ success: true }); await acknowledged.promise; await Promise.resolve() })

    expect(hook.value.slow).toBe(false)
    expect(hook.refreshState).toHaveBeenCalledExactlyOnceWith('runtime-1')
    expect(hook.syncRuntime).not.toHaveBeenCalled()
  })

  it('keeps local fast selection inert for retry without an active runtime', async () => {
    const command = vi.fn().mockResolvedValue({})
    const hook = await mountCatalogHook({ command, runtime: null })
    await act(async () => { await Promise.resolve() })

    act(() => hook.value.changeFast(true))
    expect(hook.value.fast).toBe(true)
    expect(hook.value.fastActive).toBeUndefined()
    act(() => hook.value.retryFast())
    await act(async () => { await Promise.resolve() })

    expect(command).not.toHaveBeenCalled()
    expect(hook.syncRuntime).not.toHaveBeenCalled()
  })
  it('keeps an unsent model choice when an idle runtime attaches later', async () => {
    const command = vi.fn().mockResolvedValue({})
    const hook = await mountCatalogHook({ command, runtime: null })
    await act(async () => { await Promise.resolve() })

    act(() => hook.value.changeModel('openai-codex/gpt-5.5'))
    expect(hook.value.model).toBe('openai-codex/gpt-5.5')

    await hook.updateRuntime(runtime)

    expect(hook.value.model).toBe('openai-codex/gpt-5.5')
    expect(command).not.toHaveBeenCalled()
  })

  it('keeps an unsent effort choice when an idle runtime attaches later', async () => {
    const hook = await mountCatalogHook({ command: vi.fn().mockResolvedValue({}), runtime: null })
    await act(async () => { await Promise.resolve() })
    act(() => hook.value.changeEffort('high'))

    await hook.updateRuntime({
      ...runtime,
      model: { provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet' },
      configuredThinkingLevel: 'medium',
      thinkingLevel: 'medium',
    })

    expect(hook.value.effort).toBe('high')
  })

})

describe('composer selection peek and runtime alignment', () => {
  function mountSelectionHook(options: {
    runtime?: RuntimeInfo | null
    command?: DesktopApi['agent']['command']
    refreshState?: DesktopApi['agent']['refreshState']
    lastSelectedModel?: string
  } = {}) {
    let value: ProviderCatalog | undefined
    const currentRuntime = options.runtime === undefined ? null : options.runtime
    const command = options.command ?? vi.fn().mockResolvedValue({})
    const refreshState = options.refreshState ?? vi.fn().mockResolvedValue(currentRuntime)
    const catalogMock = vi.fn().mockResolvedValue(catalog)
    const rememberModel = vi.fn()
    const syncRuntime = vi.fn().mockResolvedValue(undefined)
    const reportError = vi.fn()
    const bridge = { agent: { command, refreshState }, providers: { catalog: catalogMock } } as unknown as DesktopApi
    function Harness() {
      value = useProviderCatalog({
        bridge,
        runtime: currentRuntime,
        defaultEffort: 'medium',
        lastSelectedModel: options.lastSelectedModel,
        rememberModel,
        syncRuntime,
        reportError,
      })
      return null
    }
    return render(<Harness />).then(() => ({
      get value() { return value! },
      catalogMock,
      command,
      refreshState,
      rememberModel,
      syncRuntime,
      reportError,
    }))
  }

  const alignedModel = { provider: model.provider, id: model.id, name: model.name }

  it('peeks the selection resolveSelection applies without writing composer state', async () => {
    const hook = await mountSelectionHook({ lastSelectedModel: model.key })
    await act(async () => { await Promise.resolve() })
    expect(hook.value.model).toBe(model.key)
    const before = { model: hook.value.model, effort: hook.value.effort, fast: hook.value.fast }

    const peeked = hook.value.peekSelection!()

    expect(peeked).toEqual({ model: model.key, effort: hook.value.effort, fast: false })
    expect({ model: hook.value.model, effort: hook.value.effort, fast: hook.value.fast }).toEqual(before)
    expect(hook.rememberModel).not.toHaveBeenCalled()
    const resolved = await hook.value.resolveSelection!()
    expect(resolved).toEqual({ model: peeked!.model, effort: peeked!.effort, fast: peeked!.fast })
    expect({ model: hook.value.model, effort: hook.value.effort, fast: hook.value.fast }).toEqual(before)
  })

  it('peeks null until a catalog with a usable model is available', async () => {
    const pending = deferred<PrimeModelCatalog>()
    const bridge = { providers: { catalog: vi.fn(() => pending.promise) } } as unknown as DesktopApi
    const reportError = vi.fn()
    let value!: ProviderCatalog
    function Harness() {
      value = useProviderCatalog({ bridge, runtime: null, defaultEffort: 'medium', syncRuntime: noop, reportError })
      return null
    }
    act(() => root.render(<Harness />))
    expect(value.peekSelection!()).toBeNull()

    await act(async () => {
      pending.resolve(catalog)
      await pending.promise
      await Promise.resolve()
    })
    expect(value.peekSelection!()).toEqual({ model: expect.any(String), effort: expect.any(String), fast: false })
  })

  it('peeks null when no catalog model is usable', async () => {
    const hook = await mountSelectionHook()
    await act(async () => { await Promise.resolve() })
    hook.catalogMock.mockResolvedValue({ ...catalog, models: catalog.models.map((entry) => ({ ...entry, available: false })) })
    await act(async () => { await hook.value.refresh(true) })

    expect(hook.value.peekSelection!()).toBeNull()
  })

  it('sends only the differing selection commands in order, refreshes once, and returns the authoritative snapshot', async () => {
    const order: string[] = []
    const command = vi.fn(async (_runtimeId: string, request: Record<string, unknown>) => {
      order.push(String(request.type))
      return {}
    })
    const refreshed: RuntimeInfo = { ...runtime, model: alignedModel, configuredThinkingLevel: 'medium', thinkingLevel: 'medium', serviceTier: 'default', fastModeSupported: true }
    const refreshState = vi.fn(async () => { order.push('refresh'); return refreshed })
    const hook = await mountSelectionHook({ command, refreshState, lastSelectedModel: model.key })
    await act(async () => { await Promise.resolve() })
    const stale: RuntimeInfo = {
      ...runtime,
      model: { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' },
      configuredThinkingLevel: 'low',
      thinkingLevel: 'low',
      serviceTier: 'priority',
      fastModeSupported: true,
    }

    let aligned: RuntimeInfo | undefined
    await act(async () => { aligned = await hook.value.alignRuntime!(stale) })

    expect(order).toEqual(['set_model', 'set_thinking_level', 'refresh'])
    expect(command.mock.calls.map(([, request]) => request)).toEqual([
      { type: 'set_model', provider: 'openai-codex', modelId: 'gpt-5.6' },
      { type: 'set_thinking_level', level: 'medium' },
    ])
    expect(refreshState).toHaveBeenCalledExactlyOnceWith('runtime-1')
    expect(aligned).toBe(refreshed)
    // Alignment must never rewrite the composer through the update setters.
    expect(hook.value.model).toBe(model.key)
    expect(hook.value.effort).toBe('medium')
    expect(hook.value.fast).toBe(false)
  })

  it('is a no-op when the runtime already reports the selection', async () => {
    const hook = await mountSelectionHook({ lastSelectedModel: model.key })
    await act(async () => { await Promise.resolve() })
    const matching: RuntimeInfo = {
      ...runtime,
      model: alignedModel,
      configuredThinkingLevel: 'medium',
      thinkingLevel: 'medium',
      serviceTier: 'default',
      fastModeSupported: true,
    }

    let aligned: RuntimeInfo | undefined
    await act(async () => { aligned = await hook.value.alignRuntime!(matching) })

    expect(hook.command).not.toHaveBeenCalled()
    expect(hook.refreshState).not.toHaveBeenCalled()
    expect(aligned).toBe(matching)
  })

  it('requests priority only when the composer asks for fast', async () => {
    const hook = await mountSelectionHook({ lastSelectedModel: model.key })
    await act(async () => { await Promise.resolve() })
    act(() => hook.value.changeFast(true))
    const target: RuntimeInfo = {
      ...runtime,
      model: alignedModel,
      configuredThinkingLevel: 'medium',
      thinkingLevel: 'medium',
      serviceTier: 'default',
      fastModeSupported: true,
    }

    await act(async () => { await hook.value.alignRuntime!(target) })

    expect(hook.command).toHaveBeenCalledExactlyOnceWith('runtime-1', { type: 'set_service_tier', serviceTier: 'priority' })
  })

  it('skips effort alignment for auto and fast alignment when unsupported', async () => {
    const hook = await mountSelectionHook({ lastSelectedModel: model.key })
    await act(async () => { await Promise.resolve() })
    act(() => {
      hook.value.changeEffort('auto')
      hook.value.changeFast(true)
    })
    const target: RuntimeInfo = {
      ...runtime,
      model: alignedModel,
      configuredThinkingLevel: 'low',
      thinkingLevel: 'low',
      serviceTier: 'default',
      fastModeSupported: false,
    }

    await act(async () => { await hook.value.alignRuntime!(target) })

    expect(hook.command).not.toHaveBeenCalled()
    expect(hook.refreshState).not.toHaveBeenCalled()
  })

  it('serializes alignment behind pending provider mutations', async () => {
    const pendingCommand = deferred<Record<string, unknown>>()
    const command = vi.fn(() => pendingCommand.promise)
    const refreshState = vi.fn(async () => runtime)
    const hook = await mountSelectionHook({ command, refreshState, lastSelectedModel: model.key })
    await act(async () => { await Promise.resolve() })
    const stale: RuntimeInfo = { ...runtime, model: { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' } }

    const first = hook.value.alignRuntime!(stale)
    await act(async () => { await Promise.resolve() })
    expect(command).toHaveBeenCalledTimes(1)
    const second = hook.value.alignRuntime!(stale)
    await act(async () => { await Promise.resolve() })
    expect(command).toHaveBeenCalledTimes(1)

    await act(async () => {
      pendingCommand.resolve({})
      await pendingCommand.promise
      await first
      await second
    })

    expect(command).toHaveBeenCalledTimes(2)
    expect(refreshState).toHaveBeenCalledTimes(2)
  })
  it('resolves a queued alignment against the selection current at execution time', async () => {
    const pendingCommand = deferred<Record<string, unknown>>()
    const command = vi.fn(() => pendingCommand.promise)
    const refreshState = vi.fn(async () => runtime)
    const hook = await mountSelectionHook({ command, refreshState, lastSelectedModel: model.key })
    await act(async () => { await Promise.resolve() })
    const stale: RuntimeInfo = { ...runtime, model: { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' } }

    const aligned = hook.value.alignRuntime!(stale)
    act(() => { hook.value.changeModel('anthropic/claude-sonnet') })
    await act(async () => {
      pendingCommand.resolve({})
      await pendingCommand.promise
      await aligned
    })

    expect(command).toHaveBeenNthCalledWith(1, 'runtime-1', { type: 'set_model', provider: 'anthropic', modelId: 'claude-sonnet' })
    expect(command).toHaveBeenNthCalledWith(2, 'runtime-1', { type: 'set_thinking_level', level: 'low' })
  })


  it('propagates an alignment failure without refreshing or reporting through the hook', async () => {
    const command = vi.fn().mockRejectedValue(new Error('model rejected'))
    const hook = await mountSelectionHook({ command, lastSelectedModel: model.key })
    await act(async () => { await Promise.resolve() })
    const stale: RuntimeInfo = { ...runtime, model: { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' } }

    await expect(hook.value.alignRuntime!(stale)).rejects.toThrow('model rejected')

    expect(hook.refreshState).not.toHaveBeenCalled()
    expect(hook.syncRuntime).not.toHaveBeenCalled()
  })

  it('leaves a streaming runtime untouched', async () => {
    const hook = await mountSelectionHook({ lastSelectedModel: model.key })
    await act(async () => { await Promise.resolve() })
    const streaming: RuntimeInfo = {
      ...runtime,
      isStreaming: true,
      model: { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' },
      thinkingLevel: 'low',
    }

    let aligned: RuntimeInfo | undefined
    await act(async () => { aligned = await hook.value.alignRuntime!(streaming) })

    expect(aligned).toBe(streaming)
    expect(hook.command).not.toHaveBeenCalled()
    expect(hook.refreshState).not.toHaveBeenCalled()
  })
})
