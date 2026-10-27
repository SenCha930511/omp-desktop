import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordSessionDiagnostic } from '../../electron/main/agent-rpc/session-diagnostics'
import { RpcRuntime } from '../../electron/main/agent-rpc/runtime'
import type { RpcObject } from '../../electron/main/agent-rpc/types'
import type { RuntimeInfo } from '../../src/types/api'

afterEach(() => vi.restoreAllMocks())

describe('session identity diagnostics', () => {
  it('records correlatable identity transitions without raw paths, session ids or extra fields', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const state = {
      runtimeId: 'runtime-fixture', harness: 'omp', cwd: '/private/project',
      sessionId: 'private-session-id', sessionFile: '/private/session/file.jsonl', isStreaming: false,
      prompt: 'PRIVATE PROMPT', apiKey: 'PRIVATE KEY', tokensBefore: 12345,
    } satisfies RuntimeInfo & { prompt: string; apiKey: string; tokensBefore: number }
    recordSessionDiagnostic('compact-requested', state)
    recordSessionDiagnostic('compact-synchronized', { ...state, sessionFile: '/private/session/fork.jsonl' })
    const before: unknown = JSON.parse(String(log.mock.calls[0][1]))
    const after: unknown = JSON.parse(String(log.mock.calls[1][1]))
    expect(before).toMatchObject({ phase: 'compact-requested', runtimeId: 'runtime-fixture', leafKnown: false })
    expect(after).toMatchObject({ phase: 'compact-synchronized', runtimeId: 'runtime-fixture', leafKnown: false })
    const serialized = JSON.stringify(log.mock.calls)
    for (const secret of ['private-session-id', '/private', 'PRIVATE PROMPT', 'PRIVATE KEY', 'tokensBefore']) expect(serialized).not.toContain(secret)
    expect(before).toHaveProperty('sessionIdHash')
    expect(before).toHaveProperty('sessionPathHash')
    expect(after).not.toEqual(before)
  })

  it('does not invent a leaf or identity when OMP has not reported one', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    recordSessionDiagnostic('persistence-notice', { runtimeId: 'runtime-fixture', harness: 'omp', cwd: '.', isStreaming: false }, 'error')
    const record: unknown = JSON.parse(String(log.mock.calls[0][1]))
    expect(record).toMatchObject({ phase: 'persistence-notice', leafKnown: false, noticeLevel: 'error' })
    expect(record).not.toHaveProperty('sessionIdHash')
    expect(record).not.toHaveProperty('sessionPathHash')
    expect(record).not.toHaveProperty('leafId')
    expect(record).not.toHaveProperty('leafIdHash')
  })

  it('hashes a reported authoritative leaf id without ever logging it raw', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const state = {
      runtimeId: 'runtime-fixture', harness: 'omp', cwd: '/private/project',
      sessionId: 'private-session-id', sessionFile: '/private/session/file.jsonl', isStreaming: false,
    } satisfies RuntimeInfo
    // OMP leafId 是 60 字以上的 hex；必須像 sessionId 一樣只留 24 字 hash
    const leafId = 'a'.repeat(60) + 'beef'
    recordSessionDiagnostic('compact-synchronized', state, undefined, leafId)
    const record = JSON.parse(String(log.mock.calls[0][1])) as Record<string, unknown>
    expect(record).toMatchObject({ phase: 'compact-synchronized', leafKnown: true })
    expect(record).not.toHaveProperty('leafId')
    expect(record).toHaveProperty('leafIdHash')
    expect(String(record.leafIdHash)).toMatch(/^[0-9a-f]{24}$/)
    expect(record.leafIdHash).not.toBe('a'.repeat(24))
    expect(JSON.stringify(log.mock.calls)).not.toContain(leafId)
  })
})

describe('runtime readLeafId', () => {
  /** 只覆寫私有 request：readLeafId 不觸碰其他 runtime 狀態，不需要真的子程序。 */
  function runtimeWithRequest(request: (command: RpcObject, timeoutMs: number) => Promise<RpcObject>): RpcRuntime {
    const runtime = Object.create(RpcRuntime.prototype) as RpcRuntime
    const stubbable = runtime as unknown as { request: (command: RpcObject, timeoutMs: number) => Promise<RpcObject> }
    stubbable.request = request
    return runtime
  }

  it('issues a read-only get_tree and returns the authoritative leaf id', async () => {
    const sent: RpcObject[] = []
    const fixtureLeafId = 'c'.repeat(64)
    const runtime = runtimeWithRequest(async (command) => {
      sent.push(command)
      return { type: 'response', success: true, data: { tree: [], leafId: fixtureLeafId } }
    })
    await expect(runtime.readLeafId()).resolves.toBe(fixtureLeafId)
    expect(sent).toEqual([{ type: 'get_tree' }])
  })

  it('degrades to undefined when the request fails or times out, never throwing', async () => {
    const runtime = runtimeWithRequest(async () => {
      throw new Error('RPC command get_tree timed out after delivery; the agent may still run it — do not retry automatically')
    })
    await expect(runtime.readLeafId()).resolves.toBeUndefined()
  })

  it('degrades to undefined for a malformed or leaf-less get_tree response', async () => {
    const missing = runtimeWithRequest(async () => ({ type: 'response', success: true, data: { tree: [] } }))
    await expect(missing.readLeafId()).resolves.toBeUndefined()
    const mistyped = runtimeWithRequest(async () => ({ type: 'response', success: true, data: { leafId: 42 } }))
    await expect(mistyped.readLeafId()).resolves.toBeUndefined()
    const empty = runtimeWithRequest(async () => ({ type: 'response', success: true, data: { leafId: '' } }))
    await expect(empty.readLeafId()).resolves.toBeUndefined()
    const failed = runtimeWithRequest(async () => ({ type: 'response', success: false, error: 'Unknown command get_tree' }))
    await expect(failed.readLeafId()).resolves.toBeUndefined()
  })
})
