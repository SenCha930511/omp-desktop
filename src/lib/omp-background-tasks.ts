import type { CommandResult } from '@/hooks/useCommandOutput'
import type { MessagePart, TranscriptMessage } from '@/types/api'

export type OmpBackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type OmpBackgroundTaskKind = 'job' | 'tool' | 'bash' | 'script'

export interface OmpBackgroundTask {
  id: string
  kind: OmpBackgroundTaskKind
  title: string
  type: string
  status: OmpBackgroundTaskStatus
  detail?: string
  cancellable?: boolean
}

export interface ActiveProjectScriptSummary {
  runId: string
  kind: 'setup' | 'run'
  command: string
}

export interface DeriveOmpBackgroundTasksInput {
  messages: readonly TranscriptMessage[]
  isStreaming?: boolean
  commandOutputHistory?: readonly CommandResult[]
  activeProjectScript?: ActiveProjectScriptSummary
}

const BACKGROUNDED_JOB_RE = /^Backgrounded as job ([A-Za-z0-9._:-]+)/m
const CANCELLED_JOB_RE = /\bCancelled background job ([A-Za-z0-9._:-]+)/g
const ALREADY_JOB_RE = /\bBackground job ([A-Za-z0-9._:-]+)(?:[^\r\n]*?)\s+(?:is already|has|was)\s+(completed|failed|cancelled)\b/gi
const JOBS_LINE_RE = /^\[([A-Za-z0-9._:-]+)\]\s+([^\s(]+)\s+\((running|completed|failed|cancelled)\)(?:\s+[—-]\s+([^\n]+))?/gm
const ASYNC_SECTION_RE = /^##\s+(Completed|Failed|Cancelled)\b(?:\s*\(([^)]+)\))?/gim
const ASYNC_JOB_ID_RE = /\bjob(?:\s+id)?[:=\s`]+([A-Za-z0-9._:-]+)/gi

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function summarizeToolArgs(args: unknown, fallback: string): string {
  const record = asRecord(args)
  if (!record) return fallback
  for (const key of ['command', 'description', 'intent', 'label', 'task', 'path', 'url', 'query']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) {
      const singleLine = candidate.trim().replace(/\s+/g, ' ')
      return singleLine.length > 140 ? `${singleLine.slice(0, 140)}…` : singleLine
    }
  }
  return fallback
}

function normalizeStatus(raw: string): OmpBackgroundTaskStatus {
  const lower = raw.toLowerCase()
  if (lower === 'failed') return 'failed'
  if (lower === 'cancelled') return 'cancelled'
  if (lower === 'running') return 'running'
  return 'completed'
}

/** One replayable background-task mutation. Collected from an immutable
 * message once, then re-applied to the live job map on later derivations, so
 * completed history never re-runs its regular expressions during streaming. */
type TaskOp =
  | { op: 'upsertJob'; id: string; type: string; status: OmpBackgroundTaskStatus; detail?: string; title?: string }
  | { op: 'status'; id: string; status: OmpBackgroundTaskStatus }

function markJobTerminalStatus(jobs: Map<string, OmpBackgroundTask>, id: string, status: OmpBackgroundTaskStatus): void {
  const existing = jobs.get(id)
  if (!existing) return
  existing.status = status
  existing.cancellable = status === 'running'
}

function applyTaskOps(jobs: Map<string, OmpBackgroundTask>, ops: readonly TaskOp[]): void {
  for (const op of ops) {
    if (op.op === 'status') {
      markJobTerminalStatus(jobs, op.id, op.status)
      continue
    }
    const existing = jobs.get(op.id)
    jobs.set(op.id, {
      id: op.id,
      kind: 'job',
      title: op.title || existing?.title || op.id,
      type: op.type || existing?.type || 'job',
      status: op.status,
      detail: op.detail || existing?.detail,
      cancellable: op.status === 'running',
    })
  }
}

function collectStatusOps(text: string): TaskOp[] {
  const ops: TaskOp[] = []
  if (!text) return ops

  for (const jobMatch of text.matchAll(JOBS_LINE_RE)) {
    const [, id, type, statusRaw, elapsed] = jobMatch
    const afterLine = text.slice((jobMatch.index ?? 0) + jobMatch[0].length)
    const nextLine = /^\r?\n\s+([^\r\n]+)/.exec(afterLine)?.[1]?.trim()
    ops.push({ op: 'upsertJob', id, type, status: normalizeStatus(statusRaw), detail: elapsed?.trim(), title: nextLine })
  }

  for (const cancelMatch of text.matchAll(CANCELLED_JOB_RE)) {
    ops.push({ op: 'status', id: cancelMatch[1], status: 'cancelled' })
  }

  for (const alreadyMatch of text.matchAll(ALREADY_JOB_RE)) {
    ops.push({ op: 'status', id: alreadyMatch[1], status: normalizeStatus(alreadyMatch[2]) })
  }

  if (text.includes('## Completed') || text.includes('## Failed') || text.includes('## Cancelled')) {
    let sectionStatus: OmpBackgroundTaskStatus | null = null
    const lines = text.split(/\r?\n/)
    for (const line of lines) {
      ASYNC_SECTION_RE.lastIndex = 0
      const header = ASYNC_SECTION_RE.exec(line)
      if (header) {
        sectionStatus = normalizeStatus(header[1])
        const idInHeader = header[2]?.trim()
        if (idInHeader) ops.push({ op: 'status', id: idInHeader, status: sectionStatus })
        continue
      }
      if (!sectionStatus) continue
      const bulletMatch = /^[-*]\s+`?([A-Za-z0-9._:-]+)`?/.exec(line.trim())
      if (bulletMatch) ops.push({ op: 'status', id: bulletMatch[1], status: sectionStatus })
      for (const idMatch of line.matchAll(ASYNC_JOB_ID_RE)) {
        ops.push({ op: 'status', id: idMatch[1], status: sectionStatus })
      }
    }
  }
  return ops
}

interface MessageTaskOps {
  ops: TaskOp[]
  activeTools: OmpBackgroundTask[]
}

/**
 * Ops for one message. Completed messages yield a stable op list that callers
 * cache; the streaming message is collected live because its open tool calls
 * depend on the current `isStreaming` pass.
 */
function collectMessageTaskOps(parts: readonly MessagePart[], messageStreaming: boolean, messageId: string): MessageTaskOps {
  const ops: TaskOp[] = []
  const activeTools: OmpBackgroundTask[] = []
  const openToolCalls: Array<{ part: Extract<MessagePart, { type: 'toolCall' }>; index: number }> = []
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part.type === 'toolCall') {
      openToolCalls.push({ part, index })
      continue
    }
    if (part.type === 'toolResult') {
      const matched = part.name
        ? [...openToolCalls].reverse().findIndex((entry) => entry.part.name === part.name)
        : openToolCalls.length - 1
      const callEntry = matched >= 0
        ? openToolCalls.splice(part.name ? openToolCalls.length - 1 - matched : openToolCalls.length - 1, 1)[0]
        : openToolCalls.pop()
      const jobMatch = BACKGROUNDED_JOB_RE.exec(part.text)
      if (jobMatch) {
        const jobId = jobMatch[1]
        const toolName = callEntry?.part.name ?? part.name ?? 'job'
        ops.push({
          op: 'upsertJob',
          id: jobId,
          type: toolName,
          status: 'running',
          title: callEntry ? summarizeToolArgs(callEntry.part.args, jobId) : jobId,
        })
      }
      ops.push(...collectStatusOps(part.text))
      continue
    }
    if (part.type === 'text' || part.type === 'agentMessage') {
      ops.push(...collectStatusOps(part.text))
    }
  }

  if (messageStreaming) {
    for (const { part, index } of openToolCalls) {
      activeTools.push({
        id: part.id ?? `${messageId}:tool:${index}`,
        kind: 'tool',
        title: summarizeToolArgs(part.args, part.name),
        type: part.name,
        status: 'running',
        cancellable: true,
      })
    }
  }
  return { ops, activeTools }
}

/** Completed messages are immutable, so their op list is collected once. Weak
 * keys let a trimmed or replaced message be reclaimed by GC. */
const completedMessageOps = new WeakMap<TranscriptMessage, TaskOp[]>()

/**
 * Derives currently active (and recently tracked) OMP background work for the
 * active session: async background jobs (`/jobs`, `Backgrounded as job ...`),
 * in-flight tool executions in a live turn, direct `!` bash runs, and active
 * project run/setup scripts. Schedules are intentionally excluded.
 */
export function deriveOmpBackgroundTasks({
  messages,
  isStreaming = false,
  commandOutputHistory = [],
  activeProjectScript,
}: DeriveOmpBackgroundTasksInput): OmpBackgroundTask[] {
  const jobs = new Map<string, OmpBackgroundTask>()
  const activeTools: OmpBackgroundTask[] = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const messageStreaming = Boolean(message.streaming || (isStreaming && index === messages.length - 1 && message.role === 'assistant'))
    if (messageStreaming) {
      const live = collectMessageTaskOps(message.parts, true, message.id)
      applyTaskOps(jobs, live.ops)
      activeTools.push(...live.activeTools)
      continue
    }
    let ops = completedMessageOps.get(message)
    if (!ops) {
      ops = collectMessageTaskOps(message.parts, false, message.id).ops
      completedMessageOps.set(message, ops)
    }
    applyTaskOps(jobs, ops)
  }

  for (let index = commandOutputHistory.length - 1; index >= 0; index -= 1) {
    const entry = commandOutputHistory[index]
    if (entry.text) applyTaskOps(jobs, collectStatusOps(entry.text))
  }

  const tasks: OmpBackgroundTask[] = []
  if (activeProjectScript) {
    tasks.push({
      id: `script:${activeProjectScript.runId}`,
      kind: 'script',
      title: activeProjectScript.command,
      type: activeProjectScript.kind,
      status: 'running',
      cancellable: true,
    })
  }
  // Only the newest entry can still be running. A turn that ended without a
  // matching finish event leaves older entries marked running forever, and the
  // panel used to list that pile of dead bash rows as live work.
  const runningBash = commandOutputHistory[0]
  if (runningBash && runningBash.status === 'running') {
    tasks.push({
      id: `bash:${runningBash.id}`,
      kind: 'bash',
      title: runningBash.command ?? 'bash',
      type: 'bash',
      status: 'running',
      cancellable: Boolean(runningBash.onAbort),
    })
  }
  tasks.push(...activeTools)
  const jobList = [...jobs.values()]
  tasks.push(...jobList.filter((job) => job.status === 'running'))
  tasks.push(...jobList.filter((job) => job.status !== 'running'))
  return tasks
}
