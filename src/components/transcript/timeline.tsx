import { Check, ChevronDown, ChevronRight, CircleAlert, Copy, FileCode2, GitFork, Globe2, Layers3, LoaderCircle, MessageCircle, MessageCircleQuestion, TerminalSquare, Wrench } from 'lucide-react'
import { type ReactNode, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { writeClipboardText } from '@/lib/clipboard'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { boundText } from '@/lib/render-bounds'
import type { MessagePart, TranscriptMessage } from '@/types/api'
import { MarkdownText } from '../MarkdownText'
import { ReasoningDisclosure, ReasoningExpandedContext } from '../ReasoningDisclosure'
import { SyntaxText } from './syntax'
import { SearchRevealContext } from '../TranscriptSearch'

const COMPACTION_REASON_KEYS = {
  threshold: 'transcript.compaction.reason.threshold',
  overflow: 'transcript.compaction.reason.overflow',
  requested: 'transcript.compaction.reason.requested',
  manual: 'transcript.compaction.reason.manual',
  context: 'transcript.compaction.reason.context',
} as const satisfies Record<string, MessageKey>

function timestamp(value?: string | number): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function formatWorkedDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes === 0) return `${seconds}s`
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  if (hours === 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`
}

export type ToolKind = 'question' | 'terminal' | 'web' | 'git' | 'file' | 'mcp'

export function classifyTool(name: string): ToolKind {
  if (/ask[_\s.-]?user|ask\s+(?:a\s+)?question|ui\.select|request[_\s.-]?input/i.test(name)) return 'question'
  if (/bash|shell|terminal|command|exec|process/i.test(name)) return 'terminal'
  if (/github|\bgit\b|commit|branch|pull[_\s-]?request/i.test(name)) return 'git'
  if (/browser|web[_\s.-]?search|search[_\s.-]?web|fetch|https?|url|globe/i.test(name)) return 'web'
  if (/read|write|edit|file|path|directory|patch/i.test(name)) return 'file'
  return 'mcp'
}

function toolIcon(kind: ToolKind): ReactNode {
  if (kind === 'question') return <MessageCircleQuestion size={14} />
  if (kind === 'terminal') return <TerminalSquare size={14} />
  if (kind === 'web') return <Globe2 size={14} />
  if (kind === 'git') return <GitFork size={14} />
  if (kind === 'file') return <FileCode2 size={14} />
  return <Wrench size={14} />
}

function serialize(value: unknown, pretty = false): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, pretty ? 2 : undefined)
  } catch {
    return String(value)
  }
}

function toolPreview(part: Extract<MessagePart, { type: 'toolCall' }>): string {
  const raw = part.args
  if (raw && typeof raw === 'object') {
    const args = raw as Record<string, unknown>
    // A grouped ask_user payload names every question; collapsing them keeps
    // the summary scannable without spilling the option list.
    if (Array.isArray(args.questions)) {
      const labels = args.questions
        .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>).question : undefined))
        .map((label) => (typeof label === 'string' ? label.trim() : ''))
        .filter((label) => label !== '')
      if (labels.length > 0) return boundText(labels.join(' · '), 150, '…')
    }
    const preferred = args.question ?? args.command ?? args.query ?? args.url ?? args.path ?? args.cwd ?? args.code ?? args.input
    if (typeof preferred === 'string') return boundText(preferred.replace(/\s+/g, ' ').trim(), 120, '…')
  }
  return boundText(serialize(raw).replace(/\s+/g, ' ').trim(), 120, '…')
}

/** First line of the settled thinking text — dsh's collapsed-row summary. */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** Tail of the live stream — the collapsed row acts like a ticker. It
 * re-anchors at every sentence boundary (CJK or ASCII terminal marks), so
 * each finished sentence swaps the preview to the sentence just starting,
 * and long sentences keep scrolling from their tail. */
function tailLine(text: string): string {
  const trimmed = text.replace(/\s+$/, '')
  const newline = trimmed.lastIndexOf('\n')
  const line = newline === -1 ? trimmed : trimmed.slice(newline + 1)
  let cut = -1
  for (const match of line.matchAll(/[。！？!?；;]|[.!?](?=\s|$)/g)) cut = match.index + match[0].length
  const tail = cut === -1 ? line : line.slice(cut).trimStart()
  return tail || line
}

/** Collapse a thinking blob into one plain-text preview line: settled rows
 * lead with the first line, streaming rows tick along with the live tail. */
function plainPreview(text: string, running: boolean): string {
  const line = running ? tailLine(text) : firstLine(text)
  return line.replace(/(\*\*|__|~~|`+)|(?<=\s)[#>*_]+/g, '').replace(/\s+/g, ' ').trim()
}

function ReasoningPart({ part, streaming = false }: { part: Extract<MessagePart, { type: 'thinking' }>; streaming?: boolean }) {
  const { t } = useI18n()
  // dsh keeps the reasoning header ("思考 · first line") attached even while a
  // section renders expanded content; the body indents under that title.
  return (
    <ReasoningDisclosure className="activity-line activity-line--reasoning activity-reasoning" preview={boundText(plainPreview(part.text, streaming), 180, '…')} streaming={streaming}>
      <MarkdownText text={boundText(part.text, 40_000, t('transcript.reasoning.truncated'))} streaming={streaming} />
    </ReasoningDisclosure>
  )
}

export function ThinkingDots({ labelled = false }: { labelled?: boolean }) {
  const { t } = useI18n()
  return (
    <span className="thinking-dots" role={labelled ? 'status' : undefined} aria-label={labelled ? t('transcript.thinking.aria') : undefined} aria-hidden={labelled ? undefined : true}>
      <span />
      <span />
      <span />
    </span>
  )
}

/**
 * Self-ticking elapsed clock for a live work phase. The timer lives inside
 * this leaf component so only the small label re-renders every second, not
 * the whole transcript row. `aria-hidden` keeps the 1-second churn out of
 * screen-reader announcements; the neighbouring state text already carries
 * the semantic (thinking/working), the duration is decorative.
 */
export function LiveElapsed({ since }: { since?: string | number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [])
  const startedAt = timestamp(since)
  if (startedAt === undefined) return null
  return (
    <span className="live-elapsed" aria-hidden="true">
      {formatWorkedDuration(Math.max(0, now - startedAt))}
    </span>
  )
}

const ToolPart = memo(function ToolPart({ part, next, streaming }: { part: Extract<MessagePart, { type: 'toolCall' }>; next?: MessagePart; streaming: boolean }) {
  const { t } = useI18n()
  const [manualOpen, setOpen] = useState(false)
  const reveal = useContext(SearchRevealContext)
  const open = manualOpen || reveal
  const [copied, setCopied] = useState(false)
  const resetCopiedTimerRef = useRef<number | null>(null)
  const result = next?.type === 'toolResult' ? next : undefined
  const failed = result?.isError
  const finished = result && !result.streaming
  const kind = classifyTool(part.name)
  const output = result?.text ?? ''
  const visibleOutput = useMemo(() => {
    if (!open) return ''
    const args = serialize(part.args, true)
    return boundText(`${args}${args && output ? '\n\n' : ''}${output}`, 200_000, t('transcript.tool.outputTruncated'))
  }, [open, part.args, output, t])
  const canExpand = Boolean(output || (part.args !== undefined && part.args !== ''))
  const state = failed ? 'error' : finished ? 'done' : !streaming ? 'unknown' : kind === 'question' ? 'waiting' : 'running'
  const preview = toolPreview(part)
  useEffect(
    () => () => {
      if (resetCopiedTimerRef.current !== null) window.clearTimeout(resetCopiedTimerRef.current)
    },
    [],
  )

  const copyContents = async () => {
    try {
      await writeClipboardText(visibleOutput)
      setCopied(true)
      if (resetCopiedTimerRef.current !== null) window.clearTimeout(resetCopiedTimerRef.current)
      resetCopiedTimerRef.current = window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className={`activity-line activity-line--tool activity-line--${kind} is-${state}`}>
      <button type="button" className="activity-tool__summary" disabled={!canExpand} onClick={() => setOpen((value) => !value)} aria-expanded={canExpand ? open : undefined}>
        <span className="activity-line__icon">{toolIcon(kind)}</span>
        <span className="activity-line__kind">{kind === 'question' ? t('transcript.tool.questionKind') : part.name}</span>
        {preview ? (
          <code className="activity-tool__preview">
            <SyntaxText text={preview} />
          </code>
        ) : null}
        <span className="activity-tool__state">
          {failed ? (
            <CircleAlert size={12} aria-label={t('transcript.tool.state.failed')} role="img" />
          ) : finished ? (
            <Check size={12} aria-label={t('transcript.tool.state.done')} role="img" />
          ) : !streaming ? (
            t('transcript.tool.state.noResult')
          ) : kind === 'question' ? (
            t('transcript.tool.state.needsInput')
          ) : (
            <>
              <LoaderCircle className="spin" size={12} /> {t('transcript.tool.state.running')}
            </>
          )}
        </span>
        {canExpand ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
      </button>
      {open && visibleOutput ? (
        <div className="activity-tool__details">
          <div className="activity-tool__details-toolbar">
            <button type="button" className={`activity-tool__copy${copied ? ' is-copied' : ''}`} aria-label={copied ? t('transcript.tool.copiedContents') : t('transcript.tool.copyContents')} onClick={() => void copyContents()}>
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? t('transcript.copied.label') : t('transcript.copy.label')}
            </button>
          </div>
          <pre className="activity-tool__contents">
            <SyntaxText text={visibleOutput} />
          </pre>
        </div>
      ) : null}
    </div>
  )
})

function StandaloneToolResult({ part }: { part: Extract<MessagePart, { type: 'toolResult' }> }) {
  return (
    <div className={`activity-line activity-line--result ${part.isError ? 'is-error' : ''}`}>
      <span className="activity-line__icon">{part.isError ? <CircleAlert size={13} /> : <Check size={13} />}</span>
      <span>{boundText(part.text, 2_000, '…')}</span>
    </div>
  )
}

function AgentActivityPart({ part }: { part: Extract<MessagePart, { type: 'agentMessage' }> }) {
  const { t } = useI18n()
  const [manualOpen, setOpen] = useState(false)
  const reveal = useContext(SearchRevealContext)
  const open = manualOpen || reveal
  const canExpand = Boolean(part.text)
  return (
    <div className="activity-line activity-line--agent">
      <button type="button" className="activity-tool__summary" disabled={!canExpand} onClick={() => setOpen((value) => !value)} aria-expanded={canExpand ? open : undefined}>
        <span className="activity-line__icon">
          <MessageCircle size={14} />
        </span>
        <span className="activity-line__kind">{t('transcript.agent.summary')}</span>
        {part.agentName ? <span className="activity-agent__name">{part.agentName}</span> : null}
        {canExpand ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
      </button>
      {open && part.text ? (
        <div className="activity-agent__details">
          <MarkdownText text={boundText(part.text, 40_000, t('transcript.agent.truncated'))} />
        </div>
      ) : null}
    </div>
  )
}

function CompactionPart({ part }: { part: Extract<MessagePart, { type: 'compaction' }> }) {
  const { t } = useI18n()
  // A static status row: no expansion. The expandable details panel below
  // used to open with an empty summary and read as a stray input box; the
  // condensed summary adds nothing the transcript itself does not carry, and
  // the failure state is already announced by the CircleAlert state label.
  const label =
    part.status === 'running'
      ? t('transcript.compaction.running')
      : part.status === 'done'
        ? t('transcript.compaction.done')
        : part.status === 'cancelled'
          ? t('transcript.compaction.cancelled')
          : part.outcome === 'skipped'
            ? t('transcript.compaction.skipped')
            : t('transcript.compaction.failed')
  const state =
    part.status === 'running' ? (
      <>
        <LoaderCircle className="spin" size={12} /> {t('transcript.compaction.state.running')}
      </>
    ) : part.status === 'done' ? (
      <>
        <Check size={12} /> {part.willRetry ? t('transcript.compaction.state.continuing') : t('transcript.compaction.state.done')}
      </>
    ) : (
      <>
        <CircleAlert size={12} /> {part.status === 'cancelled' ? t('transcript.compaction.state.cancelled') : t('transcript.compaction.state.needsAttention')}
      </>
    )
  const tokenLabel = part.tokensBefore === undefined ? '' : t('transcript.compaction.tokensBefore', { count: part.tokensBefore.toLocaleString() })
  return (
    <div className={`activity-line activity-line--compaction is-${part.status}`}>
      <div className="activity-tool__summary is-static">
        <span className="activity-line__icon">
          {part.status === 'running' ? <LoaderCircle className="spin" size={13} /> : part.status === 'done' ? <Layers3 size={13} /> : <CircleAlert size={13} />}
        </span>
        <span className="activity-line__kind">{label}</span>
        <span className="activity-compaction__reason">{t(part.reason ? COMPACTION_REASON_KEYS[part.reason] : COMPACTION_REASON_KEYS.context)}</span>
        {tokenLabel ? <span className="activity-compaction__tokens">{tokenLabel}</span> : null}
        <span className="activity-tool__state">{state}</span>
      </div>
    </div>
  )
}

/**
 * Streaming reducers splice tool results into the middle of a part list, so
 * index keys detach expanded panels mid-stream. Key on the part's stable id
 * (a tool call keeps its semantic tool id); parts loaded from disk without an
 * id fall back to a type-scoped index, which is stable for static lists.
 */
function partKey(part: MessagePart, index: number): string {
  if (part.type === 'toolCall' && part.id) return part.id
  return part.partId ?? `${part.type}:${index}`
}

export function WorkTimeline({ parts, showReasoning, showTools, streaming = false }: { parts: MessagePart[]; showReasoning: boolean; showTools: boolean; streaming?: boolean }) {
  const pairedResults = new Set<number>()
  return (
    <div className="work-timeline">
      {parts.map((part, index) => {
        const key = partKey(part, index)
        if (part.type === 'toolResult' && pairedResults.has(index)) return null
        if (part.type === 'compaction') return <CompactionPart key={key} part={part} />
        if (part.type === 'thinking') return showReasoning ? <ReasoningPart key={key} part={part} streaming={streaming} /> : null
        if (part.type === 'toolCall') {
          if (!showTools) return null
          const next = parts[index + 1]
          if (next?.type === 'toolResult') pairedResults.add(index + 1)
          return <ToolPart key={key} part={part} next={next} streaming={streaming} />
        }
        if (part.type === 'toolResult') return showTools ? <StandaloneToolResult key={key} part={part} /> : null
        if (part.type === 'agentMessage') return <AgentActivityPart key={key} part={part} />
        if (part.type === 'text') {
          // Punctuation-only chatter (a stray "·" or "…" the model emits
          // between tool calls) is a stray glyph, not narration — drop it.
          if (!/[\p{L}\p{N}]/u.test(part.text)) return null
          return (
            <div className="activity-line activity-line--note" key={key}>
              <MarkdownText text={part.text} streaming={streaming} />
            </div>
          )
        }
        return null
      })}
    </div>
  )
}

function liveWorkStatus(parts: MessagePart[], showReasoning: boolean, showTools: boolean): 'Thinking' | 'Working' {
  let status: 'Thinking' | 'Working' | undefined
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    const next = parts[index + 1]
    if (part.type === 'toolCall' && (next?.type !== 'toolResult' || next.streaming)) return 'Working'
    if (status || part.type === 'image') continue
    if (part.type === 'thinking') status = showReasoning ? 'Thinking' : undefined
    else if (showTools || (part.type !== 'toolCall' && part.type !== 'toolResult')) status = 'Working'
  }
  return status ?? 'Working'
}

export function WorkDisclosure({
  message,
  parts,
  showReasoning,
  showTools,
  running = message.streaming,
}: {
  message: TranscriptMessage
  parts: MessagePart[]
  showReasoning: boolean
  showTools: boolean
  running?: boolean
}) {
  const { t } = useI18n()
  const expandThinking = useContext(ReasoningExpandedContext)
  const defaultExpanded = expandThinking && showReasoning && parts.some((part) => part.type === 'thinking')
  // While the turn streams, notes and tool calls stay first-class content —
  // visible without opening the dropdown — and the row folds back into the
  // compact "worked" summary the moment the turn completes.
  const [manualOpen, setOpen] = useState(running || defaultExpanded)
  const reveal = useContext(SearchRevealContext)
  const open = manualOpen || reveal
  useEffect(() => setOpen(running || defaultExpanded), [running, defaultExpanded])
  const status = liveWorkStatus(message.parts, showReasoning, showTools)
  const toolCount = parts.filter((part) => part.type === 'toolCall').length
  const startedAt = timestamp(message.startedAt ?? message.timestamp) ?? 0
  const completedAt = timestamp(message.completedAt) ?? startedAt
  const duration = formatWorkedDuration(Math.max(0, completedAt - startedAt))
  return (
    <section className={`work-disclosure ${running ? 'is-running' : ''}`} aria-label={t('transcript.work.aria')}>
      <button type="button" className="work-disclosure__button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {running ? <span role="status"><span className="shine-sweep">{status === 'Thinking' ? t('transcript.workStatus.thinking') : t('transcript.workStatus.working')}</span></span> : <span>{t('transcript.work.workedFor', { duration })}</span>}
        {toolCount > 0 && <span className="work-disclosure__count">{t('transcript.work.tools', { count: toolCount })}</span>}
        {running && <LiveElapsed since={message.startedAt ?? message.timestamp} />}
        {running && !open && <LoaderCircle size={12} className="spin" />}
      </button>
      {open ? <WorkTimeline parts={parts} showReasoning={showReasoning} showTools={showTools} streaming={running} /> : null}
    </section>
  )
}
