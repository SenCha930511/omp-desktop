import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ConformanceClient, type ConformanceSandbox, createConformanceSandbox, requireCapability } from './client'
import { writeOmpSessionFixture } from './fixtures/launcher'
import type { AdapterInfo } from './protocol'

let client: ConformanceClient
let info: AdapterInfo
let sandbox: ConformanceSandbox | null = null

async function drainUntil(
  runtimeId: string,
  predicate: (events: Array<{ runtimeId: string; event: Record<string, unknown> }>) => boolean,
  timeoutMs = 8_000,
): Promise<Array<{ runtimeId: string; event: Record<string, unknown> }>> {
  const collected: Array<{ runtimeId: string; event: Record<string, unknown> }> = []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const batch = await client.call<Array<{ runtimeId: string; event: Record<string, unknown> }>>('agent.drainEvents', { runtimeId })
    collected.push(...batch)
    if (predicate(collected)) return collected
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error(`Timed out waiting for agent events. Collected types: ${collected.map((e) => String(e.event.type)).join(', ')}`)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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

describe('conformance: models & OMP RPC v2', () => {
  it('loads validated model catalog, presets, fast-mode flags, and vision delegation', async () => {
    if (!requireCapability(info, 'models')) return
    sandbox = createConformanceSandbox('omp-conf-models-')
    mkdirSync(join(sandbox.homeDir, '.omp', 'agent'), { recursive: true })
    writeFileSync(
      join(sandbox.homeDir, '.omp', 'agent', 'config.yml'),
      `modelPresets:
  fast-cell:
    modelRoles:
      default: openai-codex/gpt-5.4
    defaultThinkingLevel: auto
`,
      'utf8',
    )

    await client.call('workspace.reset', {
      rootDir: sandbox.rootDir,
      homeDir: sandbox.homeDir,
      userDataDir: sandbox.userDataDir,
      appDataDir: sandbox.appDataDir,
      ompExecutable: sandbox.ompExecutable,
      extraEnv: { OMP_FIXTURE_VISION_ROLE: '1' },
    })

    const catalog = await client.call<{
      primeVersion: string
      visionDelegation?: boolean
      models: Array<{ key: string; reasoning: boolean; availableThinkingLevels: string[]; fastModeSupported: boolean }>
    }>('models.catalog', { force: true })

    expect(catalog.primeVersion).toBe('17.2.15')
    expect(catalog.visionDelegation).toBe(true)
    // Malformed entry in omp-fixture must be dropped.
    expect(catalog.models).toHaveLength(3)

    const claude = catalog.models.find((m) => m.key === 'anthropic/claude-fixture')
    const gpt = catalog.models.find((m) => m.key === 'openai-codex/gpt-5.4')
    const plain = catalog.models.find((m) => m.key === 'local/plain-model')
    expect(claude).toMatchObject({ availableThinkingLevels: ['off', 'low', 'high'], fastModeSupported: false })
    expect(gpt).toMatchObject({ availableThinkingLevels: ['off', 'low', 'medium', 'high'], fastModeSupported: true })
    expect(plain).toMatchObject({ reasoning: false, availableThinkingLevels: ['off'], fastModeSupported: false })

    const presets = await client.call<Array<{ name: string; defaultThinkingLevel?: string; modelRoles: Record<string, string> }>>('models.presets')
    expect(presets).toEqual([
      {
        name: 'fast-cell',
        modelRoles: { default: 'openai-codex/gpt-5.4' },
        defaultThinkingLevel: 'auto',
      },
    ])
  })

  it('spawns sanitized OMP RPC v2, translates commands, normalizes/reassembles events, and reaps process on stop', async () => {
    if (!requireCapability(info, 'agent') || !requireCapability(info, 'projects')) return
    sandbox = createConformanceSandbox('omp-conf-rpc-')
    const projectDir = join(sandbox.rootDir, 'project')
    mkdirSync(projectDir, { recursive: true })
    const canonicalProject = realpathSync(projectDir)

    const sessionPath = writeOmpSessionFixture({
      homeDir: sandbox.homeDir,
      bucket: '-omp-project',
      fileName: '2026-04-02T00-00-00-000Z_019fdf24-dddd-7000-8000-000000000010.jsonl',
      title: 'RPC Fixture Session',
      updatedAt: '2026-04-02T00:00:00.000Z',
      entries: [{ type: 'session', version: 3, id: '019fdf24-dddd-7000-8000-000000000010', timestamp: '2026-04-02T00:00:00.000Z', cwd: canonicalProject }],
    })

    await client.call('workspace.reset', {
      rootDir: sandbox.rootDir,
      homeDir: sandbox.homeDir,
      userDataDir: sandbox.userDataDir,
      appDataDir: sandbox.appDataDir,
      ompExecutable: sandbox.ompExecutable,
      extraEnv: {
        NODE_OPTIONS: '--max-old-space-size=1024',
        ELECTRON_RUN_AS_NODE: '1',
      },
    })

    // Unauthorized cwd must be rejected.
    await client.callExpectError('agent.start', { cwd: projectDir })

    await client.call('projects.grant', { path: projectDir })
    await client.call('state.updateSettings', { patch: { ompApprovalMode: 'write' } })

    const runtime = await client.call<{ runtimeId: string; harness: string; sessionFile?: string }>('agent.start', {
      cwd: projectDir,
      sessionPath,
      model: 'openai-codex/gpt-5.4',
      thinking: 'high',
      fast: true,
    })
    expect(runtime.harness).toBe('omp')

    const fixtureStateDir = join(sandbox.rootDir, 'fixture-state')
    const spawnedArgs = JSON.parse(readFileSync(join(fixtureStateDir, 'omp-argv.json'), 'utf8')) as string[]
    expect(spawnedArgs).toContain('--mode')
    expect(spawnedArgs).toContain('rpc')
    expect(spawnedArgs).toContain('--approval-mode')
    expect(spawnedArgs).toContain('write')
    expect(spawnedArgs).toContain('openai-codex/gpt-5.4')

    const spawnedEnv = JSON.parse(readFileSync(join(fixtureStateDir, 'omp-env.json'), 'utf8')) as Record<string, string | null>
    expect(spawnedEnv.NO_COLOR).toBe('1')
    expect(spawnedEnv.NODE_OPTIONS).toBeNull()
    expect(spawnedEnv.ELECTRON_RUN_AS_NODE).toBeNull()

    // Removed harness commands & MCP auth slash commands must fail closed.
    await client.callExpectError('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'clone' } })
    await client.callExpectError('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'send_message', message: 'hi' } })
    await client.callExpectError('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'prompt', message: '/mcp reauth' } })
    await client.callExpectError('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'steer', message: '/mcp reauth remote-srv' } })

    // Command mappings & passthroughs: side_question -> btw, get_branch_messages, set_service_tier -> set_fast_mode, fork.
    await client.call('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'side_question', question: 'why?', topicId: 't-1' } })
    await client.call('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'get_branch_messages' } })
    await client.call('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'set_service_tier', serviceTier: 'default' } })
    await client.call('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'fork', entryId: 'e-1' } })
    await client.call('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'get_login_providers' } })

    const sideEvents = await drainUntil(runtime.runtimeId, (events) => events.some((e) => e.event.type === 'side_question_record'))
    expect(sideEvents.some((e) => e.event.type === 'side_question_record')).toBe(true)

    // Base64 rpc_chunk reassembly.
    await client.call('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'prompt', message: '[chunked]' } })
    const chunkedEvents = await drainUntil(runtime.runtimeId, (events) => events.some((e) => e.event.type === 'agent_end'))
    expect(chunkedEvents.some((e) => e.event.type === 'message_update' && (e.event.assistantMessageEvent as { delta?: string } | undefined)?.delta === 'chunked-hello')).toBe(true)

    // Auto-compaction normalization (auto_compaction_* -> compaction_*).
    await client.call('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'prompt', message: '[auto-compact]' } })
    const compactEvents = await drainUntil(runtime.runtimeId, (events) => events.some((e) => e.event.type === 'agent_end'))
    expect(compactEvents.some((e) => e.event.type === 'compaction_start')).toBe(true)
    expect(compactEvents.some((e) => e.event.type === 'compaction_end')).toBe(true)
    expect(compactEvents.some((e) => String(e.event.type).startsWith('auto_compaction'))).toBe(false)

    // Non-terminal agent_end is swallowed; only terminal agent_end is emitted.
    await client.call('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'prompt', message: '[non-terminal]' } })
    const nonTermEvents = await drainUntil(runtime.runtimeId, (events) => events.some((e) => e.event.type === 'agent_end'))
    const agentEnds = nonTermEvents.filter((e) => e.event.type === 'agent_end')
    expect(agentEnds).toHaveLength(1)
    expect(agentEnds[0]!.event.isTerminal).toBe(true)

    // Live voice frame normalization & clamping + malformed phase drop.
    await client.call('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'prompt', message: '[live-events]' } })
    const liveEvents = await drainUntil(runtime.runtimeId, (events) => events.some((e) => e.event.type === 'agent_end'))
    expect(liveEvents.filter((e) => e.event.type === 'live_phase').map((e) => e.event.phase)).toEqual(['listening'])
    expect(liveEvents.find((e) => e.event.type === 'live_levels')).toMatchObject({ event: { type: 'live_levels', input: 1, output: 0 } })
    expect(liveEvents.find((e) => e.event.type === 'live_transcript')).toMatchObject({ event: { type: 'live_transcript', text: 'Hello live', final: true } })
    expect(liveEvents.some((e) => e.event.type === 'live_end')).toBe(true)

    // Retry fallback applied event passes through.
    await client.call('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'prompt', message: '[fallback]' } })
    const fallbackEvents = await drainUntil(runtime.runtimeId, (events) => events.some((e) => e.event.type === 'agent_end'))
    expect(fallbackEvents.some((e) => e.event.type === 'retry_fallback_applied')).toBe(true)

    // Direct user bash & abort_bash.
    const bashResult = await client.call<{ data: { output: string; exitCode: number } }>('agent.command', {
      runtimeId: runtime.runtimeId,
      command: { type: 'bash', command: 'echo hello' },
    })
    expect(bashResult.data.output).toContain('bash-ok: echo hello')
    await client.call('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'abort_bash' } })

    // Manual compact reads back appended JSONL compaction record and synthesizes compaction_end.
    await client.call('agent.command', { runtimeId: runtime.runtimeId, command: { type: 'compact' } })
    const manualCompactEvents = await drainUntil(runtime.runtimeId, (events) => events.some((e) => e.event.type === 'compaction_end'))
    expect(manualCompactEvents.find((e) => e.event.type === 'compaction_end')?.event).toMatchObject({
      type: 'compaction_end',
      reason: 'manual',
    })

    // Verify wire commands recorded by omp-fixture.
    const wireCommands = readFileSync(join(fixtureStateDir, 'omp-commands.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; recordId?: string; enabled?: boolean })
    expect(wireCommands.some((c) => c.type === 'btw' && c.recordId === 't-1')).toBe(true)
    expect(wireCommands.some((c) => c.type === 'get_branch_messages')).toBe(true)
    expect(wireCommands.some((c) => c.type === 'set_fast_mode' && c.enabled === true)).toBe(true)
    expect(wireCommands.some((c) => c.type === 'set_fast_mode' && c.enabled === false)).toBe(true)
    expect(wireCommands.some((c) => c.type === 'fork')).toBe(true)

    // Stop terminates the child process cleanly.
    const pidPath = join(fixtureStateDir, 'omp-pid.txt')
    expect(existsSync(pidPath)).toBe(true)
    const childPid = Number(readFileSync(pidPath, 'utf8').trim())
    expect(isPidAlive(childPid)).toBe(true)

    expect(await client.call<boolean>('agent.stop', { runtimeId: runtime.runtimeId })).toBe(true)
    const stopDeadline = Date.now() + 4_000
    while (isPidAlive(childPid) && Date.now() < stopDeadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    }
    expect(isPidAlive(childPid)).toBe(false)
  })
})
