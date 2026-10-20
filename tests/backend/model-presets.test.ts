import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
})
