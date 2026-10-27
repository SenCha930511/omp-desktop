#!/usr/bin/env node
/**
 * Isolated temp HOME builder for the parity harness.
 *
 * Every case gets a fresh mkdtemp root containing:
 *   home/.omp/agent/models.yml  — provider `parity-fixture` pointing at the
 *                                 fixture HTTP server (docs/models.md L52:
 *                                 custom provider baseUrl/apiKey/api fields).
 *   home/.omp/agent/config.yml  — setupVersion: 2 + startup.showSplash: false
 *                                 so the TUI skips the first-run wizard and
 *                                 splash (upstream main.ts cold-launch gate;
 *                                 CURRENT_SETUP_VERSION = 2 in
 *                                 packages/tui/src/setup/setup-version.ts).
 *   workspace/                   — deterministic cwd for both drivers.
 *   sessions/                    — isolated --session-dir.
 *
 * `cloneFrom` copies an existing root so both sides of a comparison start
 * from equivalent-but-independent state (no shared-file lock contention).
 */
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FIXTURE_MODEL_ID, FIXTURE_PROVIDER_ID } from './fixture-provider.mjs'

export function writeFixtureModelsYml(home, fixturePort) {
  mkdirSync(path.join(home, '.omp', 'agent'), { recursive: true })
  writeFileSync(path.join(home, '.omp', 'agent', 'models.yml'), [
    'providers:',
    '  ' + FIXTURE_PROVIDER_ID + ':',
    '    baseUrl: http://127.0.0.1:' + fixturePort + '/v1',
    '    apiKey: parity-fixture-not-a-real-key',
    '    api: openai-completions',
    '    auth: apiKey',
    '    models:',
    '      - id: ' + FIXTURE_MODEL_ID,
    '        name: Fixture Echo',
    '        api: openai-completions',
    '        reasoning: false',
  ].join('\n') + '\n')
  writeFileSync(path.join(home, '.omp', 'agent', 'config.yml'), 'setupVersion: 2\nstartup:\n  showSplash: false\ncompaction:\n  keepRecentTokens: 200\n')
}

/**
 * @param {{ fixturePort?: number, prefix?: string }} [options]
 * @returns {{ root: string, home: string, workspace: string, sessions: string }}
 */
export function buildTempHome({ fixturePort, prefix = 'parity-home-' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  const home = path.join(root, 'home')
  const workspace = path.join(root, 'workspace')
  const sessions = path.join(root, 'sessions')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(sessions, { recursive: true })
  writeFixtureModelsYml(home, fixturePort)
  return { root, home, workspace, sessions }
}

/** Equivalent-but-independent copy: a second root with the same seeded state. */
/**
 * @param {{ sessions: string }} source
 * @param {{ fixturePort?: number, prefix?: string }} [options]
 * @returns {{ root: string, home: string, workspace: string, sessions: string }}
 */
export function cloneTempHome(source, { fixturePort, prefix = 'parity-home-' } = {}) {
  const built = buildTempHome({ fixturePort, prefix })
  // Copy any session files the seed wants pre-loaded (not the lock files).
  cpSync(path.join(source.sessions), path.join(built.sessions), { recursive: true, filter: (src) => !src.includes('.lock.') })
  return built
}

/** omp argv shared by both drivers so only the mode/pty differ. */
export function ompArgs() {
  return [
    '--model', FIXTURE_PROVIDER_ID + '/' + FIXTURE_MODEL_ID,
    '--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-lsp', '--no-title',
  ]
}

/** The only ambient variables the child environment inherits. */
export function childEnv(home) {
  return {
    HOME: home,
    PATH: '/usr/bin:/bin',
    TERM: 'xterm-256color',
    TMPDIR: tmpdir(),
    LANG: 'en_US.UTF-8',
  }
}
