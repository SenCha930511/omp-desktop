#!/usr/bin/env node
/**
 * Parity harness entry: drives the REAL omp binary through both surfaces —
 * RPC mode (the GUI's path) and interactive TUI (the terminal's path) —
 * against a deterministic local fixture provider, then compares normalized
 * session artifacts.
 *
 * Cases:
 *   consistency-basic    RPC and TUI run the same sequence (two prompts);
 *                         normalized session projections must be EQUAL.
 *   divergence-detector   RPC runs two prompts, TUI only one; the comparator
 *                         MUST report a diff (tool self-check — a harness that
 *                         cannot fail proves nothing).
 *
 * Usage:
 *   node scripts/parity/run.mjs [--omp /opt/homebrew/bin/omp] [--keep]
 *
 * Output: one PASS/DIFF line per case, a JSON summary on stdout, exit 0 only
 * when consistency passes AND the divergence is detected.
 */
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { startFixtureProvider } from './fixture-provider.mjs'
import { buildTempHome } from './temp-home.mjs'
import { ParityRpcDriver } from './rpc-driver.mjs'
import { ParityTuiDriver } from './tui-driver.mjs'
import { normalizeSessionJsonl, normalizeState } from './normalize.mjs'
import { compareSessionProjections, compareProjections } from './compare.mjs'

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const OMP = argValue('--omp', '/opt/homebrew/bin/omp')
const KEEP = process.argv.includes('--keep')

/** Bookkeeping kinds each surface persisted (reported, not compared). */
function surfaceNotes(sessionText) {
  if (!sessionText) return []
  const kinds = new Set()
  for (const line of sessionText.split('\n').filter(Boolean)) {
    try {
      const entry = JSON.parse(line)
      if (entry.type === 'model_change' || entry.type === 'service_tier_change') kinds.add(entry.type)
      if (entry.type === 'custom' && entry.customType === 'system-prompt-digest') kinds.add('system-prompt-digest')
    } catch { /* ignore */ }
  }
  return [...kinds].sort()
}

function readSessionFile(filePath) {
  if (!filePath) return null
  return readFileSync(filePath, 'utf8')
}

async function runRpcSide(prompts, fixturePort) {
  const built = buildTempHome({ fixturePort, prefix: 'parity-rpc-' })
  const driver = new ParityRpcDriver(OMP, built)
  const notes = { prompts: [], turnSettled: [] }
  try {
    await driver.ready()
    await driver.newSession()
    for (const text of prompts) {
      const since = driver.events.length
      await driver.prompt(text)
      notes.turnSettled.push(await driver.waitForTurnEnd({ sinceIndex: since }))
      await driver.waitForIdle()
      notes.prompts.push(text)
    }
    const rawState = await driver.state()
    notes.state = normalizeState(rawState)
    // 權威路徑：get_state 的 sessionFile（多檔情境下目錄猜測會選錯）。
    const file = rawState.sessionFile ?? driver.sessionFile(built.sessions, { readdirSync })
    notes.sessionText = readSessionFile(file)
    notes.sessionPath = file
    return notes
  } finally {
    await driver.dispose({})
    if (!KEEP) rmSync(built.root, { recursive: true, force: true })
  }
}

async function runTuiSide(prompts, fixturePort) {
  const built = buildTempHome({ fixturePort, prefix: 'parity-tui-' })
  const driver = new ParityTuiDriver(OMP, built)
  const notes = { prompts: [], turnSettled: [] }
  try {
    const ready = await driver.waitForComposer()
    if (!ready) throw new Error('TUI composer never became ready')
    for (const text of prompts) {
      notes.turnSettled.push(await driver.sendPrompt(text))
      notes.prompts.push(text)
    }
    const file = driver.sessionFile({ readdirSync })
    notes.sessionText = readSessionFile(file)
    notes.sessionPath = file
    return notes
  } finally {
    await driver.dispose()
    if (!KEEP) rmSync(built.root, { recursive: true, force: true })
  }
}

function projectLedger(side) {
  return {
    prompts: side.prompts,
    turnSettled: side.turnSettled,
    state: side.state ?? null,
    session: side.sessionText ? normalizeSessionJsonl(side.sessionText) : null,
  }
}

const fixture = await startFixtureProvider()
const results = []

// --- Case 1: consistency (same sequence both sides) ---
try {
  const rpc = await runRpcSide(['alpha parity', 'beta parity'], fixture.port)
  const tui = await runTuiSide(['alpha parity', 'beta parity'], fixture.port)
  const rpcLedger = projectLedger(rpc)
  const tuiLedger = projectLedger(tui)
  // M2 防對稱性假 PASS：兩側投影必須非空且含預期輪數（兩側同時壞掉
  // 歸零時 compareSessionProjections 會誤判相等）。
  const expectedUserTurns = 2
  const userTurnCount = (entries) => entries.filter((entry) => entry.type === 'message' && entry.role === 'user').length
  const nonEmpty = Array.isArray(rpcLedger.session) && rpcLedger.session.length > 0 && Array.isArray(tuiLedger.session) && tuiLedger.session.length > 0
  const rpcUserTurns = nonEmpty ? userTurnCount(rpcLedger.session) : 0
  const tuiUserTurns = nonEmpty ? userTurnCount(tuiLedger.session) : 0
  const structural = nonEmpty && rpcUserTurns === expectedUserTurns && tuiUserTurns === expectedUserTurns
  const session = compareSessionProjections(rpcLedger.session ?? [], tuiLedger.session ?? [])
  const turns = compareProjections('turn-settled', rpcLedger.turnSettled, tuiLedger.turnSettled)
  const model = compareProjections('model', rpcLedger.state?.model ?? null, { provider: 'parity-fixture', modelId: 'fixture-echo' })
  const diffs = [...session.diffs, ...turns.diffs, ...model.diffs]
  if (!structural) diffs.push({ where: 'session-projection-nonempty', detail: `rpcEntries=${Array.isArray(rpcLedger.session) ? rpcLedger.session.length : 'null'} tuiEntries=${Array.isArray(tuiLedger.session) ? tuiLedger.session.length : 'null'} rpcUserTurns=${rpcUserTurns} tuiUserTurns=${tuiUserTurns}` })
  results.push({
    case: 'consistency-basic',
    status: diffs.length === 0 ? 'PASS' : 'DIFF',
    diffs,
    surfaceNotes: { rpc: surfaceNotes(rpc.sessionText), tui: surfaceNotes(tui.sessionText) },
  })
} catch (error) {
  results.push({ case: 'consistency-basic', status: 'ERROR', diffs: [{ where: 'exception', detail: String(error.message) }] })
}

// --- Case 2: divergence self-check (different sequences MUST diff) ---
try {
  const rpc = await runRpcSide(['alpha parity', 'beta parity', 'gamma parity'], fixture.port)
  const tui = await runTuiSide(['alpha parity'], fixture.port)
  const session = compareSessionProjections(
    projectLedger(rpc).session ?? [],
    projectLedger(tui).session ?? [],
  )
  const detected = session.diffs.length > 0
  results.push({
    case: 'divergence-detector',
    status: detected ? 'PASS' : 'DIFF',
    diffs: detected ? [] : [{ where: 'self-check', detail: 'comparator reported no difference for deliberately different sequences' }],
    detectedDiffs: session.diffs.slice(0, 6),
  })
} catch (error) {
  results.push({ case: 'divergence-detector', status: 'ERROR', diffs: [{ where: 'exception', detail: String(error.message) }] })
}

// --- 7.2 案例：Session（fork）---
try {
  const rpcHome = buildTempHome({ fixturePort: fixture.port, prefix: 'parity-fork-rpc-' })
  const rpc = new ParityRpcDriver(OMP, rpcHome)
  let rpcText = null
  try {
    await rpc.ready()
    await rpc.newSession()
    await rpc.prompt('fork alpha')
    await rpc.waitForTurnEnd({})
    const forkResponse = await rpc.request({ type: 'fork' })
    if (forkResponse.success !== true) throw new Error('fork RPC failed')
    const state = await rpc.state()
    await rpc.prompt('fork beta')
    await rpc.waitForTurnEnd({})
    rpcText = readFileSync(state.sessionFile, 'utf8')
  } finally {
    await rpc.dispose({})
    if (!KEEP) rmSync(rpcHome.root, { recursive: true, force: true })
  }
  const tuiHome = buildTempHome({ fixturePort: fixture.port, prefix: 'parity-fork-tui-' })
  const tui = new ParityTuiDriver(OMP, tuiHome)
  let tuiText = null
  try {
    if (!await tui.waitForComposer()) throw new Error('composer not ready')
    await tui.sendPrompt('fork alpha')
    tui.type('/fork')
    await new Promise((r) => setTimeout(r, 400))
    tui.submit()
    if (!await tui.waitForText('Session forked')) throw new Error('TUI /fork did not complete')
    await tui.sendPrompt('fork beta')
    const newest = readdirSync(tuiHome.sessions).filter((f) => f.endsWith('.jsonl') && !f.startsWith('.')).sort().pop()
    tuiText = readFileSync(path.join(tuiHome.sessions, newest), 'utf8')
  } finally {
    await tui.dispose()
    if (!KEEP) rmSync(tuiHome.root, { recursive: true, force: true })
  }
  const forkCompare = compareSessionProjections(normalizeSessionJsonl(rpcText), normalizeSessionJsonl(tuiText))
  results.push({ case: 'session-fork', status: forkCompare.pass ? 'PASS' : 'DIFF', diffs: forkCompare.diffs })
} catch (error) {
  results.push({ case: 'session-fork', status: 'ERROR', diffs: [{ where: 'exception', detail: String(error.message) }] })
}

// --- 7.2 案例：Compact ---
try {
  const rpcHome = buildTempHome({ fixturePort: fixture.port, prefix: 'parity-compact-rpc-' })
  const rpc = new ParityRpcDriver(OMP, rpcHome)
  let rpcText = null
  try {
    await rpc.ready()
    await rpc.newSession()
    // 上游 prepareCompaction 的最小規模由 compaction.keepRecentTokens
    // （預設 20000）決定；temp-home 種子已設 200，小對話即可 compact——
    // 避免 23k 字大文造成的 TUI driver 串流/落盤競態。
    // 門檻語意：session 需「超過」keepRecentTokens（種子=200）才有可摘
    // 要段落——3 輪 × ~415 字 ≈ 310 tokens，夠過門檻又小到不會觸發
    // TUI driver 的串流競態。
    // 填充不可含短週期重複——上游有 thinking-loop/stall 偵測（「重複
    // 27 字元循環 13 次」會被當串流停滯）。用 NATO 字母＋唯一序號後綴
    // 產生無循環的確定性文本。
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu']
    let filler = ''
    for (let i = 0; filler.length < 420; i += 1) filler += words[i % words.length] + '-' + i + ' '
    for (const index of [1, 2, 3]) {
      await rpc.prompt('compact alpha ' + index + ' ' + filler)
      await rpc.waitForTurnEnd({})
      await rpc.waitForIdle()
    }
    const compactResponse = await rpc.request({ type: 'compact' })
    if (compactResponse.success !== true) throw new Error('compact RPC failed')
    await rpc.prompt('after compact')
    await rpc.waitForTurnEnd({})
    const file = rpc.sessionFile(rpcHome.sessions, { readdirSync })
    rpcText = readFileSync(file, 'utf8')
  } finally {
    await rpc.dispose({})
    if (!KEEP) rmSync(rpcHome.root, { recursive: true, force: true })
  }
  const tuiHome = buildTempHome({ fixturePort: fixture.port, prefix: 'parity-compact-tui-' })
  const tui = new ParityTuiDriver(OMP, tuiHome)
  let tuiText = null
  try {
    if (!await tui.waitForComposer()) throw new Error('composer not ready')
    // 填充不可含短週期重複——上游有 thinking-loop/stall 偵測（「重複
    // 27 字元循環 13 次」會被當串流停滯）。用 NATO 字母＋唯一序號後綴
    // 產生無循環的確定性文本。
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu']
    let filler = ''
    for (let i = 0; filler.length < 420; i += 1) filler += words[i % words.length] + '-' + i + ' '
    for (const index of [1, 2, 3]) {
      await tui.sendPrompt('compact alpha ' + index + ' ' + filler)
    }
    tui.type('/compact')
    await new Promise((r) => setTimeout(r, 400))
    tui.submit()
    // compaction 本身是一次 model call（fixture 收到 ~90k 字的摘要請求），
    // 固定等待不可靠：先等螢幕靜止（busy spinner 停止），再輪詢 session
    // 檔出現 compaction entry 才繼續——確定性的完成條件，不是時間猜測。
    await tui.waitForQuiescence({ timeoutMs: 45000, stablePolls: 6 })
    const compactionOnDisk = () => {
      const file = tui.sessionFile({ readdirSync })
      return file !== null && readFileSync(file, 'utf8').includes('"type":"compaction"')
    }
    for (let attempt = 0; attempt < 60 && !compactionOnDisk(); attempt += 1) {
      await new Promise((r) => setTimeout(r, 500))
    }
    await tui.sendPrompt('after compact')
    const file = tui.sessionFile({ readdirSync })
    tuiText = readFileSync(file, 'utf8')
  } finally {
    await tui.dispose()
    if (!KEEP) rmSync(tuiHome.root, { recursive: true, force: true })
  }
  const rpcProjection = normalizeSessionJsonl(rpcText)
  const tuiProjection = normalizeSessionJsonl(tuiText)
  const compactCompare = compareSessionProjections(rpcProjection, tuiProjection)
  const rpcCompacted = rpcProjection.some((e) => e.type === 'compaction' || (e.type === 'custom' && e.customType === 'compaction'))
  const tuiCompacted = tuiProjection.some((e) => e.type === 'compaction' || (e.type === 'custom' && e.customType === 'compaction'))
  if (!rpcCompacted || !tuiCompacted) {
    compactCompare.diffs.push({ where: 'compaction-entry', detail: `rpc=${rpcCompacted} tui=${tuiCompacted}` })
    compactCompare.pass = false
  }
  results.push({ case: 'compact-parity', status: compactCompare.pass ? 'PASS' : 'DIFF', diffs: compactCompare.diffs })
} catch (error) {
  results.push({ case: 'compact-parity', status: 'ERROR', diffs: [{ where: 'exception', detail: String(error.message) + (KEEP ? ' (roots kept)' : '') }] })
}

// --- 7.2 案例：Queue（abort_and_restore_queue vs Esc）---
try {
  const rpcHome = buildTempHome({ fixturePort: fixture.port, prefix: 'parity-queue-rpc-' })
  const rpc = new ParityRpcDriver(OMP, rpcHome)
  let rpcText = null
  try {
    await rpc.ready()
    await rpc.newSession()
    const holdIndex = rpc.events.length
    await rpc.prompt('hold turn one')
    // busy 中 plain prompt 會被上游拒絕（「Use steer() or followUp()」）——
    // 這正是 GUI 2.2 的排隊路徑：follow_up 進入佇列。
    await rpc.request({ type: 'follow_up', message: 'queued turn' })
    const restore = await rpc.request({ type: 'abort_and_restore_queue' })
    if (restore.success !== true) throw new Error('abort_and_restore_queue failed')
    await rpc.prompt('queued turn')
    await rpc.waitForTurnEnd({ sinceIndex: holdIndex, timeoutMs: 60000 })
    await new Promise((r) => setTimeout(r, 1500))
    const file = rpc.sessionFile(rpcHome.sessions, { readdirSync })
    rpcText = readFileSync(file, 'utf8')
  } finally {
    await rpc.dispose({})
    if (!KEEP) rmSync(rpcHome.root, { recursive: true, force: true })
  }
  const tuiHome = buildTempHome({ fixturePort: fixture.port, prefix: 'parity-queue-tui-' })
  const tui = new ParityTuiDriver(OMP, tuiHome)
  let tuiText = null
  try {
    if (!await tui.waitForComposer()) throw new Error('composer not ready')
    tui.type('hold turn one')
    await new Promise((r) => setTimeout(r, 350))
    tui.submit()
    await new Promise((r) => setTimeout(r, 800))
    tui.type('queued turn')
    await new Promise((r) => setTimeout(r, 350))
    tui.submit()
    await new Promise((r) => setTimeout(r, 300))
    tui.term.write(String.fromCharCode(27))
    await new Promise((r) => setTimeout(r, 1200))
    tui.submit()
    await tui.waitForText(':queued turn', { timeoutMs: 60000 })
    await new Promise((r) => setTimeout(r, 1500))
    const file = tui.sessionFile({ readdirSync })
    tuiText = readFileSync(file, 'utf8')
  } finally {
    await tui.dispose()
    if (!KEEP) rmSync(tuiHome.root, { recursive: true, force: true })
  }
  // 已知上游表面差異（finding，不是 app 缺陷）：TUI Esc 走 session.abort()
  // （interactive-mode.ts），中止輪的 user 訊息與空 assistant 會落盤；
  // RPC abort_and_restore_queue 會回滾 in-flight 輪。核心 parity 是「佇列
  // 退還後重送」雙側一致——比對前把受中止輪影響的條目濾掉並記錄 finding。
  const dropAbortedTurnArtifacts = (entries) => entries
    .filter((entry) => !(entry.type === 'message' && (entry.text === '' || entry.text === 'hold turn one')))
    // fixture 的 ack 計數=持久化 user 輪數——中止輪落盤與否的直接指紋，
    // 屬上述 finding 的一部分，比對時剝除計數只留文字。
    .map((entry) => (entry.type === 'message' && typeof entry.text === 'string' ? { ...entry, text: entry.text.replace(/fixture-ack\[\d+\]:/, 'fixture-ack:') } : entry))
  const rawCompare = compareSessionProjections(normalizeSessionJsonl(rpcText), normalizeSessionJsonl(tuiText))
  const queueCompare = compareSessionProjections(dropAbortedTurnArtifacts(normalizeSessionJsonl(rpcText)), dropAbortedTurnArtifacts(normalizeSessionJsonl(tuiText)))
  results.push({
    case: 'queue-abort-restore',
    status: queueCompare.pass ? 'PASS' : 'DIFF',
    diffs: queueCompare.diffs,
    findings: rawCompare.pass ? [] : ['abort persistence differs by surface: TUI Esc (session.abort) keeps the aborted turn (user message + empty assistant); RPC abort_and_restore_queue rolls the in-flight turn back. Upstream-owned; queue restore-and-resend parity is what this case asserts.'],
  })
} catch (error) {
  results.push({ case: 'queue-abort-restore', status: 'ERROR', diffs: [{ where: 'exception', detail: String(error.message) }] })
}

fixture.server.close()
for (const result of results) {
  console.error(`${result.status === 'PASS' ? 'PASS' : 'FAIL'} ${result.case}`)
  for (const diff of result.diffs.slice(0, 6)) console.error(`   ${diff.where}: ${diff.detail}`)
  if (result.findings) for (const finding of result.findings) console.error(`   FINDING: ${finding}`)
  if (result.detectedDiffs) {
    console.error(`   detected ${result.detectedDiffs.length} real diff(s):`)
    for (const diff of result.detectedDiffs) console.error(`   - ${diff.where}: ${diff.detail}`)
  }
}
const summary = {
  omp: OMP,
  cases: results.map((result) => ({ case: result.case, status: result.status, diffCount: result.diffs.length })),
  allPassed: results.every((result) => result.status === 'PASS'),
}
console.log(JSON.stringify(summary, null, 2))
process.exit(summary.allPassed ? 0 : 1)
