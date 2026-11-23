import { type CSSProperties, type FocusEvent, memo, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import type { MessagePart, TranscriptMessage } from '@/types/api'
import './transcript-trajectory.css'

export interface TrajectoryTurn {
  id: string
  messageIndex: number
  prompt: string
  hasImagePrompt: boolean
  reply: string
  hasActivity: boolean
  streaming: boolean
  timestamp?: string | number
}

interface TranscriptTrajectoryProps {
  messages: readonly TranscriptMessage[]
  scrollRef: RefObject<HTMLDivElement | null>
  onJumpToIndex(messageIndex: number, messageId: string): void
  active?: boolean
}

const PROMPT_PREVIEW_LIMIT = 120
const REPLY_PREVIEW_LIMIT = 160
const DENSE_THRESHOLD = 28
// A preview shows at most 160 characters. Scanning the first few KiB keeps
// long tool output and code blocks out of eight full-text regex passes.
const PREVIEW_SOURCE_LIMIT = 4_096

interface MessagePreview {
  prompt: string
  hasImagePrompt: boolean
  reply: string
  hasActivity: boolean
}

// Keyed by message identity. The reducer and transcript parser replace message
// objects on change; callers must not mutate parts in place.
const messagePreviewCache = new WeakMap<TranscriptMessage, MessagePreview>()
const timeFormatters = new Map<string, Intl.DateTimeFormat>()

function stripMarkdownPreview(raw: string): string {
  const bounded = raw.length > PREVIEW_SOURCE_LIMIT ? raw.slice(0, PREVIEW_SOURCE_LIMIT) : raw
  return bounded
    .replace(/```[\w-]*\s*/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncatePreview(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1).trimEnd()}…`
}

function messageParts(message: TranscriptMessage): readonly MessagePart[] {
  return Array.isArray(message.parts) ? message.parts : []
}

function collectTextParts(message: TranscriptMessage, limit: number): string {
  const chunks: string[] = []
  let length = 0
  for (const part of messageParts(message)) {
    if ((part.type === 'text' || part.type === 'agentMessage') && typeof part.text === 'string' && part.text.trim()) {
      const remaining = limit - length
      if (remaining <= 0) break
      const text = part.text.length > remaining ? part.text.slice(0, remaining) : part.text
      chunks.push(text)
      length += text.length
      if (length >= limit) break
    }
  }
  return stripMarkdownPreview(chunks.join(' '))
}

function messagePreview(message: TranscriptMessage): MessagePreview {
  const cached = messagePreviewCache.get(message)
  if (cached) return cached
  const parts = messageParts(message)
  if (message.role === 'user') {
    const prompt = truncatePreview(collectTextParts(message, PREVIEW_SOURCE_LIMIT), PROMPT_PREVIEW_LIMIT)
    const preview = { prompt, hasImagePrompt: !prompt && parts.some((part) => part.type === 'image'), reply: '', hasActivity: false }
    messagePreviewCache.set(message, preview)
    return preview
  }
  let hasActivity = false
  for (const part of parts) {
    if (part.type === 'thinking' || part.type === 'toolCall' || part.type === 'toolResult' || part.type === 'agentMessage') {
      hasActivity = true
      break
    }
  }
  const preview = {
    prompt: '',
    hasImagePrompt: false,
    reply: truncatePreview(collectTextParts(message, PREVIEW_SOURCE_LIMIT), REPLY_PREVIEW_LIMIT),
    hasActivity,
  }
  messagePreviewCache.set(message, preview)
  return preview
}

function sameTurn(left: TrajectoryTurn, right: TrajectoryTurn): boolean {
  return left.id === right.id
    && left.messageIndex === right.messageIndex
    && left.prompt === right.prompt
    && left.hasImagePrompt === right.hasImagePrompt
    && left.reply === right.reply
    && left.hasActivity === right.hasActivity
    && left.streaming === right.streaming
    && left.timestamp === right.timestamp
}

/** Extract user turns paired with their latest assistant reply for trajectory navigation. */
export function extractTrajectoryTurns(messages: readonly TranscriptMessage[], previousTurns: readonly TrajectoryTurn[] = []): TrajectoryTurn[] {
  const turns: TrajectoryTurn[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message) continue
    if (message.role !== 'user' || message.kind === 'steer-read-marker') continue

    const preview = messagePreview(message)
    if (!preview.prompt && !preview.hasImagePrompt) continue

    let latestReply = ''
    let hasActivity = false
    let streaming = Boolean(message.streaming)

    for (let cursor = index + 1; cursor < messages.length; cursor++) {
      const candidate = messages[cursor]
      if (!candidate) continue
      if (candidate.role === 'user' && candidate.kind !== 'steer-read-marker') break
      if (candidate.streaming) streaming = true
      if (candidate.role === 'assistant' || candidate.role === 'agent') {
        const candidatePreview = messagePreview(candidate)
        if (candidatePreview.reply) latestReply = candidatePreview.reply
        if (candidatePreview.hasActivity) hasActivity = true
      } else if (candidate.role === 'tool' || candidate.role === 'goal') {
        hasActivity = true
      }
    }

    const next: TrajectoryTurn = {
      id: message.id,
      messageIndex: index,
      prompt: preview.prompt,
      hasImagePrompt: preview.hasImagePrompt,
      reply: latestReply,
      hasActivity,
      streaming,
      timestamp: message.timestamp ?? message.startedAt,
    }
    const previous = previousTurns[turns.length]
    turns.push(previous && sameTurn(previous, next) ? previous : next)
  }
  return turns
}

function formatTurnTime(timestamp: string | number | undefined, locale: string): string | null {
  if (timestamp === undefined) return null
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null
  try {
    let formatter = timeFormatters.get(locale)
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' })
      timeFormatters.set(locale, formatter)
    }
    return formatter.format(date)
  } catch {
    return null
  }
}

function resolveActiveTurnFromScroll(container: HTMLDivElement, turns: readonly TrajectoryTurn[]): number {
  if (turns.length === 0) return 0
  const elements = new Map<string, HTMLElement>()
  for (const node of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const id = node.dataset.messageId
    if (id) elements.set(id, node)
  }
  if (elements.size === 0) return turns.length - 1

  const containerRect = container.getBoundingClientRect()
  const anchorY = containerRect.top + Math.min(140, Math.max(48, containerRect.height * 0.28))

  let lastMounted = -1
  let firstMounted = -1
  let active = -1

  for (let index = 0; index < turns.length; index++) {
    const element = elements.get(turns[index].id)
    if (!element) continue
    if (firstMounted === -1) firstMounted = index
    lastMounted = index
    if (element.getBoundingClientRect().top <= anchorY) active = index
  }

  const remainingBottom = container.scrollHeight - container.clientHeight - container.scrollTop
  if (container.scrollHeight > container.clientHeight && remainingBottom <= 24 && lastMounted !== -1) {
    return lastMounted
  }
  if (active !== -1) return active
  if (firstMounted !== -1) return firstMounted
  return turns.length - 1
}

function TranscriptTrajectoryView({ messages, scrollRef, onJumpToIndex, active = true }: TranscriptTrajectoryProps) {
  const { locale, t } = useI18n()
  const turnsRef = useRef<TrajectoryTurn[]>([])
  const turns = useMemo(() => {
    const next = extractTrajectoryTurns(messages, turnsRef.current)
    turnsRef.current = next
    return next
  }, [messages])
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, turns.length - 1))
  const [previewState, setPreviewState] = useState<{ index: number; topPx?: number } | null>(null)
  const navRef = useRef<HTMLElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const dotRefs = useRef(new Map<number, HTMLButtonElement>())

  const clampedActiveIndex = turns.length === 0 ? 0 : Math.min(activeIndex, turns.length - 1)

  useEffect(() => {
    setActiveIndex((current) => (turns.length === 0 ? 0 : Math.min(current, turns.length - 1)))
  }, [turns.length])

  useEffect(() => {
    const container = scrollRef.current
    if (!active || !container || turns.length < 2) return

    let frame: number | undefined
    const sync = () => {
      frame = undefined
      setActiveIndex(resolveActiveTurnFromScroll(container, turnsRef.current))
    }
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(sync)
    }

    sync()
    container.addEventListener('scroll', schedule, { passive: true })
    return () => {
      container.removeEventListener('scroll', schedule)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [active, scrollRef, turns.length])

  useEffect(() => {
    const rail = railRef.current
    const dot = dotRefs.current.get(clampedActiveIndex)
    if (!rail || !dot || rail.clientHeight <= 0 || rail.scrollHeight <= rail.clientHeight) return
    const top = dot.offsetTop
    const bottom = top + dot.offsetHeight
    if (top < rail.scrollTop) rail.scrollTop = Math.max(0, top - 8)
    else if (bottom > rail.scrollTop + rail.clientHeight) rail.scrollTop = bottom - rail.clientHeight + 8
  }, [clampedActiveIndex])

  const showPreview = useCallback((index: number, dot: HTMLButtonElement) => {
    const nav = navRef.current
    if (!nav) {
      setPreviewState({ index })
      return
    }
    const navRect = nav.getBoundingClientRect()
    const dotRect = dot.getBoundingClientRect()
    const topPx = navRect.height > 0 && dotRect.height > 0 ? Math.max(24, Math.min(navRect.height - 24, dotRect.top + dotRect.height / 2 - navRect.top)) : undefined
    setPreviewState({ index, topPx })
  }, [])

  const clearPreview = useCallback(() => {
    setPreviewState(null)
  }, [])

  const handleBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && navRef.current?.contains(event.relatedTarget)) return
    setPreviewState(null)
  }, [])

  const handleSelect = useCallback(
    (index: number, turn: TrajectoryTurn) => {
      setActiveIndex(index)
      onJumpToIndex(turn.messageIndex, turn.id)
    },
    [onJumpToIndex],
  )

  if (turns.length < 2) return null

  const previewIndex = previewState && previewState.index < turns.length ? previewState.index : null
  const previewTurn = previewIndex === null ? null : turns[previewIndex]
  const previewTime = previewTurn ? formatTurnTime(previewTurn.timestamp, locale) : null
  const previewCardStyle = previewState?.topPx === undefined ? undefined : ({ '--trajectory-card-top': `${previewState.topPx}px` } as CSSProperties)
  const fallbackImageLabel = t('transcript.markdown.image', { label: t('transcript.markdown.imageFallback') })

  const resolvePromptLabel = (turn: TrajectoryTurn) => turn.prompt || (turn.hasImagePrompt ? fallbackImageLabel : '')

  return (
    <nav ref={navRef} className="transcript-trajectory" aria-label={t('transcript.trajectory.aria')} onMouseLeave={clearPreview} onBlur={handleBlur}>
      <div ref={railRef} className={`trajectory-rail ${turns.length > DENSE_THRESHOLD ? 'is-dense' : ''}`}>
        {turns.map((turn, index) => {
          const isActive = index === clampedActiveIndex
          const isPreviewed = index === previewIndex
          const promptLabel = resolvePromptLabel(turn)
          const className = [
            'trajectory-dot',
            isActive ? 'is-active' : '',
            isPreviewed ? 'is-previewed' : '',
            turn.streaming ? 'is-streaming' : '',
          ]
            .filter(Boolean)
            .join(' ')

          return (
            <button
              key={turn.id}
              ref={(element) => {
                if (element) dotRefs.current.set(index, element)
                else dotRefs.current.delete(index)
              }}
              type="button"
              className={className}
              aria-label={t('transcript.trajectory.turnAria', { current: index + 1, total: turns.length, preview: promptLabel })}
              aria-current={isActive ? 'location' : undefined}
              onMouseEnter={(event) => showPreview(index, event.currentTarget)}
              onFocus={(event) => showPreview(index, event.currentTarget)}
              onClick={() => handleSelect(index, turn)}
            >
              <span className="trajectory-dot__pip" aria-hidden="true" />
            </button>
          )
        })}
      </div>

      {previewTurn && previewIndex !== null ? (
        <div
          className="trajectory-card"
          style={previewCardStyle}
          role="presentation"
          onClick={() => handleSelect(previewIndex, previewTurn)}
        >
          <p className="trajectory-card__prompt">{resolvePromptLabel(previewTurn)}</p>
          <p className={`trajectory-card__reply ${previewTurn.reply ? '' : 'is-muted'}`}>
            {previewTurn.reply || (previewTurn.streaming ? t('transcript.trajectory.streaming') : t('transcript.trajectory.noReply'))}
          </p>
          <div className="trajectory-card__meta">
            <span className="trajectory-card__counter">
              {previewTurn.streaming ? <span className="trajectory-card__live-dot" aria-hidden="true" /> : null}
              <span>{t('transcript.trajectory.counter', { current: previewIndex + 1, total: turns.length })}</span>
            </span>
            {previewTime ? <time>{previewTime}</time> : null}
          </div>
        </div>
      ) : null}
    </nav>
  )
}

export const TranscriptTrajectory = memo(TranscriptTrajectoryView)
