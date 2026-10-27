// 輸入速寫語法:對齊上游 OMP TUI v18.12.6
// (packages/tui/src/prompt/queue-input.ts 與 input/controller onSubmit)的語意,
// 讓 GUI composer 與 TUI 對相同文字得到相同的命令意義。

// TUI 的合成「繼續」提示:`packages/coding-agent/src/prompts/system/manual-continue.md` 原文。
// 輸入剛好是 `.` 或 `c` 時,TUI 不送字面文字,而是送這段合成提示
// (synthetic + userInitiated),承接被中斷的回合繼續未完成的工作。
export const MANUAL_CONTINUE_PROMPT = `<system-notice>
Continue.

MUST resume most recent intent; complete unfinished work.
If interrupted mid-step: resume where stopped.
NEVER pause to summarize progress, re-confirm plan, or ask whether to proceed; continue.
</system-notice>`

/** 輸入剛好是 `.` 或 `c` 時視為「繼續」速寫(TUI 無圖片限制的 main session 語意)。 */
export function isContinueShorthand(trimmed: string): boolean {
  return trimmed === '.' || trimmed === 'c'
}

// ---------------------------------------------------------------------------
// `->` / `=>` 佇列速寫
// ---------------------------------------------------------------------------

// 上游 `Xt = ["->", "=>"]`:輸入以此開頭即進入佇列路徑(handleQueueCommand → follow_up)。
const QUEUE_PREFIXES = ['->', '=>'] as const

// 上游 `xDe`:清單標記(1.、2)、A.、iv) 等),只擷取行首縮排後的標記。
const LIST_MARKER_RE = /^([\t ]*)(\d+|[A-Za-z]+)([.)])(?=[\t ]|$)/
// 上游 `Yt`:合法羅馬數字。
const ROMAN_NUMERAL_RE = /^(?=[MDCLXVI])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i

interface ListMarker {
  line: number
  indent: string
  marker: string
  punctuation: string
  content: string
}

/** 上游 `Ue`:解析單行的清單標記;不符合回傳 undefined。 */
function parseListMarker(line: string, index: number): ListMarker | undefined {
  const match = LIST_MARKER_RE.exec(line)
  if (!match) return undefined
  const [full, indent, marker, punctuation] = match
  if (indent === undefined || marker === undefined || punctuation === undefined) return undefined
  return { line: index, indent, marker, punctuation, content: line.slice(full.length).trimStart() }
}

/** 上游 `Qt`:阿拉伯數字標記。 */
function arabicMarker(marker: string): number | undefined {
  if (!/^\d+$/.test(marker)) return undefined
  const value = Number(marker)
  return Number.isSafeInteger(value) ? value : undefined
}

/** 上游 `Zt`:羅馬數字標記。 */
function romanMarker(marker: string): number | undefined {
  if (!ROMAN_NUMERAL_RE.test(marker)) return undefined
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }
  const upper = marker.toUpperCase()
  let total = 0
  for (let index = 0; index < upper.length; index++) {
    const current = values[upper[index] ?? ''] ?? 0
    const next = values[upper[index + 1] ?? ''] ?? 0
    total += current < next ? -current : current
  }
  return total
}

/** 上游 `en`(A=1、B=2、…、Z=26、AA=27)字母序標記。 */
function alphaMarker(marker: string): number | undefined {
  if (!/^[A-Za-z]+$/.test(marker)) return undefined
  let value = 0
  for (const char of marker.toUpperCase()) {
    value = value * 26 + char.charCodeAt(0) - 64
    if (!Number.isSafeInteger(value)) return undefined
  }
  return value
}

/** 上游 `ue`:標記序列是否由同一種計數法連續遞增 1。 */
function isSequential(markers: string[], toValue: (marker: string) => number | undefined): boolean {
  let previous = toValue(markers[0] ?? '')
  if (previous === undefined) return false
  for (let index = 1; index < markers.length; index++) {
    const current = toValue(markers[index] ?? '')
    if (current === undefined || current !== previous + 1) return false
    previous = current
  }
  return true
}

/** 上游 `tn`:數字連號,或不分大小寫混用的羅馬/字母連號。 */
function isCountedList(items: readonly ListMarker[]): boolean {
  const markers = items.map((item) => item.marker)
  if (markers.every((marker) => /^\d+$/.test(marker))) return isSequential(markers, arabicMarker)
  const allUpper = markers.every((marker) => marker === marker.toUpperCase())
  const allLower = markers.every((marker) => marker === marker.toLowerCase())
  if (!allUpper && !allLower) return false
  return isSequential(markers, romanMarker) || isSequential(markers, alphaMarker)
}

/** 上游 `Ve`:整份文字是否是一個縮排一致、標點一致、連號的清單。 */
function parseCountedList(source: string): { lines: string[]; items: ListMarker[] } | undefined {
  const trimmed = source.trim()
  if (!trimmed) return undefined
  const lines = trimmed.split(/\r?\n/)
  const first = parseListMarker(lines[0] ?? '', 0)
  if (!first) return undefined
  const items = [first]
  for (let index = 1; index < lines.length; index++) {
    const marker = parseListMarker(lines[index] ?? '', index)
    if (marker?.indent === first.indent) items.push(marker)
  }
  if (items.length < 2 || items.some((item) => item.punctuation !== first.punctuation) || !isCountedList(items)) return undefined
  return { lines, items }
}

/** 上游 `aot`:剝掉前綴後的佇列內容;連號清單逐項拆開,各項目保留自己的多行內容。 */
function splitQueuedItems(body: string): string[] {
  const list = parseCountedList(body)
  if (!list) {
    const trimmed = body.trim()
    return trimmed ? [trimmed] : []
  }
  const items = list.items.map((item, index) => {
    const end = list.items[index + 1]?.line ?? list.lines.length
    return [item.content, ...list.lines.slice(item.line + 1, end)].join('\n').trim()
  })
  while (items.at(-1) === '') items.pop()
  return items.length > 0 && items.every(Boolean) ? items : [body.trim()]
}

export interface QueueShorthandParse {
  /** 剝掉 `->`/`=>` 前綴後要依序送出的佇列訊息;空陣列代表只打了前綴。 */
  items: string[]
}

/**
 * 上游 `See` + `aot` 的合體:輸入以 `->` 或 `=>` 開頭時回傳佇列解析結果,
 * 否則回傳 null(走一般送出流程)。只打前綴時 items 為空,
 * 由呼叫端仿 TUI 顯示「Usage: /queue <message>」提示。
 */
export function parseQueueShorthandInput(text: string): QueueShorthandParse | null {
  const prefix = QUEUE_PREFIXES.find((candidate) => text.startsWith(candidate))
  if (!prefix) return null
  return { items: splitQueuedItems(text.slice(prefix.length)) }
}

/**
 * 上游 `handleQueueCommand` 失敗時把未送出的剩餘項目還原成編輯器文字的格式:
 * 單則 `=> text`;多則 `=>` 換行接連號清單,方便使用者修正後原樣重送。
 */
export function formatQueuedItemsForRestore(items: readonly string[]): string {
  if (items.length === 1) return `=> ${items[0]}`
  return `=>\n${items.map((item, index) => `${index + 1}. ${item.replaceAll('\n', '\n   ')}`).join('\n')}`
}

// ---------------------------------------------------------------------------
// `!` / `!!` shell 速寫與 `$` / `$$` Python 速寫
// ---------------------------------------------------------------------------

// 對齊上游 TUI input-controller(input-controller.ts submit 路徑):
// `! cmd` 直接執行 shell(結果進 context);`!! cmd` 執行但排除出 context。
// RPC wire 的 bash 參數只有 command(wire/commands.ts BashParams),沒有
// excludeFromContext——`!!` 的「排除」語意無法透過 RPC 表達,因此 GUI 層
// 必須明確拒絕 `!!` 而不是靜默降級成 `!`(會污染模型 context,不可逆)。
export interface BashShorthandParse {
  command: string
  /** true = 上游 `!!` 的 excludeFromContext;RPC 無法表達,呼叫端應拒絕。 */
  excludeFromContext: boolean
}

export function parseBashShorthandInput(text: string): BashShorthandParse | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('!')) return null
  const excludeFromContext = trimmed.startsWith('!!')
  const command = (excludeFromContext ? trimmed.slice(2) : trimmed.slice(1)).trim()
  if (!command) return null
  return { command, excludeFromContext }
}

// 上游 SHELL_PROMPT_* / OMP_STATUS_LINE_RE:貼上的 shell 工作階段逐行看起來
// 像 `$ code`,但不是 Python 輸入。
const SHELL_PROMPT_COMMAND_RE =
  /^(?:\.{0,2}\/|~\/|cd(?:\s|$)|sudo(?:\s|$)|git(?:\s|$)|bun(?:\s|$)|npm(?:\s|$)|pnpm(?:\s|$)|yarn(?:\s|$)|node(?:\s|$)|python\d*(?:\s|$)|cargo(?:\s|$)|go(?:\s|$)|make(?:\s|$)|docker(?:\s|$)|kubectl(?:\s|$))/
const SHELL_PROMPT_OPERATOR_RE = /(?:^|\s)(?:&&|\|\||\||2>&1|[<>]{1,2})(?:\s|$)/
const OMP_STATUS_LINE_RE = /^\s*in:\s+\d+\s+out:\s+\d+(?:\s+cache\s+\S+)?\s+t:\s+\S+\s+tok\/s:\s+\S+/m

function looksLikePastedShellPrompt(code: string): boolean {
  const firstLine = code.split('\n', 1)[0]?.trimStart() ?? ''
  return SHELL_PROMPT_COMMAND_RE.test(firstLine) || SHELL_PROMPT_OPERATOR_RE.test(firstLine) || OMP_STATUS_LINE_RE.test(code)
}

/**
 * 上游 pythonCommandPrefixLength:`$`/`$$` 後必須接空白才算 Python sigil;
 * 裸 `$HOME` 這類 prose 不攔截。
 */
function pythonCommandPrefixLength(trimmedText: string): 0 | 1 | 2 {
  if (trimmedText.charCodeAt(0) !== 36 /* $ */) return 0
  const prefixLength = trimmedText.charCodeAt(1) === 36 /* $ */ ? 2 : 1
  const next = trimmedText.charCodeAt(prefixLength)
  return next === 32 || next === 9 || next === 10 || next === 13 ? prefixLength : 0
}

export interface PythonShorthandParse {
  code: string
  /** true = 上游 `$$` 的 excludeFromContext。 */
  excludeFromContext: boolean
}

/**
 * 上游 parsePythonCommandInput 的移植。GUI 不在本地執行 Python;
 * 上游 RPC wire 沒有 python/eval 命令(wire/commands.ts 無對應),呼叫端
 * 必須明確拒絕並告知缺口,絕不能把 `$ code` 偽造成一般 prompt 或本地執行。
 */
export function parsePythonShorthandInput(text: string): PythonShorthandParse | null {
  const trimmed = text.trimStart()
  const prefixLength = pythonCommandPrefixLength(trimmed)
  if (prefixLength === 0) return null
  const code = trimmed.slice(prefixLength).trim()
  if (prefixLength === 1 && looksLikePastedShellPrompt(code)) return null
  if (!code) return null
  return { code, excludeFromContext: prefixLength === 2 }
}
