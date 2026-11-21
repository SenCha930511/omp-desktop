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

function markJobTerminalStatus(jobs: Map<string, OmpBackgroundTask>, id: string, status: OmpBackgroundTaskStatus): void {
  const existing = jobs.get(id)
  if (!existing) return
  existing.status = status
  existing.cancellable = status === 'running'
}

function applyStatusUpdatesFromText(text: string, jobs: Map<string, OmpBackgroundTask>): void {
  if (!text) return

  for (const jobMatch of text.matchAll(JOBS_LINE_RE)) {
    const [, id, type, statusRaw, elapsed] = jobMatch
    const status = normalizeStatus(statusRaw)
    const afterLine = text.slice((jobMatch.index ?? 0) + jobMatch[0].length)
    const nextLine = /^\r?\n\s+([^\r\n]+)/.exec(afterLine)?.[1]?.trim()
    const existing = jobs.get(id)
    jobs.set(id, {
      id,
      kind: 'job',
      title: nextLine || existing?.title || id,
      type: type || existing?.type || 'job',
      status,
      detail: elapsed?.trim() || existing?.detail,
      cancellable: status === 'running',
    })
  }

  for (const cancelMatch of text.matchAll(CANCELLED_JOB_RE)) {
    markJobTerminalStatus(jobs, cancelMatch[1], 'cancelled')
  }

  for (const alreadyMatch of text.matchAll(ALREADY_JOB_RE)) {
    markJobTerminalStatus(jobs, alreadyMatch[1], normalizeStatus(alreadyMatch[2]))
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
        if (idInHeader) markJobTerminalStatus(jobs, idInHeader, sectionStatus)
        continue
      }
      if (!sectionStatus) continue
      const bulletMatch = /^[-*]\s+`?([A-Za-z0-9._:-]+)`?/.exec(line.trim())
      if (bulletMatch) markJobTerminalStatus(jobs, bulletMatch[1], sectionStatus)
      for (const idMatch of line.matchAll(ASYNC_JOB_ID_RE)) {
        markJobTerminalStatus(jobs, idMatch[1], sectionStatus)
      }
    }
  }
}

function collectPartToolCalls(
  parts: readonly MessagePart[],
  jobs: Map<string, OmpBackgroundTask>,
  activeTools: OmpBackgroundTask[],
  messageStreaming: boolean,
  messageId: string,
): void {
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
        jobs.set(jobId, {
          id: jobId,
          kind: 'job',
          title: callEntry ? summarizeToolArgs(callEntry.part.args, jobId) : jobId,
          type: toolName,
          status: 'running',
          cancellable: true,
        })
      }
      applyStatusUpdatesFromText(part.text, jobs)
      continue
    }
    if (part.type === 'text' || part.type === 'agentMessage') {
      applyStatusUpdatesFromText(part.text, jobs)
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
}

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
    collectPartToolCalls(message.parts, jobs, activeTools, messageStreaming, message.id)
  }

  for (let index = commandOutputHistory.length - 1; index >= 0; index -= 1) {
    const entry = commandOutputHistory[index]
    if (entry.text) applyStatusUpdatesFromText(entry.text, jobs)
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
  for (const entry of commandOutputHistory) {
    if (entry.status !== 'running') continue
    tasks.push({
      id: `bash:${entry.id}`,
      kind: 'bash',
      title: entry.command ?? 'bash',
      type: 'bash',
      status: 'running',
      cancellable: Boolean(entry.onAbort),
    })
  }
  tasks.push(...activeTools)
  const jobList = [...jobs.values()]
  tasks.push(...jobList.filter((job) => job.status === 'running'))
  tasks.push(...jobList.filter((job) => job.status !== 'running'))
  return tasks
}
