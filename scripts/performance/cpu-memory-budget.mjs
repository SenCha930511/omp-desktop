import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname)
const measuredTrialCount = 7
const rendererUpdateCount = 200
const catalogRefreshCount = 100
const totalStartedAt = performance.now()
const gcAvailable = typeof globalThis.gc === 'function'

function collectGarbage() {
  if (gcAvailable) globalThis.gc()
}

function maxRssKiB() {
  return process.resourceUsage().maxRSS
}

async function loadModule(source) {
  const built = await build({
    stdin: { contents: source, resolveDir: repositoryRoot, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    alias: { '@': resolve(repositoryRoot, 'src') },
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

async function measureCase(name, workload, prepare) {
  const warmup = await prepare()
  await warmup()

  const samples = []
  for (let trial = 1; trial <= measuredTrialCount; trial += 1) {
    const run = await prepare()
    collectGarbage()
    const heapUsedBeforeBytes = gcAvailable ? process.memoryUsage().heapUsed : null
    const cpuStarted = process.cpuUsage()
    const startedAt = performance.now()
    const output = await run()
    const elapsedMs = performance.now() - startedAt
    const cpu = process.cpuUsage(cpuStarted)
    collectGarbage()
    const heapUsedAfterBytes = gcAvailable ? process.memoryUsage().heapUsed : null
    const retainedHeapBytes = gcAvailable ? heapUsedAfterBytes - heapUsedBeforeBytes : null
    const currentMaxRssKiB = maxRssKiB()
    samples.push({
      trial,
      cpuUserMs: cpu.user / 1_000,
      cpuSystemMs: cpu.system / 1_000,
      cpuMs: (cpu.user + cpu.system) / 1_000,
      elapsedMs,
      heapUsedBeforeBytes,
      heapUsedAfterBytes,
      retainedHeapBytes,
      maxRssKiB: currentMaxRssKiB,
      maxRssDeltaKiB: currentMaxRssKiB - baselineMaxRssKiB,
      output,
    })
  }

  return {
    name,
    workload,
    measuredTrials: measuredTrialCount,
    warmupTrials: 1,
    median: {
      cpuMs: median(samples.map((sample) => sample.cpuMs)),
      elapsedMs: median(samples.map((sample) => sample.elapsedMs)),
      retainedHeapBytes: gcAvailable ? median(samples.map((sample) => sample.retainedHeapBytes)) : null,
    },
    samples,
  }
}

function rendererMessages(messageCount) {
  const messages = []
  const turnCount = (messageCount - 2) / 2
  const startedAt = Date.parse('2026-11-24T00:00:00.000Z')
  for (let turn = 0; turn < turnCount; turn += 1) {
    messages.push({
      id: `user-${turn}`,
      role: 'user',
      timestamp: new Date(startedAt + turn * 2_000).toISOString(),
      parts: [{ type: 'text', text: `Prompt ${turn}: inspect the retained transcript prefix and report the result.` }],
    })
    /** @type {Array<import('../../src/types/api').MessagePart>} */
    const parts = [{ type: 'text', text: `Answer ${turn} with **markdown**, a [link](https://example.com/${turn}), and retained history.` }]
    if (turn % 10 === 0) parts.push({ type: 'toolCall', id: `tool-${turn}`, name: 'Read', args: { path: `/tmp/artifact-${turn}.txt` } })
    messages.push({
      id: `assistant-${turn}`,
      role: 'assistant',
      timestamp: new Date(startedAt + turn * 2_000 + 1_000).toISOString(),
      parts,
    })
  }
  messages.push({
    id: 'assistant-final-context',
    role: 'assistant',
    timestamp: new Date(startedAt + turnCount * 2_000).toISOString(),
    parts: [
      {
        type: 'toolResult',
        name: 'todo',
        text: 'Overall: 1/3 done, 2 open.\n\n  phase A:\n    - [X] measure baseline\n    - [ ] inspect samples (in progress)\n\n  phase B:\n    - [ ] compare workloads',
      },
      { type: 'text', text: 'Task state retained beside the streaming response.' },
    ],
  })
  return messages
}

function createRendererFixture(modules, messageCount) {
  assert.ok(messageCount >= 6 && messageCount % 2 === 0)
  const prefix = rendererMessages(messageCount)
  assert.equal(prefix.length, messageCount - 1)
  const frames = Array.from({ length: rendererUpdateCount }, (_, update) => [
    ...prefix,
    {
      id: 'assistant-streaming-tail',
      role: 'assistant',
      timestamp: prefix.at(-1).timestamp,
      startedAt: prefix.at(-1).timestamp,
      streaming: true,
      parts: [{ type: 'text', text: `Streaming update ${update}: ${'current answer '.repeat(12)}` }],
    },
  ])
  for (const frame of frames) {
    assert.equal(frame.length, messageCount)
    for (let index = 0; index < prefix.length; index += 1) assert.equal(frame[index], prefix[index])
  }
  const directSummaries = frames.map((frame) => {
    const summary = modules.createTranscriptStore(frame).getSummary()
    assert.equal(summary.count, messageCount)
    return summary
  })
  return { frames, directSummaries }
}

function prepareRendererRun(modules, fixture, messageCount) {
  const coalesce = modules.createAssistantTurnCoalescer()
  const store = modules.createTranscriptStore([])
  let previousTurns = []
  return () => {
    let finalCoalesced = []
    let finalTodoPhases = []
    for (let update = 0; update < rendererUpdateCount; update += 1) {
      const messages = fixture.frames[update]
      finalCoalesced = coalesce(messages)
      assert.equal(finalCoalesced.length, messageCount - 2)
      assert.ok(finalCoalesced.length > 0)
      previousTurns = modules.extractTrajectoryTurns(messages, previousTurns)
      assert.equal(previousTurns.length, (messageCount - 2) / 2)
      assert.ok(previousTurns.length > 0)
      finalTodoPhases = modules.latestTodoPhases(messages)
      assert.equal(finalTodoPhases.length, 2)
      store.update(messages)
      assert.equal(store.getSnapshot(), messages)
      assert.deepEqual(store.getSummary(), fixture.directSummaries[update])
    }
    return {
      retainedMessages: messageCount,
      coalescedMessages: finalCoalesced.length,
      trajectoryTurns: previousTurns.length,
      todoPhases: finalTodoPhases.length,
      summaryFramesExactlyMatched: rendererUpdateCount,
      summaryFieldsCompared: Object.keys(store.getSummary()),
      finalSummary: store.getSummary(),
    }
  }
}

function fakeStat(directory, ino, mtimeMs = 0, size = 0) {
  return {
    dev: 1,
    ino,
    size,
    mtimeMs,
    ctimeMs: mtimeMs,
    mode: directory ? 0o40755 : 0o100644,
    isFile: () => !directory,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  }
}

function createCatalogFixture(sessionCount) {
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'omp-cpu-memory-')))
  const sessionRoot = join(temporaryRoot, 'sessions')
  const projectPath = join(temporaryRoot, 'project')
  mkdirSync(sessionRoot)
  mkdirSync(projectPath)
  const baseTime = Date.parse('2026-11-24T00:00:00.000Z')
  const metadata = Array.from({ length: sessionCount }, (_, index) => {
    const filePath = join(sessionRoot, `${String(index).padStart(5, '0')}.jsonl`)
    const timestamp = new Date(baseTime - index * 1_000).toISOString()
    return {
      id: `session-${index}`,
      filePath,
      projectPath,
      title: `Session ${index}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastUserMessageAt: timestamp,
      status: 'idle',
      model: 'benchmark-model',
      provider: 'benchmark-provider',
      thinkingLevel: 'medium',
      depth: index % 3,
      preview: `Retained preview ${index}`,
      unread: index % 17 === 0,
      lastUserTexts: [`Prompt ${index}`, `Follow-up ${index}`],
    }
  })
  const metadataByPath = new Map(metadata.map((entry) => [entry.filePath, entry]))
  const statsByPath = new Map([[sessionRoot, fakeStat(true, 0)]])
  for (const [index, entry] of metadata.entries()) {
    statsByPath.set(entry.filePath, fakeStat(false, index + 1, baseTime - index * 1_000, 1_024 + index))
  }
  const directoryEntries = metadata.map((entry) => ({
    name: entry.filePath.slice(sessionRoot.length + 1),
    isFile: () => true,
    isSymbolicLink: () => false,
  }))
  const directRecords = new Map(metadata.map((entry) => [entry.filePath, { ...entry, harness: 'omp', archived: false, pinned: false }]))
  const catalogIo = {
    readDirectory: async (path) => {
      assert.equal(resolve(path), sessionRoot)
      return directoryEntries
    },
    canonicalize: async (path) => resolve(path),
    inspect: async (path) => {
      const stat = statsByPath.get(resolve(path))
      if (!stat) throw new Error(`Unexpected fake stat path: ${path}`)
      return stat
    },
  }
  return { temporaryRoot, sessionRoot, metadataByPath, directRecords, catalogIo }
}

function prepareCatalogRun(SessionService, fixture, sessionCount) {
  const store = {
    getArchivedSessions: () => [],
    getPinnedSessions: () => [],
  }
  const service = new SessionService(store, null, sessionCount, {
    sessionRoot: fixture.sessionRoot,
    catalogIo: fixture.catalogIo,
    metadataReader: async (filePath) => {
      const metadata = fixture.metadataByPath.get(filePath)
      if (!metadata) throw new Error(`Unexpected metadata path: ${filePath}`)
      return { ...metadata, lastUserTexts: [...metadata.lastUserTexts] }
    },
  })
  return async () => {
    let revision
    let records = []
    let snapshots = 0
    let deltas = 0
    for (let refresh = 0; refresh < catalogRefreshCount; refresh += 1) {
      const previousRevision = revision
      const update = await service.sync(revision)
      assert.ok(Object.keys(update).length > 0)
      revision = update.revision
      if (refresh === 0) {
        assert.equal(update.kind, 'snapshot')
        assert.equal(update.records.length, sessionCount)
        records = update.records
        assert.deepEqual(new Map(records.map((record) => [record.filePath, record])), fixture.directRecords)
        snapshots += 1
      } else {
        assert.equal(update.kind, 'delta')
        assert.equal(update.baseRevision, previousRevision)
        assert.equal(update.revision, previousRevision)
        assert.equal(update.upserts.length, 0)
        assert.equal(update.removals.length, 0)
        deltas += 1
      }
    }
    assert.equal(records.length, sessionCount)
    assert.ok(records.length > 0)
    return {
      sessionRecords: records.length,
      snapshots,
      emptyDeltas: deltas,
      finalRevision: revision,
      refreshes: catalogRefreshCount,
    }
  }
}

const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output')) {
  throw new Error('Usage: node --expose-gc scripts/performance/cpu-memory-budget.mjs [--output <path>]')
}

const [rendererModules, catalogModule] = await Promise.all([
  loadModule(`
    export { createAssistantTurnCoalescer } from '@/lib/assistant-turns'
    export { extractTrajectoryTurns } from '@/components/TranscriptTrajectory'
    export { latestTodoPhases } from '@/lib/todo'
    export { createTranscriptStore } from '@/app/transcript-store'
  `),
  loadModule("export { SessionService } from './electron/main/sessions.ts'"),
])

collectGarbage()
const baselineMaxRssKiB = maxRssKiB()
const baselineHeapUsedBytes = gcAvailable ? process.memoryUsage().heapUsed : null
const cases = []
for (const messageCount of [5_000, 100]) {
  const fixture = createRendererFixture(rendererModules, messageCount)
  cases.push(await measureCase(
    `renderer-${messageCount}-messages`,
    {
      retainedMessages: messageCount,
      identityStablePrefixMessages: messageCount - 1,
      streamingTailUpdatesPerTrial: rendererUpdateCount,
      directSummarySource: 'fresh-createTranscriptStore-scan-per-frame',
      summaryFieldsExactlyComparedPerFrame: Object.keys(fixture.directSummaries[0]),
    },
    async () => prepareRendererRun(rendererModules, fixture, messageCount),
  ))
}
for (const sessionCount of [5_000, 100]) {
  const fixture = createCatalogFixture(sessionCount)
  try {
    cases.push(await measureCase(
      `catalog-${sessionCount}-sessions`,
      {
        sessionMetadataEntries: sessionCount,
        syncRefreshesPerTrial: catalogRefreshCount,
        expectedSnapshotsPerTrial: 1,
        expectedEmptyDeltasPerTrial: catalogRefreshCount - 1,
        fakeIo: true,
        externalServices: false,
      },
      async () => prepareCatalogRun(catalogModule.SessionService, fixture, sessionCount),
    ))
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true })
  }
}

const report = {
  schemaVersion: 1,
  scope: 'focused-headless-cpu-and-memory-workloads',
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  gcAvailable,
  units: { cpu: 'milliseconds', elapsed: 'milliseconds', heap: 'bytes', maxRss: 'KiB' },
  maxRssSemantics: 'process-high-water-mark',
  baseline: {
    maxRssKiB: baselineMaxRssKiB,
    heapUsedBytes: baselineHeapUsedBytes,
  },
  totalDurationMs: performance.now() - totalStartedAt,
  cases,
}
const json = `${JSON.stringify(report, null, 2)}\n`
if (args.length === 2) await writeFile(resolve(args[1]), json, 'utf8')
else process.stdout.write(json)
