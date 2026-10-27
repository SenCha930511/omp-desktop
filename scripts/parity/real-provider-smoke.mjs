#!/usr/bin/env node
/**
 * Controlled real-provider integration smoke (7.4).
 *
 * What this does — and deliberately does NOT do:
 *   - Copies the user's REAL provider configuration (models.yml, models.db*
 *     snapshot, pi-model-sync.json) from ~/.omp/agent into an ISOLATED temp
 *     HOME, so the real state is never written to (no session files, no
 *     credential mutations, no lock contention beyond a read-only snapshot).
 *   - Runs ONE tiny prompt (`reply with exactly: ok`) through the real
 *     configured default provider via the real binary, in print mode.
 *   - Reports only: exit code, model selector resolved, elapsed ms, whether
 *     a non-empty reply arrived, and the reply's trimmed length. Reply text
 *     is compared against expected ack but never printed in full (no
 *     provider diagnostics or config values are echoed).
 *
 * Missing prerequisites (documented, not faked):
 *   - OAuth browser flows (anthropic/openai-codex/github-copilot/...) cannot
 *     be automated headlessly; the login/logout RPC surface is covered by
 *     unit tests (tests/backend/agent-rpc-command-schema.test.ts OAuth
 *     describe) and the panel flow by tests/frontend/provider-accounts*.
 *     Manual verification steps are listed in the audit doc.
 *
 * Usage: node scripts/parity/real-provider-smoke.mjs [--omp /opt/homebrew/bin/omp]
 * Exit 0 only when the real provider answered the tiny prompt.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { homedir } from 'node:os'

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const OMP = arg('--omp', '/opt/homebrew/bin/omp')
const SOURCE_AGENT = path.join(homedir(), '.omp', 'agent')
const PROMPT = 'reply with exactly: ok'
const EXPECTED = 'ok'
const TIMEOUT_MS = 120_000

function fail(reason) {
  console.log(JSON.stringify({ smoke: 'real-provider', status: 'FAIL', reason }))
  process.exit(1)
}
// models.yml 的 `apiKey:` 值可能是環境變數名（如 NCHC_LLM_API_KEY）。
// 只轉發設定檔明確引用的變數名（值不列印、不寫入任何輸出），
// 其餘環境一律隔離。
function referencedCredentialEnvNames(ymlPath) {
  try {
    const text = readFileSync(ymlPath, 'utf8')
    const names = new Set()
    for (const match of text.matchAll(/apiKey['\"]?\s*[:=]\s*['\"]?([A-Za-z_][A-Za-z0-9_]{3,})['\"]?/g)) {
      const candidate = match[1]
      if (/^[A-Z][A-Z0-9_]+$/.test(candidate)) names.add(candidate)
    }
    return [...names]
  } catch {
    return []
  }
}


if (!existsSync(path.join(SOURCE_AGENT, 'models.yml'))) fail('no real models.yml at ~/.omp/agent — nothing to copy')

const root = mkdtempSync(path.join(tmpdir(), 'parity-realprovider-'))
const agentDir = path.join(root, 'home', '.omp', 'agent')
mkdirSync(agentDir, { recursive: true })
const workspace = path.join(root, 'workspace')
mkdirSync(workspace, { recursive: true })

// Snapshot the provider configuration. Read-only copies; contents never printed.
for (const name of ['models.yml', 'models.db', 'models.db-wal', 'models.db-shm', 'pi-model-sync.json']) {
  const source = path.join(SOURCE_AGENT, name)
  if (existsSync(source)) {
    try { copyFileSync(source, path.join(agentDir, name)) } catch { /* optional file */ }
  }
}

const credentialEnv = {}
for (const name of referencedCredentialEnvNames(path.join(agentDir, 'models.yml'))) {
  if (process.env[name] !== undefined) credentialEnv[name] = process.env[name]
}

const started = Date.now()
const child = spawn(OMP, ['-p', PROMPT, '--cwd', workspace, '--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-lsp', '--no-title', '--no-session'], {
  env: {
    HOME: path.join(root, 'home'),
    PATH: process.env.PATH,
    TERM: 'dumb',
    TMPDIR: tmpdir(),
    ...credentialEnv,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', (chunk) => { out += chunk })
child.stderr.on('data', (chunk) => { err += chunk })
const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, TIMEOUT_MS)
timer.unref()
const code = await new Promise((resolve) => child.on('close', resolve))
clearTimeout(timer)

const elapsedMs = Date.now() - started
const trimmed = out.trim()
// 只回報長度與是否命中預期，不印回覆內容或 provider 診斷。
const answered = code === 0 && trimmed.length > 0
const matched = trimmed.toLowerCase().includes(EXPECTED)

rmSync(root, { recursive: true, force: true })

const summary = {
  smoke: 'real-provider',
  status: answered && matched ? 'PASS' : answered ? 'PASS_WITH_UNEXPECTED_REPLY' : 'FAIL',
  exitCode: code,
  elapsedMs,
  replyLength: trimmed.length,
  matchedExpectedAck: matched,
  stderrMentionedError: /error|failed|unauthorized|invalid/i.test(err),
}
console.log(JSON.stringify(summary, null, 2))
process.exit(answered ? 0 : 1)
