#!/usr/bin/env node
/**
 * Empirical validation that the fixture provider actually serves a REAL
 * omp binary: starts the fixture on a random port, writes an isolated
 * temp HOME whose models.yml points at it, and runs `omp -p` (print mode)
 * with one prompt. Prints the raw omp output plus which fixture routes
 * were hit. Exit 0 only when omp produced the deterministic ack text.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startFixtureProvider, FIXTURE_PROVIDER_ID, FIXTURE_MODEL_ID } from './fixture-provider.mjs'

const OMP = process.argv[2] || '/opt/homebrew/bin/omp'
const PROMPT = 'hello fixture'

const fixture = await startFixtureProvider()
const root = mkdtempSync(path.join(tmpdir(), 'parity-smoke-'))
const home = path.join(root, 'home')
const workspace = path.join(root, 'workspace')
const sessions = path.join(root, 'sessions')
mkdirSync(home, { recursive: true })
mkdirSync(workspace, { recursive: true })
mkdirSync(sessions, { recursive: true })
mkdirSync(path.join(home, '.omp', 'agent'), { recursive: true })

const modelsYml = [
  'providers:',
  '  ' + FIXTURE_PROVIDER_ID + ':',
  '    baseUrl: http://127.0.0.1:' + fixture.port + '/v1',
  '    apiKey: parity-fixture-not-a-real-key',
  '    api: openai-completions',
  '    auth: apiKey',
  '    models:',
  '      - id: ' + FIXTURE_MODEL_ID,
  '        name: Fixture Echo',
  '        api: openai-completions',
  '        reasoning: false',
].join('\n')
writeFileSync(path.join(home, '.omp', 'agent', 'models.yml'), modelsYml + '\n')

const env = { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb', TMPDIR: tmpdir() }
const args = [
  '-p', PROMPT,
  '--model', FIXTURE_PROVIDER_ID + '/' + FIXTURE_MODEL_ID,
  '--cwd', workspace,
  '--session-dir', sessions,
  '--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-lsp', '--no-title',
]

const child = spawn(OMP, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
let err = ''
child.stdout.on('data', (c) => { out += c })
child.stderr.on('data', (c) => { err += c })
const code = await new Promise((resolve) => { child.on('close', resolve) })

const hit = fixture.requests()
const ok = code === 0 && out.includes('fixture-ack[1]:hello fixture')
console.log('exit=' + code + ' auth=' + fixture.sawAuthorization())
console.log('routes=' + JSON.stringify(hit))
console.log('--- stdout ---')
console.log(out.slice(0, 2000))
console.log('--- stderr ---')
console.log(err.slice(0, 2000))
fixture.server.close()
rmSync(root, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
