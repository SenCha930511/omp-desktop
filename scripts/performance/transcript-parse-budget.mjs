import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname)
const alias = { '@': resolve(repositoryRoot, 'src') }

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

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

async function measure(name, iterations, run) {
  const samples = []
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    await run(index)
    samples.push(performance.now() - started)
  }
  return {
    name,
    iterations,
    medianMs: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    totalMs: Number(samples.reduce((total, sample) => total + sample, 0).toFixed(3)),
  }
}

function sessionFixture({ calls, textBytes }) {
  const lines = []
  let previous = null
  let sequence = 0
  const nextId = () => `e${String(sequence++).padStart(6, '0')}`
  const push = (entry) => {
    const id = entry.id ?? nextId()
    lines.push(JSON.stringify({ ...entry, id, parentId: previous }))
    previous = id
  }
  push({ type: 'session', version: 3, cwd: '/tmp', timestamp: '2026-11-22T12:00:00.000Z' })
  const callsPerRecord = 10
  for (let offset = 0; offset < calls; offset += callsPerRecord) {
    const content = [{ type: 'text', text: `Turn ${offset}` }]
    for (let index = offset; index < Math.min(calls, offset + callsPerRecord); index += 1) {
      content.push({ type: 'toolCall', id: `call-${index}`, name: 'bash', arguments: { command: `echo ${index} ${'a'.repeat(Math.max(0, textBytes - 16))}` } })
    }
    push({ type: 'message', timestamp: '2026-11-22T12:00:01.000Z', message: { role: 'assistant', content } })
  }
  for (let index = 0; index < calls; index += 1) {
    push({
      type: 'message',
      timestamp: '2026-11-22T12:00:02.000Z',
      message: { role: 'tool', toolCallId: `call-${index}`, toolName: 'bash', content: [{ type: 'text', text: `result ${index} ${'b'.repeat(Math.max(0, textBytes - 16))}` }] },
    })
  }
  return `${lines.join('\n')}\n`
}

const module = await loadModule(`export { createBranchSummaryTranscriptReader } from './electron/main/sessions/bucketed.ts'`)
const directory = mkdtempSync(join(tmpdir(), 'omp-desktop-perf-transcript-'))
const results = []
try {
  for (const fixture of [
    { name: 'transcript-2000-tool-results', calls: 2_000, textBytes: 1_024, iterations: 3 },
    { name: 'transcript-50mb-cold-open', calls: 1_000, textBytes: 25_600, iterations: 1 },
  ]) {
    const filePath = join(directory, `${fixture.name}.jsonl`)
    writeFileSync(filePath, sessionFixture(fixture))
    results.push(await measure(fixture.name, fixture.iterations, async () => {
      const reader = module.createBranchSummaryTranscriptReader()
      await reader(filePath, false)
    }))
  }
  for (const result of results) assert.ok(result.totalMs > 0)
  console.log(JSON.stringify({ node: process.version, results }, null, 2))
} finally {
  rmSync(directory, { recursive: true, force: true })
}
