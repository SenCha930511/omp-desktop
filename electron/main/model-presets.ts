import { readFile } from 'node:fs/promises'
import { load as parseYaml } from 'js-yaml'
import type { PrimeModelPresetRecord } from '../../src/types/api'

const MAX_PRESETS = 128
const MAX_PRESET_NAME_CHARS = 64
const MAX_ROLE_ENTRIES = 64
const MAX_ROLE_NAME_CHARS = 64
const MAX_ROLE_VALUE_CHARS = 256

/**
 * Reads `modelPresets` from the harness config (`config.yml`). YAML is a data
 * file here — the harness owns the schema — so every entry is validated and
 * bounded before it reaches the renderer.
 */
export async function readModelPresets(configFile: string): Promise<PrimeModelPresetRecord[]> {
  let raw: unknown
  try {
    const text = await readFile(configFile, 'utf8')
    raw = parseYaml(text)
  } catch {
    return []
  }
  if (!raw || typeof raw !== 'object') return []
  const table = (raw as Record<string, unknown>).modelPresets
  if (!table || typeof table !== 'object') return []
  const presets: PrimeModelPresetRecord[] = []
  for (const [name, entry] of Object.entries(table as Record<string, unknown>)) {
    if (presets.length >= MAX_PRESETS) break
    if (!name.trim() || name.length > MAX_PRESET_NAME_CHARS) continue
    if (!entry || typeof entry !== 'object') continue
    const rolesRaw = (entry as Record<string, unknown>).modelRoles
    const modelRoles: Record<string, string> = {}
    if (rolesRaw && typeof rolesRaw === 'object') {
      for (const [role, value] of Object.entries(rolesRaw as Record<string, unknown>).slice(0, MAX_ROLE_ENTRIES)) {
        if (role.length > MAX_ROLE_NAME_CHARS) continue
        if (typeof value === 'string' && value.trim() && value.length <= MAX_ROLE_VALUE_CHARS) modelRoles[role] = value
      }
    }
    const thinking = (entry as Record<string, unknown>).defaultThinkingLevel
    presets.push({ name, modelRoles, ...(typeof thinking === 'string' && thinking.length <= 32 ? { defaultThinkingLevel: thinking } : {}) })
  }
  return presets
}
