import type { ToolBashAsyncDetails, ToolBashExecutionDetails, ToolExecutionDetails, ToolWaitExecutionDetails, ToolWaitJobDetails } from '@/types/api'
import { parseVitestReport, type VitestReportSummary } from './vitest-report'

export const MAX_WAIT_JOBS = 128

const IDENTIFIER_CHARS = 256
const LABEL_CHARS = 1_000
const RESULT_CHARS = 4_000

function objectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function elapsed(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function waitJob(value: unknown): ToolWaitJobDetails | undefined {
  if (!objectValue(value)) return undefined
  const id = boundedString(value.id, IDENTIFIER_CHARS)
  const type = boundedString(value.type, IDENTIFIER_CHARS)
  const status = boundedString(value.status, IDENTIFIER_CHARS)
  const intent = boundedString(value.intent, LABEL_CHARS)
  const label = boundedString(value.label, LABEL_CHARS)
  const stage = boundedString(value.stage, LABEL_CHARS)
  const durationMs = elapsed(value.durationMs)
  const resultText = boundedString(value.resultText, RESULT_CHARS)
  const errorText = boundedString(value.errorText, RESULT_CHARS)
  if (id === undefined && type === undefined && status === undefined && intent === undefined && label === undefined && stage === undefined && durationMs === undefined && resultText === undefined && errorText === undefined) return undefined
  return { id, type, status, intent, label, stage, durationMs, resultText, errorText }
}

function waitExecutionDetails(value: unknown): ToolWaitExecutionDetails | undefined {
  if (!objectValue(value) || value.op !== 'wait' || !Array.isArray(value.jobs)) return undefined
  const jobs: ToolWaitJobDetails[] = []
  for (const entry of value.jobs.slice(0, MAX_WAIT_JOBS)) {
    const job = waitJob(entry)
    if (!job) return undefined
    jobs.push(job)
  }
  return { kind: 'wait', jobs, truncated: value.jobs.length > MAX_WAIT_JOBS || undefined }
}

function asyncBashDetails(value: unknown): ToolBashAsyncDetails | undefined {
  if (!objectValue(value) || value.type !== 'bash') return undefined
  const jobId = boundedString(value.jobId, IDENTIFIER_CHARS)
  const state = value.state
  if (!jobId || (state !== 'running' && state !== 'completed' && state !== 'failed' && state !== 'cancelled')) return undefined
  return { jobId, state }
}

function bashExecutionDetails(value: unknown): ToolBashExecutionDetails | undefined {
  if (!objectValue(value)) return undefined
  const wallTimeMs = elapsed(value.wallTimeMs)
  const exitCode = typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 ? value.exitCode : undefined
  const timedOut = typeof value.timedOut === 'boolean' ? value.timedOut : undefined
  const async = asyncBashDetails(value.async)
  const terminalId = boundedString(value.terminalId, IDENTIFIER_CHARS)
  if (wallTimeMs === undefined && exitCode === undefined && timedOut === undefined && !async && terminalId === undefined) return undefined
  return { kind: 'bash', wallTimeMs, exitCode, timedOut, async, terminalId }
}

export function projectToolExecutionDetails(name: string, value: unknown): ToolExecutionDetails | undefined {
  if (!objectValue(value)) return undefined
  switch (name.trim().toLowerCase()) {
    case 'wait': return waitExecutionDetails(value.details)
    case 'bash': return bashExecutionDetails(value.details)
    default: return undefined
  }
}

export interface ToolResultProjection {
  details?: ToolExecutionDetails
  testReport?: VitestReportSummary
}

/** The update/end result is a full snapshot: omitted or malformed projections clear old facts. */
export function projectToolResult(name: string, text: string, value: unknown): ToolResultProjection {
  const details = projectToolExecutionDetails(name, value)
  const testReport = name.trim().toLowerCase() === 'bash' && !(details?.kind === 'bash' && details.terminalId) ? parseVitestReport(text) : undefined
  if (!details && !testReport) return {}
  return { ...(details ? { details } : {}), ...(testReport ? { testReport } : {}) }
}
