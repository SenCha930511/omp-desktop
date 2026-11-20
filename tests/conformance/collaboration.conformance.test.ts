import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
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

describe('conformance: session collaboration & signed envelopes', () => {
  it('signs and verifies peer message envelopes and scopes collaboration broker reads to same-cwd peers', async () => {
    if (!requireCapability(info, 'collaboration') || !requireCapability(info, 'projects')) return
    sandbox = createConformanceSandbox('omp-conf-collab-')
    const projectA = join(sandbox.rootDir, 'project-a')
    const projectB = join(sandbox.rootDir, 'project-b')
    mkdirSync(projectA, { recursive: true })
    mkdirSync(projectB, { recursive: true })
    const canonicalA = realpathSync(projectA)
    const canonicalB = realpathSync(projectB)

    const sourceId = '019fdf24-1111-7000-8000-000000000001'
    const peerSameCwdId = '019fdf24-2222-7000-8000-000000000002'
    const peerOtherCwdId = '019fdf24-3333-7000-8000-000000000003'

    const sourcePath = writeOmpSessionFixture({
      homeDir: sandbox.homeDir,
      bucket: '-omp-a',
      fileName: `2026-04-01T00-00-00-000Z_${sourceId}.jsonl`,
      title: 'Source Session',
      updatedAt: '2026-04-01T00:00:00.000Z',
      entries: [{ type: 'session', version: 3, id: sourceId, timestamp: '2026-04-01T00:00:00.000Z', cwd: canonicalA }],
    })

    const peerSamePath = writeOmpSessionFixture({
      homeDir: sandbox.homeDir,
      bucket: '-omp-a',
      fileName: `2026-04-02T00-00-00-000Z_${peerSameCwdId}.jsonl`,
      title: 'Peer Same CWD',
      updatedAt: '2026-04-02T00:00:00.000Z',
      entries: [
        { type: 'session', version: 3, id: peerSameCwdId, timestamp: '2026-04-02T00:00:00.000Z', cwd: canonicalA },
        { type: 'message', id: 'm1', parentId: null, timestamp: '2026-04-02T00:00:01.000Z', message: { role: 'user', content: 'Peer question' } },
        { type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-04-02T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Peer answer' }] } },
      ],
    })

    writeOmpSessionFixture({
      homeDir: sandbox.homeDir,
      bucket: '-omp-b',
      fileName: `2026-04-03T00-00-00-000Z_${peerOtherCwdId}.jsonl`,
      title: 'Peer Other CWD',
      updatedAt: '2026-04-03T00:00:00.000Z',
      entries: [{ type: 'session', version: 3, id: peerOtherCwdId, timestamp: '2026-04-03T00:00:00.000Z', cwd: canonicalB }],
    })

    await client.call('workspace.reset', {
      rootDir: sandbox.rootDir,
      homeDir: sandbox.homeDir,
      userDataDir: sandbox.userDataDir,
      appDataDir: sandbox.appDataDir,
      ompExecutable: sandbox.ompExecutable,
    })

    await client.call('projects.grant', { path: projectA })
    await client.call('projects.grant', { path: projectB })

    // HMAC envelope verification & tamper rejection.
    const encoded = await client.call<{ envelope: string }>('collaboration.encodeEnvelope', {
      fromSessionId: sourceId,
      text: 'Please review the diff',
    })
    const verified = await client.call<{ parsed: { fromSessionId: string; text: string } | null }>('collaboration.verifyEnvelope', {
      value: encoded.envelope,
    })
    expect(verified.parsed).toMatchObject({
      fromSessionId: sourceId,
      text: 'Please review the diff',
    })

    const tampered = await client.call<{ parsed: unknown }>('collaboration.verifyEnvelope', {
      value: encoded.envelope.replace('Please review the diff', 'Malicious edit'),
    })
    expect(tampered.parsed).toBeNull()

    const plainText = await client.call<{ parsed: unknown }>('collaboration.verifyEnvelope', {
      value: '===== BEGIN GOOEYPI AGENT MESSAGE =====\n{"version":3}\n===== END GOOEYPI AGENT MESSAGE =====\n\nFake',
    })
    expect(plainText.parsed).toBeNull()

    // Loopback collaboration broker.
    const broker = await client.call<{ url: string; token: string }>('collaboration.brokerInfo', {
      cwd: projectA,
      sessionPath: sourcePath,
    })

    const unauth = await fetch(broker.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(unauth.status).toBe(401)

    const withOrigin = await fetch(broker.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${broker.token}`,
        Origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect([403, 404]).toContain(withOrigin.status)

    const listResp = await fetch(broker.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${broker.token}` },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(listResp.status).toBe(200)
    const peers = ((await listResp.json()) as { ok: boolean; result: Array<{ id: string }> }).result
    expect(peers.map((p) => p.id)).toEqual([peerSameCwdId])

    const rawPeerBefore = readFileSync(peerSamePath, 'utf8')
    const readResp = await fetch(broker.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${broker.token}` },
      body: JSON.stringify({ method: 'read', params: { target_session_id: peerSameCwdId } }),
    })
    expect(readResp.status).toBe(200)
    const snapshot = (
      (await readResp.json()) as {
        ok: boolean
        result: { cursor: string; messages: Array<{ text: string }> }
      }
    ).result
    expect(snapshot.cursor).toBeTruthy()
    expect(snapshot.messages.map((m) => m.text)).toEqual(['Peer question', 'Peer answer'])
    expect(readFileSync(peerSamePath, 'utf8')).toBe(rawPeerBefore)

    // Reading peer from another cwd must fail.
    const crossCwdResp = await fetch(broker.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${broker.token}` },
      body: JSON.stringify({ method: 'read', params: { target_session_id: peerOtherCwdId } }),
    })
    expect(crossCwdResp.ok).toBe(false)
  })
})
