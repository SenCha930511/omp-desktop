import { Check, ChevronDown, ChevronRight, Copy, Target } from 'lucide-react'
import { Fragment, memo, type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react'
import { splitAnnotationBlock } from '@/lib/browser-annotations'
import { splitCapabilityRouting } from '@/lib/capability-mentions'
import { writeClipboardText } from '@/lib/clipboard'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { boundText } from '@/lib/render-bounds'
import { type RoutedSessionReference, routedSessionReferences, splitSessionRouting } from '@/lib/session-mentions'
import { splitTerminalContextBlock } from '@/lib/terminal-context'
import type { HarnessId, MessagePart, TranscriptMessage } from '@/types/api'
import { MarkdownText } from '../MarkdownText'
import { SearchRevealContext } from '../TranscriptSearch'
import { ImagePart, UnsupportedAttachment } from './attachment-part'
import { InlineText } from './syntax'
import { ThinkingDots, WorkDisclosure, WorkTimeline } from './timeline'

const MESSAGE_COPY_KEYS = {
  user: { copy: 'transcript.copy.user', copied: 'transcript.copied.user' },
  assistant: { copy: 'transcript.copy.assistant', copied: 'transcript.copied.assistant' },
  agent: { copy: 'transcript.copy.agent', copied: 'transcript.copied.agent' },
} as const satisfies Record<'user' | 'assistant' | 'agent', { copy: MessageKey; copied: MessageKey }>

function UserImagePart({ part }: { part: Extract<MessagePart, { type: 'image' }> }) {
  const { t } = useI18n()
  return <ImagePart part={part} alt={t('transcript.image.userAttachment')} />
}

function renderNarrative(parts: MessagePart[], keyPrefix: string, streaming = false) {
  return parts.map((part, index) => {
    if (part.type === 'text') return <MarkdownText key={`${keyPrefix}-${index}`} text={part.text} streaming={streaming} />
    if (part.type === 'image') return <UserImagePart key={`${keyPrefix}-${index}`} part={part} />
    return null
  })
}

function renderNarrativeWithActivity(parts: MessagePart[], keyPrefix: string, showReasoning: boolean, showTools: boolean, streaming = false) {
  const groups: Array<{ activity: boolean; parts: MessagePart[] }> = []
  for (const part of parts) {
    const activity = part.type !== 'text' && part.type !== 'image'
    const current = groups.at(-1)
    if (current?.activity === activity) current.parts.push(part)
    else groups.push({ activity, parts: [part] })
  }
  return groups.map((group, index) =>
    group.activity ? (
      <WorkTimeline key={`${keyPrefix}-activity-${index}`} parts={group.parts} showReasoning={showReasoning} showTools={showTools} streaming={streaming} />
    ) : (
      <div key={`${keyPrefix}-narrative-${index}`}>{renderNarrative(group.parts, `${keyPrefix}-${index}`, streaming)}</div>
    ),
  )
}

function isNarrative(part: MessagePart): part is Extract<MessagePart, { type: 'text' | 'image' }> {
  return part.type === 'text' || part.type === 'image'
}

/**
 * Completed turns can receive lightweight activity after their final answer.
 * Anchor the visible tail at the most substantial narrative run, preferring
 * the later run on ties, so everything after that anchor remains in order and
 * a short trailing note cannot bury a longer deliverable in the work rail.
 */
function primaryNarrativeStart(parts: MessagePart[], start: number): number {
  let bestStart = -1
  let bestScore = 0
  for (let index = start; index < parts.length; ) {
    if (!isNarrative(parts[index])) {
      index += 1
      continue
    }
    const runStart = index
    let score = 0
    while (index < parts.length && isNarrative(parts[index])) {
      const part = parts[index]
      score += part.type === 'text' ? part.text.trim().length : 1
      index += 1
    }
    if (score > 0 && score >= bestScore) {
      bestStart = runStart
      bestScore = score
    }
  }
  return bestStart
}

function messageText(message: TranscriptMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function MessageActions({ message, text: suppliedText }: { message: TranscriptMessage; text?: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)
  const text = suppliedText ?? messageText(message)
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'agent' ? 'agent' : 'user'

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    },
    [],
  )

  if (!text) return null

  const copyMessage = async () => {
    try {
      await writeClipboardText(text)
      setCopied(true)
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  const copyKeys = MESSAGE_COPY_KEYS[role]

  return (
    <div className="message-actions">
      <button type="button" className={copied ? 'is-copied' : undefined} disabled={!text} aria-label={copied ? t(copyKeys.copied) : t(copyKeys.copy)} onClick={() => void copyMessage()}>
        {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? t('transcript.copied.label') : t('transcript.copy.label')}
      </button>
    </div>
  )
}

export const AssistantMessage = memo(
  function AssistantMessage({ message, showReasoning, showTools, entering = false }: { message: TranscriptMessage; showReasoning: boolean; showTools: boolean; entering?: boolean }) {
    const { t } = useI18n()
    const isActivity = (part: MessagePart) => part.type === 'thinking' || part.type === 'toolCall' || part.type === 'toolResult' || part.type === 'agentMessage' || part.type === 'compaction'
    const firstActivity = message.parts.findIndex(isActivity)
    let lastActivity = -1
    for (let index = message.parts.length - 1; index >= 0; index -= 1) {
      if (isActivity(message.parts[index])) {
        lastActivity = index
        break
      }
    }
    const finalNarrative = firstActivity < 0 ? -1 : primaryNarrativeStart(message.parts, firstActivity + 1)
    const workEnd = finalNarrative >= 0 ? finalNarrative : lastActivity + 1
    const before = firstActivity < 0 ? message.parts : message.parts.slice(0, firstActivity)
    const work = firstActivity < 0 ? [] : message.parts.slice(firstActivity, workEnd)
    const after = firstActivity < 0 ? [] : message.parts.slice(workEnd)
    const hasVisibleActivity = work.some(
      (part) => part.type === 'agentMessage' || part.type === 'compaction' || (part.type === 'thinking' && showReasoning) || ((part.type === 'toolCall' || part.type === 'toolResult') && showTools),
    )
    const hiddenMiddleNarrative = !hasVisibleActivity ? work.filter((part) => part.type === 'text' || part.type === 'image') : []
    const copyableNarrative = hasVisibleActivity ? [...before, ...after] : [...before, ...hiddenMiddleNarrative, ...after]
    const copyableText = copyableNarrative.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
    return (
      <article className={`message message--assistant${entering ? ' message--enter' : ''}`}>
        <div className="message__content">
          {renderNarrative(before, 'before', message.streaming)}
          {hasVisibleActivity ? (
            <WorkDisclosure message={message} parts={work} showReasoning={showReasoning} showTools={showTools} />
          ) : (
            renderNarrative(hiddenMiddleNarrative, 'middle', message.streaming)
          )}
          {renderNarrativeWithActivity(after, 'after', showReasoning, showTools, message.streaming)}
          {message.streaming && !hasVisibleActivity ? (
            <div className="streaming-state" aria-live="polite">
              <ThinkingDots /> <span className="shine-sweep">{t('transcript.workStatus.thinking')}</span>
            </div>
          ) : null}
          {!message.streaming ? <MessageActions message={message} text={copyableText} /> : null}
        </div>
      </article>
    )
  },
  (previous, next) => previous.message === next.message && previous.showReasoning === next.showReasoning && previous.showTools === next.showTools && previous.entering === next.entering,
)

function SessionReferenceText({ text, references, onOpen }: { text: string; references: RoutedSessionReference[]; onOpen?(sessionId: string, harness: HarnessId): void }) {
  const { t } = useI18n()
  if (!references.length) return <InlineText text={text} />
  const ordered = [...references].sort((left, right) => right.label.length - left.label.length)
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, lineIndex) => {
        const parts: ReactNode[] = []
        let cursor = 0
        while (cursor < line.length) {
          let foundIndex = -1
          let found: RoutedSessionReference | undefined
          for (let index = cursor; index < line.length; index += 1) {
            const before = line[index - 1]
            found = ordered.find((reference) => {
              const after = line[index + reference.label.length]
              return (before === undefined || /[\s([{"'`]/.test(before)) && line.startsWith(reference.label, index) && (after === undefined || /[\s.,!?;:()[\]{}"'`]/.test(after))
            })
            if (found) {
              foundIndex = index
              break
            }
          }
          if (!found || foundIndex < 0) {
            parts.push(line.slice(cursor))
            break
          }
          if (foundIndex > cursor) parts.push(line.slice(cursor, foundIndex))
          const reference = found
          parts.push(
            <button
              type="button"
              key={`${reference.harness}:${reference.sessionId}:${foundIndex}`}
              className="session-reference"
              aria-label={t('transcript.sessionReference.open', { label: reference.label.slice(1) })}
              onClick={() => onOpen?.(reference.sessionId, reference.harness)}
            >
              {reference.label}
            </button>,
          )
          cursor = foundIndex + reference.label.length
        }
        return (
          <Fragment key={`${lineIndex}-${line.slice(0, 12)}`}>
            {parts}
            {lineIndex < lines.length - 1 ? <br /> : null}
          </Fragment>
        )
      })}
    </>
  )
}

function visibleUserText(text: string): string {
  const terminal = splitTerminalContextBlock(text)
  const annotations = splitAnnotationBlock(terminal.text)
  const capability = splitCapabilityRouting(annotations.text)
  return splitSessionRouting(capability.text).text
}

function UserText({ text, onOpenSessionReference }: { text: string; onOpenSessionReference?(sessionId: string, harness: HarnessId): void }) {
  const { t } = useI18n()
  // Sent prompts can carry verbose model-facing context blocks. Keep both
  // attachments collapsed and capability routing hidden while preserving the
  // user's own message.
  const terminal = splitTerminalContextBlock(text)
  const annotations = splitAnnotationBlock(terminal.text)
  const capability = splitCapabilityRouting(annotations.text)
  const sessions = splitSessionRouting(capability.text)
  const references = routedSessionReferences(sessions.block)
  if (!sessions.block && !capability.block && !annotations.block && !terminal.block) return <InlineText text={text} />
  return (
    <>
      {sessions.text && sessions.text !== '[Page annotations]' && sessions.text !== '[Terminal selection]' ? (
        <SessionReferenceText text={sessions.text} references={references} onOpen={onOpenSessionReference} />
      ) : null}
      {annotations.block ? (
        <details className="user-annotations">
          <summary>{annotations.count > 0 ? t('transcript.annotations.count', { count: annotations.count }) : t('transcript.annotations.title')}</summary>
          <pre>{annotations.block}</pre>
        </details>
      ) : null}
      {terminal.selection ? (
        <details className="user-annotations user-terminal-context">
          <summary>{t('transcript.terminalContext.title', { source: terminal.label ?? t('transcript.terminalContext.terminal') })}</summary>
          <pre>{terminal.selection}</pre>
        </details>
      ) : null}
    </>
  )
}

export const USER_BUBBLE_COLLAPSE_CHAR_THRESHOLD = 360
export const USER_BUBBLE_COLLAPSE_LINE_THRESHOLD = 10

export const UserMessage = memo(function UserMessage({ message, entering = false, onOpenSessionReference }: { message: TranscriptMessage; entering?: boolean; onOpenSessionReference?(sessionId: string, harness: HarnessId): void }) {
  const { t } = useI18n()
  const reveal = useContext(SearchRevealContext)
  const [expanded, setExpanded] = useState(false)
  const copyableText = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => visibleUserText(part.text))
    .filter(Boolean)
    .join('\n')
  const isCollapsible = copyableText.length > USER_BUBBLE_COLLAPSE_CHAR_THRESHOLD || copyableText.split('\n').length > USER_BUBBLE_COLLAPSE_LINE_THRESHOLD
  const isCollapsed = isCollapsible && !expanded && !reveal
  const toggleLabel = t(expanded ? 'transcript.user.showLess' : 'transcript.user.showMore')
  return (
    <article className={`message message--user${entering ? ' message--enter' : ''}`}>
      <div className={`user-bubble${isCollapsed ? ' is-collapsed' : ''}`}>
        {message.parts.map((part, index) =>
          part.type === 'text' ? (
            <UserText key={index} text={part.text} onOpenSessionReference={onOpenSessionReference} />
          ) : part.type === 'image' ? (
            <UserImagePart key={`user-${index}`} part={part} />
          ) : part.type === 'unsupported' ? (
            // 使用者訊息裡的未知附件（file/audio 等）顯示可讀資料視圖，不靜默消失
            <UnsupportedAttachment key={`user-${index}`} contentType={part.contentType} data={part.data} />
          ) : null,
        )}
      </div>
      {isCollapsible ? (
        <button type="button" className="user-bubble__toggle" aria-expanded={!isCollapsed} aria-label={toggleLabel} data-label={toggleLabel} onClick={() => setExpanded((value) => !value)}>
          <ChevronDown className="user-bubble__toggle-icon" size={12} aria-hidden="true" />
        </button>
      ) : null}
      {message.steerState ? (
        <div className={`message__steer-state is-${message.steerState}`} role="status">
          {message.steerState === 'accepted' ? t('transcript.steer.accepted') : t('transcript.steer.read')}
        </div>
      ) : null}
      <MessageActions message={message} text={copyableText} />
    </article>
  )
})

export const SteerReadMarker = memo(function SteerReadMarker({ message }: { message: TranscriptMessage }) {
  return (
    <div className="message message--steer-read" role="status">
      <span>{messageText(message)}</span>
    </div>
  )
})

export type AgentNoticeLevel = 'info' | 'warning' | 'error'

export function isAgentNoticeKind(kind: TranscriptMessage['kind']): kind is 'agent-notice' | 'agent-notice-warning' | 'agent-notice-error' {
  return kind === 'agent-notice' || kind === 'agent-notice-warning' || kind === 'agent-notice-error'
}

/**
 * Agent notice row (upstream `notice` events): always readable — never folded
 * into the collapsed work-activity disclosure, since persistence and
 * compaction-sync notices carry guidance the user must actually read.
 */
export const NoticeMessage = memo(function NoticeMessage({ message }: { message: TranscriptMessage }) {
  const { t } = useI18n()
  const level: AgentNoticeLevel = message.kind === 'agent-notice-error'
    ? 'error'
    : message.kind === 'agent-notice-warning' ? 'warning' : 'info'
  const levelLabel = t(level === 'error' ? 'transcript.notice.level.error' : level === 'warning' ? 'transcript.notice.level.warning' : 'transcript.notice.level.info')
  return (
    <div className="message message--notice" data-level={level} role="status" aria-label={t('transcript.notice.aria')}>
      <span className="message__notice-level">{levelLabel}</span>
      <span className="message__notice-text">{messageText(message)}</span>
    </div>
  )
})

export const ActivityMessage = memo(function ActivityMessage({ message, harness = 'omp' }: { message: TranscriptMessage; harness?: HarnessId }) {
  const { t } = useI18n()
  const activityLabel = t('transcript.activity.message', { harness: HARNESS_SHORT_NAMES[harness] })
  const sourceParts: MessagePart[] =
    message.role === 'system' && !message.parts.some((part) => part.type === 'compaction')
      ? [
          { type: 'toolCall', id: message.id, name: activityLabel },
          { type: 'toolResult', name: activityLabel, text: messageText(message), isError: true },
        ]
      : message.parts
  const parts = sourceParts.flatMap((part, index) =>
    part.type === 'toolResult' && sourceParts[index - 1]?.type !== 'toolCall' ? [{ type: 'toolCall' as const, id: `${message.id}-${index}`, name: t('transcript.tool.fallbackName') }, part] : [part],
  )
  return (
    <article className="message message--activity">
      <WorkTimeline parts={parts} showReasoning showTools />
    </article>
  )
})

export const AgentMessage = memo(function AgentMessage({ message }: { message: TranscriptMessage }) {
  const { t } = useI18n()
  const [manualOpen, setOpen] = useState(false)
  // Same rule as WorkDisclosure: only user-initiated opens animate, so a
  // remount-open message never shifts layout under restored scroll offsets.
  const userToggledRef = useRef(false)
  const reveal = useContext(SearchRevealContext)
  const open = manualOpen || reveal
  const contentId = useId()
  const text = messageText(message)
  const label = message.agentName ? t('transcript.agent.summaryNamed', { name: message.agentName }) : t('transcript.agent.summary')
  return (
    <article className={`message message--agent ${open ? 'is-open' : ''}`}>
      <button type="button" className="agent-message__summary" aria-expanded={open} aria-controls={contentId} aria-label={label} onClick={() => { userToggledRef.current = true; setOpen((value) => !value) }}>
        <span className="agent-message__label">{t('transcript.agent.summary')}</span>
        {message.agentName ? <span className="agent-message__name">{message.agentName}</span> : null}
        {open ? <ChevronDown className="agent-message__chevron" size={13} /> : <ChevronRight className="agent-message__chevron" size={13} />}
      </button>
      {open ? (
        <div className={`accordion-grid is-open${userToggledRef.current ? ' is-animated' : ''}`}>
          <div className="accordion-grid__inner">
            <div className="agent-message__content" id={contentId}>
              <MarkdownText text={boundText(text, 40_000, t('transcript.agent.truncated'))} />
              <MessageActions message={message} />
            </div>
          </div>
        </div>
      ) : null}
    </article>
  )
})

export const GoalMessage = memo(function GoalMessage({ message }: { message: TranscriptMessage }) {
  const { t } = useI18n()
  const [manualOpen, setOpen] = useState(false)
  const reveal = useContext(SearchRevealContext)
  const open = manualOpen || reveal
  const contentId = useId()
  const text = messageText(message)
  return (
    <article className={`message message--goal ${open ? 'is-open' : ''}`}>
      <button type="button" className="goal-message__summary" aria-expanded={open} aria-controls={contentId} aria-label={t('transcript.goal.summary')} onClick={() => setOpen((value) => !value)}>
        <span className="goal-message__icon">
          <Target size={15} />
        </span>
        <span className="goal-message__label">{t('transcript.goal.summary')}</span>
        {open ? <ChevronDown className="goal-message__chevron" size={13} /> : <ChevronRight className="goal-message__chevron" size={13} />}
      </button>
      {open ? (
        <div className="goal-message__content" id={contentId}>
          <MarkdownText text={boundText(text, 40_000, t('transcript.goal.truncated'))} />
        </div>
      ) : null}
    </article>
  )
})
