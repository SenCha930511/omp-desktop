import { describe, expect, it } from 'vitest'
import { SessionLaunches } from '../../electron/main/agent-rpc/session-launches'
import type { RuntimeInfo } from '../../src/types/api'

const info = (runtimeId: string): RuntimeInfo => ({
  runtimeId,
  harness: 'omp',
  cwd: '/tmp/project',
  sessionFile: '/tmp/project/session.jsonl',
  isStreaming: false,
})

const key = '/tmp/project/session.jsonl'
const interactive = { interactive: true, ownerId: 7 } as const

describe('SessionLaunches', () => {
  it('lets the same audience join the owner launch and publishes one ready runtime', async () => {
    const launches = new SessionLaunches()
    const owner = launches.begin(key, interactive)
    expect(owner.kind).toBe('owner')
    if (owner.kind !== 'owner') throw new Error('expected an owner launch')

    const joined = launches.begin(key, { interactive: true, ownerId: 7 })
    expect(joined.kind).toBe('join')
    if (joined.kind !== 'join') throw new Error('expected a joined launch')
    expect(joined.ticket.ready).toBe(owner.launch.ready)
    expect(launches.pending(key)).toBe(joined.ticket)

    const published = info('runtime-1')
    owner.launch.publish(published)
    await expect(joined.ticket.ready).resolves.toBe(published)
    expect(launches.pending(key)).toBeUndefined()
    // Publication is idempotent: a second publish cannot settle the ticket again
    // and the slot is free for the next launch.
    owner.launch.publish(info('runtime-2'))
    await expect(joined.ticket.ready).resolves.toBe(published)
    expect(launches.begin(key, interactive).kind).toBe('owner')
  })

  it('rejects every joiner with the owner error and frees the slot for a later owner', async () => {
    const launches = new SessionLaunches()
    const owner = launches.begin(key, interactive)
    if (owner.kind !== 'owner') throw new Error('expected an owner launch')
    const joined = launches.begin(key, interactive)
    if (joined.kind !== 'join') throw new Error('expected a joined launch')

    const failure = new Error('handshake failed')
    owner.launch.fail(failure)
    await expect(joined.ticket.ready).rejects.toBe(failure)
    expect(launches.pending(key)).toBeUndefined()

    // fail is idempotent and cannot be converted into a success afterwards.
    owner.launch.fail(new Error('second failure'))
    owner.launch.publish(info('runtime-late'))
    await expect(joined.ticket.ready).rejects.toBe(failure)

    const retry = launches.begin(key, interactive)
    expect(retry.kind).toBe('owner')
  })

  it('defers a different audience and settles it with the owner runtime', async () => {
    const launches = new SessionLaunches()
    const owner = launches.begin(key, interactive)
    if (owner.kind !== 'owner') throw new Error('expected an owner launch')

    const deferred = launches.begin(key, { interactive: false })
    expect(deferred.kind).toBe('defer')
    if (deferred.kind !== 'defer') throw new Error('expected a deferred launch')
    expect(deferred.ticket.ready).toBe(owner.launch.ready)

    const otherOwner = launches.begin(key, { interactive: true, ownerId: 8 })
    expect(otherOwner.kind).toBe('defer')

    let settled = false
    void deferred.ticket.ready.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    const published = info('runtime-1')
    owner.launch.publish(published)
    await expect(deferred.ticket.ready).resolves.toBe(published)
    expect(launches.pending(key)).toBeUndefined()
  })

  it('keeps different sessions independent', async () => {
    const launches = new SessionLaunches()
    const first = launches.begin('/tmp/project/a.jsonl', interactive)
    const second = launches.begin('/tmp/project/b.jsonl', interactive)
    expect(first.kind).toBe('owner')
    expect(second.kind).toBe('owner')
    expect(launches.pending('/tmp/project/a.jsonl')).not.toBe(launches.pending('/tmp/project/b.jsonl'))

    if (first.kind !== 'owner' || second.kind !== 'owner') throw new Error('expected owner launches')
    first.launch.publish(info('runtime-a'))
    expect(launches.pending('/tmp/project/b.jsonl')?.audience).toEqual(interactive)
    expect(launches.pending('/tmp/project/a.jsonl')).toBeUndefined()
    second.launch.publish(info('runtime-b'))
    expect(launches.pending('/tmp/project/b.jsonl')).toBeUndefined()
  })

  it('does not raise an unhandled rejection when a failed launch has no joiner', async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', listener)
    try {
      const launches = new SessionLaunches()
      const owner = launches.begin(key, interactive)
      if (owner.kind !== 'owner') throw new Error('expected an owner launch')
      owner.launch.fail(new Error('owner gave up'))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })
})
