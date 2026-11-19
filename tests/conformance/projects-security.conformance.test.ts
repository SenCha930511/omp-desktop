import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, parse } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ConformanceClient, type ConformanceSandbox, createConformanceSandbox, requireCapability } from './client'
import type { AdapterInfo } from './protocol'

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

describe('conformance: projects & containment security', () => {
  it('grants projects persistently, rejects broad roots, filters symlinks, and revokes on removal', async () => {
    if (!requireCapability(info, 'projects')) return
    sandbox = createConformanceSandbox('omp-conf-proj-')
    await client.call('workspace.reset', {
      rootDir: sandbox.rootDir,
      homeDir: sandbox.homeDir,
      userDataDir: sandbox.userDataDir,
      appDataDir: sandbox.appDataDir,
      ompExecutable: sandbox.ompExecutable,
    })

    const projectDir = join(sandbox.rootDir, 'workspace')
    const outsideDir = join(sandbox.rootDir, 'outside')
    mkdirSync(join(projectDir, 'src'), { recursive: true })
    mkdirSync(join(projectDir, '.git'), { recursive: true })
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(projectDir, 'README.md'), '# Project\n', 'utf8')
    writeFileSync(join(projectDir, 'src', 'main.ts'), 'export const ok = true\n', 'utf8')
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret\n', 'utf8')

    let symlinkCreated = false
    try {
      symlinkSync(join(outsideDir, 'secret.txt'), join(projectDir, 'escape-link.txt'))
      symlinkCreated = true
    } catch {
      // Unprivileged Windows runners without Developer Mode may forbid symlinks.
    }

    const fsRoot = parse(sandbox.rootDir).root
    const broadRootError = await client.callExpectError('projects.grant', { path: fsRoot })
    expect(broadRootError.message).toMatch(/broad/i)

    const granted = await client.call<{ id: string; harness: string; primaryFolder: string }>('projects.grant', { path: projectDir })
    expect(granted.harness).toBe('omp')
    expect(realpathSync(granted.primaryFolder)).toBe(realpathSync(projectDir))

    const listing = await client.call<{ entries: Array<{ path: string; type: string }> }>('projects.listFiles', { root: projectDir })
    const paths = listing.entries.map((entry) => entry.path)
    expect(paths).toContain('README.md')
    expect(paths).toContain('src/main.ts')
    expect(paths.some((entryPath) => entryPath.startsWith('.git'))).toBe(false)
    if (symlinkCreated) {
      expect(paths).not.toContain('escape-link.txt')
    }

    // Grant survives restart.
    await client.call('state.close')
    await client.call('state.open')
    const persisted = await client.call<Array<{ id: string }>>('projects.list')
    expect(persisted.some((project) => project.id === granted.id)).toBe(true)

    // Removing the project revokes file-listing authorization immediately.
    const removed = await client.call<boolean>('projects.remove', { id: granted.id })
    expect(removed).toBe(true)
    await client.callExpectError('projects.listFiles', { root: projectDir })
  })
})
