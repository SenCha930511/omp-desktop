import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ConformanceClient, type ConformanceSandbox, createConformanceSandbox, requireCapability } from './client'
import { createOmpFixtureExecutable } from './fixtures/launcher'
import type { AdapterInfo } from './protocol'

const CONFORMANCE_DIR = dirname(fileURLToPath(import.meta.url))

function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'adapters') continue
      collectTestFiles(full, out)
    } else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

let client: ConformanceClient
let info: AdapterInfo
let sandbox: ConformanceSandbox | null = null

beforeAll(async () => {
  client = await ConformanceClient.launch()
  info = await client.info()
})

afterEach(async () => {
  await client.call('state.close').catch(() => undefined)
  sandbox?.cleanup()
  sandbox = null
})

afterAll(async () => {
  await client.close()
})

describe('conformance: architectural isolation, black-box fixture, & PTY terminal', () => {
  it('keeps all conformance suites & fixtures completely decoupled from Electron/React source files', () => {
    const files = collectTestFiles(CONFORMANCE_DIR)
    expect(files.length).toBeGreaterThanOrEqual(11)
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      expect(content, `${file} must not import Electron runtime`).not.toMatch(/from\s+['"]electron['"]/)
      expect(content, `${file} must not import electron/ sources`).not.toMatch(/from\s+['"][^'"]*electron\//)
      expect(content, `${file} must not import src/ renderer sources`).not.toMatch(/from\s+['"][^'"]*src\//)
      expect(content, `${file} must not import scripts/ sources`).not.toMatch(/from\s+['"][^'"]*scripts\//)
    }
  })

  it('spawns the standalone omp-fixture natively with shell:false across platforms', () => {
    sandbox = createConformanceSandbox('omp-conf-bb-')
    const binDir = join(sandbox.rootDir, 'standalone-bin')
    const executable = createOmpFixtureExecutable(binDir)

    const version = spawnSync(executable, ['--version'], { shell: false, encoding: 'utf8' })
    expect(version.status).toBe(0)
    expect(version.stdout.trim()).toBe('omp/17.2.15')

    const models = spawnSync(executable, ['models', '--json'], { shell: false, encoding: 'utf8' })
    expect(models.status).toBe(0)
    const parsed = JSON.parse(models.stdout) as { models: Array<{ provider: string; id: string }> }
    expect(parsed.models.some((m) => m.provider === 'openai-codex' && m.id === 'gpt-5.4')).toBe(true)
  })

  it('manages PTY terminals inside granted projects, reads output, resizes, and terminates cleanly', async () => {
    if (!requireCapability(info, 'terminal') || !requireCapability(info, 'projects')) return
    sandbox = createConformanceSandbox('omp-conf-pty-')
    const projectDir = join(sandbox.rootDir, 'project')
    const unauthorizedDir = join(sandbox.rootDir, 'unauthorized')
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(unauthorizedDir, { recursive: true })

    await client.call('workspace.reset', {
      rootDir: sandbox.rootDir,
      homeDir: sandbox.homeDir,
      userDataDir: sandbox.userDataDir,
      appDataDir: sandbox.appDataDir,
      ompExecutable: sandbox.ompExecutable,
    })

    await client.callExpectError('terminal.create', { cwd: unauthorizedDir })
    await client.call('projects.grant', { path: projectDir })

    const created = await client.call<{ terminalId: string; shell: string }>('terminal.create', {
      cwd: projectDir,
      cols: 80,
      rows: 24,
    })
    expect(created.terminalId).toBeTruthy()
    expect(created.shell).toBeTruthy()

    const marker = 'OMP_PTY_CONFORMANCE_MARKER_789'
    const command = process.platform === 'win32' ? `echo ${marker}\r\n` : `echo ${marker}\r`
    await client.call('terminal.input', { terminalId: created.terminalId, data: command })

    let captured = ''
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && !captured.includes(marker)) {
      const chunk = await client.call<{ output: string; exited: boolean }>('terminal.readOutput', {
        terminalId: created.terminalId,
      })
      captured += chunk.output
      if (captured.includes(marker)) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40))
    }
    expect(captured).toContain(marker)

    await client.call('terminal.resize', { terminalId: created.terminalId, cols: 120, rows: 40 })
    expect(await client.call<boolean>('terminal.kill', { terminalId: created.terminalId })).toBe(true)
  })

  it('validates black-box compiled binary readiness marker when OMP_SMOKE_EXECUTABLE is configured', () => {
    const customExe = process.env.OMP_SMOKE_EXECUTABLE?.trim()
    if (!customExe) {
      expect(process.env.OMP_SMOKE_EXECUTABLE ?? '').toBe('')
      return
    }
    sandbox = createConformanceSandbox('omp-conf-smoke-')
    const markerPath = join(sandbox.rootDir, 'smoke-ready.json')
    const smokeUserData = join(sandbox.rootDir, 'smoke-user-data')
    mkdirSync(smokeUserData, { recursive: true })
    const result = spawnSync(resolve(customExe), [`--packaged-smoke=${markerPath}`, `--user-data-dir=${smokeUserData}`], {
      cwd: dirname(resolve(customExe)),
      encoding: 'utf8',
      timeout: 45_000,
      shell: false,
    })
    expect(result.status).toBe(0)
    expect(existsSync(markerPath)).toBe(true)
    expect(statSync(markerPath).size).toBeLessThanOrEqual(4096)
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { event: string; url: string; version: string }
    expect(marker.event).toBe('gooeypi-packaged-smoke-ready')
    expect(() => new URL(marker.url)).not.toThrow()
    expect(marker.version.length).toBeGreaterThan(0)
  })
})
