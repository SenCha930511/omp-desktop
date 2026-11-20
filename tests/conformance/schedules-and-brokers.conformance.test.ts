import { mkdirSync } from 'node:fs'
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

describe('conformance: schedules & loopback broker', () => {
  it('previews rrules, persists schedule CRUD, blocks auth slash commands, and enforces loopback broker auth/origin gates', async () => {
    if (!requireCapability(info, 'schedules') || !requireCapability(info, 'projects')) return
    sandbox = createConformanceSandbox('omp-conf-sched-')
    const projectDir = join(sandbox.rootDir, 'project')
    mkdirSync(projectDir, { recursive: true })

    await client.call('workspace.reset', {
      rootDir: sandbox.rootDir,
      homeDir: sandbox.homeDir,
      userDataDir: sandbox.userDataDir,
      appDataDir: sandbox.appDataDir,
      ompExecutable: sandbox.ompExecutable,
    })

    const project = await client.call<{ id: string }>('projects.grant', { path: projectDir })

    const preview = await client.call<{ occurrences: string[] }>('schedules.preview', {
      timing: { kind: 'rrule', dtstartLocal: '2030-01-01T09:00:00', timeZone: 'Asia/Taipei', rrule: 'FREQ=DAILY;COUNT=5' },
      count: 3,
    })
    expect(preview.occurrences).toHaveLength(3)

    // Forbidden auth slash commands must be rejected on create.
    await client.callExpectError('schedules.create', {
      input: {
        title: 'Bad Auth Schedule',
        prompt: '/mcp reauth',
        target: { kind: 'project', projectId: project.id },
        timing: { kind: 'rrule', dtstartLocal: '2030-01-01T09:00:00', timeZone: 'UTC', rrule: 'FREQ=DAILY' },
        execution: { model: 'auto', thinking: 'auto', speed: 'normal' },
      },
    })

    const created = await client.call<{ id: string; revision: number; status: string; title: string }>('schedules.create', {
      input: {
        title: 'Morning Check',
        prompt: 'Summarize git status',
        target: { kind: 'project', projectId: project.id },
        timing: { kind: 'rrule', dtstartLocal: '2030-01-01T09:00:00', timeZone: 'UTC', rrule: 'FREQ=DAILY' },
        execution: { model: 'auto', thinking: 'auto', speed: 'normal' },
      },
    })
    expect(created.status).toBe('active')
    expect(created.revision).toBe(1)

    // Optimistic revision check on update & rejection of forbidden prompt on update.
    await client.callExpectError('schedules.update', {
      id: created.id,
      patch: { revision: 99, title: 'Stale' },
    })
    await client.callExpectError('schedules.update', {
      id: created.id,
      patch: { revision: created.revision, prompt: '/mcp reauth remote-srv' },
    })

    const updated = await client.call<{ revision: number; title: string }>('schedules.update', {
      id: created.id,
      patch: { revision: created.revision, title: 'Morning Check v2' },
    })
    expect(updated.title).toBe('Morning Check v2')
    expect(updated.revision).toBe(2)

    const paused = await client.call<{ status: string }>('schedules.pause', { id: created.id })
    expect(paused.status).toBe('paused')
    const resumed = await client.call<{ status: string }>('schedules.resume', { id: created.id })
    expect(resumed.status).toBe('active')

    // Persistence across state close/reopen.
    await client.call('state.close')
    await client.call('state.open')
    const listed = await client.call<Array<{ id: string; title: string }>>('schedules.list')
    expect(listed.some((t) => t.id === created.id && t.title === 'Morning Check v2')).toBe(true)

    // Real HTTP loopback broker security and CRUD tests.
    const broker = await client.call<{ url: string; token: string }>('schedules.brokerInfo', { cwd: projectDir })
    expect(broker.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
    expect(broker.token.length).toBeGreaterThan(16)

    const unauth = await fetch(broker.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(unauth.status).toBe(401)

    const wrongToken = await fetch(broker.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(wrongToken.status).toBe(401)

    const withOrigin = await fetch(broker.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${broker.token}`,
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect([403, 404]).toContain(withOrigin.status)

    const brokerList = await fetch(broker.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${broker.token}` },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(brokerList.status).toBe(200)
    const brokerListPayload = (await brokerList.json()) as { ok: boolean; result: Array<{ id: string }> }
    expect(brokerListPayload.ok).toBe(true)
    expect(brokerListPayload.result.some((t) => t.id === created.id)).toBe(true)

    const brokerCreate = await fetch(broker.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${broker.token}` },
      body: JSON.stringify({
        method: 'create',
        params: {
          target: 'current_project',
          input: {
            title: 'Agent Created',
            prompt: 'Run check',
            timing: { kind: 'rrule', dtstartLocal: '2030-02-01T10:00:00', timeZone: 'UTC', rrule: 'FREQ=WEEKLY' },
            execution: { model: 'auto', thinking: 'auto', speed: 'normal' },
          },
        },
      }),
    })
    expect(brokerCreate.status).toBe(200)
    const createdByAgent = ((await brokerCreate.json()) as { ok: boolean; result: { id: string; createdBy: string } }).result
    expect(createdByAgent.createdBy).toBe('agent')

    const brokerDelete = await fetch(broker.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${broker.token}` },
      body: JSON.stringify({ method: 'delete', params: { id: createdByAgent.id } }),
    })
    expect(brokerDelete.status).toBe(200)

    expect(await client.call<boolean>('schedules.delete', { id: created.id })).toBe(true)
  })
})
