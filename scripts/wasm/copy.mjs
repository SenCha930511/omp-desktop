#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = join(repositoryRoot, 'assets', 'wasm', 'omp-jsonl-core.wasm')
const destination = join(repositoryRoot, 'out', 'main', 'omp-jsonl-core.wasm')
if (!existsSync(source)) throw new Error(`Committed wasm artifact is missing: ${source}. Run npm run wasm:build.`)
mkdirSync(dirname(destination), { recursive: true })
copyFileSync(source, destination)
chmodSync(destination, 0o644)
console.log(`Copied ${source} to ${destination} (${statSync(destination).size} bytes)`)
