// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProviderCatalog, useProviderCatalog } from '../../src/hooks/useProviderCatalog'
import { ProviderSettings } from '../../src/pages/settings/ProviderSettings'
import type { PrimeModelCatalog, DesktopApi, RuntimeInfo } from '../../src/types/api'

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
    syncRuntime?: (runtimeId: string) => Promise<void>
    reportError?: (error: unknown) => void
  }) {
    let value: ProviderCatalog | undefined
    const catalogMock = vi.fn().mockResolvedValue(catalog)
    const bridge = {
      agent: { command: options.command },
      providers: {
        catalog: catalogMock,
      },
    } as unknown as DesktopApi
    const syncRuntime = options.syncRuntime ?? vi.fn().mockResolvedValue(undefined)
    const reportError = options.reportError ?? vi.fn()
    function Harness() {
      value = useProviderCatalog({ bridge, runtime, syncRuntime, reportError })
      return null
    }
    return render(<Harness />).then(() => ({ get value() { return value! }, catalogMock, syncRuntime, reportError }))
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
})
