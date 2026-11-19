#!/usr/bin/env node
import { createHmac } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const output = join(projectRoot, 'rust', 'crates', 'omp-core', 'tests', 'fixtures', 'agent-envelopes.json')
const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex')
const BEGIN = '===== BEGIN GOOEYPI AGENT MESSAGE ====='
const END = '===== END GOOEYPI AGENT MESSAGE ====='

function sign(metadata, text) {
  return createHmac('sha256', key).update(JSON.stringify(metadata)).update('\0').update(text).digest('base64url')
}

function envelope(unsigned, text) {
  const metadata = { ...unsigned, signature: sign(unsigned, text) }
  return `${BEGIN}\n${JSON.stringify(metadata)}\n${END}\n\n${text}`
}

const fromSessionId = '019fdf24-1111-7000-8000-000000000001'
const nonce = '019fdf24-2222-4000-8000-000000000002'
const sentAt = '2026-04-01T00:00:00.000Z'
const text = 'Please review the diff'

const v1 = { version: 1, from_session_id: fromSessionId, from_title: 'Legacy Peer', from_harness: 'prime', nonce, sent_at: sentAt }
const v1Reply = { version: 1, from_session_id: fromSessionId, from_title: 'Legacy Peer', from_harness: 'omp', reply_with: 'session_send', nonce, sent_at: sentAt }
const v2 = { version: 2, from_session_id: fromSessionId, reply_with: 'session_send', nonce, sent_at: sentAt }
const v3 = { version: 3, from_session_id: fromSessionId, reply_with: 'gooeypi_session_send', nonce, sent_at: sentAt }

const fixtures = {
  key: key.toString('base64'),
  fromSessionId,
  text,
  cases: [
    { name: 'v1', envelope: envelope(v1, text) },
    { name: 'v1-reply', envelope: envelope(v1Reply, text) },
    { name: 'v2', envelope: envelope(v2, text) },
    { name: 'v3', envelope: envelope(v3, text) },
  ],
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(fixtures, null, 2)}\n`, 'utf8')
console.log(`Wrote ${output}`)
