import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ConformanceClient, type ConformanceSandbox, createConformanceSandbox, requireCapability } from './client'
import { writeOmpSessionFixture } from './fixtures/launcher'
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

describe('conformance: OMP JSONL sessions', () => {
  it('discovers, orders, syncs, reads read-only, pins, archives, and deletes OMP v3 sessions', async () => {
    if (!requireCapability(info, 'sessions')) return
    sandbox = createConformanceSandbox('omp-conf-sess-')
    const projectDir = join(sandbox.rootDir, 'project')
    mkdirSync(projectDir, { recursive: true })
    const canonicalProject = realpathSync(projectDir)

    const olderPath = writeOmpSessionFixture({
      homeDir: sandbox.homeDir,
      bucket: '-omp-project',
      fileName: '2026-03-01T00-00-00-000Z_019fdf24-aaaa-7000-8000-000000000001.jsonl',
      title: 'Older Session',
      updatedAt: '2026-03-01T00:00:00.000Z',
      entries: [
        { type: 'session', version: 3, id: '019fdf24-aaaa-7000-8000-000000000001', timestamp: '2026-03-01T00:00:00.000Z', cwd: canonicalProject },
        { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-03-01T00:00:01.000Z', model: 'anthropic/claude-fixture' },
        { type: 'message', id: 'u1', parentId: 'm1', timestamp: '2026-03-01T00:00:02.000Z', message: { role: 'user', content: 'First prompt' } },
      ],
    })

    const newerPath = writeOmpSessionFixture({
      homeDir: sandbox.homeDir,
      bucket: '-omp-project',
      fileName: '2026-04-01T00-00-00-000Z_019fdf24-bbbb-7000-8000-000000000002.jsonl',
      title: 'Newer Session',
      updatedAt: '2026-04-01T00:00:00.000Z',
      entries: [
        { type: 'session', version: 3, id: '019fdf24-bbbb-7000-8000-000000000002', timestamp: '2026-04-01T00:00:00.000Z', cwd: canonicalProject },
        { type: 'model_change', id: 'm2', parentId: null, timestamp: '2026-04-01T00:00:01.000Z', model: 'openai-codex/gpt-5.4' },
        {
          type: 'message',
          id: 'u2',
          parentId: 'm2',
          timestamp: '2026-04-01T00:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect this' },
              {
                type: 'image',
                mimeType: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
              },
            ],
          },
        },
        {
          type: 'message',
          id: 'a2',
          parentId: 'u2',
          timestamp: '2026-04-01T00:00:03.000Z',
          message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }] },
        },
        {
          type: 'message',
          id: 'tr2',
          parentId: 'a2',
          timestamp: '2026-04-01T00:00:04.000Z',
          message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'bash', content: [{ type: 'text', text: 'file.txt' }] },
        },
        {
          type: 'compaction',
          id: 'c2',
          parentId: 'tr2',
          timestamp: '2026-04-01T00:00:05.000Z',
          tokensBefore: 1000,
          tokensAfter: 200,
          summary: 'Compacted earlier history.',
        },
        {
          type: 'custom_message',
          id: 'am2',
          parentId: 'c2',
          customType: 'agent_message',
          display: true,
          content: '[from child:reviewer]\nMetadata',
          details: { message: 'Review completed.', from: { sessionName: 'reviewer', runtimeKind: 'subagent' } },
          timestamp: '2026-04-01T00:00:06.000Z',
        },
      ],
    })

    await client.call('workspace.reset', {
      rootDir: sandbox.rootDir,
      homeDir: sandbox.homeDir,
      userDataDir: sandbox.userDataDir,
      appDataDir: sandbox.appDataDir,
      ompExecutable: sandbox.ompExecutable,
    })

    const listed = await client.call<Array<{ id: string; title: string; provider?: string; model?: string; pinned?: boolean }>>('sessions.list', {
      force: true,
    })
    expect(listed.map((s) => s.title)).toEqual(['Newer Session', 'Older Session'])
    expect(listed[0]).toMatchObject({ provider: 'openai-codex', model: 'gpt-5.4' })
    expect(listed[1]).toMatchObject({ provider: 'anthropic', model: 'claude-fixture' })

    const rawBefore = readFileSync(newerPath, 'utf8')
    const transcript = await client.call<Array<{ role: string; agentName?: string; parts: Array<{ type: string; text?: string }> }>>('sessions.read', { filePath: newerPath })
    expect(readFileSync(newerPath, 'utf8')).toBe(rawBefore)
    const partTypes = transcript.flatMap((msg) => msg.parts.map((part) => part.type))
    expect(partTypes).toContain('text')
    expect(partTypes).toContain('image')
    expect(partTypes).toContain('toolCall')
    expect(partTypes).toContain('toolResult')
    expect(partTypes).toContain('compaction')
    expect(transcript.some((msg) => msg.role === 'agent' && msg.agentName === 'reviewer' && msg.parts.some((part) => part.text === 'Review completed.'))).toBe(true)

    // Path traversal outside ~/.omp/agent/sessions must be rejected.
    const outsideFile = join(sandbox.rootDir, 'outside.jsonl')
    writeFileSync(outsideFile, '{"type":"session"}\n', 'utf8')
    await client.callExpectError('sessions.read', { filePath: outsideFile })

    // Incremental catalog sync: snapshot then delta.
    const snapshot = await client.call<{ kind: string; revision: number; records: unknown[] }>('sessions.sync')
    expect(snapshot.kind).toBe('snapshot')
    expect(snapshot.records).toHaveLength(2)

    const addedPath = writeOmpSessionFixture({
      homeDir: sandbox.homeDir,
      bucket: '-omp-project',
      fileName: '2026-05-01T00-00-00-000Z_019fdf24-cccc-7000-8000-000000000003.jsonl',
      title: 'Added Session',
      updatedAt: '2026-05-01T00:00:00.000Z',
      entries: [{ type: 'session', version: 3, id: '019fdf24-cccc-7000-8000-000000000003', timestamp: '2026-05-01T00:00:00.000Z', cwd: canonicalProject }],
    })
    rmSync(olderPath)

    const delta = await client.call<{ kind: string; baseRevision: number; revision: number; upserts: Array<{ title: string }>; removals: string[] }>('sessions.sync', {
      revision: snapshot.revision,
    })
    expect(delta.kind).toBe('delta')
    expect(delta.upserts.map((u) => u.title)).toContain('Added Session')
    expect(delta.removals.some((removedPath) => removedPath === olderPath || removedPath.endsWith('000000000001.jsonl'))).toBe(true)

    // Pin survives restart, archive hides unless includeArchived, delete removes file on disk.
    await client.call('sessions.setPinned', { filePath: newerPath, pinned: true })
    await client.call('state.close')
    await client.call('state.open')
    const afterReopen = await client.call<Array<{ filePath: string; pinned?: boolean }>>('sessions.list', { force: true })
    expect(afterReopen.find((s) => realpathSync(s.filePath) === realpathSync(newerPath))?.pinned).toBe(true)

    await client.call('sessions.archive', { filePath: addedPath, archived: true })
    const unarchivedOnly = await client.call<Array<{ filePath: string }>>('sessions.list', { includeArchived: false, force: true })
    expect(unarchivedOnly.some((s) => realpathSync(s.filePath) === realpathSync(addedPath))).toBe(false)
    const withArchived = await client.call<Array<{ filePath: string }>>('sessions.list', { includeArchived: true, force: true })
    expect(withArchived.some((s) => realpathSync(s.filePath) === realpathSync(addedPath))).toBe(true)

    expect(await client.call<boolean>('sessions.delete', { filePath: newerPath })).toBe(true)
    expect(existsSync(newerPath)).toBe(false)
  })
})
