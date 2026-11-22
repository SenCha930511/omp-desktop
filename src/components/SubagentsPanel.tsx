import { ArrowUp, Bot, ChevronDown, X } from 'lucide-react'
import { memo, useMemo, useState, type FormEvent } from 'react'
import { combineSubagentMessages, type SubagentView } from '@/hooks/useSubagents'
import { subagentTranscript } from '@/lib/subagent-transcript'
import { ActivityMessage, AssistantMessage, UserMessage } from './transcript/messages'
import { useI18n } from '@/lib/i18n'
import { subagentExecution } from '@/lib/subagent-activity'
import { ExecutionStatus } from './ExecutionStatus'
import { useTranscriptScroll } from './transcript/scroll'
import { SearchMessage, TranscriptSearchBar, useTranscriptSearch } from './TranscriptSearch'
import './subagents.css'

function SteerForm({ agent, pending, onSteer }: { agent: SubagentView; pending: boolean; onSteer(id: string, message: string): Promise<void> }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const message = draft.trim()
    if (!message || pending) return
    setError(undefined)
    try {
      await onSteer(agent.id, message)
      setDraft('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <form
      className="subagents__steer"
      onSubmit={(event) => {
        void submit(event)
      }}
    >
      <input
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(undefined)
        }}
        disabled={pending}
        maxLength={32_000}
        placeholder={t('agents.steerPlaceholder')}
        aria-label={t('agents.steerLabel', { name: agent.agent })}
      />
      <button type="submit" disabled={pending || !draft.trim()} aria-label={t('agents.steerSend')} title={t('agents.steerSend')}>
        <ArrowUp size={17} />
      </button>
      {error && (
        <p className="subagents__steer-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

/** One subagent's transcript. Rendered by the inspector's Agents tab, one agent at a time. */
export const AgentTranscript = memo(function AgentTranscript({
  agent,
  showReasoning,
  showTools,
  active,
  pendingActions,
  onLoadEarlier,
  onSteer,
  onClose,
}: {
  agent: SubagentView
  showReasoning: boolean
  showTools: boolean
  active: boolean
  pendingActions?: ReadonlySet<string>
  onLoadEarlier?(id: string): void
  onSteer?(id: string, message: string): Promise<void>
  onClose?(): void
}) {
  const { t, locale } = useI18n()
  const progress = agent.progress
  const messages = useMemo(() => subagentTranscript(combineSubagentMessages(agent.history, agent.messages), agent.status === 'running'), [agent.history, agent.messages, agent.status])
  const historyPending = pendingActions?.has(`history:${agent.id}`) ?? false
  const showLoadEarlier = Boolean(onLoadEarlier) && agent.historyDone !== true
  const { scrollRef, updatePinnedState, awayFromBottom, scrollToBottom, visibleMessages, hiddenCount, hiddenAfter, showEarlier, showNewer, revealIndex, hasNewContent } = useTranscriptScroll(
    messages,
    active,
  )
  const search = useTranscriptSearch(messages, scrollRef, revealIndex, active)
  const execution = useMemo(() => subagentExecution(agent), [agent])
  const metrics = [
    [t('agents.tools'), progress?.toolCount],
    [t('agents.requests'), progress?.requests],
    [t('agents.tokens'), progress?.tokens],
    [t('agents.elapsed'), typeof progress?.durationMs === 'number' ? t('agents.seconds', { count: Math.round(progress.durationMs / 1_000) }) : undefined],
  ].filter(([, value]) => typeof value === 'string' || typeof value === 'number')
  const jumpLabel = t(hasNewContent ? 'agents.newContent' : 'transcript.jumpToBottom')
  return (
    <article className="subagents__transcript" aria-label={t('agents.transcript', { name: agent.agent })}>
      <TranscriptSearchBar state={search} />
      <div className="subagents__overview">
        <header className="subagents__heading">
          <div className="subagents__avatar">
            <Bot size={20} />
          </div>
          <div>
            <h2>{agent.agent}</h2>
            <ExecutionStatus state={execution} compact />
          </div>
          {onClose ? (
            <button type="button" className="subagents__pane-close" onClick={onClose} aria-label={t('agents.closeDetail')} title={t('agents.closeDetail')}>
              <X size={15} />
            </button>
          ) : null}
        </header>
        <details className="subagents__details">
          <summary>{t('agents.details')}</summary>
          <div className="subagents__assignment">
            <strong>{t('agents.assignment')}</strong>
            <div>{agent.task ?? agent.description}</div>
          </div>
          {metrics.length > 0 && (
            <div className="subagents__metrics">
              {metrics.map(([label, value]) => (
                <span key={String(label)}>
                  <small>{String(label)}</small>
                  <strong>{typeof value === 'number' ? value.toLocaleString(locale) : String(value)}</strong>
                </span>
              ))}
            </div>
          )}
          {typeof progress?.resolvedModel === 'string' && <p className="subagents__model">{progress.resolvedModel}</p>}
        </details>
      </div>
      <div className="subagents__messages" ref={scrollRef} tabIndex={-1} onScroll={updatePinnedState}>
        <div className="transcript__inner">
          {showLoadEarlier && (
            <button type="button" className="transcript__show-earlier" disabled={historyPending} onClick={() => onLoadEarlier?.(agent.id)}>
              {t(historyPending ? 'agents.loadingEarlier' : 'agents.loadEarlier')}
            </button>
          )}
          {hiddenCount > 0 && (
            <button type="button" className="transcript__show-earlier" onClick={showEarlier}>
              {t('transcript.showEarlier', { count: Math.min(hiddenCount, 250) })}
            </button>
          )}
          {!messages.length && agent.status === 'running' && (
            <div className="subagents__empty">
              <p>{t('agents.waiting')}</p>
            </div>
          )}
          {visibleMessages.map((message) => (
            <SearchMessage key={message.id} id={message.id} reveal={search.matchId === message.id}>
              {message.role === 'user' ? (
                <details className="subagents__instruction" key={message.id}>
                  <summary>{t('agents.parentInstruction')}</summary>
                  <div>
                    <UserMessage message={message} />
                  </div>
                </details>
              ) : (
                <div className="subagents__message" key={message.id}>
                  {message.role === 'assistant' ? (
                    <AssistantMessage message={message} showReasoning={showReasoning || search.matchId === message.id} showTools={showTools || search.matchId === message.id} />
                  ) : (
                    <ActivityMessage message={message} />
                  )}
                </div>
              )}
            </SearchMessage>
          ))}
          {hiddenAfter > 0 && (
            <button type="button" className="transcript__show-earlier" onClick={showNewer}>
              {t('conversation.search.newer', { count: Math.min(250, hiddenAfter) })}
            </button>
          )}
        </div>
      </div>
      {awayFromBottom && (
        <button type="button" className="subagents__jump" onClick={scrollToBottom} aria-label={jumpLabel} title={jumpLabel}>
          <ChevronDown size={17} />
        </button>
      )}
      {agent.status === 'running' && onSteer && <SteerForm agent={agent} pending={pendingActions?.has(`steer:${agent.id}`) ?? false} onSteer={onSteer} />}
    </article>
  )
})
