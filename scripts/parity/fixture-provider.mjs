#!/usr/bin/env node
/**
 * Deterministic OpenAI-compatible fixture provider for the parity harness.
 * Wire surface: POST {baseUrl}/chat/completions (SSE stream or JSON when
 * stream:false) and GET {baseUrl}/models. Empirically validated against a
 * real omp 18.13.1 binary (see scripts/parity/smoke-fixture.mjs).
 *
 * Serves just enough of the `openai-completions` wire surface
 * (docs/models.md provider fields; openai-completions.ts posts to
 * `{baseUrl}/chat/completions` and parses streamed `delta.content`)
 * for a REAL omp binary to run end-to-end with zero network.
 *
 * Determinism contract: same conversation -> same assistant text:
 * `fixture-ack[<user-turn-count>]:<last user text>`, constant wire ids,
 * constant created. RPC (GUI path) and TUI runs are comparable after
 * normalization. This file intentionally avoids literal newline escapes
 */
import { createServer } from 'node:http'

export const FIXTURE_MODEL_ID = 'fixture-echo'
export const FIXTURE_PROVIDER_ID = 'parity-fixture'
const FIXTURE_CREATED = 1700000000
const FIXTURE_HOLD_MS = 4000

/** Drops omp-injected <system-reminder> wrappers so echoed text stays
 *  deterministic and path-independent for RPC/TUI comparison. */
function stripReminders(text) {
  const open = '<system-reminder>'
  const close = '</system-reminder>'
  let clean = ''
  for (const part of String(text).split(open)) {
    const end = part.indexOf(close)
    if (end >= 0) clean += part.slice(end + close.length)
    else clean += part
  }
  return clean.trim()
}
function lastUserText(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : []
  let text = ''
  let count = 0
  for (const message of messages) {
    if (!message || message.role !== 'user') continue
    count += 1
    const content = message.content
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      const joined = content.filter((part) => part && part.type === 'text').map((part) => part.text).join('\n')
      if (joined) text = joined
    }
  }
  return { count, text: stripReminders(text).slice(0, 400) }
}

function assistantText(body) {
  const { count, text } = lastUserText(body)
  return `fixture-ack[${count}]:${text}`
}

function ssePieces(body) {
  const full = assistantText(body)
  const pieces = []
  const step = Math.max(1, Math.ceil(full.length / 4))
  for (let i = 0; i < full.length; i += step) pieces.push(full.slice(i, i + step))
  return pieces
}

function chunkPayload(delta, finish) {
  return JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: FIXTURE_CREATED, model: FIXTURE_MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish === undefined ? null : finish }] })
}

export function startFixtureProvider() {
  let sawAuthorization = false
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.headers.authorization !== undefined) sawAuthorization = true
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, path: url.pathname })
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: FIXTURE_MODEL_ID, object: 'model', created: FIXTURE_CREATED, owned_by: 'parity' }] }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        let body = {}
        try { body = JSON.parse(rawBody) } catch { body = {} }
        if (body.stream === false) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion', created: FIXTURE_CREATED, model: FIXTURE_MODEL_ID, choices: [{ index: 0, message: { role: 'assistant', content: assistantText(body) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
          return
        }
        // HOLD 模式：last user text 以 'hold' 開頭時延遲回應，讓佇列案例
        // 能在 busy 期間塞入第二則訊息（RPC 與 TUI 同語意）。
        const { text: holdText } = lastUserText(body)
        if (holdText.startsWith('hold')) await new Promise((resolve) => setTimeout(resolve, FIXTURE_HOLD_MS))
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        for (const piece of ssePieces(body)) res.write('data: ' + chunkPayload({ role: 'assistant', content: piece }) + '\n\n')
        res.write('data: ' + chunkPayload({}, 'stop') + '\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fixture has no ' + req.method + ' ' + url.pathname } }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, port, requests: () => [...requests], sawAuthorization: () => sawAuthorization })
    })
  })
}
