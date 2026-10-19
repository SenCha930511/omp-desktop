import { describe, expect, it } from 'vitest'
import { withModelVisibility } from '../../electron/main/model-visibility'
import type { PrimeModelCatalog } from '../../src/types/api'

const catalog: PrimeModelCatalog = {
  primeVersion: 'test',
  refreshedAt: '2026-08-13T00:00:00.000Z',
  providers: [{ id: 'openai', name: 'OpenAI', authMethod: 'external', configured: true, modelCount: 2, availableModelCount: 2, enabled: true }],
  models: [
    { key: 'openai/alpha', provider: 'openai', id: 'alpha', name: 'Alpha', reasoning: false, input: ['text'], contextWindow: 1, maxTokens: 1, availableThinkingLevels: ['off'], fastModeSupported: false, available: true },
    { key: 'openai/beta', provider: 'openai', id: 'beta', name: 'Beta', reasoning: false, input: ['text'], contextWindow: 1, maxTokens: 1, availableThinkingLevels: ['off'], fastModeSupported: false, available: true },
  ],
}

const appleCatalog: PrimeModelCatalog = {
  primeVersion: 'test',
  refreshedAt: '2026-08-13T00:00:00.000Z',
  providers: [{ id: 'apple', name: 'Apple', authMethod: 'external', configured: true, modelCount: 1, availableModelCount: 1, enabled: true }],
  models: [
    { key: 'apple/on-device', provider: 'apple', id: 'on-device', name: 'On device', reasoning: false, input: ['text'], contextWindow: 1, maxTokens: 1, availableThinkingLevels: ['off'], fastModeSupported: false, available: true },
  ],
}

describe('withModelVisibility', () => {
  it('turns every model off when its provider is off', () => {
    const result = withModelVisibility(catalog, new Set(['openai']), new Set())
    expect(result.providers[0].enabled).toBe(false)
    expect(result.models.map((model) => model.enabled)).toEqual([false, false])
  })

  it('keeps a provider on while any model is on and turns it off when none are on', () => {
    const partial = withModelVisibility(catalog, new Set(), new Set(['openai/beta']))
    expect(partial.providers[0].enabled).toBe(true)
    expect(partial.models.map((model) => model.enabled)).toEqual([true, false])

    const empty = withModelVisibility(catalog, new Set(), new Set(['openai/alpha', 'openai/beta']))
    expect(empty.providers[0].enabled).toBe(false)
    expect(empty.models.map((model) => model.enabled)).toEqual([false, false])
  })

  it('hides opt-in providers until the user enables them', () => {
    const hidden = withModelVisibility(appleCatalog, new Set(), new Set())
    expect(hidden.providers[0].enabled).toBe(false)
    expect(hidden.models.map((model) => model.enabled)).toEqual([false])

    const shown = withModelVisibility(appleCatalog, new Set(), new Set(), new Set(['apple']))
    expect(shown.providers[0].enabled).toBe(true)
    expect(shown.models.map((model) => model.enabled)).toEqual([true])

    // Re-hiding an opt-in provider clears only the affirmative list: the
    // disabled-Providers path cannot accidentally re-show it.
    const reHidden = withModelVisibility(appleCatalog, new Set(['apple']), new Set(), new Set(['apple']))
    expect(reHidden.providers[0].enabled).toBe(true)
  })
})
