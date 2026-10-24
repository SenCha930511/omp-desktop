import { ChevronDown, LoaderCircle } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { createAssistantTurnCoalescer } from '@/lib/assistant-turns'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { useI18n } from '@/lib/i18n'
import type { GitStatus, HarnessId, TranscriptMessage } from '@/types/api'
import { ChangesCard } from './ChangesCard'
import { ErrorBoundary } from './ErrorBoundary'
import { MarkdownText } from './MarkdownText'
import { ActivityMessage, AgentMessage, AssistantMessage, GoalMessage, SteerReadMarker, UserMessage } from './transcript/messages'
import { useTranscriptScroll } from './transcript/scroll'
import { TranscriptHud } from './TranscriptHud'
import { OmpMark } from './ui'
import { LiveElapsed, ThinkingDots, WorkDisclosure } from './transcript/timeline'
import { SearchMessage, TranscriptSearchBar, useTranscriptSearch } from './TranscriptSearch'
import { failedTurn, TurnRecovery } from './TurnRecovery'

export { tokenizeSyntax } from './transcript/syntax'
export { classifyTool, formatWorkedDuration } from './transcript/timeline'

export { coalesceAssistantTurns } from '@/lib/assistant-turns'

interface TranscriptProps {
  messages: TranscriptMessage[]
  git: GitStatus
  /** Active harness; brands the assistant marks and working copy. */
  harness?: HarnessId
  loading?: boolean
  active?: boolean
  visible?: boolean
  showReasoning?: boolean
  showTools?: boolean
  onOpenChanges(): void
  onSuggestion(prompt: string): void
  suggestionsDisabled?: boolean
  /** Identifies the conversation; a change re-engages bottom-following like the jump button. */
  followKey?: string
  /** Render the changes card inline under the latest turn instead of beside the composer. */
  showChangesCard?: boolean
  onDismissChanges?(): void
  /** Restores every changed file to its last commit. */
  onUndoChanges?(): void
  queuedMessageCount?: number
  onOpenSessionReference?(sessionId: string, harness: HarnessId): void
  onRetry?(): Promise<void>
  onRestorePrompt?(prompt: string): void
}

function ActiveAssistantMessage({ message, showReasoning, showTools, entering = false }: { message: TranscriptMessage; showReasoning: boolean; showTools: boolean; entering?: boolean }) {
  const { t } = useI18n()
  const visibleActivity = message.parts.some(
    (part) => (part.type === 'thinking' && showReasoning) || ((part.type === 'toolCall' || part.type === 'toolResult') && showTools) || part.type === 'agentMessage',
  )
  return (
    <article className={`message message--assistant${entering ? ' message--enter' : ''}`}>
      <div className="message__content">
        {visibleActivity ? (
          <WorkDisclosure message={message} parts={message.parts} showReasoning={showReasoning} showTools={showTools} running />
        ) : (
          <>
            {message.parts.map((part, index) => (part.type === 'text' ? <MarkdownText key={index} text={part.text} streaming /> : null))}
            <div className="streaming-state" aria-live="polite">
              <ThinkingDots /> <span className="shine-sweep">{t('transcript.workStatus.thinking')}</span> <LiveElapsed since={message.startedAt ?? message.timestamp} />
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
  visible = true,
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
  followKey,
  onRetry,
  onRestorePrompt,
}: TranscriptProps) {
  const { t } = useI18n()
  const coalesce = useMemo(createAssistantTurnCoalescer, [])
  const groupedMessages = useMemo(() => coalesce(messages), [coalesce, messages])
  const { announcement, awayFromBottom, hiddenCount, hiddenAfter, scrollRef, scrollToBottom, scrolled, showEarlier, showNewer, revealIndex, updatePinnedState, visibleMessages } = useTranscriptScroll(groupedMessages, visible, followKey)
  const search = useTranscriptSearch(groupedMessages, scrollRef, revealIndex, visible)
  const recovery = useMemo(() => failedTurn(messages), [messages])
  // One-shot entrance tracking: messages present when the transcript settles
  // (history load, session switch) render without animation; only messages
  // appended afterwards get the entrance class. Reset per followed session.
  const entranceRef = useRef<{ key: string | undefined; hydrated: boolean; initial: Set<string> }>({ key: followKey, hydrated: false, initial: new Set() })
  if (entranceRef.current.key !== followKey) {
    entranceRef.current = { key: followKey, hydrated: false, initial: new Set() }
  }
  if (!entranceRef.current.hydrated && !loading) {
    entranceRef.current.hydrated = true
    entranceRef.current.initial = new Set(visibleMessages.map((message) => message.id))
  }
  const entering = (id: string) => entranceRef.current.hydrated && !entranceRef.current.initial.has(id)
  const activeAssistantId = useMemo(() => (active && groupedMessages.at(-1)?.role === 'assistant' ? groupedMessages.at(-1)?.id : undefined), [active, groupedMessages])
  const transcriptClasses = [
    'transcript',
    'scroll-area',
    scrolled ? 'is-scrolled' : '',
    queuedMessageCount > 0 ? 'has-queued-messages' : '',
    search.open ? 'is-searching' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <TranscriptSearchBar state={search} dockToToolbar />
      <div ref={scrollRef} tabIndex={-1} className={transcriptClasses} aria-busy={loading} onScroll={updatePinnedState}>
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
            <SearchMessage key={message.id} id={message.id} reveal={search.matchId === message.id}>
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
                <UserMessage message={message} entering={entering(message.id)} onOpenSessionReference={onOpenSessionReference} />
              ) : message.role === 'assistant' ? (
                message.streaming || message.id === activeAssistantId ? (
                  <ActiveAssistantMessage message={message} entering={entering(message.id)} showReasoning={showReasoning || search.matchId === message.id} showTools={showTools || search.matchId === message.id} />
                ) : (
                  <AssistantMessage message={message} entering={entering(message.id)} showReasoning={showReasoning || search.matchId === message.id} showTools={showTools || search.matchId === message.id} />
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
            </SearchMessage>
          ))}
          {hiddenAfter > 0 && <button type="button" className="transcript__show-earlier" onClick={showNewer}>{t('conversation.search.newer', { count: Math.min(250, hiddenAfter) })}</button>}
          {recovery && onRetry && onRestorePrompt && <TurnRecovery turn={recovery} busy={active} onRetry={onRetry} onRestore={onRestorePrompt} />}
          {active && !activeAssistantId && !recovery ? (
            <article className="message message--assistant transcript-active-placeholder" aria-live="polite">
              <div className="streaming-state">
                <ThinkingDots /> <span className="shine-sweep">{t('transcript.workStatus.thinking')}</span>
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
      <TranscriptHud messages={messages} />
      {awayFromBottom ? (
        <button type="button" className="transcript__jump-to-bottom" onClick={scrollToBottom} aria-label={t('transcript.jumpToBottom')} title={t('transcript.jumpToBottom')}>
          <ChevronDown size={17} />
        </button>
      ) : null}
    </>
  )
}
