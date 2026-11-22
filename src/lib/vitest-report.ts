import type { VitestCountSummary, VitestReportSummary } from '@/types/api'

export type { VitestReportSummary } from '@/types/api'

const MAX_REPORT_INPUT_CHARS = 256 * 1024
const COUNT_LABELS = ['failed', 'passed', 'expected fail', 'skipped', 'todo'] as const
type CountLabel = (typeof COUNT_LABELS)[number]

/** Strip only color SGR. Cursor movement, OSC, and other controls make the report unsafe to summarize. */
function printableReport(value: string): string | undefined {
  if (value.length > MAX_REPORT_INPUT_CHARS || value.includes('… [truncated] …')) return undefined
  let text = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x1b) {
      if (value[index + 1] !== '[') return undefined
      let end = index + 2
      while (end < value.length) {
        const final = value.charCodeAt(end)
        if (final >= 0x40 && final <= 0x7e) break
        end += 1
      }
      if (end >= value.length || value[end] !== 'm' || !/^[0-9;:]*$/.test(value.slice(index + 2, end))) return undefined
      index = end
      continue
    }
    if (code === 0x0d && value.charCodeAt(index + 1) === 0x0a) continue
    if ((code >= 0 && code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return undefined
    text += value[index]
  }
  return text
}

function summaryCount(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const count = Number(value)
  return Number.isSafeInteger(count) ? count : undefined
}

function countSummary(line: string): VitestCountSummary | undefined {
  const totalMatch = / \((\d+)\)$/.exec(line)
  if (!totalMatch) return undefined
  const total = summaryCount(totalMatch[1])
  if (total === undefined) return undefined
  const values: Record<CountLabel, number> = { failed: 0, passed: 0, 'expected fail': 0, skipped: 0, todo: 0 }
  const seen = new Set<CountLabel>()
  let sum = 0
  const body = line.slice(0, -totalMatch[0].length)
  for (const segment of body.split(' | ')) {
    const match = /^(\d+) (failed|passed|expected fail|skipped|todo)$/.exec(segment)
    if (!match) return undefined
    const label = match[2] as CountLabel
    const count = summaryCount(match[1])
    if (count === undefined || seen.has(label)) return undefined
    seen.add(label)
    values[label] = count
    sum += count
    if (!Number.isSafeInteger(sum)) return undefined
  }
  if (seen.size === 0 || sum !== total) return undefined
  return { failed: values.failed, passed: values.passed, expectedFailed: values['expected fail'], skipped: values.skipped, todo: values.todo, total }
}

/** Return the latest fully observed flat Vitest 4 footer; never add counts across snapshots. */
export function parseVitestReport(value: string): VitestReportSummary | undefined {
  const printable = printableReport(value)
  if (printable === undefined) return undefined
  let latest: VitestReportSummary | undefined
  let pendingFiles: VitestCountSummary | undefined
  for (const line of printable.split('\n')) {
    const match = /^[ \t]*(Test Files|Tests)[ \t]+(.+?)[ \t]*$/.exec(line)
    if (!match) continue
    const summary = countSummary(match[2])
    if (match[1] === 'Test Files') {
      pendingFiles = summary
    } else {
      if (summary && pendingFiles) latest = { files: pendingFiles, tests: summary }
      pendingFiles = undefined
    }
  }
  return latest
}
