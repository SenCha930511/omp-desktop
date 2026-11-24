import assert from 'node:assert/strict'
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
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

const sessionName = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f][0-9a-f-]*\.jsonl$/i
function collect(root, output = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) collect(path, output)
    else if (entry.isFile() && (process.env.OMP_WASM_ALL_JSONL === '1' ? entry.name.endsWith('.jsonl') : sessionName.test(entry.name))) output.push(path)
    if (output.length >= 500) return output
  }
  return output
}

const module = await loadModule(`export { createOmpSessionMetadataReader } from './electron/main/sessions/omp.ts'; export { nodeMetadataReaderIo } from './electron/main/sessions/metadata.ts'; export { scanOmpMetadataBytes } from './electron/main/sessions/omp-wasm.ts'`)
const files = collect(join(homedir(), '.omp', 'agent', 'sessions')).slice(0, 500)
const inspect = async (path) => statSync(path)
const openStream = (path, start, end) => createReadStream(path, { start, end })
const baseIo = { inspect, openStream, readPrefix: module.nodeMetadataReaderIo.readPrefix }
const wasmIo = { ...baseIo, readAll: (path) => readFileSync(path) }
const tsReader = module.createOmpSessionMetadataReader(baseIo)
const wasmReader = module.createOmpSessionMetadataReader(wasmIo)

let fastPathOk = 0
let fallback = 0
const mismatches = []
for (const file of files) {
  const [ts, wasm] = await Promise.all([tsReader(file), wasmReader(file)])
  try {
    assert.deepEqual(wasm, ts)
  } catch {
    const keys = Object.keys(ts).filter((key) => JSON.stringify(ts[key]) !== JSON.stringify(wasm[key]))
    mismatches.push({ file: file.slice(file.lastIndexOf('/') + 1), keys })
  }
  const bytes = readFileSync(file)
  const stat = statSync(file)
  const result = await module.scanOmpMetadataBytes(bytes.subarray(Math.min(256, bytes.length)), {
    id: 'fallback',
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
  })
  if (result.status === 'ok') fastPathOk += 1
  else fallback += 1
}

console.log(JSON.stringify({ files: files.length, fastPathOk, fallback, mismatches: mismatches.slice(0, 10), mismatchCount: mismatches.length }, null, 2))
if (mismatches.length > 0) process.exitCode = 1
