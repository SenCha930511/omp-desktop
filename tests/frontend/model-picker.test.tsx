// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker } from '../../src/components/ModelPicker'
import { groupModelsByProvider } from '../../src/hooks/useProviderCatalog'
import type { PrimeModelDescriptor, PrimeModelPresetRecord, PrimeProviderDescriptor } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const model = (key: string, provider: string, name: string, available = true): PrimeModelDescriptor => ({
  key,
  provider,
  id: key.slice(key.indexOf('/') + 1),
  name,
  reasoning: true,
  input: ['text'],
  contextWindow: 200_000,
  maxTokens: 32_000,
  availableThinkingLevels: ['medium'],
  fastModeSupported: false,
  available,
})

const models = [
  model('openai/gpt-5.6-sol', 'openai', 'GPT-5.6 Sol'),
  model('openai/gpt-5.6-luna', 'openai', 'GPT-5.6 Luna'),
  model('anthropic/claude-opus-4-8', 'anthropic', 'Claude Opus 4.8'),
  model('anthropic/claude-sonnet-4-7', 'anthropic', 'Claude Sonnet 4.7', false),
]
const providers: PrimeProviderDescriptor[] = [
  { id: 'openai', name: 'OpenAI', authMethod: 'oauth', configured: true, modelCount: 2, availableModelCount: 2, enabled: true },
  { id: 'anthropic', name: 'Anthropic', authMethod: 'api_key', configured: false, modelCount: 2, availableModelCount: 1, enabled: true },
]
const modelsByProvider = groupModelsByProvider(models)

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function renderPicker(onChange = vi.fn()) {
  await act(async () => {
    root.render(<ModelPicker value="openai/gpt-5.6-sol" modelsByProvider={modelsByProvider} providers={providers} onChange={onChange} />)
  })
  return onChange
}

async function openPicker(): Promise<HTMLInputElement> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.model-picker__trigger')?.click()
  })
  return container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!
}

function optionLabels(): string[] {
  return [...container.querySelectorAll<HTMLElement>('[role="option"] strong')].map((option) => option.textContent ?? '')
}

async function setSearch(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ModelPicker presets', () => {
  const presets: PrimeModelPresetRecord[] = [
    { name: 'fast-cell', modelRoles: { default: 'openai/gpt-5.6-sol:low', advisor: 'anthropic/claude-opus-4-8:max' }, defaultThinkingLevel: 'auto' },
    { name: 'plan-deck', modelRoles: { default: 'anthropic/claude-opus-4-8:medium' }, defaultThinkingLevel: 'medium' },
  ]
  async function renderPresetPicker(onSwitchPreset = vi.fn(), onSavePreset = vi.fn()) {
    await act(async () => {
      root.render(<ModelPicker value="openai/gpt-5.6-sol" modelsByProvider={modelsByProvider} providers={providers} onChange={vi.fn()} presets={presets} onSwitchPreset={onSwitchPreset} onSavePreset={onSavePreset} />)
    })
    return { onSwitchPreset, onSavePreset }
  }

  it('lists presets above the models with their default role and level summary', async () => {
    await renderPresetPicker()
    await openPicker()
    const group = container.querySelector('.model-picker__group--presets')
    expect(group?.querySelector('.model-picker__group-heading')?.textContent).toContain('Model presets')
    expect(optionLabels().slice(0, 2)).toEqual(['fast-cell', 'plan-deck'])
    const first = group?.querySelectorAll('.model-picker__option--preset small')[0]
    expect(first?.textContent).toBe('openai/gpt-5.6-sol:low · auto')
  })

  it('activates a preset by click and by keyboard entry, and keeps models out of its row', async () => {
    const { onSwitchPreset } = await renderPresetPicker()
    const search = await openPicker()
    await act(async () => { container.querySelectorAll<HTMLButtonElement>('.model-picker__option--preset')[1]?.click() })
    expect(onSwitchPreset).toHaveBeenCalledWith(presets[1])

    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<ModelPicker value="openai/gpt-5.6-sol" modelsByProvider={modelsByProvider} providers={providers} onChange={vi.fn()} presets={presets} onSwitchPreset={onSwitchPreset} />))
    await openPicker()
    // Home lands on the first preset row deterministically regardless of the
    // preselected model's position in the ring.
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onSwitchPreset).toHaveBeenCalledTimes(2)
    expect(onSwitchPreset).toHaveBeenLastCalledWith(presets[0])
  })

  it('searches presets by name and role value without hiding them behind a provider filter-less view', async () => {
    await renderPresetPicker()
    const search = await openPicker()
    await setSearch(search, 'karate')
    expect(optionLabels()).toHaveLength(0)
    await setSearch(search, 'advisor')
    expect(optionLabels()).toEqual(['fast-cell'])
    await setSearch(search, 'plan-deck')
    expect(optionLabels()).toEqual(['plan-deck'])
  })

  it('saves the current setup through the save row and clears the input', async () => {
    const { onSavePreset } = await renderPresetPicker()
    await openPicker()
    const input = container.querySelector<HTMLInputElement>('.model-picker__preset-save input')!
    await setSearch(input, 'desk-light')
    await act(async () => { container.querySelector<HTMLButtonElement>('.model-picker__preset-save .button')?.click() })
    expect(onSavePreset).toHaveBeenCalledWith('desk-light')
    expect(input.value).toBe('')
  })

  it('renders no preset section when the harness has none', async () => {
    await renderPicker()
    await openPicker()
    expect(container.querySelector('.model-picker__group--presets')).toBeNull()
  })
})

describe('ModelPicker', () => {
  it('searches model names, ids, and providers', async () => {
    await renderPicker()
    const search = await openPicker()

    expect(document.activeElement).toBe(search)
    expect(optionLabels()).toEqual(['GPT-5.6 Sol', 'GPT-5.6 Luna', 'Claude Opus 4.8', 'Claude Sonnet 4.7'])

    await setSearch(search, 'opus')
    expect(optionLabels()).toEqual(['Claude Opus 4.8'])

    await setSearch(search, 'anthropic')
    expect(optionLabels()).toEqual(['Claude Opus 4.8', 'Claude Sonnet 4.7'])
  })

  it('filters the visible list by provider', async () => {
    await renderPicker()
    await openPicker()

    await act(async () => {
      ;[...container.querySelectorAll<HTMLButtonElement>('.model-picker__providers button')]
        .find((button) => button.textContent === 'Anthropic')?.click()
    })

    expect(optionLabels()).toEqual(['Claude Opus 4.8', 'Claude Sonnet 4.7'])
    expect(container.querySelector('.model-picker__group-heading')?.textContent).toContain('Not connected')
  })

  it('filters to a provider whose id collides with the unfiltered sentinel', async () => {
    const collidingModels = [
      model('all/local-large', 'all', 'Local Large'),
      model('openai/gpt-5.6-sol', 'openai', 'GPT-5.6 Sol'),
    ]
    const collidingProviders: PrimeProviderDescriptor[] = [
      { id: 'all', name: 'All Hands', authMethod: 'api_key', configured: true, modelCount: 1, availableModelCount: 1, enabled: true },
      { id: 'openai', name: 'OpenAI', authMethod: 'oauth', configured: true, modelCount: 1, availableModelCount: 1, enabled: true },
    ]
    await act(async () => {
      root.render(<ModelPicker value="openai/gpt-5.6-sol" modelsByProvider={groupModelsByProvider(collidingModels)} providers={collidingProviders} onChange={vi.fn()} />)
    })
    await openPicker()

    await act(async () => {
      ;[...container.querySelectorAll<HTMLButtonElement>('.model-picker__providers button')]
        .find((button) => button.textContent === 'All Hands')?.click()
    })

    expect(optionLabels()).toEqual(['Local Large'])
    const chips = [...container.querySelectorAll<HTMLButtonElement>('.model-picker__providers button')]
    expect(chips.find((chip) => chip.textContent === 'All')?.getAttribute('aria-pressed')).toBe('false')
    expect(chips.find((chip) => chip.textContent === 'All Hands')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('dismisses with Escape from the provider filters, not just the search field', async () => {
    await renderPicker()
    await openPicker()

    const anthropic = [...container.querySelectorAll<HTMLButtonElement>('.model-picker__providers button')]
      .find((button) => button.textContent === 'Anthropic')!
    await act(async () => {
      anthropic.focus()
      anthropic.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(container.querySelector('.model-picker__popover')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('.model-picker__trigger'))
  })

  it('dismisses when keyboard focus leaves the popover', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    await renderPicker()
    const search = await openPicker()

    await act(async () => {
      outside.focus()
      search.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }))
    })

    expect(container.querySelector('.model-picker__popover')).toBeNull()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('selects an available result from the keyboard and restores trigger focus', async () => {
    const onChange = await renderPicker()
    const search = await openPicker()

    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(onChange).toHaveBeenCalledWith('openai/gpt-5.6-luna')
    expect(container.querySelector('.model-picker__popover')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('.model-picker__trigger'))
  })

  it('keeps unavailable models visible but prevents selection', async () => {
    const onChange = await renderPicker()
    const search = await openPicker()

    await setSearch(search, 'sonnet')
    const unavailable = container.querySelector<HTMLButtonElement>('[role="option"]')!
    expect(unavailable.getAttribute('aria-disabled')).toBe('true')

    await act(async () => unavailable.click())
    expect(onChange).not.toHaveBeenCalled()
    expect(container.querySelector('.model-picker__popover')).not.toBeNull()
  })

  it('shows the model id under every entry, even when it matches the name', async () => {
    const same = model('openai/GLM-5.2', 'openai', 'GLM-5.2')
    const provider: PrimeProviderDescriptor = { id: 'openai', name: 'OpenAI', authMethod: 'oauth', configured: true, modelCount: 1, availableModelCount: 1, enabled: true }
    await act(async () => {
      root.render(<ModelPicker value="openai/GLM-5.2" modelsByProvider={groupModelsByProvider([same])} providers={[provider]} onChange={vi.fn()} />)
    })
    await openPicker()
    const identity = container.querySelector('.model-picker__option .model-picker__identity')!
    expect(identity.querySelector('strong')?.textContent).toBe('GLM-5.2')
    expect(identity.querySelector('small')?.textContent).toBe('GLM-5.2')
  })
})
