import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  DESKTOP_OPEN_URL_TOOL,
  DesktopOpenUrlService,
} from '../../electron/main/desktop-open-url'
import type {
  DesktopHostToolResult,
  DesktopOpenUrlToolCallRequest,
  HostAuthorizationResponseInput,
  HostAuthorizationSnapshot,
} from '../../src/types/host-capabilities'

interface Harness {
  service: DesktopOpenUrlService
  openExternal: Mock<(url: string) => Promise<void>>
  writeResult: Mock<(runtimeId: string, result: DesktopHostToolResult) => Promise<void>>
  results: Array<{ runtimeId: string; result: DesktopHostToolResult }>
}

function createHarness(openExternal?: (url: string) => Promise<void>): Harness {
  const results: Harness['results'] = []
  const open = vi.fn(openExternal ?? (async (_url: string) => undefined))
  const writeResult = vi.fn(async (runtimeId: string, result: DesktopHostToolResult) => {
    results.push({ runtimeId, result })
  })
  return {
    service: new DesktopOpenUrlService({ openExternal: open, writeResult }),
    openExternal: open,
    writeResult,
    results,
  }
}

function toolCall(
  id = 'request-1',
  url = 'https://example.test/page',
  toolCallId = 'tool-call-1',
): DesktopOpenUrlToolCallRequest {
  return {
    type: 'host_tool_call',
    id,
    toolCallId,
    toolName: 'desktop_open_url',
    arguments: { url },
  }
}

async function registered(service: DesktopOpenUrlService, runtimeId = 'runtime-a', ownerId = 11): Promise<number> {
  const registrationGeneration = await service.beginInteractiveRegistration(runtimeId, ownerId)
  expect(service.finishRegistration({
    runtimeId,
    registrationGeneration,
    ownerId,
    outcome: { ok: true, toolNames: ['desktop_open_url'] },
  })).toBe('registered')
  return registrationGeneration
}

function response(runtimeId: string, registrationGeneration: number, requestId = 'request-1', decision: 'approve' | 'deny' = 'approve'): HostAuthorizationResponseInput {
  return { runtimeId, registrationGeneration, requestId, decision }
}

function texts(harness: Harness): string[] {
  return harness.results.map(({ result }) => result.result.content[0]?.text)
}

describe('DesktopOpenUrlService', () => {
  it('publishes one fixed immutable upstream-compatible tool definition', () => {
    expect(DESKTOP_OPEN_URL_TOOL).toEqual({
      name: 'desktop_open_url',
      label: 'Open a web page',
      description: 'Open one HTTP(S) URL after explicit user confirmation.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', maxLength: 8192 } },
        required: ['url'],
        additionalProperties: false,
      },
      loadMode: 'discoverable',
    })
    expect(Object.isFrozen(DESKTOP_OPEN_URL_TOOL)).toBe(true)
    expect(Object.isFrozen(DESKTOP_OPEN_URL_TOOL.parameters)).toBe(true)
    expect(Object.isFrozen(DESKTOP_OPEN_URL_TOOL.parameters.properties.url)).toBe(true)
    expect(Object.isFrozen(DESKTOP_OPEN_URL_TOOL.parameters.required)).toBe(true)
  })

  it('never invokes the authorization effect before approval by the registered owner', async () => {
    const harness = createHarness()
    const generation = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall())

    expect(harness.service.hasPendingOperations('runtime-a')).toBe(true)
    expect(harness.openExternal).not.toHaveBeenCalled()
    expect(await harness.service.respond(99, response('runtime-a', generation))).toBe(false)
    expect(harness.openExternal).not.toHaveBeenCalled()
    expect(harness.service.snapshot('runtime-a', 99)).toEqual({ runtimeId: 'runtime-a', registrationGeneration: 0, pending: null })
    expect(harness.service.snapshot('runtime-a', 11).pending?.url).toBe('https://example.test/page')

    expect(await harness.service.respond(11, response('runtime-a', generation))).toBe(true)
    expect(harness.openExternal).toHaveBeenCalledOnce()
    expect(harness.openExternal).toHaveBeenCalledWith('https://example.test/page')
    expect(harness.results).toHaveLength(1)
    expect(harness.results[0]?.result.isError).toBeUndefined()
    expect(harness.service.hasPendingOperations('runtime-a')).toBe(false)
  })

  it('answers valid calls while registration is pending, failed, uncertain, or absent', async () => {
    for (const finish of ['pending', 'failed', 'mismatched', 'absent'] as const) {
      const harness = createHarness()
      let generation = 0
      if (finish !== 'absent') {
        generation = await harness.service.beginInteractiveRegistration('runtime-a', 11)
      }
      if (finish === 'failed') {
        expect(harness.service.finishRegistration({ runtimeId: 'runtime-a', registrationGeneration: generation, ownerId: 11, outcome: { ok: false } })).toBe('unavailable')
      } else if (finish === 'mismatched') {
        expect(harness.service.finishRegistration({
          runtimeId: 'runtime-a', registrationGeneration: generation, ownerId: 11,
          outcome: { ok: true, toolNames: ['desktop_open_url', 'unexpected_tool'] },
        })).toBe('unavailable')
      }

      await harness.service.handleHostToolCall('runtime-a', toolCall())
      expect(texts(harness), finish).toEqual(['Host tool unavailable.'])
      expect(harness.results[0]?.result.isError).toBe(true)
      expect(harness.service.snapshot('runtime-a', 11).pending).toBeNull()
      expect(harness.openExternal).not.toHaveBeenCalled()
    }
  })

  it.each([
    'file:///tmp/private',
    'javascript:alert(1)',
    'data:text/html,hello',
    'mailto:user@example.test',
    'ftp://example.test/file',
    'https://user:secret@example.test/',
    'not a url',
  ])('rejects an unauthorized URL without prompting or opening: %s', async (url) => {
    const harness = createHarness()
    await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall('request-1', url))

    expect(harness.results).toHaveLength(1)
    expect(harness.results[0]?.result).toMatchObject({ id: 'request-1', isError: true })
    expect(texts(harness)).toEqual(['Invalid open URL request.'])
    expect(harness.service.snapshot('runtime-a', 11).pending).toBeNull()
    expect(harness.openExternal).not.toHaveBeenCalled()
  })

  it('enforces UTF-8 URL limits and the exact single-property argument schema', async () => {
    const harness = createHarness()
    await registered(harness.service)
    const overlongUtf8 = `https://example.test/${'\u{1F310}'.repeat(2_100)}`
    await harness.service.handleHostToolCall('runtime-a', toolCall('request-utf8', overlongUtf8))
    await harness.service.handleHostToolCall('runtime-a', { ...toolCall('request-extra'), arguments: { url: 'https://example.test/', ownerId: 11 } })
    await harness.service.handleHostToolCall('runtime-a', { ...toolCall('request-type'), arguments: { url: 42 } })
    await harness.service.handleHostToolCall('runtime-a', { ...toolCall('request-null'), arguments: null })

    expect(harness.results.map(({ result }) => result.id)).toEqual(['request-utf8', 'request-extra', 'request-type', 'request-null'])
    expect(texts(harness)).toEqual(Array(4).fill('Invalid open URL request.'))
    expect(harness.service.snapshot('runtime-a', 11).pending).toBeNull()
    expect(harness.openExternal).not.toHaveBeenCalled()
  })

  it('classifies unknown tools as errors but silently consumes unbounded and duplicate protocol anomalies', async () => {
    const harness = createHarness()
    await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', { ...toolCall('unknown'), toolName: 'some_other_tool' })
    await harness.service.handleHostToolCall('runtime-a', toolCall('x'.repeat(257)))
    await harness.service.handleHostToolCall('runtime-a', { ...toolCall('bad-tool-name'), toolName: 'x'.repeat(257) })
    await harness.service.handleHostToolCall('runtime-a', { ...toolCall('bad-tool-call'), toolCallId: '' })
    await harness.service.handleHostToolCall('runtime-a', { ...toolCall('bad-unicode'), id: 'bad-\ud800' })

    expect(harness.results.map(({ result }) => result.id)).toEqual(['unknown'])
    expect(texts(harness)).toEqual(['Unknown host tool.'])

    await harness.service.handleHostToolCall('runtime-a', toolCall('duplicate', 'https://first.example.test/'))
    await harness.service.handleHostToolCall('runtime-a', toolCall('duplicate', 'https://second.example.test/'))
    expect(harness.results).toHaveLength(1)
    expect(harness.service.snapshot('runtime-a', 11).pending?.url).toBe('https://first.example.test/')
  })

  it('answers a valid over-cap call without disturbing the eight queued requests', async () => {
    const harness = createHarness()
    await registered(harness.service)
    for (let index = 0; index < 8; index += 1) {
      await harness.service.handleHostToolCall('runtime-a', toolCall(`request-${index}`))
    }
    await harness.service.handleHostToolCall('runtime-a', toolCall('request-over-cap'))

    expect(harness.results).toHaveLength(1)
    expect(harness.results[0]?.result).toMatchObject({ id: 'request-over-cap', isError: true })
    expect(texts(harness)).toEqual(['Host tool unavailable: too many pending requests.'])
    expect(harness.service.snapshot('runtime-a', 11).pending?.requestId).toBe('request-0')
  })

  it('normalizes before display and opens only the stored normalized URL', async () => {
    const harness = createHarness()
    const generation = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall('request-1', '  https://example.test  '))
    expect(harness.service.snapshot('runtime-a', 11).pending?.url).toBe('https://example.test/')

    expect(await harness.service.respond(11, response('runtime-a', generation))).toBe(true)
    expect(harness.openExternal).toHaveBeenCalledWith('https://example.test/')
    expect(harness.openExternal).toHaveBeenCalledOnce()
    expect(JSON.stringify(harness.results[0]?.result)).not.toContain('example.test')
  })

  it('denies once and makes late decisions and duplicate frames inert', async () => {
    const harness = createHarness()
    const generation = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall())

    expect(await harness.service.respond(11, response('runtime-a', generation, 'request-1', 'deny'))).toBe(true)
    expect(await harness.service.respond(11, response('runtime-a', generation))).toBe(false)
    await harness.service.handleHostToolCall('runtime-a', toolCall())
    await harness.service.cancel('runtime-a', 'cancel-late', 'request-1')

    expect(harness.openExternal).not.toHaveBeenCalled()
    expect(harness.results).toHaveLength(1)
    expect(texts(harness)).toEqual(['Open URL request denied by the user.'])
    expect(harness.results[0]?.result.isError).toBe(true)
  })

  it('rejects wrong runtime, generation, malformed decisions, and renderer-supplied extra response fields', async () => {
    const harness = createHarness()
    const generation = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall())
    const forged = { ...response('runtime-a', generation), url: 'https://attacker.example/' }

    expect(await harness.service.respond(11, response('runtime-b', generation))).toBe(false)
    expect(await harness.service.respond(11, response('runtime-a', generation + 1))).toBe(false)
    const malformedDecision = response('runtime-a', generation)
    Reflect.set(malformedDecision, 'decision', 'maybe')
    expect(await harness.service.respond(11, malformedDecision)).toBe(false)
    expect(await harness.service.respond(11, forged)).toBe(false)
    expect(harness.service.snapshot('runtime-a', 11).pending?.requestId).toBe('request-1')
    expect(harness.results).toHaveLength(0)
    expect(harness.openExternal).not.toHaveBeenCalled()
  })

  it('cancels an awaiting request, reveals the correct successor, and settles each request once', async () => {
    const harness = createHarness()
    const generation = await registered(harness.service)
    for (const id of ['request-1', 'request-2', 'request-3']) {
      await harness.service.handleHostToolCall('runtime-a', toolCall(id, `https://example.test/${id}`))
    }

    expect(await harness.service.cancel('runtime-a', 'cancel-1', 'request-1')).toBe(true)
    expect(harness.service.snapshot('runtime-a', 11).pending?.requestId).toBe('request-2')
    expect(await harness.service.respond(11, response('runtime-a', generation, 'request-2', 'deny'))).toBe(true)
    expect(harness.service.snapshot('runtime-a', 11).pending?.requestId).toBe('request-3')
    expect(await harness.service.respond(11, response('runtime-a', generation, 'request-3'))).toBe(true)

    expect(harness.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.test/request-3')
    expect(harness.results.map(({ result }) => result.id)).toEqual(['request-1', 'request-2', 'request-3'])
    expect(harness.service.snapshot('runtime-a', 11).pending).toBeNull()
  })

  it('honors cancellation delivered before its call without displaying a prompt', async () => {
    const harness = createHarness()
    await registered(harness.service)
    expect(await harness.service.cancel('runtime-a', 'cancel-1', 'request-1')).toBe(false)
    await harness.service.handleHostToolCall('runtime-a', toolCall())
    await harness.service.handleHostToolCall('runtime-a', toolCall())

    expect(harness.results).toHaveLength(1)
    expect(texts(harness)).toEqual(['Open URL request cancelled.'])
    expect(harness.service.snapshot('runtime-a', 11).pending).toBeNull()
    expect(harness.openExternal).not.toHaveBeenCalled()
  })

  it('cannot undo an in-flight shell invocation or fabricate cancellation success', async () => {
    const gate = Promise.withResolvers<void>()
    const harness = createHarness(() => gate.promise)
    const generation = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall())
    const approval = harness.service.respond(11, response('runtime-a', generation))
    expect(harness.openExternal).toHaveBeenCalledOnce()
    expect(harness.service.hasPendingOperations('runtime-a')).toBe(true)

    expect(await harness.service.cancel('runtime-a', 'cancel-after-open', 'request-1')).toBe(false)
    expect(harness.results).toHaveLength(0)
    gate.resolve()
    expect(await approval).toBe(true)

    expect(harness.results).toHaveLength(1)
    expect(harness.results[0]?.result.isError).toBeUndefined()
    expect(texts(harness)).toEqual(['Opened the approved web page.'])
  })

  it('settles a double-click approve concurrently with one shell call and one result', async () => {
    const gate = Promise.withResolvers<void>()
    const harness = createHarness(() => gate.promise)
    const generation = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall())

    const first = harness.service.respond(11, response('runtime-a', generation))
    const second = harness.service.respond(11, response('runtime-a', generation))
    gate.resolve()
    expect(await Promise.all([first, second])).toEqual([true, false])
    expect(harness.openExternal).toHaveBeenCalledOnce()
    expect(harness.results).toHaveLength(1)
  })

  it('wins concurrent deny/cancel settlement once and ignores later answers', async () => {
    const harness = createHarness()
    const generation = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall())

    const denied = harness.service.respond(11, response('runtime-a', generation, 'request-1', 'deny'))
    const cancelled = harness.service.cancel('runtime-a', 'cancel-1', 'request-1')
    expect(await Promise.all([denied, cancelled])).toEqual([true, false])
    expect(await harness.service.respond(11, response('runtime-a', generation))).toBe(false)
    expect(harness.results).toHaveLength(1)
    expect(harness.openExternal).not.toHaveBeenCalled()
  })

  it('returns an error when the injected executor fails', async () => {
    const harness = createHarness(async () => { throw new Error('synthetic executor failure') })
    const generation = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall())

    expect(await harness.service.respond(11, response('runtime-a', generation))).toBe(true)
    expect(harness.results).toHaveLength(1)
    expect(harness.results[0]?.result.isError).toBe(true)
    expect(texts(harness)).toEqual(['The approved web page could not be opened.'])
    expect(harness.service.snapshot('runtime-a', 11).pending).toBeNull()
  })

  it('invalidates pending operations and answers on registration change without cross-generation answers', async () => {
    const harness = createHarness()
    const oldGeneration = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall('old-request'))
    const newGeneration = await harness.service.beginInteractiveRegistration('runtime-a', 11)

    expect(newGeneration).toBeGreaterThan(oldGeneration)
    expect(harness.results.map(({ result }) => result.id)).toEqual(['old-request'])
    expect(texts(harness)).toEqual(['Host tool registration changed.'])
    expect(await harness.service.respond(11, response('runtime-a', oldGeneration, 'old-request'))).toBe(false)
    expect(harness.openExternal).not.toHaveBeenCalled()

    expect(harness.service.finishRegistration({
      runtimeId: 'runtime-a', registrationGeneration: newGeneration, ownerId: 11,
      outcome: { ok: true, toolNames: ['desktop_open_url'] },
    })).toBe('registered')
    await harness.service.handleHostToolCall('runtime-a', toolCall('new-request', 'https://new.example.test/'))
    expect(await harness.service.respond(11, response('runtime-a', newGeneration, 'new-request'))).toBe(true)
    expect(harness.openExternal).toHaveBeenCalledExactlyOnceWith('https://new.example.test/')
  })

  it('does not accept a late or foreign registration acknowledgment', async () => {
    const harness = createHarness()
    const oldGeneration = await harness.service.beginInteractiveRegistration('runtime-a', 11)
    const currentGeneration = await harness.service.beginInteractiveRegistration('runtime-a', 11)

    expect(harness.service.finishRegistration({
      runtimeId: 'runtime-a', registrationGeneration: oldGeneration, ownerId: 11,
      outcome: { ok: true, toolNames: ['desktop_open_url'] },
    })).toBe('stale')
    expect(harness.service.finishRegistration({
      runtimeId: 'runtime-a', registrationGeneration: currentGeneration, ownerId: 99,
      outcome: { ok: true, toolNames: ['desktop_open_url'] },
    })).toBe('stale')
    await harness.service.handleHostToolCall('runtime-a', toolCall())
    expect(texts(harness)).toEqual(['Host tool unavailable.'])
  })

  it('retires a runtime, invalidates queued calls, and starts a later generation cleanly', async () => {
    const harness = createHarness()
    const oldGeneration = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall())
    await harness.service.retireRuntime('runtime-a')

    expect(harness.results).toHaveLength(1)
    expect(texts(harness)).toEqual(['Host tool runtime ended.'])
    expect(harness.service.snapshot('runtime-a', 11)).toEqual({ runtimeId: 'runtime-a', registrationGeneration: 0, pending: null })
    expect(await harness.service.respond(11, response('runtime-a', oldGeneration))).toBe(false)
    expect(harness.openExternal).not.toHaveBeenCalled()

    const newGeneration = await registered(harness.service, 'runtime-a', 22)
    expect(newGeneration).toBeGreaterThan(oldGeneration)
    expect(harness.service.snapshot('runtime-a', 22).registrationGeneration).toBe(newGeneration)
  })

  it('ends only the exact owner/generation pair and invalidates its pending head', async () => {
    const harness = createHarness()
    const generation = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall())

    expect(await harness.service.endRegistration('runtime-a', generation, 99)).toBe(false)
    expect(harness.results).toHaveLength(0)
    expect(await harness.service.endRegistration('runtime-a', generation, 11)).toBe(true)
    expect(harness.results).toHaveLength(1)
    expect(texts(harness)).toEqual(['Host tool registration changed.'])
    expect(await harness.service.endRegistration('runtime-a', generation, 11)).toBe(false)
    expect(await harness.service.respond(11, response('runtime-a', generation))).toBe(false)
    expect(harness.service.hasPendingOperations('runtime-a')).toBe(false)

    const nextGeneration = await harness.service.beginInteractiveRegistration('runtime-a', 11)
    expect(nextGeneration).toBeGreaterThan(generation)
  })

  it('preserves the genuine result when retirement happens after shell invocation began', async () => {
    const gate = Promise.withResolvers<void>()
    const harness = createHarness(() => gate.promise)
    const generation = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall())
    const approval = harness.service.respond(11, response('runtime-a', generation))
    await harness.service.retireRuntime('runtime-a')
    expect(harness.service.hasPendingOperations('runtime-a')).toBe(true)
    gate.resolve()

    expect(await approval).toBe(true)
    expect(harness.service.hasPendingOperations('runtime-a')).toBe(false)
    expect(harness.results).toHaveLength(1)
    expect(harness.results[0]?.result.isError).toBeUndefined()
    expect(texts(harness)).toEqual(['Opened the approved web page.'])
  })

  it('revokes all capabilities and subscriptions owned by a departing window', async () => {
    const harness = createHarness()
    const generation = await registered(harness.service)
    const listener = vi.fn<(snapshot: HostAuthorizationSnapshot) => void>()
    const unsubscribe = harness.service.onChanged('runtime-a', 11, listener)
    await harness.service.handleHostToolCall('runtime-a', toolCall())
    expect(listener).toHaveBeenCalled()
    await harness.service.revokeOwner(11)

    expect(harness.results).toHaveLength(1)
    expect(texts(harness)).toEqual(['Host tool owner revoked.'])
    const callsAtRevocation = listener.mock.calls.length
    expect(await harness.service.respond(11, response('runtime-a', generation))).toBe(false)
    unsubscribe()
    const nextGeneration = await registered(harness.service, 'runtime-a', 22)
    await harness.service.handleHostToolCall('runtime-a', toolCall('next-request'))
    expect(listener).toHaveBeenCalledTimes(callsAtRevocation)
    expect(nextGeneration).toBeGreaterThan(generation)
  })

  it('publishes fresh owner-scoped head snapshots and stops notifying after explicit unsubscribe', async () => {
    const harness = createHarness()
    const generation = await registered(harness.service)
    const snapshots: HostAuthorizationSnapshot[] = []
    const unsubscribe = harness.service.onChanged('runtime-a', 11, (snapshot) => { snapshots.push(snapshot) })
    await harness.service.handleHostToolCall('runtime-a', toolCall())

    expect(snapshots.at(-1)).toEqual({
      runtimeId: 'runtime-a', registrationGeneration: generation,
      pending: { requestId: 'request-1', kind: 'open-url', url: 'https://example.test/page' },
    })
    const first = harness.service.snapshot('runtime-a', 11)
    const second = harness.service.snapshot('runtime-a', 11)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)

    unsubscribe()
    expect(await harness.service.respond(11, response('runtime-a', generation, 'request-1', 'deny'))).toBe(true)
    expect(snapshots).toHaveLength(1)
  })

  it('routes identical protocol request ids once to their own runtime', async () => {
    const harness = createHarness()
    const firstGeneration = await registered(harness.service, 'runtime-a', 11)
    const secondGeneration = await registered(harness.service, 'runtime-b', 22)
    await harness.service.handleHostToolCall('runtime-a', toolCall('shared-request', 'https://a.example.test/'))
    await harness.service.handleHostToolCall('runtime-b', toolCall('shared-request', 'https://b.example.test/'))

    expect(await harness.service.respond(11, response('runtime-a', firstGeneration, 'shared-request'))).toBe(true)
    expect(await harness.service.respond(22, response('runtime-b', secondGeneration, 'shared-request'))).toBe(true)
    expect(harness.results.map(({ runtimeId, result }) => ({ runtimeId, id: result.id }))).toEqual([
      { runtimeId: 'runtime-a', id: 'shared-request' },
      { runtimeId: 'runtime-b', id: 'shared-request' },
    ])
    expect(harness.openExternal).toHaveBeenNthCalledWith(1, 'https://a.example.test/')
    expect(harness.openExternal).toHaveBeenNthCalledWith(2, 'https://b.example.test/')
  })

  it('keeps a live awaiting id authoritative after its remembered cursor is evicted', async () => {
    const harness = createHarness()
    const generation = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall('request-live', 'https://original.example.test/'))
    for (let index = 0; index < 256; index += 1) {
      await harness.service.handleHostToolCall('runtime-a', { ...toolCall(`junk-${index}`), toolName: 'unsupported_tool' })
    }
    const resultCountBeforeReplay = harness.results.length

    await harness.service.handleHostToolCall('runtime-a', toolCall('request-live', 'https://replay.example.test/'))
    expect(harness.results).toHaveLength(resultCountBeforeReplay)
    expect(harness.service.snapshot('runtime-a', 11).pending).toEqual({
      requestId: 'request-live', kind: 'open-url', url: 'https://original.example.test/',
    })

    expect(await harness.service.respond(11, response('runtime-a', generation, 'request-live'))).toBe(true)
    expect(harness.openExternal).toHaveBeenCalledExactlyOnceWith('https://original.example.test/')
    expect(harness.results.filter(({ result }) => result.id === 'request-live')).toHaveLength(1)
    expect(harness.results).toHaveLength(resultCountBeforeReplay + 1)
  })

  it('keeps an in-flight opening id authoritative after its remembered cursor is evicted', async () => {
    const gate = Promise.withResolvers<void>()
    const harness = createHarness(() => gate.promise)
    const generation = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall('request-live', 'https://original.example.test/'))
    const approval = harness.service.respond(11, response('runtime-a', generation, 'request-live'))
    expect(harness.openExternal).toHaveBeenCalledExactlyOnceWith('https://original.example.test/')
    for (let index = 0; index < 256; index += 1) {
      await harness.service.handleHostToolCall('runtime-a', { ...toolCall(`junk-${index}`), toolName: 'unsupported_tool' })
    }
    const resultCountBeforeReplay = harness.results.length

    await harness.service.handleHostToolCall('runtime-a', toolCall('request-live', 'https://replay.example.test/'))
    expect(harness.results).toHaveLength(resultCountBeforeReplay)
    expect(harness.service.snapshot('runtime-a', 11).pending).toBeNull()
    expect(harness.openExternal).toHaveBeenCalledOnce()
    gate.resolve()

    expect(await approval).toBe(true)
    expect(harness.openExternal).toHaveBeenCalledExactlyOnceWith('https://original.example.test/')
    expect(harness.results.filter(({ result }) => result.id === 'request-live')).toHaveLength(1)
    expect(harness.results).toHaveLength(resultCountBeforeReplay + 1)
    expect(harness.service.snapshot('runtime-a', 11).pending).toBeNull()
  })

  it('rejects null and undefined decisions without changing the live authorization', async () => {
    const harness = createHarness()
    const generation = await registered(harness.service)
    await harness.service.handleHostToolCall('runtime-a', toolCall('request-live'))
    const before = harness.service.snapshot('runtime-a', 11)

    expect(await harness.service.respond(11, null)).toBe(false)
    expect(await harness.service.respond(11, undefined)).toBe(false)
    expect(harness.service.snapshot('runtime-a', 11)).toEqual(before)
    expect(harness.results).toHaveLength(0)
    expect(harness.openExternal).not.toHaveBeenCalled()
    expect(await harness.service.respond(11, response('runtime-a', generation, 'request-live', 'deny'))).toBe(true)
    expect(harness.results.filter(({ result }) => result.id === 'request-live')).toHaveLength(1)
    expect(harness.openExternal).not.toHaveBeenCalled()
  })

  it('does not re-answer when a terminal result sink fails', async () => {
    const results: DesktopHostToolResult[] = []
    const service = new DesktopOpenUrlService({
      openExternal: async () => undefined,
      writeResult: async (_runtimeId, result) => { results.push(result); throw new Error('synthetic closed transport') },
    })
    const generation = await registered(service)
    await service.handleHostToolCall('runtime-a', toolCall())

    expect(await service.respond(11, response('runtime-a', generation, 'request-1', 'deny'))).toBe(true)
    await service.cancel('runtime-a', 'cancel-late', 'request-1')
    expect(results).toHaveLength(1)
  })
})
