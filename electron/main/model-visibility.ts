import type { PrimeModelCatalog } from '../../src/types/api'

/**
 * Providers the harness advertises without any explicit user configuration.
 * macOS always lists Apple's on-device Foundation Model, yet its 8K context
 * cannot hold the agent scaffold (every call trips context_size_exceeded), so
 * offering it by default reads as broken. These providers stay hidden until
 * the user enables them in Providers settings.
 */
export const OPT_IN_PROVIDERS: ReadonlySet<string> = new Set(['apple'])

/** Applies OMP Desktop's synchronized provider/model visibility policy to a raw harness catalog. */
export function withModelVisibility(
  catalog: PrimeModelCatalog,
  disabledProviders: ReadonlySet<string>,
  disabledModels: ReadonlySet<string>,
  enabledProviders: ReadonlySet<string> = new Set(),
): PrimeModelCatalog {
  const modelKeysByProvider = new Map<string, string[]>()
  for (const model of catalog.models) {
    const keys = modelKeysByProvider.get(model.provider)
    if (keys) keys.push(model.key)
    else modelKeysByProvider.set(model.provider, [model.key])
  }

  const providerEnabled = new Map(catalog.providers.map((provider) => {
    const modelKeys = modelKeysByProvider.get(provider.id)
    const hasEnabledModel = !modelKeys || modelKeys.some((key) => !disabledModels.has(key))
    const baseVisible = OPT_IN_PROVIDERS.has(provider.id) ? enabledProviders.has(provider.id) : !disabledProviders.has(provider.id)
    return [provider.id, baseVisible && hasEnabledModel] as const
  }))

  return {
    ...catalog,
    models: catalog.models.map((model) => ({
      ...model,
      enabled: providerEnabled.get(model.provider) !== false && !disabledModels.has(model.key),
    })),
    providers: catalog.providers.map((provider) => ({ ...provider, enabled: providerEnabled.get(provider.id) !== false })),
  }
}
