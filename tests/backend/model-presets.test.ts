import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readModelPresets } from '../../electron/main/model-presets'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'omp-presets-'))
  dirs.push(dir)
  const file = join(dir, 'config.yml')
  writeFileSync(file, body)
  return file
}

describe('readModelPresets', () => {
  it('parses presets with roles and a default thinking level', async () => {
    const file = writeConfig(`modelPresets:
  fast-cell:
    modelRoles:
      default: nchc/GLM-5.3:auto
      advisor: nchc/Kimi-K3:max
    defaultThinkingLevel: auto
  plan-deck:
    modelRoles:
      default: openai-codex/gpt-6-astra:medium
    note: plan work
`)
    await expect(readModelPresets(file)).resolves.toEqual([
      { name: 'fast-cell', modelRoles: { default: 'nchc/GLM-5.3:auto', advisor: 'nchc/Kimi-K3:max' }, defaultThinkingLevel: 'auto' },
      { name: 'plan-deck', modelRoles: { default: 'openai-codex/gpt-6-astra:medium' } },
    ])
  })

  it('returns an empty list for a missing file, broken YAML, or a presets section with the wrong shape', async () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'omp-presets-missing-')), 'config.yml')
    dirs.push(missing.split('/').slice(0, -1).join('/'))
    await expect(readModelPresets(missing)).resolves.toEqual([])
    await expect(readModelPresets(writeConfig('modelPresets: [not-a-map]'))).resolves.toEqual([])
    await expect(readModelPresets(writeConfig('modelPresets:\n  oil: : :'))).resolves.toEqual([])
  })

  it('drops oversized names and non-string role values, and keeps bounded caps', async () => {
    const rows: string[] = []
    for (let index = 0; index < 140; index++) rows.push(`  preset-${index}:\n    modelRoles:\n      default: p/m:a`)
    const overlong = 'x'.repeat(65)
    const file = writeConfig(`modelPresets:\n  bad-roles:\n    modelRoles:\n      default: p/m:a\n      broken: 12\n  ${overlong}:\n    modelRoles:\n      default: p/m:a\n${rows.join('\n')}\n`)
    const presets = await readModelPresets(file)
    expect(presets).toHaveLength(128)
    expect(presets.every((preset) => preset.name.length <= 64)).toBe(true)
    const badRoles = presets.find((preset) => preset.name === 'bad-roles')
    expect(badRoles?.modelRoles).toEqual({ default: 'p/m:a' })
  })

  it('reuses a parsed table until the file identity changes', async () => {
    const file = writeConfig('modelPresets:\n  fast:\n    modelRoles:\n      default: p/m:a\n')
    const stamp = new Date('2026-01-01T00:00:00Z')
    utimesSync(file, stamp, stamp)
    await expect(readModelPresets(file)).resolves.toEqual([{ name: 'fast', modelRoles: { default: 'p/m:a' } }])
    // Same byte length and a restored mtime: the cached parse is served.
    writeFileSync(file, 'modelPresets:\n  fast:\n    modelRoles:\n      default: p/m:b\n')
    utimesSync(file, stamp, stamp)
    await expect(readModelPresets(file)).resolves.toEqual([{ name: 'fast', modelRoles: { default: 'p/m:a' } }])
    // A new mtime invalidates the entry.
    const later = new Date('2026-01-02T00:00:00Z')
    utimesSync(file, later, later)
    await expect(readModelPresets(file)).resolves.toEqual([{ name: 'fast', modelRoles: { default: 'p/m:b' } }])
  })

  it('returns copies so callers cannot mutate the cached table', async () => {
    const file = writeConfig('modelPresets:\n  fast:\n    modelRoles:\n      default: p/m:a\n')
    const first = await readModelPresets(file)
    first[0].modelRoles.default = 'mutated/model:x'
    first.push({ name: 'injected', modelRoles: {} })
    await expect(readModelPresets(file)).resolves.toEqual([{ name: 'fast', modelRoles: { default: 'p/m:a' } }])
  })

  it('does not cache a missing config, so a later write is picked up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-presets-late-'))
    dirs.push(dir)
    const file = join(dir, 'config.yml')
    await expect(readModelPresets(file)).resolves.toEqual([])
    writeFileSync(file, 'modelPresets:\n  fast:\n    modelRoles:\n      default: p/m:a\n')
    await expect(readModelPresets(file)).resolves.toEqual([{ name: 'fast', modelRoles: { default: 'p/m:a' } }])
  })

  it('keeps a separate entry per config file', async () => {
    const first = writeConfig('modelPresets:\n  alpha:\n    modelRoles:\n      default: p/m:a\n')
    const second = writeConfig('modelPresets:\n  beta:\n    modelRoles:\n      default: p/m:b\n')
    await expect(readModelPresets(first)).resolves.toMatchObject([{ name: 'alpha' }])
    await expect(readModelPresets(second)).resolves.toMatchObject([{ name: 'beta' }])
    await expect(readModelPresets(first)).resolves.toMatchObject([{ name: 'alpha' }])
  })
})
