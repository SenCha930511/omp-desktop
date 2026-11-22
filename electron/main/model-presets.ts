import { readFile, stat } from 'node:fs/promises'
import { load as parseYaml } from 'js-yaml'
import type { PrimeModelPresetRecord } from '../../src/types/api'

const MAX_PRESETS = 128
const MAX_PRESET_NAME_CHARS = 64
const MAX_ROLE_ENTRIES = 64
const MAX_ROLE_NAME_CHARS = 64
const MAX_ROLE_VALUE_CHARS = 256
const MAX_PRESET_FILE_CACHE_ENTRIES = 8

interface PresetFileCacheEntry {
  mtimeMs: number
  size: number
  presets: PrimeModelPresetRecord[]
}

const presetFileCache = new Map<string, PresetFileCacheEntry>()

/**
 * Reads `modelPresets` from the harness config (`config.yml`). YAML is a data
 * file here — the harness owns the schema — so every entry is validated and
 * bounded before it reaches the renderer.
 *
 * The config is parsed on every settings read, so a parsed result is cached
 * against the file's `(mtimeMs, size)` identity; an edit changes at least one
 * of those and the next call reparses. Missing or unparsable files are never
 * cached, and callers receive copies so a consumer cannot mutate cached rows.
 */
export async function readModelPresets(configFile: string): Promise<PrimeModelPresetRecord[]> {
  let mtimeMs: number
  let size: number
  try {
    const info = await stat(configFile)
    mtimeMs = info.mtimeMs
    size = info.size
  } catch {
    presetFileCache.delete(configFile)
    return []
  }
  const cached = presetFileCache.get(configFile)
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return copyPresets(cached.presets)
  let raw: unknown
  try {
    raw = parseYaml(await readFile(configFile, 'utf8'))
  } catch {
    presetFileCache.delete(configFile)
    return []
  }
  const presets = parsePresets(raw)
  presetFileCache.delete(configFile)
  presetFileCache.set(configFile, { mtimeMs, size, presets })
  while (presetFileCache.size > MAX_PRESET_FILE_CACHE_ENTRIES) {
    const oldest = presetFileCache.keys().next().value
    if (oldest === undefined) break
    presetFileCache.delete(oldest)
  }
  return copyPresets(presets)
}

function copyPresets(presets: readonly PrimeModelPresetRecord[]): PrimeModelPresetRecord[] {
  return presets.map((preset) => ({ ...preset, modelRoles: { ...preset.modelRoles } }))
}

function parsePresets(raw: unknown): PrimeModelPresetRecord[] {
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
