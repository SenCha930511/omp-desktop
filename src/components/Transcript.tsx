import { ChevronDown, LoaderCircle } from 'lucide-react'
import { useMemo } from 'react'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { useI18n } from '@/lib/i18n'
import type { GitStatus, HarnessId, TranscriptMessage } from '@/types/api'
import { ChangesCard } from './ChangesCard'
import { ErrorBoundary } from './ErrorBoundary'
import { MarkdownText } from './MarkdownText'
import { ActivityMessage, AgentMessage, AssistantMessage, GoalMessage, SteerReadMarker, UserMessage } from './transcript/messages'
import { useTranscriptScroll } from './transcript/scroll'
import { OmpMark } from './ui'
import { LiveElapsed, ThinkingDots, WorkDisclosure } from './transcript/timeline'

export { tokenizeSyntax } from './transcript/syntax'
export { classifyTool, formatWorkedDuration } from './transcript/timeline'

export function coalesceAssistantTurns(messages: TranscriptMessage[]): TranscriptMessage[] {
  let changed = false
  const grouped: TranscriptMessage[] = []
  for (const message of messages) {
    const previous = grouped.at(-1)
    if (message.role !== 'assistant' || previous?.role !== 'assistant') {
      grouped.push(message)
      continue
    }
    changed = true
    const streaming = Boolean(previous.streaming || message.streaming)
    grouped[grouped.length - 1] = {
      ...previous,
      completedAt: streaming ? undefined : (message.completedAt ?? previous.completedAt),
      streaming,
      parts: [...previous.parts, ...message.parts],
    }
  }
  return changed ? grouped : messages
}

interface TranscriptProps {
  messages: TranscriptMessage[]
  git: GitStatus
  /** Active harness; brands the assistant marks and working copy. */
  harness?: HarnessId
  loading?: boolean
  active?: boolean
  showReasoning?: boolean
  showTools?: boolean
  onOpenChanges(): void
  onSuggestion(prompt: string): void
  suggestionsDisabled?: boolean
  /** Render the changes card inline under the latest turn instead of beside the composer. */
  showChangesCard?: boolean
  onDismissChanges?(): void
  /** Restores every changed file to its last commit. */
  onUndoChanges?(): void
  queuedMessageCount?: number
  onOpenSessionReference?(sessionId: string, harness: HarnessId): void
}

function ActiveAssistantMessage({ message, harness, showReasoning, showTools }: { message: TranscriptMessage; harness: HarnessId; showReasoning: boolean; showTools: boolean }) {
  const { t } = useI18n()
  const visibleActivity = message.parts.some(
    (part) => (part.type === 'thinking' && showReasoning) || ((part.type === 'toolCall' || part.type === 'toolResult') && showTools) || part.type === 'agentMessage',
  )
  return (
    <article className="message message--assistant">
      <div className="message__content">
        {visibleActivity ? (
          <WorkDisclosure message={message} parts={message.parts} showReasoning={showReasoning} showTools={showTools} running />
        ) : (
          <>
            {message.parts.map((part, index) => (part.type === 'text' ? <MarkdownText key={index} text={part.text} /> : null))}
            <div className="streaming-state" aria-live="polite">
              <ThinkingDots /> {t('transcript.working', { harness: HARNESS_SHORT_NAMES[harness] })} <LiveElapsed since={message.startedAt ?? message.timestamp} />
            </div>
          </>
        )}
      </div>
    </article>
  )
}

export function Transcript({
  messages,
  git,
  harness = 'omp',
  loading,
  active = false,
  showReasoning = true,
  showTools = true,
  onOpenChanges,
  onSuggestion,
  suggestionsDisabled,
  showChangesCard = false,
  onDismissChanges,
  onUndoChanges,
  queuedMessageCount = 0,
  onOpenSessionReference,
}: TranscriptProps) {
  const { t } = useI18n()
  const groupedMessages = useMemo(() => coalesceAssistantTurns(messages), [messages])
  const { announcement, awayFromBottom, hiddenCount, scrollRef, scrollToBottom, showEarlier, updatePinnedState, visibleMessages } = useTranscriptScroll(groupedMessages)
  const activeAssistantId = useMemo(() => (active && groupedMessages.at(-1)?.role === 'assistant' ? groupedMessages.at(-1)?.id : undefined), [active, groupedMessages])
  const transcriptClasses = [
    'transcript',
    'scroll-area',
    queuedMessageCount > 0 ? 'has-queued-messages' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <div ref={scrollRef} className={transcriptClasses} aria-busy={loading} onScroll={updatePinnedState}>
        <div className="sr-only" role="status" aria-live="polite">
          {announcement}
        </div>
        <div className="transcript__inner">
          {loading ? (
            <div className="transcript-loading">
              <LoaderCircle className="spin" size={16} /> {t('transcript.loading')}
            </div>
          ) : null}
          {!loading && messages.length === 0 ? (
            <div className="session-welcome">
              <OmpMark size={34} />
              <h1>{t('transcript.welcome.title')}</h1>
              <p>{t('transcript.welcome.description', { harness: HARNESS_SHORT_NAMES[harness] })}</p>
              <div className="prompt-suggestions">
                <button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion(t('transcript.welcome.suggestion.summarize'))}>
                  {t('transcript.welcome.suggestion.summarize')}
                </button>
                <button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion(t('transcript.welcome.suggestion.nextTask'))}>
                  {t('transcript.welcome.suggestion.nextTask')}
                </button>
                <button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion(t('transcript.welcome.suggestion.runTests'))}>
                  {t('transcript.welcome.suggestion.runTests')}
                </button>
              </div>
            </div>
          ) : null}
          {hiddenCount > 0 ? (
            <button type="button" className="transcript__show-earlier" onClick={showEarlier}>
              {t('transcript.showEarlier', { count: Math.min(250, hiddenCount) })}
            </button>
          ) : null}
          {visibleMessages.map((message) => (
            <ErrorBoundary
              key={message.id}
              fallback={
                <div className="message message--render-failure" role="note">
                  {t('transcript.renderFailure')}
                </div>
              }
            >
              {message.kind === 'steer-read-marker' ? (
                <SteerReadMarker message={message} />
              ) : message.role === 'user' ? (
                <UserMessage message={message} onOpenSessionReference={onOpenSessionReference} />
              ) : message.role === 'assistant' ? (
                message.streaming || message.id === activeAssistantId ? (
                  <ActiveAssistantMessage message={message} harness={harness} showReasoning={showReasoning} showTools={showTools} />
                ) : (
                  <AssistantMessage message={message} harness={harness} showReasoning={showReasoning} showTools={showTools} />
                )
              ) : message.role === 'agent' ? (
                <AgentMessage message={message} />
              ) : message.role === 'goal' ? (
                <GoalMessage message={message} />
              ) : message.role === 'tool' || message.role === 'system' ? (
                <ActivityMessage message={message} harness={harness} />
              ) : (
                <div className={`message message--${message.role}`}>{message.parts.map((part, partIndex) => (part.type === 'text' ? <span key={partIndex}>{part.text}</span> : null))}</div>
              )}
            </ErrorBoundary>
          ))}
          {active && !activeAssistantId ? (
            <article className="message message--assistant transcript-active-placeholder" aria-live="polite">
              <div className="streaming-state">
                <ThinkingDots /> {t('transcript.working', { harness: HARNESS_SHORT_NAMES[harness] })}
              </div>
            </article>
          ) : null}
          {showChangesCard && git.files.length && messages.length > 0 ? (
            <div className="transcript__changes">
              <ChangesCard git={git} onOpenChanges={onOpenChanges} onClose={onDismissChanges} onUndo={onUndoChanges} />
            </div>
          ) : null}
          <div />
        </div>
      </div>
      {awayFromBottom ? (
        <button type="button" className="transcript__jump-to-bottom" onClick={scrollToBottom} aria-label={t('transcript.jumpToBottom')} title={t('transcript.jumpToBottom')}>
          <ChevronDown size={17} />
        </button>
      ) : null}
    </>
  )
}
