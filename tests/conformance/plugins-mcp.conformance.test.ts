import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

describe('conformance: plugins, skills & MCP settings', () => {
  it('discovers skills/broken MCP warnings, validates MCP policies, preserves auth on replace, and installs plugins', async () => {
    if (!requireCapability(info, 'plugins') || !requireCapability(info, 'projects')) return
    sandbox = createConformanceSandbox('omp-conf-plugins-')
    const projectDir = join(sandbox.rootDir, 'project')
    const agentDir = join(sandbox.homeDir, '.omp', 'agent')
    mkdirSync(join(projectDir, '.omp', 'skills', 'demo-skill'), { recursive: true })
    mkdirSync(join(projectDir, '.agents', 'skills'), { recursive: true })
    mkdirSync(agentDir, { recursive: true })

    writeFileSync(join(projectDir, '.omp', 'skills', 'demo-skill', 'SKILL.md'), '---\nname: Demo Skill\ndescription: Project skill fixture\n---\nBody\n', 'utf8')
    writeFileSync(join(projectDir, '.agents', 'skills', 'shared.md'), '# Shared Skill\nShared guidance\n', 'utf8')
    writeFileSync(join(agentDir, 'mcp.json.broken-1'), '{broken', 'utf8')

    await client.call('workspace.reset', {
      rootDir: sandbox.rootDir,
      homeDir: sandbox.homeDir,
      userDataDir: sandbox.userDataDir,
      appDataDir: sandbox.appDataDir,
      ompExecutable: sandbox.ompExecutable,
    })

    await client.call('projects.grant', { path: projectDir })

    const initialCatalog = await client.call<{
      skills: Array<{ name: string; kind: string; location: string }>
      warnings: Array<{ scope: string; message: string }>
    }>('plugins.list', { projectPath: projectDir })
    expect(initialCatalog.skills.some((s) => s.kind === 'skill' && s.name === 'Demo Skill' && s.location === 'project')).toBe(true)
    expect(initialCatalog.warnings.some((w) => w.scope === 'user' && w.message.includes('invalid MCP config'))).toBe(true)

    // Reject public plain HTTP and embedded URL credentials.
    await client.callExpectError('plugins.connectMcp', {
      input: { name: 'public-http', scope: 'user', type: 'http', url: 'http://example.com/mcp' },
    })
    await client.callExpectError('plugins.connectMcp', {
      input: { name: 'cred-url', scope: 'user', type: 'http', url: 'https://user:secret@example.com/mcp' },
    })

    // Accept loopback HTTP with explicit allowInsecureHttp, and preserve ${VAR}/!command verbatim.
    const stdioOutcome = await client.call<{ ok: boolean }>('plugins.connectMcp', {
      input: {
        name: 'local-stdio',
        scope: 'project',
        projectPath: projectDir,
        type: 'stdio',
        command: 'npx',
        args: ['--token', '${MY_TOKEN}', '!echo raw'],
      },
    })
    expect(stdioOutcome.ok).toBe(true)

    const loopbackOutcome = await client.call<{ ok: boolean }>('plugins.connectMcp', {
      input: {
        name: 'local-http',
        scope: 'user',
        type: 'http',
        url: 'http://127.0.0.1:4321/mcp',
        headers: { Authorization: 'Bearer ${LOCAL_TOKEN}' },
        allowInsecureHttp: true,
      },
    })
    expect(loopbackOutcome.ok).toBe(true)

    const userMcpPath = join(agentDir, 'mcp.json')
    const userMcpBefore = JSON.parse(readFileSync(userMcpPath, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    userMcpBefore.mcpServers['local-http']!.auth = { tokenRef: 'omp-managed' }
    writeFileSync(userMcpPath, JSON.stringify(userMcpBefore, null, 2), 'utf8')

    // mode: 'replace' must preserve harness-owned auth/oauth fields and headers not supplied.
    const replaced = await client.call<{ ok: boolean }>('plugins.connectMcp', {
      input: {
        name: 'local-http',
        scope: 'user',
        mode: 'replace',
        type: 'http',
        url: 'https://localhost:4321/mcp',
      },
    })
    expect(replaced.ok).toBe(true)
    const userMcpAfterReplace = JSON.parse(readFileSync(userMcpPath, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(userMcpAfterReplace.mcpServers['local-http']?.auth).toEqual({ tokenRef: 'omp-managed' })
    expect(userMcpAfterReplace.mcpServers['local-http']?.headers).toEqual({ Authorization: 'Bearer ${LOCAL_TOKEN}' })

    const projectMcpPath = join(projectDir, '.omp', 'mcp.json')
    const projectMcpRaw = readFileSync(projectMcpPath, 'utf8')
    expect(projectMcpRaw).toContain('${MY_TOKEN}')
    expect(projectMcpRaw).toContain('!echo raw')

    // Denylist precedence over enabledServers + toggle normalization.
    writeFileSync(
      userMcpPath,
      JSON.stringify({
        mcpServers: {
          ...userMcpAfterReplace.mcpServers,
          'extra-stdio': { command: 'node', args: ['-v'], enabled: true },
        },
        enabledServers: ['local-http', 'extra-stdio'],
        disabledServers: ['local-http'],
      }),
      'utf8',
    )
    const afterDeny = await client.call<{ skills: Array<{ name: string; kind: string; enabled: boolean }> }>('plugins.list', {
      projectPath: projectDir,
    })
    expect(afterDeny.skills.find((s) => s.kind === 'mcp' && s.name === 'local-http')?.enabled).toBe(false)

    expect(
      (
        await client.call<{ ok: boolean }>('plugins.setMcpEnabled', {
          input: { name: 'local-http', scope: 'user', enabled: true },
        })
      ).ok,
    ).toBe(true)
    const afterEnable = await client.call<{ skills: Array<{ name: string; kind: string; enabled: boolean }> }>('plugins.list', {
      projectPath: projectDir,
    })
    expect(afterEnable.skills.find((s) => s.kind === 'mcp' && s.name === 'local-http')?.enabled).toBe(true)

    // Remove one definition while preserving the other definition.
    expect(
      (
        await client.call<{ ok: boolean }>('plugins.mutateCapability', {
          input: { kind: 'mcp', action: 'remove', name: 'extra-stdio', definitionKey: 'extra-stdio', scope: 'user' },
        })
      ).ok,
    ).toBe(true)
    const afterRemove = JSON.parse(readFileSync(userMcpPath, 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(afterRemove.mcpServers['extra-stdio']).toBeUndefined()
    expect(afterRemove.mcpServers['local-http']).toBeDefined()

    // Package install validation & omp plugin install delegation.
    await client.callExpectError('plugins.install', { source: 'git://example.com/repo.git' })
    await client.callExpectError('plugins.install', { source: 'http://example.com/pkg.tgz' })

    const installOutcome = await client.call<{ ok: boolean }>('plugins.install', { source: 'npm:demo-plugin@1.0.0' })
    expect(installOutcome.ok).toBe(true)
    const withPlugin = await client.call<{ skills: Array<{ name: string; kind: string }> }>('plugins.list', {
      projectPath: projectDir,
    })
    expect(withPlugin.skills.some((s) => s.kind === 'package' && s.name === 'demo-plugin')).toBe(true)
  })
})
