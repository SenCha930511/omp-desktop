import { mkdtempSync, rmSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentScheduleBridge } from '../../electron/main/schedules/agent-bridge'
import { AutomationService } from '../../electron/main/schedules/service'
import { JsonStateStore, type JsonStateStoreFileSystem } from '../../electron/main/store'

class TestAgentScheduleBridge extends AgentScheduleBridge {
  requestsFor(token: string | undefined): number | undefined {
    return token ? this.claimForToken(token)?.requests : undefined
  }
}

const dirs: string[] = []
const bridges: TestAgentScheduleBridge[] = []
const services: AutomationService[] = []
const stores: JsonStateStore[] = []
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
  await Promise.all(services.splice(0).map((service) => service.stop()))
  await Promise.all(stores.splice(0).map((store) => store.beginShutdown()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function fixture(harness: 'omp' = 'omp', fileSystem?: JsonStateStoreFileSystem) {
  const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-agent-schedules-'))
  dirs.push(dir)
  const store = new JsonStateStore(join(dir, 'state.json'), fileSystem)
  stores.push(store)
  await store.ready()
  const service = new AutomationService(store, {
    validateTarget: async () => undefined,
    validateExecution: async () => undefined,
    run: async () => ({}),
    now: () => new Date('2030-01-01T00:00:00Z'),
  })
  services.push(service)
  const bridge = new TestAgentScheduleBridge({
    service, harness, skillPath: '/app/skills/omp-desktop-schedules',
    resolveScope: async ({ sessionPath }) => ({ projectId: 'project-one', sessionId: sessionPath ? 'session-one' : undefined }),
  })
  await bridge.start()
  bridges.push(bridge)
  const environment = bridge.environmentFor({ cwd: '/project', sessionPath: '/sessions/one.jsonl' })
  const call = async (method: string, params: Record<string, unknown>, token = environment.OMP_DESKTOP_SCHEDULE_TOKEN) => {
    const response = await fetch(environment.OMP_DESKTOP_SCHEDULE_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
    return { status: response.status, body: await response.json() as { ok: boolean; result?: unknown; error?: string } }
  }
  return { bridge, store, service, environment, call }
}

function rawBodyRequest(url: string, token: string | undefined, body: string) {
  const request = httpRequest(url, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'keep-alive',
    },
  })
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    request.on('response', (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
  })
  request.write(body.slice(0, -1))
  return { request, response, finish: () => request.end(body.slice(-1)) }
}

describe('AgentScheduleBridge', () => {
  it('revokes only the requested runtime claim and treats repeated revocation as a no-op', async () => {
    const { environment, call } = await fixture()
    const other = bridges[0].environmentFor({ cwd: '/project', sessionPath: '/sessions/two.jsonl' })

    expect(await call('list', {})).toMatchObject({ status: 200 })
    expect(bridges[0].revoke(environment.OMP_DESKTOP_SCHEDULE_TOKEN)).toBe(true)
    expect(bridges[0].revoke(environment.OMP_DESKTOP_SCHEDULE_TOKEN)).toBe(false)

    expect(await call('list', {})).toMatchObject({ status: 401 })
    expect(await call('list', {}, other.OMP_DESKTOP_SCHEDULE_TOKEN)).toMatchObject({ status: 200 })
  })

  it('creates agent-attributed tasks only in the capability current target', async () => {
    const { service, environment, call } = await fixture()
    expect(environment.OMP_DESKTOP_SCHEDULE_SKILL_PATH).toBe('/app/skills/omp-desktop-schedules')
    const response = await call('create', {
      target: 'current_session',
      input: {
        title: 'Follow up', prompt: 'Check the deployment',
        timing: { kind: 'once', at: '2030-01-02T00:00:00Z' },
        execution: { model: 'auto', thinking: 'auto', speed: 'normal' },
      },
    })
    expect(response.status).toBe(200)
    expect(service.list()[0]).toMatchObject({ harness: 'omp', createdBy: 'agent', target: { kind: 'session', projectId: 'project-one', sessionId: 'session-one' } })
    const list = await call('list', {})
    expect(list.body.result).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Follow up' })]))
  })

  it('attributes both user- and agent-created tasks to the omp harness in bridge scope', async () => {
    const { service, call } = await fixture()
    await service.create({
      prompt: 'User-owned', target: { kind: 'project', projectId: 'project-one' },
      timing: { kind: 'once', at: '2030-01-02T00:00:00Z' },
      execution: { model: 'auto', thinking: 'auto', speed: 'normal' },
    })
    await call('create', {
      target: 'current_project',
      input: { prompt: 'Agent-owned', timing: { kind: 'once', at: '2030-01-02T00:00:00Z' }, execution: { model: 'auto', thinking: 'auto', speed: 'normal' } },
    })
    const listed = (await call('list', {})).body.result as Array<{ harness: string; prompt: string }>
    expect(listed.map(({ harness, prompt }) => ({ harness, prompt }))).toEqual(expect.arrayContaining([
      { harness: 'omp', prompt: 'User-owned' },
      { harness: 'omp', prompt: 'Agent-owned' },
    ]))
  })

  it('rejects non-JSON and missing content types but accepts parameterized application/json', async () => {
    const { environment, call } = await fixture()
    const plain = await fetch(environment.OMP_DESKTOP_SCHEDULE_URL!, {
      method: 'POST',
      headers: { Authorization: `Bearer ${environment.OMP_DESKTOP_SCHEDULE_TOKEN}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(plain.status).toBe(415)
    const missing = await fetch(environment.OMP_DESKTOP_SCHEDULE_URL!, {
      method: 'POST',
      headers: { Authorization: `Bearer ${environment.OMP_DESKTOP_SCHEDULE_TOKEN}` },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(missing.status).toBe(415)
    const charset = await fetch(environment.OMP_DESKTOP_SCHEDULE_URL!, {
      method: 'POST',
      headers: { Authorization: `Bearer ${environment.OMP_DESKTOP_SCHEDULE_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(charset.status).toBe(200)
    expect((await call('list', {})).status).toBe(200)
  })

  it('rejects missing tokens, browser origins, and unavailable target scopes', async () => {
    const { environment, call } = await fixture()
    expect((await call('list', {}, 'wrong')).status).toBe(401)
    const origin = await fetch(environment.OMP_DESKTOP_SCHEDULE_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${environment.OMP_DESKTOP_SCHEDULE_TOKEN}`, Origin: 'https://example.com' },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(origin.status).toBe(404)
    const noSessionEnvironment = bridges[0].environmentFor({ cwd: '/project' })
    const response = await fetch(noSessionEnvironment.OMP_DESKTOP_SCHEDULE_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${noSessionEnvironment.OMP_DESKTOP_SCHEDULE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'create', params: { target: 'current_session', input: {} } }),
    })
    expect(response.status).toBe(400)
  })

  it('drains partial-body rejects and admitted bodies before stop completes', async () => {
    const { bridge, service, environment } = await fixture()
    const body = JSON.stringify({ method: 'list', params: {} })
    const rejected = rawBodyRequest(environment.OMP_DESKTOP_SCHEDULE_URL!, undefined, body)
    expect(await rejected.response).toMatchObject({ status: 401, body: expect.stringContaining('Unauthorized') })
    await bridge.stop()

    await bridge.start()
    const active = bridge.environmentFor({ cwd: '/project', sessionPath: '/sessions/active.jsonl' })
    const admitted = rawBodyRequest(active.OMP_DESKTOP_SCHEDULE_URL!, active.OMP_DESKTOP_SCHEDULE_TOKEN, body)
    while (bridge.requestsFor(active.OMP_DESKTOP_SCHEDULE_TOKEN) !== 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    let stopped = false
    const stopping = bridge.stop().then(() => { stopped = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(stopped).toBe(false)

    admitted.finish()
    expect(await admitted.response).toMatchObject({ status: 401, body: expect.stringContaining('Capability expired') })
    await stopping
    expect(service.list()).toEqual([])
  })

  it('drains an in-flight persisted response and closes every state handle before cleanup', async () => {
    const liveHandles = new Set<string>()
    const writeStarted = Promise.withResolvers<void>()
    const allowWrite = Promise.withResolvers<void>()
    let blockNextWrite = false
    const fileSystem: JsonStateStoreFileSystem = {
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode)
        liveHandles.add(path)
        return {
          writeFile: (data, options) => handle.writeFile(data, options),
          sync: async () => {
            if (blockNextWrite && flags === 'w') {
              blockNextWrite = false
              writeStarted.resolve()
              await allowWrite.promise
            }
            await handle.sync()
          },
          close: async () => {
            try { await handle.close() } finally { liveHandles.delete(path) }
          },
        }
      },
      rename,
      unlink,
    }
    const { bridge, store, call } = await fixture('omp', fileSystem)
    blockNextWrite = true
    const pendingResponse = call('create', {
      target: 'current_project',
      input: {
        prompt: 'Persist before shutdown',
        timing: { kind: 'once', at: '2030-01-02T00:00:00Z' },
        execution: { model: 'auto', thinking: 'auto', speed: 'normal' },
      },
    })
    await writeStarted.promise
    let stopped = false
    const stopping = bridge.stop().then(() => { stopped = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(stopped).toBe(false)
    expect(liveHandles.size).toBe(1)

    allowWrite.resolve()
    expect((await pendingResponse).status).toBe(200)
    await stopping
    await store.beginShutdown()
    expect(liveHandles).toEqual(new Set())
  })
})
