import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as waitForTimeout } from 'node:timers/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { _electron as electron } from '@playwright/test'
import { build } from 'esbuild'

const repositoryRoot = process.cwd()
const bundleEntry = join(repositoryRoot, 'out/main/index.js')
const args = process.argv.slice(2)
let math = false
let eager = false
let outputPath
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--math' && !math) {
    math = true
  } else if (args[index] === '--eager' && !eager) {
    eager = true
  } else if (args[index] === '--output' && outputPath === undefined && args[index + 1]) {
    outputPath = args[index + 1]
    index += 1
  } else {
    throw new Error('Usage: node scripts/performance/electron-resource-budget.mjs [--math] [--eager] [--output <path>]')
  }
}
assert.ok(existsSync(bundleEntry), `Missing ${bundleEntry}; run npm run build:bundle in the working directory first`)

const streamFrameCount = 120
const streamIntervalMs = 50
const idleSampleMs = 8_000
const startupSettleMs = 2_000
const sessionSwitchCount = 8
const actionTimeoutMs = 20_000
const prompt = math ? '__omp_resource_budget_math__' : '__omp_resource_budget_text__'
const finalReply = math
  ? 'Resource budget math final reply: $x^2 + y^2 = z^2$.'
  : 'Resource budget text final reply.'
const replyNeedle = math ? 'Resource budget math final reply:' : finalReply

function requireUnique(source, needle, label) {
  const index = source.indexOf(needle)
  assert.notEqual(index, -1, `${label} is missing; the hermetic fixture may have changed`)
  assert.equal(source.indexOf(needle, index + 1), -1, `${label} is ambiguous; refusing to instrument the fixture`)
  return index
}

function replaceUnique(source, needle, replacement, label) {
  requireUnique(source, needle, label)
  return source.replace(needle, replacement)
}

async function loadHermeticFixture() {
  const fixturePath = join(repositoryRoot, 'tests/e2e/app.spec.ts')
  const fixtureSource = readFileSync(fixturePath, 'utf8')
  const playwrightImport = "import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'\n"
  requireUnique(fixtureSource, playwrightImport, 'Playwright import')
  const describeNeedle = "test.describe('OMP Desktop desktop smoke'"
  const describeIndex = requireUnique(fixtureSource, describeNeedle, 'Hermetic helper boundary')
  const helperSource = fixtureSource.slice(0, describeIndex).replace(playwrightImport, '')
  const contents = `${helperSource}\nexport { closeHermeticApp, createHermeticFixture, hermeticEnvironment }\nexport function electronResourceBudgetFixtureRoot() { return fixtureRoot }\n`
  const built = await build({
    stdin: { contents, resolveDir: dirname(fixturePath), loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    write: false,
    logLevel: 'silent',
  })
  assert.equal(built.outputFiles.length, 1, 'Fixture helper extraction did not produce exactly one module')
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
  return import(moduleUrl)
}

function instrumentFixture(executable) {
  let source = readFileSync(executable, 'utf8')
  const lineReaderNeedle = '  const command = JSON.parse(line)\n'
  source = replaceUnique(source, lineReaderNeedle, `${lineReaderNeedle}  fs.appendFileSync(marker('rpc-census.log'), String(command.type ?? '<missing>') + '\\n')\n`, 'JSON-RPC line reader')
  const regularTurnNeedle = '    // The adoption-probe flow ends with an authoritative disk reconciliation,\n'
  const streamBranch = `    if (message === ${JSON.stringify(prompt)}) {
      streaming = true
      send({ type: 'agent_start' })
      send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
      let frame = 0
      const timer = setInterval(() => {
        frame += 1
        const toolCallId = 'resource-budget-tool-' + frame
        send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Stream payload ' + frame + ' ' } })
        send({ type: 'tool_execution_start', toolCallId, toolName: 'bash', args: { command: 'resource-budget', frame } })
        send({ type: 'tool_execution_end', toolCallId, toolName: 'bash', result: { content: [{ type: 'text', text: 'resource result ' + frame }] } })
        if (frame !== ${streamFrameCount}) return
        clearInterval(timer)
        streaming = false
        const completedAt = new Date().toISOString()
        fs.appendFileSync(sessionFile, [
          JSON.stringify({ type: 'message', id: 'resource-budget-user', parentId: lastEntryId(), timestamp: completedAt, message: { role: 'user', content: message } }),
          JSON.stringify({ type: 'message', id: 'resource-budget-assistant', parentId: 'resource-budget-user', timestamp: completedAt, message: { role: 'assistant', content: ${JSON.stringify(finalReply)} } }),
        ].join('\\n') + '\\n')
        send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ${JSON.stringify(finalReply)} } })
        send({ type: 'agent_end' })
      }, ${streamIntervalMs})
      return
    }
`
  source = replaceUnique(source, regularTurnNeedle, `${streamBranch}${regularTurnNeedle}`, 'Regular prompt branch')
  writeFileSync(executable, source, 'utf8')
}

function assertFixtureRoot(candidate) {
  assert.ok(candidate, 'The fixture did not expose its temporary root')
  const lexicalRoot = resolve(candidate)
  assert.equal(dirname(lexicalRoot), resolve(tmpdir()), 'Fixture root is not directly inside the system temp directory')
  assert.ok(basename(lexicalRoot).startsWith('omp-desktop-e2e-'), 'Fixture root does not have the generator prefix')
  const canonicalRoot = realpathSync(lexicalRoot)
  assert.equal(dirname(canonicalRoot), realpathSync(tmpdir()), 'Canonical fixture root escaped the system temp directory')
  assert.ok(basename(canonicalRoot).startsWith('omp-desktop-e2e-'), 'Canonical fixture root does not have the generator prefix')
  const info = lstatSync(canonicalRoot)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Fixture root is not a real temporary directory')
  return canonicalRoot
}

function cleanFixtureRoot(candidate) {
  if (!candidate || !existsSync(candidate)) return
  rmSync(assertFixtureRoot(candidate), { recursive: true, force: true })
}


async function electronSnapshot(target) {
  return target.evaluate(({ app }) => ({
    mainProcessMemoryBytes: process.memoryUsage(),
    processes: app.getAppMetrics().map((item) => ({
      pid: item.pid,
      creationTime: item.creationTime,
      type: item.type,
      name: item.name ?? null,
      serviceName: item.serviceName ?? null,
      cpu: {
        percentCPUUsage: item.cpu?.percentCPUUsage ?? null,
        cumulativeCPUUsage: item.cpu?.cumulativeCPUUsage ?? null,
        idleWakeupsPerSecond: item.cpu?.idleWakeupsPerSecond ?? null,
      },
      nativeMemoryKiB: {
        workingSet: item.memory?.workingSetSize ?? null,
        peakWorkingSet: item.memory?.peakWorkingSetSize ?? null,
      },
    })),
  }))
}

function parsePsTime(value) {
  const daySplit = value.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/)
  if (!daySplit) return null
  const days = Number(daySplit[1] ?? 0)
  const hours = Number(daySplit[2] ?? 0)
  const minutes = Number(daySplit[3])
  const seconds = Number(daySplit[4])
  return daySplit[2] === undefined
    ? minutes * 60 + seconds
    : days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

function ompProcessSnapshot(root) {
  const markerPath = join(root, 'omp-runtime.pid')
  if (!existsSync(markerPath)) {
    return { status: 'missing-pid-marker', pid: null, metrics: null, note: 'Native fake-agent OMP process metrics are unavailable until the fixture writes omp-runtime.pid.' }
  }
  const pid = Number(readFileSync(markerPath, 'utf8').trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: 'invalid-pid-marker', pid: null, metrics: null, note: 'The fake-agent OMP pid marker was not a positive integer.' }
  }
  if (process.platform === 'win32') {
    return { status: 'unsupported-platform', pid, metrics: null, note: 'This verifier samples an external OMP pid with POSIX ps; Electron process metrics remain available.' }
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'time=,rss='], { encoding: 'utf8' })
  const match = result.status === 0 ? result.stdout.trim().match(/^(\S+)\s+(\d+)$/) : null
  if (!match) {
    return { status: 'process-metrics-unavailable', pid, metrics: null, note: 'The marked fake-agent process exited or ps could not read its metrics.' }
  }
  return {
    status: 'available',
    pid,
    metrics: {
      cumulativeCpuTimeSeconds: parsePsTime(match[1]),
      cumulativeCpuTimeRaw: match[1],
      residentSetKiB: Number(match[2]),
    },
    note: 'POSIX ps metrics describe the injected fake-agent Node process, not a production OMP installation. CPU time is cumulative, not percentCPUUsage.',
  }
}

function cpuTimeDeltas(beforeElectron, afterElectron) {
  const beforeByPid = new Map(beforeElectron.processes.map((entry) => [entry.pid, entry]))
  const measured = []
  const unavailable = []
  for (const current of afterElectron.processes) {
    const previous = beforeByPid.get(current.pid)
    const identity = { pid: current.pid, creationTime: current.creationTime, type: current.type }
    if (!previous || previous.creationTime !== current.creationTime) {
      unavailable.push({ ...identity, reason: 'new-or-replaced-process' })
      continue
    }
    const previousSeconds = previous.cpu.cumulativeCPUUsage
    const currentSeconds = current.cpu.cumulativeCPUUsage
    if (typeof previousSeconds !== 'number' || typeof currentSeconds !== 'number' || currentSeconds < previousSeconds) {
      unavailable.push({ ...identity, reason: 'incomplete-or-decreasing-cumulative-cpu' })
      continue
    }
    measured.push({ ...identity, seconds: currentSeconds - previousSeconds })
  }
  return { measured, unavailable }
}

async function sampleWindow(target, root, name, action) {
  const beforeElectron = await electronSnapshot(target)
  const beforeOmp = ompProcessSnapshot(root)
  const startedAt = performance.now()
  await action()
  const durationMs = performance.now() - startedAt
  const afterElectron = await electronSnapshot(target)
  const afterOmp = ompProcessSnapshot(root)
  return {
    name,
    durationMs,
    electron: { before: beforeElectron, after: afterElectron },
    fakeAgentOmpProcess: { before: beforeOmp, after: afterOmp },
    cpuTimeDeltaSeconds: cpuTimeDeltas(beforeElectron, afterElectron),
    cpuSemantics: 'percentCPUUsage and idleWakeupsPerSecond are averages since the previous getAppMetrics call. cumulativeCPUUsage measures seconds since process startup. Deltas use matching pid and creationTime only and are never summed across windows.',
  }
}

async function resourcesSnapshot(page, networkRequests, executedScriptUrls) {
  return page.evaluate(() => ({
    performanceResources: performance.getEntriesByType('resource').filter((entry) => entry instanceof PerformanceResourceTiming).map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      durationMs: entry.duration,
      transferSizeBytes: entry.transferSize,
      decodedBodySizeBytes: entry.decodedBodySize,
    })),
    stylesheetHrefs: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).filter((element) => element instanceof HTMLLinkElement).map((link) => link.href),
  })).then(({ performanceResources, stylesheetHrefs }) => ({ networkRequests, performanceResources, stylesheetHrefs })).then(({ networkRequests, performanceResources, stylesheetHrefs }) => {
    const resources = networkRequests.map((request) => ({
      name: request.url,
      initiatorType: request.type.toLowerCase(),
      source: 'cdp-network',
    }))
    const katexJavaScript = resources.filter((entry) => /\bkatex[^/?#]*\.js(?:[?#]|$)/i.test(entry.name) && entry.initiatorType !== 'css')
    for (const url of executedScriptUrls) {
      if (/\bkatex[^/?#]*\.js(?:[?#]|$)/i.test(url) && !katexJavaScript.some((entry) => entry.name === url)) katexJavaScript.push({ name: url, initiatorType: 'script', source: 'cdp-script-parsed' })
    }
    const katexStyleSheets = resources.filter((entry) => /(?:katex\.min|katex-vendor)[^/?#]*\.css(?:[?#]|$)/i.test(entry.name) || (/\bkatex/i.test(entry.name) && entry.initiatorType === 'css' && /\.css(?:[?#]|$)/i.test(entry.name)))
    for (const href of stylesheetHrefs) if (/(?:katex\.min|katex-vendor)[^/?#]*\.css(?:[?#]|$)/i.test(href) && !katexStyleSheets.some((entry) => entry.name === href)) katexStyleSheets.push({ name: href, initiatorType: 'css', source: 'stylesheet-link' })
    const katexFonts = resources.filter((entry) => /(?:^|\/)KaTeX_[^/?#]+\.(?:woff2?|ttf)(?:[?#]|$)/i.test(entry.name))
    return { resources, katexJavaScript, katexStyleSheets, katexFonts, performanceResources, stylesheetHrefs, executedScriptUrls, observedNetworkRequestCount: networkRequests.length }
  })
}

function replyLocator(page) {
  return page.locator('.prose').filter({ hasText: replyNeedle })
}

function chromiumPerformanceUnit(name) {
  if (name === 'JSHeapUsedSize' || name === 'JSHeapTotalSize') return 'bytes'
  if (/(?:Duration|Time)$/.test(name)) return 'seconds'
  if (name === 'Timestamp' || name === 'NavigationStart' || name === 'DomContentLoaded' || name === 'FirstMeaningfulPaint') return 'seconds on the Chromium Performance metric timeline'
  return 'count'
}

async function rendererMemorySnapshot(cdp, target, page, name) {
  await cdp.send('HeapProfiler.collectGarbage')
  const [metrics, dom, electronState] = await Promise.all([
    cdp.send('Performance.getMetrics'),
    cdp.send('Memory.getDOMCounters'),
    electronSnapshot(target),
  ])
  return {
    name,
    forcedGarbageCollection: true,
    rendererPerformance: metrics.metrics,
    rendererPerformanceUnits: Object.fromEntries(metrics.metrics.map((entry) => [entry.name, chromiumPerformanceUnit(entry.name)])),
    domCounters: dom,
    domCounterUnits: { documents: 'documents', nodes: 'nodes', jsEventListeners: 'listeners' },
    katexElementCount: await page.locator('.katex').count(),
    mainProcessMemoryBytes: electronState.mainProcessMemoryBytes,
    appProcesses: electronState.processes,
  }
}

function selectSession(page, title) {
  return page.locator('.project-group .session-row-wrap').filter({ hasText: title }).locator('.session-row')
}

const fixtureHelpers = await loadHermeticFixture()
const { closeHermeticApp, createHermeticFixture, electronResourceBudgetFixtureRoot, hermeticEnvironment } = fixtureHelpers
let app
let fixture
let report
const pageErrors = []
try {
  fixture = createHermeticFixture()
  const fixtureRoot = assertFixtureRoot(electronResourceBudgetFixtureRoot())
  assert.equal(realpathSync(dirname(fixture.ompExecutable)), fixtureRoot, 'Returned OMP executable is outside the guarded fixture root')
  instrumentFixture(fixture.ompExecutable)
  app = await electron.launch({
    args: ['.', `--user-data-dir=${fixture.userData}`],
    cwd: repositoryRoot,
    env: hermeticEnvironment(fixture.home, fixture.ompExecutable, fixture.cuaExecutable),
    timeout: 20_000,
  })
  const page = await app.firstWindow({ timeout: 15_000 })
  page.setDefaultTimeout(actionTimeoutMs)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const networkRequests = []
  const executedScriptUrls = []
  const cdp = await page.context().newCDPSession(page)
  cdp.on('Debugger.scriptParsed', (event) => {
    if (event.url) executedScriptUrls.push(event.url)
  })
  await cdp.send('Debugger.enable')
  cdp.on('Network.requestWillBeSent', (event) => {
    networkRequests.push({ url: event.request.url, type: event.type ?? 'other', requestId: event.requestId })
  })
  await cdp.send('Network.enable')
  await page.locator('.app-shell[data-ready="true"]').waitFor({ timeout: actionTimeoutMs })
  await page.evaluate(() => performance.setResourceTimingBufferSize(5_000))
  await waitForTimeout(startupSettleMs)
  const initialResourceSnapshot = await resourcesSnapshot(page, networkRequests, executedScriptUrls)
  assert.ok(initialResourceSnapshot.observedNetworkRequestCount > 0, 'The network observer did not see any renderer requests and cannot establish a no-KaTeX baseline')
  assert.ok(initialResourceSnapshot.executedScriptUrls.length > 0, 'The debugger observer did not see any renderer script execution')
  if (!eager) {
    assert.equal(initialResourceSnapshot.katexJavaScript.length, 0, 'KaTeX JavaScript loaded before a math prompt was rendered')
    assert.equal(initialResourceSnapshot.katexStyleSheets.length, 0, 'KaTeX CSS loaded before a math prompt was rendered')
    assert.equal(initialResourceSnapshot.katexFonts.length, 0, 'A KaTeX font loaded before a math prompt was rendered')
  }
  const initialKatexElementCount = await page.locator('.katex').count()
  assert.equal(initialKatexElementCount, 0, 'The initial ordinary-text fixture unexpectedly contains a KaTeX DOM element')

  await cdp.send('Performance.enable')
  await cdp.send('HeapProfiler.enable')
  const memorySnapshots = [
    await rendererMemorySnapshot(cdp, app, page, 'ready-before-stream-after-gc'),
  ]
  const processSamples = [
    await sampleWindow(app, fixtureRoot, 'idle-before-stream', () => waitForTimeout(idleSampleMs)),
  ]

  await selectSession(page, 'Hermetic desktop fixture').click()
  await page.getByRole('combobox', { name: 'Message OMP' }).fill(prompt)
  processSamples.push(await sampleWindow(app, fixtureRoot, 'stream-120-text-and-tool-frames', async () => {
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await replyLocator(page).waitFor({ state: 'visible', timeout: actionTimeoutMs })
    if (math) await replyLocator(page).locator('.katex').first().waitFor({ state: 'visible', timeout: actionTimeoutMs })
  }))
  assert.equal(await replyLocator(page).count(), 1, 'The deterministic final reply did not render exactly once')
  const finalKatexElementCount = await page.locator('.katex').count()
  if (math) {
    assert.ok(finalKatexElementCount > 0, 'Math mode completed without a rendered .katex formula')
    assert.ok(await replyLocator(page).locator('.katex .katex-html[aria-hidden="true"]').count() > 0, 'Math mode did not produce KaTeX HTML output')
  } else {
    assert.equal(finalKatexElementCount, 0, 'Ordinary text unexpectedly produced a KaTeX DOM element')
  }
  memorySnapshots.push(await rendererMemorySnapshot(cdp, app, page, 'after-stream-and-gc'))
  processSamples.push(await sampleWindow(app, fixtureRoot, 'idle-after-stream', () => waitForTimeout(idleSampleMs)))
  const loadedResources = await resourcesSnapshot(page, networkRequests, executedScriptUrls)
  if ((math || eager) && (loadedResources.katexJavaScript.length === 0 || loadedResources.katexStyleSheets.length === 0)) {
    console.error(JSON.stringify({ observedMathResources: loadedResources }, null, 2))
  }
  if (math || eager) {
    assert.ok(loadedResources.katexJavaScript.length > 0, 'Math readiness or eager control did not correspond to an actually loaded KaTeX JavaScript resource')
    assert.ok(loadedResources.katexStyleSheets.length > 0, 'Math readiness or eager control did not correspond to actually loaded KaTeX CSS')
  } else {
    assert.equal(loadedResources.katexJavaScript.length, 0, 'Ordinary text loaded KaTeX JavaScript')
    assert.equal(loadedResources.katexStyleSheets.length, 0, 'Ordinary text loaded KaTeX CSS')
    assert.equal(loadedResources.katexFonts.length, 0, 'Ordinary text loaded a KaTeX font')
  }

  for (let iteration = 0; iteration < sessionSwitchCount; iteration += 1) {
    await selectSession(page, 'Todo plan fixture').click()
    await page.getByText('Plan the fixture work', { exact: true }).waitFor({ timeout: actionTimeoutMs })
    await selectSession(page, 'Hermetic desktop fixture').click()
    await replyLocator(page).waitFor({ state: 'visible', timeout: actionTimeoutMs })
    if (math) await replyLocator(page).locator('.katex').first().waitFor({ state: 'visible', timeout: actionTimeoutMs })
    memorySnapshots.push(await rendererMemorySnapshot(cdp, app, page, `after-session-switch-${iteration + 1}-and-gc`))
  }

  const censusPath = join(fixtureRoot, 'rpc-census.log')
  const censusLines = existsSync(censusPath) ? readFileSync(censusPath, 'utf8').split('\n').filter(Boolean) : []
  const commandCounts = Object.create(null)
  for (const type of censusLines) commandCounts[type] = (commandCounts[type] ?? 0) + 1
  assert.ok((commandCounts.prompt ?? 0) >= 1, 'The command census did not observe the resource prompt')
  assert.deepEqual(pageErrors, [], 'The renderer emitted page errors during the benchmark')
  const electronVersions = await app.evaluate(() => ({ ...process.versions }))
  const finalOmp = ompProcessSnapshot(fixtureRoot)
  report = {
    schemaVersion: 'omp-desktop/electron-resource-budget/v1',
    generatedAt: new Date().toISOString(),
    math,
    eager,
    runtime: {
      hostNodeVersion: process.version,
      electronNodeVersion: electronVersions.node,
      electronVersion: electronVersions.electron,
      chromiumVersion: electronVersions.chrome,
      platform: process.platform,
      architecture: process.arch,
    },
    scope: {
      description: 'One deterministic run of the real built Electron UI against the injected hermetic fake-agent fixture. This isolates the selected ordinary-text or math scenario; it is not a whole-application CPU or memory conclusion.',
      repetitions: 1,
      buildAssumption: 'npm run build:bundle has already completed in the invocation working directory; out/main/index.js is required.',
      fixtureIsolation: 'Uses createHermeticFixture and hermeticEnvironment extracted unchanged from tests/e2e/app.spec.ts, except for asserted in-memory command census and deterministic stream insertions into the generated fake agent.',
      cpuAttribution: 'Electron app.getAppMetrics is per process. POSIX ps separately describes only the marked fake-agent OMP subprocess. JSON-RPC command counts measure protocol traffic and are never attributed as CPU usage.',
      memoryAttribution: 'Electron native workingSet and peakWorkingSet values are KiB. Main-process Node memoryUsage and Chromium Performance.getMetrics byte values remain separate; DOM counters are retained after forced GC.',
      sampling: 'No cross-window medians or cumulative CPU sums are computed. Each sample preserves its own elapsed wall time and before/after process identities.',
      commandCoverage: 'Every parsed fake-agent JSON-RPC command type is appended at the single line reader, with no command exclusions. The census includes session switches and is read after those switches.',
    },
    configuration: {
      prompt,
      finalReply,
      streamFrameCount,
      streamIntervalMs,
      toolExecutionEventsPerFrame: 2,
      textDeltaEventsPerFrame: 1,
      idleSampleMs,
      startupSettleMs,
      sessionSwitchCount,
      actionTimeoutMs,
    },
    processSamples,
    memorySnapshots,
    resources: {
      ...loadedResources,
      matchingRules: 'KaTeX JavaScript execution is identified through CDP Network.requestWillBeSent and Debugger.scriptParsed, including cached responses. CSS is cross-checked against actual stylesheet href values. Fonts are identified through CDP Network requests. PerformanceResourceTiming is retained as a diagnostic, so an empty buffer never establishes an absence of resources. Negative assertions require ordinary network and script execution evidence.',
    },
    dom: {
      initialKatexElementCount,
      finalKatexElementCount,
      finalReplyCount: await replyLocator(page).count(),
      requiredMathFormula: math,
      rendererPageErrors: pageErrors,
    },
    rpcCommandTraffic: {
      countsByType: commandCounts,
      totalCommands: censusLines.length,
      source: 'Generated fake-agent rpc-census.log at its only JSON-RPC line reader.',
    },
    processCoverage: {
      supported: 'All processes returned by Electron app.getAppMetrics, with pid and type retained; Node main process memoryUsage is separate.',
      fakeAgentOmp: finalOmp,
      missingNativeOmpMetrics: finalOmp.metrics === null,
    },
  }
} finally {
  try {
    await closeHermeticApp(app)
  } finally {
    cleanFixtureRoot(electronResourceBudgetFixtureRoot())
  }
}

assert.ok(report, 'The benchmark ended without a report')
const json = `${JSON.stringify(report, null, 2)}\n`
if (outputPath) writeFileSync(resolve(outputPath), json, 'utf8')
else process.stdout.write(json)
