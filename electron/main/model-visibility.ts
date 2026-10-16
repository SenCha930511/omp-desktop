import type { PrimeModelCatalog } from '../../src/types/api'

/** Applies OMP Desktop's synchronized provider/model visibility policy to a raw harness catalog. */
export function withModelVisibility(
  catalog: PrimeModelCatalog,
  disabledProviders: ReadonlySet<string>,
  disabledModels: ReadonlySet<string>,
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
    return [provider.id, !disabledProviders.has(provider.id) && hasEnabledModel] as const
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
