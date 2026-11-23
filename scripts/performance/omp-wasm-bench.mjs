import assert from 'node:assert/strict'
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname)
const alias = { '@': resolve(repositoryRoot, 'src') }
const wasmPath = resolve(repositoryRoot, 'assets/wasm/omp-jsonl-core.wasm')
process.env.OMP_DESKTOP_WASM_PATH = wasmPath
delete process.env.OMP_DESKTOP_DISABLE_WASM

async function loadModule(source) {
  const built = await build({
    stdin: { contents: source, resolveDir: repositoryRoot, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    alias,
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
}

function titleSlot(title) {
  const base = JSON.stringify({ type: 'title', title, pad: '' })
  return JSON.stringify({ type: 'title', title, pad: ' '.repeat(255 - Buffer.byteLength(base)) })
}

function writeLargeFixture(file, messages) {
  const lines = [titleSlot('Large session')]
  lines.push(JSON.stringify({ type: 'session', version: 3, id: 'large', cwd: '/large', timestamp: '2026-01-01T00:00:00.000Z' }))
  for (let message = 0; message < messages; message += 1) {
    const role = message % 2 ? 'assistant' : 'user'
    const text = role === 'user' ? `User ${message} ${'x'.repeat(900)}` : `Assistant ${message} ${'類別間'.repeat(180)}`
    lines.push(JSON.stringify({ type: 'message', timestamp: new Date(Date.parse('2026-01-01T00:00:00.000Z') + message * 1_000).toISOString(), message: { role, content: text, ...(role === 'assistant' ? { stopReason: 'end' } : {}) } }))
  }
  writeFileSync(file, `${lines.join('\n')}\n`)
}

function writeFixture(file, index) {
  const lines = [titleSlot(`Session ${index}`)]
  lines.push(JSON.stringify({ type: 'session', version: 3, id: `session-${index}`, cwd: `/project/${index % 10}`, timestamp: '2026-01-01T00:00:00.000Z', previousSessionFiles: ['/old/path'] }))
  lines.push(JSON.stringify({ type: 'model_change', model: 'openai/gpt-5', role: 'default' }))
  lines.push(JSON.stringify({ type: 'thinking_level_change', thinkingLevel: index % 2 ? 'high' : 'auto' }))
  lines.push(JSON.stringify({ type: 'title_change', title: `Renamed ${index}` }))
  for (let message = 0; message < 40; message += 1) {
    const role = message % 2 ? 'assistant' : 'user'
    const text = role === 'user' ? `User ${index}/${message} ${'x'.repeat(400)}` : `Assistant ${index}/${message} ${'類別間'.repeat(80)}`
    lines.push(JSON.stringify({ type: 'message', timestamp: new Date(Date.parse('2026-01-01T00:00:00.000Z') + message * 1_000).toISOString(), message: { role, content: text, ...(role === 'assistant' ? { stopReason: 'end' } : {}) } }))
  }
  writeFileSync(file, `${lines.join('\n')}\n`)
}

const module = await loadModule(`export { createOmpSessionMetadataReader } from './electron/main/sessions/omp.ts'; export { nodeMetadataReaderIo } from './electron/main/sessions/metadata.ts'`)
const directory = mkdtempSync(join(tmpdir(), 'omp-desktop-wasm-bench-'))
const fileCount = 1_000
const files = []
for (let index = 0; index < fileCount; index += 1) {
  const file = join(directory, `2026-01-01T00-00-00-000Z_session-${String(index).padStart(5, '0')}.jsonl`)
  writeFixture(file, index)
  files.push(file)
}

const inspect = async (path) => statSync(path)
const openStream = (path, start, end) => createReadStream(path, { start, end })
const tsIo = { inspect, openStream, readPrefix: module.nodeMetadataReaderIo.readPrefix }
const wasmIo = { ...tsIo, readAll: (path) => readFileSync(path) }

async function readAll(io) {
  const reader = module.createOmpSessionMetadataReader(io)
  const metadata = []
  for (const file of files) metadata.push(await reader(file))
  return metadata
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

try {
  const expected = await readAll(tsIo)
  const wasmMetadata = await readAll(wasmIo)
  assert.deepEqual(wasmMetadata, expected, 'WASM metadata differs from the TS reader')

  const tsSamples = []
  const wasmSamples = []
  for (let pass = 0; pass < 3; pass += 1) {
    const tsStart = performance.now()
    await readAll(tsIo)
    tsSamples.push(performance.now() - tsStart)
    const wasmStart = performance.now()
    await readAll(wasmIo)
    wasmSamples.push(performance.now() - wasmStart)
  }
  const tsMedianMs = median(tsSamples)
  const wasmMedianMs = median(wasmSamples)
  const largeFile = join(directory, '2026-01-01T00-00-00-000Z_large.jsonl')
  writeLargeFixture(largeFile, 20_000)
  const readOne = async (io) => {
    const reader = module.createOmpSessionMetadataReader(io)
    return reader(largeFile)
  }
  assert.deepEqual(await readOne(wasmIo), await readOne(tsIo), 'WASM large-file metadata differs from the TS reader')
  const largeTsSamples = []
  const largeWasmSamples = []
  for (let pass = 0; pass < 3; pass += 1) {
    const tsStart = performance.now()
    await readOne(tsIo)
    largeTsSamples.push(performance.now() - tsStart)
    const wasmStart = performance.now()
    await readOne(wasmIo)
    largeWasmSamples.push(performance.now() - wasmStart)
  }
  const largeTsMedianMs = median(largeTsSamples)
  const largeWasmMedianMs = median(largeWasmSamples)
  console.log(JSON.stringify({
    files: fileCount,
    equivalent: true,
    tsMedianMs: Number(tsMedianMs.toFixed(2)),
    wasmMedianMs: Number(wasmMedianMs.toFixed(2)),
    speedup: Number((tsMedianMs / wasmMedianMs).toFixed(2)),
    largeFileBytes: statSync(largeFile).size,
    largeTsMedianMs: Number(largeTsMedianMs.toFixed(2)),
    largeWasmMedianMs: Number(largeWasmMedianMs.toFixed(2)),
    largeSpeedup: Number((largeTsMedianMs / largeWasmMedianMs).toFixed(2)),
  }, null, 2))
} finally {
  rmSync(directory, { recursive: true, force: true })
}
