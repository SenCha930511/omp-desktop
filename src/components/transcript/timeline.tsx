import { Check, ChevronDown, ChevronRight, CircleAlert, Copy, FileCode2, GitFork, Globe2, LoaderCircle, MessageCircle, MessageCircleQuestion, Sparkles, TerminalSquare, Wrench } from 'lucide-react'
import { type ReactNode, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { writeClipboardText } from '@/lib/clipboard'
import { useI18n } from '@/lib/i18n'
import { boundText } from '@/lib/render-bounds'
import type { MessagePart, TranscriptMessage } from '@/types/api'
import { MarkdownText } from '../MarkdownText'
import { ReasoningDisclosure, ReasoningExpandedContext } from '../ReasoningDisclosure'
import { ImagePart, UnsupportedAttachment } from './attachment-part'
import { SyntaxText } from './syntax'
import { SearchRevealContext } from '../TranscriptSearch'
import { CompactionSyncRetry } from './compaction-sync-retry'


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

function ReasoningPart({ part, live = false }: { part: Extract<MessagePart, { type: 'thinking' }>; live?: boolean }) {
  const { t } = useI18n()
  // dsh keeps the reasoning header ("思考 · first line") attached even while a
  // section renders expanded content; the body indents under that title.
  // `live` marks the row the agent is writing right now: only it sweeps and
  // ticks its preview along the tail — earlier rows stay settled.
  return (
    <ReasoningDisclosure className="activity-line activity-line--reasoning activity-reasoning" preview={boundText(plainPreview(part.text, live), 180, '…')} streaming={live}>
      <MarkdownText text={boundText(part.text, 40_000, t('transcript.reasoning.truncated'))} streaming={live} />
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
        <span className={`activity-line__kind${state === 'running' ? ' shine-sweep' : ''}`}>{kind === 'question' ? t('transcript.tool.questionKind') : part.name}</span>
        {preview ? (
          <code className={`activity-tool__preview${state === 'running' && !open ? ' shine-sweep' : ''}`}>
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
              <LoaderCircle className="spin" size={12} /> <span className="shine-sweep">{t('transcript.tool.state.running')}</span>
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

/** 工具輸出的圖片 part（alt 走 i18n，與使用者附件區分來源）。 */
function ToolImagePart({ part }: { part: Extract<MessagePart, { type: 'image' }> }) {
  const { t } = useI18n()
  return <ImagePart part={part} alt={t('transcript.image.toolOutput')} />
}

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
  // Claude-Code style: compaction is a quiet centered divider line in the
  // conversation flow — icon, label, token delta — never a card or a chip.
  const label =
    part.status === 'running'
      ? t('transcript.compaction.running')
      : part.status === 'sync_pending'
        ? t('transcript.compaction.syncPending')
        : part.status === 'done'
          ? part.outcome === 'skipped' ? t('transcript.compaction.skipped') : t('transcript.compaction.done')
          : part.status === 'cancelled' ? t('transcript.compaction.cancelled') : t('transcript.compaction.failed')
  const tokenLabel = part.tokensBefore === undefined
    ? ''
    : part.tokensAfter !== undefined
      ? t('transcript.compaction.tokens', {
          before: part.tokensBefore.toLocaleString(),
          after: part.tokensAfter.toLocaleString(),
          percent: part.tokensBefore > 0 ? Math.max(1, Math.round((part.tokensAfter / part.tokensBefore) * 100)) : 0,
        })
      : t('transcript.compaction.tokensBefore', { count: part.tokensBefore.toLocaleString() })
  return (
    <div className={`compaction-divider is-${part.status}`} role="note">
      <span className="compaction-divider__rule" aria-hidden="true" />
      <span className="compaction-divider__label">
        {part.status === 'running' ? <LoaderCircle className="spin" size={11} /> : <Sparkles size={11} />}
        {label}{tokenLabel ? ` · ${tokenLabel}` : ''}
        {part.status === 'sync_pending' ? <CompactionSyncRetry /> : null}
      </span>
      <span className="compaction-divider__rule" aria-hidden="true" />
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
  // A running section once marked every pending row live, so backgrounded
  // commands and earlier thinking rows all swept in unison. Now settled
  // thinking rows stay quiet — only the newest one (the row the agent is
  // writing) may shine — while running tools sweep on their own running
  // state regardless of position.
  let lastLiveIndex = -1
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if ((part.type === 'thinking' && showReasoning) || (part.type === 'toolCall' && showTools)) lastLiveIndex = index
  }
  return (
    <div className="work-timeline">
      {parts.map((part, index) => {
        const key = partKey(part, index)
        const live = streaming && index === lastLiveIndex
        if (part.type === 'toolResult' && pairedResults.has(index)) return null
        if (part.type === 'compaction') return <CompactionPart key={key} part={part} />
        if (part.type === 'thinking') return showReasoning ? <ReasoningPart key={key} part={part} live={live} /> : null
        if (part.type === 'toolCall') {
          if (!showTools) return null
          const next = parts[index + 1]
          if (next?.type === 'toolResult') pairedResults.add(index + 1)
          return <ToolPart key={key} part={part} next={next} streaming={streaming} />
        }
        if (part.type === 'toolResult') return showTools ? <StandaloneToolResult key={key} part={part} /> : null
        if (part.type === 'agentMessage') return <AgentActivityPart key={key} part={part} />
        // 工具結果的圖片輸出與未知附件保持可見；先前無分支會回 null 直接消失。
        if (part.type === 'image') return showTools ? <ToolImagePart key={key} part={part} /> : null
        if (part.type === 'unsupported') return <UnsupportedAttachment key={key} contentType={part.contentType} data={part.data} />
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
    if (status || part.type === 'image' || part.type === 'unsupported') continue
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
  // Running work is always expanded: the live tool timeline is the turn's
  // main content, so there is no collapse control while it streams. When the
  // turn completes the disclosure folds back to the compact "worked" summary
  // — only the final output stays visible around it — and remains
  // expandable for review.
  const [manualOpen, setOpen] = useState(defaultExpanded)
  // The entrance ramp plays only for user-initiated opens. A remount with the
  // disclosure already open (agent reselect, session switch) must stay static:
  // the height ramp shifts layout under a restored scroll offset.
  const userToggledRef = useRef(false)
  const reveal = useContext(SearchRevealContext)
  const open = running || manualOpen || reveal
  useEffect(() => { if (!running) setOpen(defaultExpanded) }, [running, defaultExpanded])
  const status = liveWorkStatus(message.parts, showReasoning, showTools)
  const toolCount = parts.filter((part) => part.type === 'toolCall').length
  const startedAt = timestamp(message.startedAt ?? message.timestamp) ?? 0
  const completedAt = timestamp(message.completedAt) ?? startedAt
  const duration = formatWorkedDuration(Math.max(0, completedAt - startedAt))
  return (
    <section className={`work-disclosure ${running ? 'is-running' : ''}`} aria-label={t('transcript.work.aria')}>
      {running ? (
        <div className="work-disclosure__button" role="status">
          <span className="shine-sweep">{status === 'Thinking' ? t('transcript.workStatus.thinking') : t('transcript.workStatus.working')}</span>
          {toolCount > 0 && <span className="work-disclosure__count">{t('transcript.work.tools', { count: toolCount })}</span>}
          <LiveElapsed since={message.startedAt ?? message.timestamp} />
          <LoaderCircle size={12} className="spin" />
        </div>
      ) : (
        <button type="button" className="work-disclosure__button" onClick={() => { userToggledRef.current = true; setOpen((value) => !value) }} aria-expanded={open}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>{t('transcript.work.workedFor', { duration })}</span>
          {toolCount > 0 && <span className="work-disclosure__count">{t('transcript.work.tools', { count: toolCount })}</span>}
        </button>
      )}
      {open ? (
        <div className={`accordion-grid is-open${userToggledRef.current ? ' is-animated' : ''}`}>
          <div className="accordion-grid__inner">
            <WorkTimeline parts={parts} showReasoning={showReasoning} showTools={showTools} streaming={running} />
          </div>
        </div>
      ) : null}
    </section>
  )
}
