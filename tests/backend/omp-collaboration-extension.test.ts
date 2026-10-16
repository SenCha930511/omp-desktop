import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OmpExtensionApi } from '../../assets/extensions/omp-work-collaboration'
import type { AgentRpcManager } from '../../electron/main/agent-rpc'
import { AgentCollaborationBridge } from '../../electron/main/collaboration/agent-bridge'
import { configureGooeyPiAgentMessageSigning } from '../../electron/main/collaboration/message-envelope'
import type { RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'

interface RegisteredTool {
  name: string
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>
}

configureGooeyPiAgentMessageSigning(Buffer.alloc(32, 7))

const bridges: AgentCollaborationBridge[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  await Promise.all(bridges.splice(0).map(async (bridge) => bridge.stop()))
})

const source: SessionRecord = {
  id: '019f0000-0000-7000-8000-000000000001',
  harness: 'omp',
  filePath: '/sessions/source.jsonl',
  projectPath: '/project',
  title: 'Planner',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
}
const target: SessionRecord = {
  id: '019f0000-0000-7000-8000-000000000002',
  harness: 'omp',
  filePath: '/sessions/target.jsonl',
  projectPath: '/project',
  title: 'API owner',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  status: 'idle',
  depth: 0,
}
const created: SessionRecord = {
  ...target,
  id: '019f0000-0000-7000-8000-000000000006',
  filePath: '/sessions/created.jsonl',
  title: 'Model reviewer',
  status: 'running',
}

const targetTranscript: TranscriptMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Implement the API.' }] },
  { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'The endpoint is ready.' }] },
]

function fakePi(withTypebox: boolean) {
  const tools: RegisteredTool[] = []
  const schema =
    (kind: string) =>
    (...args: unknown[]) => ({ kind, args })
  const pi: Record<string, unknown> = {
    registerTool: (tool: RegisteredTool) => tools.push(tool),
  }
  if (withTypebox) {
    pi.typebox = { Type: { Object: schema('object'), String: schema('string'), Number: schema('number'), Boolean: schema('boolean'), Optional: schema('optional') } }
  }
  return { tools, pi: pi as unknown as OmpExtensionApi }
}

async function loadExtension(url?: string, token?: string) {
  vi.resetModules()
  vi.stubEnv('GOOEYPI_COLLABORATION_URL', url ?? (undefined as unknown as string))
  vi.stubEnv('GOOEYPI_COLLABORATION_TOKEN', token ?? (undefined as unknown as string))
  return (await import('../../assets/extensions/omp-work-collaboration')).default
}

async function fixture() {
  const records = [source, target]
  const sessions = {
    omp: {
      list: vi.fn(async () => records),
      read: vi.fn(async (filePath: unknown) => (filePath === target.filePath ? targetTranscript : [])),
    },
  }
  const targetRuntime: RuntimeInfo = {
    runtimeId: 'runtime-target',
    harness: 'omp',
    sessionId: target.id,
    sessionFile: target.filePath,
    cwd: '/project',
    isStreaming: false,
  }
  const agents = {
    omp: {
      getForSession: vi.fn((filePath: string) => (targetRuntime.sessionFile === filePath ? targetRuntime : undefined)),
      start: vi.fn(async ({ cwd }: { cwd: string }) => {
        records.push(created)
        return { runtimeId: 'runtime-created', harness: 'omp', sessionId: created.id, sessionFile: created.filePath, cwd, isStreaming: false }
      }),
      command: vi.fn(async () => ({ ok: true })),
      list: vi.fn(() => [targetRuntime]),
      stop: vi.fn(async () => true),
    } as unknown as AgentRpcManager,
  }
  const bridge = new AgentCollaborationBridge({
    extensionPath: '/app/extensions/omp-work-collaboration.ts',
    sessions: sessions as unknown as ConstructorParameters<typeof AgentCollaborationBridge>[0]['sessions'],
    agents,
    catalogs: {
      omp: {
        catalog: vi.fn(async () => ({
          primeVersion: 'test',
          refreshedAt: '2026-01-01T00:00:00.000Z',
          providers: [{ id: 'openai-codex', name: 'OpenAI Codex', authMethod: 'oauth' as const, configured: true, modelCount: 1, availableModelCount: 1, enabled: true }],
          models: [
            {
              key: 'openai-codex/gpt-5.6-sol',
              provider: 'openai-codex',
              id: 'gpt-5.6-sol',
              name: 'GPT-5.6 Sol',
              reasoning: true,
              input: ['text'] as const,
              contextWindow: 128_000,
              maxTokens: 16_000,
              availableThinkingLevels: ['low', 'high', 'max'] as const,
              fastModeSupported: true,
              available: true,
              enabled: true,
            },
          ],
        })),
      },
    } as unknown as ConstructorParameters<typeof AgentCollaborationBridge>[0]['catalogs'],
    disabledProviders: { omp: () => new Set() },
    disabledModels: { omp: () => new Set() },
  })
  await bridge.start()
  bridges.push(bridge)
  const environment = bridge.environmentFor({ cwd: '/project', sessionPath: source.filePath, harness: 'omp' })
  const factory = await loadExtension(environment.GOOEYPI_COLLABORATION_URL, environment.GOOEYPI_COLLABORATION_TOKEN)
  const { tools, pi } = fakePi(true)
  factory(pi)
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!
  return { tools, tool }
}

describe('omp-work-collaboration extension', () => {
  it('registers nothing without a scoped broker claim', async () => {
    const factory = await loadExtension()
    const { tools, pi } = fakePi(true)
    factory(pi)
    expect(tools).toEqual([])
  })

  it('registers the session tools through the injected typebox', async () => {
    const { tools } = await fixture()
    expect(tools.map((candidate) => candidate.name)).toEqual([
      'gooeypi_session_list',
      'gooeypi_session_models',
      'gooeypi_session_create',
      'gooeypi_session_read',
      'gooeypi_session_send',
      'gooeypi_session_wait',
    ])
  })

  it('falls back to a built-in schema builder when the host injects no typebox', async () => {
    const factory = await loadExtension('http://127.0.0.1:9/broker', 'token')
    const { tools, pi } = fakePi(false)
    await factory(pi)
    expect(tools.map((candidate) => candidate.name)).toHaveLength(6)
  })

  it('lists peers, models, and creates, reads, and messages sessions through the broker', async () => {
    const { tool } = await fixture()
    const listed = await tool('gooeypi_session_list').execute('one', {})
    expect(listed.content[0].text).toContain('API owner')

    const models = await tool('gooeypi_session_models').execute('two', { query: 'sol' })
    expect(models.content[0].text).toContain('gpt-5.6-sol')

    const createdMessage = await tool('gooeypi_session_create').execute('three', { prompt: 'Review the model list', title: 'Model reviewer' })
    expect(createdMessage.content[0].text).toContain(created.id)

    const read = await tool('gooeypi_session_read').execute('four', { target_session_id: target.id })
    expect(read.content[0].text).toContain('The endpoint is ready.')

    const sent = await tool('gooeypi_session_send').execute('five', { target_session_id: target.id, message: 'Please ship it.' })
    expect(sent.details).toEqual({})
    expect(sent.content[0].text).toContain('delivered')

    const waited = await tool('gooeypi_session_wait').execute('six', { target_session_id: target.id, timeout_ms: 0 })
    expect(waited.content[0].text).toContain('API owner')
  })

  it('surfaces broker errors from failed calls', async () => {
    const { tool } = await fixture()
    await expect(tool('gooeypi_session_read').execute('one', { target_session_id: 'missing-session' })).rejects.toThrow(/session/i)
  })
})
