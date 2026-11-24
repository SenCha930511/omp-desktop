#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = join(repositoryRoot, 'crates', 'omp-jsonl-core', 'Cargo.toml')
const source = join(repositoryRoot, 'crates', 'omp-jsonl-core', 'target', 'wasm32-unknown-unknown', 'release', 'omp_jsonl_core.wasm')
const destination = join(repositoryRoot, 'assets', 'wasm', 'omp-jsonl-core.wasm')

function rustupWhich(tool) {
  const result = spawnSync('rustup', ['which', tool], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : undefined
}

const cargo = process.env.CARGO ?? 'cargo'
const rustc = process.env.RUSTC ?? rustupWhich('rustc')
if (!existsSync(manifest)) throw new Error(`Rust crate manifest is missing: ${manifest}`)

const result = spawnSync(cargo, ['build', '--manifest-path', manifest, '--target', 'wasm32-unknown-unknown', '--release', '--locked'], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  env: rustc ? { ...process.env, RUSTC: rustc } : process.env,
})
if (result.status !== 0) throw new Error(`cargo build failed with status ${result.status ?? 'unknown'}`)
if (!existsSync(source)) throw new Error(`cargo did not emit the expected wasm artifact: ${source}`)

mkdirSync(dirname(destination), { recursive: true })
copyFileSync(source, destination)
chmodSync(destination, 0o644)
const bytes = readFileSync(destination)
console.log(JSON.stringify({ artifact: destination, bytes: statSync(destination).size, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2))
