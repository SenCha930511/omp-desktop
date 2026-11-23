import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
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

function measure(name, iterations, run) {
  const samples = []
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    run(index)
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

function markdownText(index, length = 4_096) {
  const body = `## Step ${index}\n\n**Result** for [turn](https://example.com/${index}) with \`code\` and ~~old~~ text.\n\n- one\n- two\n\n\`\`\`ts\nconst value = ${index}\n\`\`\`\n\n`
  return body.repeat(Math.ceil(length / body.length)).slice(0, length)
}

function trajectoryMessages() {
  const messages = []
  for (let index = 0; index < 200; index += 1) {
    messages.push({ id: `u-${index}`, role: 'user', timestamp: '2026-11-22T01:22:00.000Z', parts: [{ type: 'text', text: `Prompt ${index} ${'x'.repeat(800)}` }] })
    messages.push({ id: `a-${index}`, role: 'assistant', timestamp: '2026-11-22T01:23:00.000Z', parts: [{ type: 'text', text: markdownText(index) }] })
  }
  return messages
}

const results = []
const trajectoryModule = await loadModule(`export { extractTrajectoryTurns } from '@/components/TranscriptTrajectory'`)
const baseMessages = trajectoryMessages()
const trajectoryFrames = Array.from({ length: 500 }, (_, frame) => {
  const next = baseMessages.slice()
  const last = next.at(-1)
  next[next.length - 1] = { ...last, parts: [{ type: 'text', text: `${last.parts[0].text} frame ${frame}` }] }
  return next
})
results.push(measure('trajectory-500-frames', 1, () => {
  for (const frame of trajectoryFrames) assert.equal(trajectoryModule.extractTrajectoryTurns(frame).length, 200)
}))

const searchModule = await loadModule(`export { searchTranscript } from '@/lib/transcript-search'`)
/** @type {Array<{ id: string, role: string, parts: Array<Record<string, unknown>> }>} */
const searchMessages = Array.from({ length: 1_000 }, (_, index) => ({
  id: String(index),
  role: index % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: index === 0 ? 'Older needle' : 'Recent text' }],
}))
searchMessages[999].parts.push({ type: 'toolCall', id: 'call', name: 'bash', args: { command: 'x'.repeat(128 * 1024) } })
results.push(measure('search-1000-messages-200-queries', 200, (index) => {
  searchModule.searchTranscript(searchMessages, index % 2 ? 'needle' : 'recent', 'all')
}))

const syntaxModule = await loadModule(`export { tokenizeSyntax } from '@/components/transcript/syntax'`)
const syntaxText = '{"key":"value","n":123,"ok":true}\n'.repeat(6_000).slice(0, 200_000)
results.push(measure('syntax-200kb-100-scans', 100, () => {
  assert.ok(syntaxModule.tokenizeSyntax(syntaxText).length > 0)
}))

const sidebarModule = await loadModule(`export { recentSidebarSessions } from '@/components/Sidebar'`)
const baseTime = Date.parse('2026-11-22T12:00:00.000Z')
const sidebarSessions = Array.from({ length: 5_000 }, (_, index) => ({
  id: String(index),
  filePath: `/project/${String(index).padStart(5, '0')}.jsonl`,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: new Date(baseTime - index * 60_000).toISOString(),
  pinned: index % 97 === 0,
}))
results.push(measure('sidebar-5000-recent-100', 100, () => {
  assert.equal(sidebarModule.recentSidebarSessions(sidebarSessions).length, 8)
}))

const catalogModule = await loadModule(`export { boundedSessionDiscoveryNames } from './electron/main/sessions/catalog.ts'; export { timestampFromBucketedSessionName } from './electron/main/sessions/bucketed.ts'`)
const catalogNames = Array.from({ length: 5_000 }, (_, index) => {
  const timestamp = new Date(baseTime - index * 60_000).toISOString().replace(/[:.]/g, '-')
  return `${timestamp}_${String(index).padStart(8, '0')}-0000-7000-8000-000000000000.jsonl`
})
results.push(measure('catalog-5000-names-100', 100, () => {
  assert.equal(catalogModule.boundedSessionDiscoveryNames(catalogNames, 500, catalogModule.timestampFromBucketedSessionName).length, 500)
}))
const hudModule = await loadModule(`export { latestTodoPhases } from '@/components/TranscriptHud'`)
const todoText = `Overall: 1/3 done, 2 open.\n\n  phase A:\n    - [X] task1\n    - [ ] task2 (in progress)\n\n  phase B:\n    - [ ] task3\n${'  filler:\n'.repeat(200)}`
const hudMessages = Array.from({ length: 400 }, (_, index) => ({
  id: String(index),
  role: index % 2 ? 'assistant' : 'user',
  parts: index === 0 ? [{ type: 'toolResult', name: 'todo', text: todoText }] : [{ type: 'text', text: `Message ${index}` }],
}))
results.push(measure('hud-400-messages-1000', 1_000, () => {
  assert.ok(hudModule.latestTodoPhases(hudMessages).length > 0)
}))

console.log(JSON.stringify({ node: process.version, results }, null, 2))
