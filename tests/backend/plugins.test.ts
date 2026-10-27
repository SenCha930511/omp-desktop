import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginService, beginPluginDiscoveryShutdown } from '../../electron/main/plugins'
import { removeMcpDefinition, updateMcpSettings, updateMcpState } from '../../electron/main/plugins/mcp'
import { ProjectService } from '../../electron/main/projects'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-mcp-')); dirs.push(dir); return dir }

describe('PluginService discovery', () => {
  it('reads dynamic bundled capability state on each refreshed catalog', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    let enabled = true
    const service = new PluginService(null, async (path) => resolve(path), {
      agentDir,
      builtInSkills: () => [{
        id: 'gooeypi-ask-user', name: 'Ask user', description: '', kind: 'extension',
        location: 'system', enabled,
      }],
    })

    expect((await service.list()).skills[0].enabled).toBe(true)
    enabled = false
    expect((await service.refresh()).skills[0].enabled).toBe(false)
  })

  it('coalesces duplicate refreshes while discovery is in flight', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const first = service.list()
    const duplicate = service.refresh()

    expect(duplicate).toBe(first)
    await expect(first).resolves.toEqual({ skills: expect.any(Array), warnings: [] })
  })

  it('does not report a shared user settings tree as both user and project', async () => {
    const root = temp()
    const agentDir = join(root, '.omp')
    mkdirSync(agentDir, { recursive: true })
    const sharedPrompt = join(agentDir, 'shared-prompt.md')
    writeFileSync(sharedPrompt, '# Shared')
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
      packages: ['local-package'],
      prompts: [sharedPrompt],
    }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const catalog = await service.list(root)
    const packageRecords = catalog.skills.filter((item) => item.kind === 'package' && item.source === 'local-package')
    const promptRecords = catalog.skills.filter((item) => item.kind === 'prompt' && item.path === realpathSync(sharedPrompt))

    expect(packageRecords).toHaveLength(1)
    expect(packageRecords[0]).toMatchObject({ location: 'user' })
    expect(promptRecords).toHaveLength(1)
    expect(promptRecords[0]).toMatchObject({ location: 'user' })
  })
  it('keeps every user and project OMP MCP definition visible with source scope and editable summaries', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.omp')
    mkdirSync(agentDir)
    mkdirSync(projectAgentDir, { recursive: true })
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      'http-server': { type: 'http', url: 'https://mcp.example/server' },
      'legacy-scalar': 'legacy-owned-value',
    } }))
    writeFileSync(join(projectAgentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      'sse-server': { type: 'sse', url: 'https://project.example/sse' },
      'null-shape': null,
    } }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const records = (await service.list(project)).skills.filter((item) => item.kind === 'mcp')

    for (const [name, location] of [
      ['http-server', 'user'], ['sse-server', 'project'],
    ] as const) {
      // Manageable keys are fully actionable now (edit/enable/disable/remove);
      // availability stays undefined instead of the old external-management block.
      expect(records).toContainEqual(expect.objectContaining({ name, location }))
      expect(records.find((item) => item.name === name)?.availability).toBeUndefined()
    }
    // Non-record definitions never surface, so hostile values stay unread.
    expect(records.some((item) => item.name === 'legacy-scalar' || item.name === 'null-shape')).toBe(false)
    const httpRecord = records.find((item) => item.name === 'http-server')
    expect(httpRecord?.description).toContain('HTTP MCP server at https://mcp.example')
    expect(httpRecord?.description).not.toContain('Managed outside OMP Desktop')
    // 編輯器摘要:URL 原樣帶回;header 值不回流。
    expect(httpRecord?.mcpDefinition).toMatchObject({ transport: 'http', url: 'https://mcp.example/server' })
    const sseRecord = records.find((item) => item.name === 'sse-server')
    expect(sseRecord?.description).toContain('SSE MCP server at https://project.example')
    expect(sseRecord?.mcpDefinition?.transport).toBe('sse')

    await expect(service.mutateCapability({ kind: 'mcp', action: 'remove', name: 'http-server', scope: 'user' }))
      .resolves.toMatchObject({ ok: true })
    await expect(service.mutateCapability({ kind: 'mcp', action: 'remove', name: 'sse-server', scope: 'project', projectPath: project }))
      .resolves.toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8')).mcpServers).not.toHaveProperty('http-server')
    expect(JSON.parse(readFileSync(join(projectAgentDir, 'mcp.json'), 'utf8')).mcpServers).not.toHaveProperty('sse-server')
  })

  it('does not let saturated omp package discovery hide user or project MCP rows', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.omp')
    mkdirSync(agentDir)
    mkdirSync(projectAgentDir, { recursive: true })
    const packages = Array.from({ length: 2_500 }, (_, index) => `npm:catalog-saturation-${index}`)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages }))
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify({ packages }))
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      'user-must-be-visible': { type: 'http', url: 'https://user.example/mcp' },
    } }))
    writeFileSync(join(projectAgentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      'project-must-be-visible': { type: 'http', url: 'https://project.example/mcp' },
    } }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const records = (await service.list(project)).skills.filter((item) => item.kind === 'mcp')

    expect(records).toContainEqual(expect.objectContaining({ name: 'user-must-be-visible', location: 'user' }))
    expect(records).toContainEqual(expect.objectContaining({ name: 'project-must-be-visible', location: 'project' }))
  })

  it.each(['user', 'project'] as const)('bounds omp %s MCP discovery independently and reports the exact truncated file', async (scope) => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.omp')
    mkdirSync(agentDir)
    mkdirSync(projectAgentDir, { recursive: true })
    const mcpServers = Object.fromEntries(Array.from({ length: 2_501 }, (_, index) => [
      `server-${index}`,
      { type: 'http', url: 'https://mcp.example/server' },
    ]))
    const settingsPath = scope === 'user' ? join(agentDir, 'mcp.json') : join(projectAgentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ mcpServers }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const catalog = await service.list(scope === 'project' ? project : undefined)
    const expectedSettingsPath = scope === 'project' ? realpathSync(settingsPath) : settingsPath

    expect(catalog.skills.filter((item) => item.kind === 'mcp')).toHaveLength(2_500)
    expect(catalog.warnings).toContainEqual({
      scope, path: expectedSettingsPath, message: expect.stringContaining('2,500'),
    })
  })

  it('ignores stray OMP settings.json MCP entries so actions identify only mcp.json definitions', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    const mcpPath = join(agentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: {
      docs: { type: 'stdio', command: 'settings-shadow' },
    } }))
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {
      docs: { type: 'stdio', command: 'mcp-native' },
    } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })

    const records = (await service.list()).skills.filter((item) => item.kind === 'mcp' && item.name === 'docs')

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ source: 'mcp-native', definitionKey: 'docs', location: 'user' })
    await expect(service.mutateCapability({
      kind: 'mcp', action: 'remove', name: records[0].name,
      definitionKey: records[0].definitionKey, scope: 'user',
    })).resolves.toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers).toHaveProperty('docs')
    expect(JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers).not.toHaveProperty('docs')
  })

  it('removes unusual OMP definition keys by their exact bounded catalog identity', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const longKey = `long-${'x'.repeat(80)}`
    const oversizedKey = `oversized-${'x'.repeat(1_024)}`
    const definitions: Record<string, unknown> = Object.create(null)
    definitions['team/docs'] = { type: 'http', url: 'https://docs.example/mcp' }
    Object.defineProperty(definitions, '__proto__', {
      value: { type: 'http', url: 'https://prototype.example/mcp' }, enumerable: true, configurable: true, writable: true,
    })
    definitions['control\u0001key'] = { type: 'http', url: 'https://control.example/mcp' }
    definitions[longKey] = { type: 'http', url: 'https://long.example/mcp' }
    definitions[oversizedKey] = { type: 'http', url: 'https://oversized.example/mcp' }
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: definitions }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const records = (await service.list()).skills.filter((item) => item.kind === 'mcp' && item.location === 'user')
    const expected = [
      ['team/docs', 'team/docs'],
      ['__proto__', '__proto__'],
      ['control\u0001key', 'control�key'],
      [longKey, longKey],
    ] as const
    for (const [definitionKey, displayName] of expected) {
      expect(records).toContainEqual(expect.objectContaining({ name: displayName, definitionKey }))
      await expect(service.mutateCapability({
        kind: 'mcp', action: 'remove', name: displayName, definitionKey, scope: 'user',
      } as never)).resolves.toMatchObject({ ok: true })
    }
    expect(records).toContainEqual(expect.objectContaining({
      name: oversizedKey.slice(0, 120), definitionRemovalAvailable: false,
    }))
    expect(records.find((item) => item.name === oversizedKey.slice(0, 120))).not.toHaveProperty('definitionKey')
    await expect(service.mutateCapability({
      kind: 'mcp', action: 'remove', name: 'oversized', definitionKey: oversizedKey, scope: 'user',
    } as never)).rejects.toThrow('exceeds the supported removal limit')
    await expect(removeMcpDefinition(join(agentDir, 'mcp.json'), {
      name: 'oversized', definitionKey: oversizedKey,
    })).rejects.toThrow('exceeds the supported removal limit')
    expect(Object.keys(JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8')).mcpServers)).toEqual([oversizedKey])
  })

  it('uses package manifest metadata and collapses an associated MCP bridge row', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const packageRoot = join(root, 'supabase-bridge')
    mkdirSync(agentDir)
    mkdirSync(packageRoot)
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'OMP Supabase',
      description: 'Connect OMP to Supabase.',
      gooeypi: { mcpServers: ['supabase'] },
    }))
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
      packages: [packageRoot],
    }))
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } },
    }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const catalog = await service.list()

    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'supabase', kind: 'mcp' }))
    expect(catalog.skills).not.toContainEqual(expect.objectContaining({ name: 'OMP Supabase', kind: 'package' }))
  })

  it('uses a normalized slug instead of exposing a package path when metadata is unavailable', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const packageRoot = join(root, 'My Package')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(packageRoot)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [packageRoot] }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const record = (await service.list()).skills.find((skill) => skill.kind === 'package')

    expect(record).toMatchObject({ name: 'my-package', description: 'my-package capability package' })
    expect(record?.description).not.toContain(root)
  })

  it('coalesces lexical aliases after project authorization canonicalizes them', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const alias = join(root, 'project-alias')
    mkdirSync(agentDir); mkdirSync(project); symlinkSync(project, alias)
    let discoveries = 0
    const service = new PluginService(null, async (path) => realpathSync(path), {
      agentDir,
      discover: async () => { discoveries += 1; await new Promise((resolveWait) => setTimeout(resolveWait, 20)); return { skills: [], warnings: [] } },
    })

    await Promise.all([service.list(project), service.list(alias)])

    expect(discoveries).toBe(1)
  })

  it('coalesces hostile concurrent nested paths to their authorized project root', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const pluginPrompt = join(project, 'project-prompt.md')
    mkdirSync(agentDir); mkdirSync(project); writeFileSync(pluginPrompt, '# Project prompt')
    const nestedPaths = Array.from({ length: 96 }, (_, index) => join(project, 'workspaces', String(index), 'deep'))
    for (const path of nestedPaths) mkdirSync(path, { recursive: true })

    const store = new JsonStateStore(join(root, 'state.json'))
    const info = lstatSync(project, { bigint: true })
    await store.update((state) => { state.projects.push({
      id: 'project', harness: 'omp', name: 'Project', path: project, folders: [project], primaryFolder: project, pinned: false,
      createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
      folderIdentities: { [realpathSync(project)]: { dev: info.dev.toString(), ino: info.ino.toString() } },
    }) })
    const projects = new ProjectService(store, () => null)
    await projects.list()

    let authorized = 0
    let signalAuthorized: () => void = () => undefined
    const allAuthorized = new Promise<void>((resolveWait) => { signalAuthorized = resolveWait })
    let releaseDiscovery: () => void = () => undefined
    const discoveryGate = new Promise<void>((resolveWait) => { releaseDiscovery = resolveWait })
    let discoveries = 0
    const discoveredRoots = new Set<string | undefined>()
    const service = new PluginService(null, async (path) => {
      const authorizedRoot = await projects.authorizeProjectRoot(path)
      authorized += 1
      if (authorized === nestedPaths.length) signalAuthorized()
      return authorizedRoot
    }, {
      agentDir,
      discover: async (_agentDir, projectPath) => {
        discoveries += 1
        discoveredRoots.add(projectPath)
        await discoveryGate
        return { skills: [{
          id: 'project-prompt', name: 'Project prompt', description: '', kind: 'prompt',
          location: 'project', path: realpathSync(pluginPrompt), enabled: true,
        }], warnings: [] }
      },
    })

    const requests = nestedPaths.map((path) => service.list(path))
    await allAuthorized
    expect(discoveries).toBe(1)
    expect(discoveredRoots).toEqual(new Set([realpathSync(project)]))
    releaseDiscovery()
    const results = await Promise.all(requests)

    expect(new Set(results).size).toBe(1)
    expect(service.authorizeReveal(pluginPrompt)).toBe(realpathSync(pluginPrompt))
  })

  it('rejects excess distinct discovery work instead of growing the global queue', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    let releaseDiscovery: () => void = () => undefined
    const discoveryGate = new Promise<void>((resolveWait) => { releaseDiscovery = resolveWait })
    let active = 0
    const service = new PluginService(null, async (path) => resolve(path), {
      agentDir,
      discover: async () => {
        active += 1
        await discoveryGate
        active -= 1
        return { skills: [], warnings: [] }
      },
    })

    const outcomes = Array.from({ length: 40 }, (_, index) => service.list(join(root, `hostile-${index}`)))
      .map((request) => request.then(() => 'fulfilled', (error: unknown) => error))
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    const internal = service as unknown as { discoveryInFlight: Map<string, Promise<unknown>> }

    expect(active).toBe(2)
    expect(internal.discoveryInFlight.size).toBeLessThanOrEqual(34)
    releaseDiscovery()
    const settled = await Promise.all(outcomes)
    const rejected = settled.filter((outcome) => outcome !== 'fulfilled')
    expect(rejected).toHaveLength(6)
    expect(rejected.every((error) => error instanceof TypeError && error.message.includes('Too many plugin discoveries'))).toBe(true)
  })

  it('rejects queued discovery waiters on shutdown so pending lists settle', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    let releaseDiscovery: () => void = () => undefined
    const discoveryGate = new Promise<void>((resolveWait) => { releaseDiscovery = resolveWait })
    const service = new PluginService(null, async (path) => resolve(path), {
      agentDir,
      discover: async () => { await discoveryGate; return { skills: [], warnings: [] } },
    })

    const outcomes = Array.from({ length: 4 }, (_, index) => service.list(join(root, `pending-${index}`)))
      .map((request) => request.then(() => 'fulfilled', (error: unknown) => error))
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))

    beginPluginDiscoveryShutdown()
    releaseDiscovery()
    const settled = await Promise.all(outcomes)

    expect(settled.filter((outcome) => outcome === 'fulfilled')).toHaveLength(2)
    const rejected = settled.filter((outcome) => outcome !== 'fulfilled')
    expect(rejected).toHaveLength(2)
    expect(rejected.every((error) => error instanceof TypeError && error.message.includes('shutting down'))).toBe(true)
  })

  it('bounds catalog work globally across distinct discovery keys', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    let active = 0
    let peak = 0
    const service = new PluginService(null, async (path) => resolve(path), {
      agentDir,
      discover: async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
        active -= 1
        return { skills: [], warnings: [] }
      },
    })

    await Promise.all(Array.from({ length: 8 }, (_, index) => service.list(join(root, `project-${index}`))))

    expect(peak).toBe(2)
  })

  it('surfaces a structured warning for invalid settings.json instead of silently hiding plugins', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.omp')
    const skillDir = join(root, 'skills', 'local')
    mkdirSync(agentDir); mkdirSync(skillDir, { recursive: true }); mkdirSync(projectAgentDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: local\n---\nLocal skill')
    writeFileSync(join(agentDir, 'settings.json'), '{ this is not json')
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify(['not', 'an', 'object']))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const catalog = await service.list(project)

    expect(catalog.warnings).toEqual([
      { scope: 'user', path: join(agentDir, 'settings.json'), message: 'settings.json invalid — plugins hidden' },
      { scope: 'project', path: join(realpathSync(project), '.omp', 'settings.json'), message: 'settings.json invalid — plugins hidden' },
    ])
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'local', kind: 'skill' }))
  })

  it('retains reveal authorization independently for user and project catalogs', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.omp')
    const userPrompt = join(root, 'agent', 'user-prompt.md')
    const projectPrompt = join(project, 'project-prompt.md')
    mkdirSync(agentDir); mkdirSync(projectAgentDir, { recursive: true })
    writeFileSync(userPrompt, '# User prompt')
    writeFileSync(projectPrompt, '# Project prompt')
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ prompts: [userPrompt] }))
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify({ prompts: [projectPrompt] }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    await service.list()
    await service.list(project)

    expect(service.authorizeReveal(userPrompt)).toBe(realpathSync(userPrompt))
    expect(service.authorizeReveal(projectPrompt)).toBe(realpathSync(projectPrompt))
  })

  it('re-authorizes refresh scope and revokes reveal paths after project removal', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.omp')
    const projectPrompt = join(project, 'project-prompt.md')
    mkdirSync(agentDir); mkdirSync(projectAgentDir, { recursive: true })
    writeFileSync(projectPrompt, '# Project prompt')
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify({ prompts: [projectPrompt] }))
    const store = new JsonStateStore(join(root, 'state.json'))
    const info = lstatSync(project, { bigint: true })
    await store.update((state) => { state.projects.push({
      id: 'project', harness: 'omp', name: 'Project', path: project, folders: [project], primaryFolder: project, pinned: false,
      createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
      folderIdentities: { [realpathSync(project)]: { dev: info.dev.toString(), ino: info.ino.toString() } },
    }) })
    const projectsService = new ProjectService(store, () => null)
    projectsService.bindProviders({
      sessions: async () => [],
      branch: async () => undefined,
      stopProjectProcesses: async (roots) => service.evictProjects(roots),
    })
    const service = new PluginService(null, (path) => projectsService.authorizeProjectRoot(path), { agentDir })

    await service.list(project)
    expect(service.authorizeReveal(projectPrompt)).toBe(realpathSync(projectPrompt))

    expect(await projectsService.remove('project')).toBe(true)
    await expect(service.refresh()).rejects.toThrow(/not inside an added OMP Desktop project/)
    expect(() => service.authorizeReveal(projectPrompt)).toThrow('plugin path was not discovered')
  })

  it('bounds the reveal path owners to a fixed LRU window', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const projectFor = (index: number) => {
      const project = join(root, `project-${index}`)
      mkdirSync(project)
      writeFileSync(join(project, 'prompt.md'), `# ${index}`)
      return project
    }
    const projects = Array.from({ length: 66 }, (_, index) => projectFor(index))
    const service = new PluginService(null, async (path) => realpathSync(path), {
      agentDir,
      discover: async (_agentDirectory, safeProjectPath) => safeProjectPath
        ? { skills: [{ id: `skill-${safeProjectPath}`, name: 'Prompt', description: '', kind: 'prompt', location: 'project', path: join(safeProjectPath, 'prompt.md'), enabled: true }], warnings: [] }
        : { skills: [], warnings: [] },
    })

    for (const project of projects) await service.list(project)

    expect(() => service.authorizeReveal(join(projects[0], 'prompt.md'))).toThrow('plugin path was not discovered')
    expect(service.authorizeReveal(join(projects.at(-1)!, 'prompt.md'))).toBe(realpathSync(join(projects.at(-1)!, 'prompt.md')))
  })

  it('discovers only the authorized project .agents root without walking ancestors', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'workspace', 'project')
    const localSkill = join(project, '.agents', 'skills', 'local', 'SKILL.md')
    const ancestorSkill = join(root, 'workspace', '.agents', 'skills', 'ancestor', 'SKILL.md')
    mkdirSync(agentDir)
    mkdirSync(resolve(localSkill, '..'), { recursive: true })
    mkdirSync(resolve(ancestorSkill, '..'), { recursive: true })
    writeFileSync(localSkill, '---\nname: local\n---\nLocal skill')
    writeFileSync(ancestorSkill, '---\nname: ancestor\n---\nAncestor skill')
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const { skills: records } = await service.list(project)

    expect(records).toContainEqual(expect.objectContaining({ name: 'local', path: realpathSync(localSkill) }))
    expect(records.some((record) => record.path === realpathSync(ancestorSkill))).toBe(false)
    expect(readFileSync('electron/main/plugins/catalog.ts', 'utf8')).not.toContain('collectAncestorSkills')
  })

  it('keeps user-configured discovery contained to the agent directory and home', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const inside = join(agentDir, 'inside-prompt.md')
    const outside = join(root, 'outside-prompt.md')
    mkdirSync(agentDir)
    writeFileSync(inside, '# Inside\ncontained user discovery')
    writeFileSync(outside, '# Outside\nshould not be disclosed')
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ prompts: [inside, outside] }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const { skills: records } = await service.list()

    expect(records).toContainEqual(expect.objectContaining({ kind: 'prompt', location: 'user', path: realpathSync(inside) }))
    expect(records.some((record) => record.path === outside || record.path === realpathSync(outside))).toBe(false)
  })

  it('keeps project-configured discovery contained while accepting in-project files', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.omp')
    const notes = join(project, 'notes')
    const outside = join(root, 'outside.md')
    mkdirSync(agentDir); mkdirSync(projectAgentDir, { recursive: true }); mkdirSync(notes)
    const inside = join(notes, 'inside.md')
    writeFileSync(inside, '# Inside\ncontained discovery')
    writeFileSync(outside, '# Outside\nshould not be disclosed')
    symlinkSync(outside, join(notes, 'linked-outside.md'))
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify({
      prompts: [inside, outside, join(notes, 'linked-outside.md')],
    }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const { skills: records } = await service.list(project)

    expect(records).toContainEqual(expect.objectContaining({ kind: 'prompt', location: 'project', path: realpathSync(inside) }))
    expect(records.some((record) => record.path === outside || record.path === join(notes, 'linked-outside.md'))).toBe(false)
  })
})

describe('PluginService MCP connections', () => {
  it('writes stdio and https network definitions at the low-level settings writer', async () => {
    const root = temp()
    const settingsPath = join(root, 'mcp.json')

    await expect(updateMcpSettings(
      settingsPath,
      { name: 'remote', scope: 'user', type: 'sse', url: 'https://mcp.example/sse', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } },
      undefined,
      { harness: 'omp', agentName: 'OMP' },
    )).resolves.toMatchObject({ ok: true })

    const config = JSON.parse(readFileSync(settingsPath, 'utf8'))
    // ${VAR} 原樣寫入;OMP Desktop 不展開,上游載入時才解析。
    expect(config.mcpServers.remote).toEqual({
      type: 'sse', url: 'https://mcp.example/sse', headers: { Authorization: 'Bearer ${MCP_TOKEN}' }, enabled: true,
    })
  })

  it('toggles network definitions at the low-level writer and normalizes allow/deny lists', async () => {
    const root = temp()
    const settingsPath = join(root, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({
      mcpServers: {
        remote: { type: 'http', url: 'https://mcp.example/mcp', enabled: true },
        forced: { type: 'stdio', command: 'mcp-forced', enabled: false },
      },
      disabledServers: ['remote'],
      enabledServers: ['forced'],
    }))

    // deny 優先:清單中的 remote 即使 enabled:true 也視為停用;enable 時一併從清單移除。
    await expect(updateMcpState(settingsPath, { name: 'remote', scope: 'user', enabled: true }))
      .resolves.toMatchObject({ ok: true })
    // allow 會覆蓋定義的 enabled:false;disable 時一併從 allowlist 移除。
    await expect(updateMcpState(settingsPath, { name: 'forced', scope: 'user', enabled: false }))
      .resolves.toMatchObject({ ok: true })

    const config = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(config.mcpServers.remote.enabled).toBe(true)
    expect(config.mcpServers.forced.enabled).toBe(false)
    expect(config.disabledServers ?? []).not.toContain('remote')
    expect(config.enabledServers ?? []).not.toContain('forced')
  })

  it('replace saves preserve harness-owned auth/oauth and unsupplied fields', async () => {
    const root = temp()
    const settingsPath = join(root, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://old.example/mcp',
          headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
          auth: { type: 'oauth', credentialId: 'cred-1', tokenUrl: 'https://old.example/token' },
          oauth: { clientId: 'client-1' },
          enabled: false,
        },
      },
    }))

    // 編輯 URL(未提供 headers/auth/oauth/enabled):全部保留,hidden credential
    // 不被編輯器抹掉。
    await expect(updateMcpSettings(
      settingsPath,
      { name: 'remote', scope: 'user', mode: 'replace', type: 'http', url: 'https://new.example/mcp' },
      undefined,
      { harness: 'omp', agentName: 'OMP' },
    )).resolves.toMatchObject({ ok: true })

    const saved = JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers.remote
    expect(saved).toEqual({
      type: 'http',
      url: 'https://new.example/mcp',
      headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
      auth: { type: 'oauth', credentialId: 'cred-1', tokenUrl: 'https://old.example/token' },
      oauth: { clientId: 'client-1' },
      enabled: false,
    })

    // replace 未知名稱 → blocked;create 撞名 → blocked。
    await expect(updateMcpSettings(
      settingsPath,
      { name: 'missing', scope: 'user', mode: 'replace', type: 'http', url: 'https://new.example/mcp' },
      undefined,
      { harness: 'omp', agentName: 'OMP' },
    )).resolves.toMatchObject({ ok: false, reason: 'blocked' })
    await expect(updateMcpSettings(
      settingsPath,
      { name: 'remote', scope: 'user', type: 'http', url: 'https://other.example/mcp' },
      undefined,
      { harness: 'omp', agentName: 'OMP' },
    )).resolves.toMatchObject({ ok: false, reason: 'blocked' })

    // 換 transport 時丟棄舊 transport 專屬欄位,仍保留 auth。
    await expect(updateMcpSettings(
      settingsPath,
      { name: 'remote', scope: 'user', mode: 'replace', type: 'stdio', command: 'mcp-local' },
      undefined,
      { harness: 'omp', agentName: 'OMP' },
    )).resolves.toMatchObject({ ok: true })
    const swapped = JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers.remote
    expect(swapped).toMatchObject({ type: 'stdio', command: 'mcp-local', auth: { type: 'oauth', credentialId: 'cred-1', tokenUrl: 'https://old.example/token' } })
    expect(swapped).not.toHaveProperty('url')
    expect(swapped).not.toHaveProperty('headers')
  })

  it('renders effective state from disabledServers/enabledServers and labels harness-resolved secrets', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        denied: { type: 'http', url: 'https://denied.example/mcp', enabled: true },
        allowed: { type: 'stdio', command: 'mcp-allowed', enabled: false },
        secretful: { type: 'http', url: 'https://secret.example/mcp', headers: { Authorization: '!gh auth token' } },
      },
      disabledServers: ['denied'],
      enabledServers: ['allowed'],
    }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const records = (await service.list()).skills.filter((item) => item.kind === 'mcp')
    const denied = records.find((item) => item.name === 'denied')
    expect(denied?.enabled).toBe(false)
    expect(denied?.description).toContain('Disabled by the disabledServers list')
    const allowed = records.find((item) => item.name === 'allowed')
    expect(allowed?.enabled).toBe(true)
    expect(allowed?.description).toContain('Enabled by the enabledServers list')
    // 讀檔不解析 !command / ${...}:只標示由 OMP 解析;header 值不回流摘要。
    const secretful = records.find((item) => item.name === 'secretful')
    expect(secretful?.description).toContain('${VAR} or !command')
    expect(secretful?.mcpDefinition?.headerNames).toEqual(['Authorization'])
    expect(JSON.stringify(secretful?.mcpDefinition)).not.toContain('gh auth token')
  })

  it('surfaces OMP-quarantined mcp.json.broken-* files as catalog warnings', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'mcp.json.broken-1761234567890-42-9f0d3b7e'), '{ not json')
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { ok: { type: 'stdio', command: 'mcp-ok' } } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const catalog = await service.list()

    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'ok', kind: 'mcp' }))
    expect(catalog.warnings).toContainEqual(expect.objectContaining({
      scope: 'user',
      message: expect.stringContaining('mcp.json.broken-'),
    }))
  })

  it('enforces the network URL policy before touching settings', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })
    const settingsPath = join(agentDir, 'mcp.json')

    // 公網必須 https;純 http 一律拒絕。
    for (const url of ['http://mcp.example/mcp', 'ftp://mcp.example/mcp', 'not-a-url', 'https://user:pw@mcp.example/mcp']) {
      await expect(service.connectMcp({ name: 'remote', scope: 'user', type: 'http', url } as never)).rejects.toThrow()
      expect(existsSync(settingsPath)).toBe(false)
    }
    // loopback/私有網段的純 http 需要明示 allowInsecureHttp。
    for (const url of ['http://127.0.0.1:3333/mcp', 'http://localhost:3333/mcp', 'http://[::1]:3333/mcp', 'http://192.168.1.10/mcp', 'http://printer.local/mcp']) {
      await expect(service.connectMcp({ name: 'remote', scope: 'user', type: 'http', url } as never))
        .rejects.toThrow('insecure-http')
      expect(existsSync(settingsPath)).toBe(false)
    }
    // stdio 與 url 互斥(上游 schema not: required [url])。
    await expect(service.connectMcp({ name: 'remote', scope: 'user', type: 'stdio', command: 'mcp-local', url: 'https://mcp.example/mcp' } as never))
      .rejects.toThrow('cannot include a URL')
    // http/sse 與 command 互斥。
    await expect(service.connectMcp({ name: 'remote', scope: 'user', type: 'http', url: 'https://mcp.example/mcp', command: 'mcp-local' } as never))
      .rejects.toThrow('cannot include a command')
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('accepts https network transports and acknowledged private http', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    for (const input of [
      { type: 'http', url: 'https://mcp.example/mcp' },
      { type: 'sse', url: 'https://mcp.example/sse' },
      { type: 'http', url: 'http://127.0.0.1:3333/mcp', allowInsecureHttp: true },
      { type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer ${MCP_TOKEN}' }, timeout: 30_000, requestIdFormat: 'string' },
    ] as const) {
      const name = `remote-${Math.random().toString(36).slice(2, 8)}`
      await expect(service.connectMcp({ name, scope: 'user', ...input } as never)).resolves.toMatchObject({ ok: true })
    }

    const config = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'))
    const saved = Object.values(config.mcpServers) as Array<Record<string, unknown>>
    expect(saved).toHaveLength(4)
    expect(saved.some((item) => item.type === 'sse' && item.url === 'https://mcp.example/sse' && item.enabled === true)).toBe(true)
    expect(saved.some((item) => item.type === 'http' && item.timeout === 30_000 && item.requestIdFormat === 'string')).toBe(true)
  })

  it('retains local stdio create and state management for omp', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    expect((await service.connectMcp({ name: 'files', scope: 'user', type: 'stdio', command: 'mcp-files', args: ['--root', '/tmp'] })).ok).toBe(true)
    expect((await service.setMcpEnabled({ name: 'files', scope: 'user', enabled: false })).ok).toBe(true)
    expect((await service.setMcpEnabled({ name: 'files', scope: 'user', enabled: true })).ok).toBe(true)

    const config = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'))
    expect(config.mcpServers.files).toMatchObject({ command: 'mcp-files', args: ['--root', '/tmp'], enabled: true })
  })

  it('marks unaddressable local omp MCP keys non-actionable while retaining bounded cleanup identity', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const longKey = `long-${'x'.repeat(60)}`
    const oversizedKey = `oversized-${'x'.repeat(1_024)}`
    const mcpServers: Record<string, unknown> = Object.create(null)
    mcpServers.valid = { type: 'stdio', command: 'mcp-valid' }
    mcpServers['team/docs'] = { type: 'stdio', command: 'mcp-slash' }
    mcpServers[longKey] = { type: 'stdio', command: 'mcp-long' }
    mcpServers['control\u0001key'] = { type: 'stdio', command: 'mcp-control' }
    mcpServers[oversizedKey] = { type: 'stdio', command: 'mcp-oversized' }
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const records = (await service.list()).skills.filter((item) => item.kind === 'mcp')

    expect(records.find((item) => item.name === 'valid')?.availability).toBeUndefined()
    for (const definitionKey of ['team/docs', longKey, 'control\u0001key']) {
      expect(records.find((item) => item.definitionKey === definitionKey)).toMatchObject({
        availability: { available: false, detail: expect.stringContaining('enable or disable') },
      })
    }
    expect(records.find((item) => item.name === oversizedKey.slice(0, 120))).toMatchObject({
      definitionRemovalAvailable: false,
      availability: { available: false, detail: expect.stringContaining('enable or disable') },
    })
  })

  it('toggles an omp network server through both state APIs without touching its definition', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: { remote: { type: 'sse', url: 'https://mcp.example/sse', enabled: true } } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const record = (await service.list()).skills.find((item) => item.kind === 'mcp' && item.name === 'remote')
    expect(record).toMatchObject({ enabled: true })
    expect(record?.availability).toBeUndefined()

    await expect(service.setMcpEnabled({ name: 'remote', scope: 'user', enabled: false }))
      .resolves.toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers.remote).toMatchObject({
      type: 'sse', url: 'https://mcp.example/sse', enabled: false,
    })
    await expect(service.mutateCapability({ kind: 'mcp', action: 'enable', name: 'remote', scope: 'user' }))
      .resolves.toMatchObject({ ok: true })
    await expect(service.mutateCapability({ kind: 'mcp', action: 'disable', name: 'remote', scope: 'user' }))
      .resolves.toMatchObject({ ok: true })
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers.remote
    expect(saved).toMatchObject({ type: 'sse', url: 'https://mcp.example/sse', enabled: false })
    // URL/transport 原樣保留;toggle 只動 enabled 旗標。
    expect(saved.url).toBe('https://mcp.example/sse')
  })

  it('allows definition-only deletion for an externally configured network server', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      remote: { type: 'http', url: 'https://mcp.example/mcp', oauth: true, enabled: true },
      keep: { type: 'http', url: 'https://keep.example/mcp', enabled: true },
    } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    await expect(service.mutateCapability({ kind: 'mcp', action: 'remove', name: 'remote', scope: 'user' }))
      .resolves.toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8')).mcpServers).toEqual({
      keep: { type: 'http', url: 'https://keep.example/mcp', enabled: true },
    })
  })

  it('keeps project settings preparation free of synchronous fs syscalls', () => {
    // renameSync is the one deliberate exception (kept adjacent to its identity
    // checks); everything else in the settings path must be fs/promises.
    const source = readFileSync('electron/main/plugins/mcp.ts', 'utf8')
    expect(source).not.toMatch(/\b(?:existsSync|lstatSync|mkdirSync|realpathSync|readFileSync|writeFileSync|rmSync)\b/)
  })

  it('does not create a missing MCP definition while changing state', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const response = await service.setMcpEnabled({ name: 'missing', scope: 'user', enabled: false })
    expect(response).toMatchObject({ ok: false, reason: 'blocked' })
  })

  it('removes one MCP definition without changing neighboring servers or global credentials', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      docs: { type: 'http', url: 'https://docs.example/mcp', oauth: true },
      keep: { type: 'http', url: 'https://keep.example/mcp' },
    } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const response = await service.mutateCapability({ kind: 'mcp', action: 'remove', name: 'docs', scope: 'user' })

    expect(response.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8')).mcpServers).toEqual({ keep: { type: 'http', url: 'https://keep.example/mcp' } })
  })

  it('removes only the MCP definition when an associated package source is forged into the request', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const executable = join(root, 'omp.cjs')
    const capture = join(root, 'argv.json')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      docs: { type: 'http', url: 'https://docs.example/mcp' },
    } }))
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('removed\\n')\n`)
    chmodSync(executable, 0o755)
    const service = new PluginService(executable, async (path) => resolve(path), { agentDir })

    await expect(service.mutateCapability({
      kind: 'mcp', action: 'remove', name: 'docs', source: 'npm:prime-docs', scope: 'user',
    })).resolves.toMatchObject({ ok: true })

    expect(existsSync(capture)).toBe(false)
    expect(JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8')).mcpServers).toEqual({})
  })

  it('disables and restores a package through the omp plugin command', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const executable = join(root, 'omp.cjs')
    const captures: string[] = []
    mkdirSync(agentDir)
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(root, 'argv.json'))}, JSON.stringify(process.argv.slice(2))); process.stdout.write('{"ok":true}\\n')\n`)
    chmodSync(executable, 0o755)
    const service = new PluginService(executable, async (path) => resolve(path), { agentDir })

    expect((await service.mutateCapability({ kind: 'package', action: 'disable', name: 'acme-tools', source: 'npm:acme-tools', scope: 'user' })).ok).toBe(true)
    captures.push(readFileSync(join(root, 'argv.json'), 'utf8'))
    expect((await service.mutateCapability({ kind: 'package', action: 'enable', name: 'acme-tools', source: 'npm:acme-tools', scope: 'user' })).ok).toBe(true)
    captures.push(readFileSync(join(root, 'argv.json'), 'utf8'))

    expect(JSON.parse(captures[0])).toEqual(['plugin', 'disable', 'acme-tools', '--json'])
    expect(JSON.parse(captures[1])).toEqual(['plugin', 'enable', 'acme-tools', '--json'])
  })

  it('connects an OMP stdio MCP server at project scope', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    mkdirSync(project)
    const service = new PluginService(null, async (path) => {
      expect(path).toBe(project)
      return resolve(path)
    }, { agentDir, harness: 'omp' })

    const response = await service.connectMcp({
      name: 'project-files',
      scope: 'project',
      projectPath: project,
      type: 'stdio',
      command: 'mcp-project-files',
    })

    expect(response.ok).toBe(true)
    const settings = JSON.parse(readFileSync(join(project, '.omp', 'mcp.json'), 'utf8'))
    expect(settings.mcpServers['project-files']).toEqual({ type: 'stdio', command: 'mcp-project-files', enabled: true })
    expect((await service.list(project)).skills.find((item) => item.name === 'project-files')).toMatchObject({ kind: 'mcp', location: 'project' })
  })

  it('rejects project MCP settings paths that traverse repository symlinks', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const outside = join(root, 'outside')
    mkdirSync(project); mkdirSync(outside)
    symlinkSync(outside, join(project, '.omp'))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })

    await expect(service.connectMcp({
      name: 'escaped', scope: 'project', projectPath: project, type: 'stdio', command: 'mcp-local',
    })).rejects.toThrow(/real directory/)
    expect(() => readFileSync(join(outside, 'agent', 'settings.json'))).toThrow()
  })

  it('fails closed when the project MCP directory is substituted at the final rename boundary', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.omp')
    const displacedAgentDir = join(project, '.omp-original')
    const outside = join(root, 'outside')
    mkdirSync(agentDir); mkdirSync(projectAgentDir, { recursive: true }); mkdirSync(outside)
    const settingsPath = join(projectAgentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    writeFileSync(join(outside, 'mcp.json'), JSON.stringify({ outside: 'unchanged' }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'omp' })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let substituted = false
    internal.settingsFingerprint = async (path) => {
      const fingerprint = await original(path)
      if (!substituted) {
        substituted = true
        const temporaryName = readdirSync(projectAgentDir).find((name) => name.startsWith('mcp.json.') && name.endsWith('.tmp'))
        expect(temporaryName).toBeTypeOf('string')
        const stagedSettings = readFileSync(join(projectAgentDir, temporaryName!), 'utf8')
        renameSync(projectAgentDir, displacedAgentDir)
        symlinkSync(outside, projectAgentDir, 'dir')
        // Recreate the observed random staging name so the vulnerable lexical
        // rename would overwrite settings in the substituted directory.
        writeFileSync(join(outside, temporaryName!), stagedSettings)
      }
      return fingerprint
    }

    await expect(service.connectMcp({
      name: 'escaped', scope: 'project', projectPath: project, type: 'stdio', command: 'mcp-local',
    })).rejects.toThrow(/configuration directory changed/)

    expect(substituted).toBe(true)
    expect(JSON.parse(readFileSync(join(outside, 'mcp.json'), 'utf8')).outside).toBe('unchanged')
    expect(JSON.parse(readFileSync(join(displacedAgentDir, 'mcp.json'), 'utf8')).mcpServers).toBeUndefined()
  })

  it('rechecks the pinned project directory before reading a definition-removal snapshot', async () => {
    const root = temp()
    const projectAgentDir = join(root, 'project', '.omp')
    const displacedAgentDir = join(root, 'project', '.omp-original')
    const outside = join(root, 'outside')
    mkdirSync(projectAgentDir, { recursive: true })
    mkdirSync(outside)
    const settingsPath = join(projectAgentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'mcp-other' } } }))
    writeFileSync(join(outside, 'mcp.json'), JSON.stringify({ outside: 'unchanged', mcpServers: {} }))
    let verifyCalls = 0
    let substituted = false
    const verify = async () => {
      verifyCalls += 1
      if (substituted) throw new TypeError('Project MCP configuration directory changed during update')
      // Lock acquisition performs three verification calls. Substitute only
      // when removal enters its pre-snapshot check so both the pre- and
      // post-read checks are required to catch the change before early return.
      if (verifyCalls === 4) {
        renameSync(projectAgentDir, displacedAgentDir)
        symlinkSync(outside, projectAgentDir, 'dir')
        substituted = true
      }
    }

    await expect(removeMcpDefinition({ path: settingsPath, verify }, { name: 'docs', definitionKey: 'docs' }))
      .rejects.toThrow(/configuration directory changed/)

    expect(substituted).toBe(true)
    expect(JSON.parse(readFileSync(join(outside, 'mcp.json'), 'utf8'))).toEqual({ outside: 'unchanged', mcpServers: {} })
    expect(verifyCalls).toBe(5)
    expect(JSON.parse(readFileSync(join(displacedAgentDir, 'mcp.json'), 'utf8')).mcpServers).toHaveProperty('other')
  })

  it('rejects network URLs and refuses to overwrite an existing local server', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { existing: { type: 'stdio', command: 'safe' } } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })

    await expect(service.connectMcp({ name: 'secret', scope: 'user', type: 'http', url: 'https://token@example.test/mcp' })).rejects.toThrow(/must not embed credentials/)
    const duplicate = await service.connectMcp({ name: 'existing', scope: 'user', type: 'stdio', command: 'other' })
    expect(duplicate.ok).toBe(false)
    expect(JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8')).mcpServers.existing.command).toBe('safe')
  })

  it('serializes updates across service instances and rereads settings after locking', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ marker: 'kept' }))
    const first = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })
    const second = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })

    const responses = await Promise.all([
      first.connectMcp({ name: 'first', scope: 'user', type: 'stdio', command: 'mcp-first' }),
      second.connectMcp({ name: 'second', scope: 'user', type: 'stdio', command: 'mcp-second' }),
    ])

    expect(responses.every((response) => response.ok)).toBe(true)
    const settings = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'))
    expect(settings.marker).toBe('kept')
    expect(settings.mcpServers.first.command).toBe('mcp-first')
    expect(settings.mcpServers.second.command).toBe('mcp-second')
  })

  it('recovers a lock only after its recorded owner has exited', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ marker: 'kept' }))
    const exited = spawn(process.execPath, ['-e', 'process.exit(0)'])
    const exitedPid = exited.pid
    expect(exitedPid).toBeTypeOf('number')
    await new Promise<void>((resolveExit, rejectExit) => {
      exited.once('error', rejectExit)
      exited.once('exit', () => resolveExit())
    })
    const lockPath = `${settingsPath}.lock`
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      version: 1,
      pid: exitedPid,
      token: 'exited-test-owner',
      createdAt: Date.now() - 1_000,
    }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })

    const response = await service.connectMcp({ name: 'after-crash', scope: 'user', type: 'stdio', command: 'mcp-after-crash' })

    expect(response.ok).toBe(true)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers['after-crash'].command).toBe('mcp-after-crash')
    expect(() => readFileSync(join(lockPath, 'owner.json'))).toThrow()
  })

  it('detects and merges a non-cooperating writer update before rename', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ marker: 'kept' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let injected = false
    internal.settingsFingerprint = async (path) => {
      if (!injected) {
        injected = true
        writeFileSync(settingsPath, JSON.stringify({ marker: 'kept', changedByCli: true }))
      }
      return original(path)
    }

    expect((await service.connectMcp({ name: 'merged', scope: 'user', type: 'stdio', command: 'mcp-merged' })).ok).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.changedByCli).toBe(true)
    expect(settings.mcpServers.merged.command).toBe('mcp-merged')
  })

  it('retries multiple non-cooperating writer conflicts and merges the latest snapshot', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ marker: 'kept' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let conflicts = 0
    internal.settingsFingerprint = async (path) => {
      if (conflicts < 2) {
        conflicts += 1
        writeFileSync(settingsPath, JSON.stringify({ marker: 'kept', externalRevision: conflicts }))
      }
      return original(path)
    }

    expect((await service.connectMcp({ name: 'after-retries', scope: 'user', type: 'stdio', command: 'mcp-after-retries' })).ok).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(conflicts).toBe(2)
    expect(settings.externalRevision).toBe(2)
    expect(settings.mcpServers['after-retries'].command).toBe('mcp-after-retries')
  })

  it('fails after bounded conflicts without replacing the external writer snapshot', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ marker: 'kept' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let externalRevision = 0
    internal.settingsFingerprint = async (path) => {
      externalRevision += 1
      writeFileSync(settingsPath, JSON.stringify({ marker: 'kept', externalRevision }))
      return original(path)
    }

    await expect(service.connectMcp({ name: 'never-written', scope: 'user', type: 'stdio', command: 'mcp-never-written' }))
      .rejects.toThrow(/changed repeatedly/)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(externalRevision).toBe(4)
    expect(settings.externalRevision).toBe(4)
    expect(settings.mcpServers).toBeUndefined()
  })

})

describe('PluginService OMP parity', () => {
  it('discovers OMP-native user, project, MCP, and installed plugin surfaces', async () => {
    const root = temp()
    const agentDir = join(root, '.omp', 'agent')
    const userSkill = join(root, '.omp', 'skills', 'user-skill', 'SKILL.md')
    const userPackage = join(root, '.omp', 'plugins', 'node_modules', 'user-plugin')
    const packageSkill = join(userPackage, 'skills', 'package-skill', 'SKILL.md')
    const project = join(root, 'project')
    const projectSkill = join(project, '.omp', 'skills', 'project-skill', 'SKILL.md')
    const projectPackage = join(project, '.omp', 'plugins', 'node_modules', 'project-plugin')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(resolve(userSkill, '..'), { recursive: true })
    mkdirSync(resolve(packageSkill, '..'), { recursive: true })
    mkdirSync(resolve(projectSkill, '..'), { recursive: true })
    mkdirSync(projectPackage, { recursive: true })
    writeFileSync(userSkill, '---\nname: OMP user skill\n---\nUser workflow')
    writeFileSync(packageSkill, '---\nname: Plugin skill\n---\nInstalled workflow')
    writeFileSync(join(userPackage, 'package.json'), JSON.stringify({ name: 'user-plugin', description: 'User OMP plugin', omp: {} }))
    writeFileSync(projectSkill, '---\nname: OMP project skill\n---\nProject workflow')
    writeFileSync(join(projectPackage, 'package.json'), JSON.stringify({ name: 'project-plugin', description: 'Project OMP plugin', pi: {} }))
    writeFileSync(join(project, '.omp', 'plugins', 'omp-plugins.lock.json'), JSON.stringify({ plugins: { 'project-plugin': { enabled: false, enabledFeatures: null, version: '1.0.0' } }, settings: {} }))
    const transitive = join(root, '.omp', 'plugins', 'node_modules', 'transitive-only')
    mkdirSync(transitive)
    writeFileSync(join(transitive, 'package.json'), JSON.stringify({ name: 'transitive-only' }))
    const marketplace = join(root, '.omp', 'plugins', 'node_modules', 'marketplace-plugin')
    mkdirSync(marketplace)
    writeFileSync(join(marketplace, 'package.json'), JSON.stringify({ name: 'marketplace-plugin', description: 'Marketplace plugin' }))
    writeFileSync(join(root, '.omp', 'plugins', 'omp-plugins.lock.json'), JSON.stringify({ plugins: { 'marketplace-plugin': { enabled: true, enabledFeatures: null, version: '1.0.0' } }, settings: {} }))
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } } }))
    mkdirSync(join(project, '.omp'), { recursive: true })
    writeFileSync(join(project, '.omp', 'mcp.json'), JSON.stringify({ mcpServers: { files: { type: 'stdio', command: 'npx' } } }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'omp' })

    const catalog = await service.list(project)

    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'OMP user skill', kind: 'skill', location: 'user' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'OMP project skill', kind: 'skill', location: 'project' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'Plugin skill', kind: 'skill', location: 'user' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'user-plugin', kind: 'package', location: 'user' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'project-plugin', kind: 'package', location: 'project', enabled: false }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'marketplace-plugin', kind: 'package', location: 'user', enabled: true }))
    expect(catalog.skills.some((item) => item.name === 'transitive-only')).toBe(false)
    expect(catalog.skills).toContainEqual(expect.objectContaining({
      name: 'docs', kind: 'mcp', location: 'user',
      description: expect.stringContaining('HTTP MCP server at https://docs.example'),
      mcpDefinition: expect.objectContaining({ transport: 'http', url: 'https://docs.example/mcp' }),
    }))
    expect(catalog.skills.find((item) => item.kind === 'mcp' && item.name === 'docs')?.availability).toBeUndefined()
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'files', kind: 'mcp', location: 'project' }))
  })

  it('writes stdio and https network definitions to native OMP mcp.json files at both scopes', async () => {
    const root = temp()
    const agentDir = join(root, '.omp', 'agent')
    const project = join(root, 'project')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(project)
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'omp' })

    const remote = await service.connectMcp({ name: 'docs:remote', scope: 'user', type: 'http', url: 'https://docs.example/mcp' })
    const stream = await service.connectMcp({ name: 'stream', scope: 'user', type: 'sse', url: 'https://docs.example/sse' })
    const user = await service.connectMcp({ name: 'local', scope: 'user', type: 'stdio', command: 'mcp-local' })
    const projectResult = await service.connectMcp({ name: 'files', scope: 'project', projectPath: project, type: 'stdio', command: 'npx', args: ['-y', 'server'] })
    await expect(service.connectMcp({ name: 'invalid name', scope: 'user', type: 'stdio', command: 'npx' })).rejects.toThrow(/unsupported characters/)

    expect(remote.ok).toBe(true)
    expect(stream.ok).toBe(true)
    expect(user).toMatchObject({ ok: true, output: expect.stringContaining('new OMP session') })
    expect(projectResult.ok).toBe(true)
    const userConfig = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'))
    const projectConfig = JSON.parse(readFileSync(join(project, '.omp', 'mcp.json'), 'utf8'))
    expect(userConfig.$schema).toContain('can1357/oh-my-pi')
    expect(userConfig.mcpServers).toEqual({
      'docs:remote': { type: 'http', url: 'https://docs.example/mcp', enabled: true },
      stream: { type: 'sse', url: 'https://docs.example/sse', enabled: true },
      local: { type: 'stdio', command: 'mcp-local', enabled: true },
    })
    expect(projectConfig.mcpServers.files).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'server'], enabled: true })
    expect(existsSync(join(project, '.prime'))).toBe(false)
  })

  it('installs through the native omp plugin command with validated argv', async () => {
    const root = temp()
    const agentDir = join(root, '.omp', 'agent')
    const executable = join(root, 'omp.cjs')
    const capture = join(root, 'argv.json')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('{"ok":true}\\n')\n`)
    chmodSync(executable, 0o755)
    const service = new PluginService(executable, async (path) => resolve(path), { agentDir, harness: 'omp' })

    const result = await service.install('npm:@scope/example-plugin')

    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['plugin', 'install', '@scope/example-plugin', '--json'])

    await service.install('code-review@official')
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['plugin', 'install', 'code-review@official', '--json'])
  })

  it('installs standalone OMP extensions through native user and project extension directories', async () => {
    const root = temp()
    const agentDir = join(root, '.omp', 'agent')
    const project = join(root, 'project')
    const source = join(root, 'clock.ts')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(project)
    writeFileSync(source, 'export default () => undefined\n')
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'omp' })

    const user = await service.installExtension({ source, scope: 'user' })
    const local = await service.installExtension({ source, scope: 'project', projectPath: project })
    const duplicate = await service.installExtension({ source, scope: 'user' })

    expect(user).toMatchObject({ ok: true, output: expect.stringContaining('clock.ts') })
    expect(local.ok).toBe(true)
    expect(readFileSync(join(agentDir, 'extensions', 'clock.ts'), 'utf8')).toContain('export default')
    expect(readFileSync(join(project, '.omp', 'extensions', 'clock.ts'), 'utf8')).toContain('export default')
    expect(duplicate).toMatchObject({ ok: false, reason: 'blocked' })
    await expect(service.installExtension({ source: join(root, 'missing.ts'), scope: 'user' })).rejects.toThrow(/does not exist/)
  })
})
