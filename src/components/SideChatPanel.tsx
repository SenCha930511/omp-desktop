import { ArrowUp, ChevronDown, CirclePlus, Plus, Square, X } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { isTopicRunning, type SideQuestionSessionState } from '@/hooks/useSideQuestions'
import { useI18n } from '@/lib/i18n'
import type { SideQuestionTopic, SideQuestionTurn } from '@/types/api'
import { MarkdownText } from './MarkdownText'
import { IconButton } from './ui'
import './side-chat.css'

const SCROLL_PIN_THRESHOLD = 120

interface SideChatPanelProps {
  state: SideQuestionSessionState
  hasSession: boolean
  onAsk(question: string, topicId?: string): void
  onCancel(topicId?: string): void
  onSelectTopic(topicId: string | null): void
  onClose(): void
}

/** Inline controller exposed for tests and the panel body. */
export function sideChatBusy(state: SideQuestionSessionState): boolean {
  return state.sending || state.topics.some(isTopicRunning)
}

function SideChatTurn({ turn, live }: { turn: SideQuestionTurn; live: string }) {
  const { t } = useI18n()
  const running = turn.status === 'running'
  const stalledKey = turn.status === 'cancelled' ? 'sidechat.status.cancelled' as const
    : turn.status === 'error' ? 'sidechat.status.error' as const
    : turn.status === 'interrupted' ? 'sidechat.status.interrupted' as const
    : null
  const answer = turn.answer + (running ? live : '')
  return (
    <div className="side-chat__turn">
      <div className="side-chat__question">
        <div className="user-bubble side-chat__bubble">{turn.question}</div>
      </div>
      <div className="side-chat__answer" data-status={turn.status}>
        {stalledKey ? <span className={`side-chat__status side-chat__status--${turn.status}`}>{t(stalledKey)}</span> : null}
        {answer ? <MarkdownText text={answer} streaming={running} /> : null}
        {running && !answer ? <span className="side-chat__thinking shine-sweep">{t('sidechat.status.running')}</span> : null}
      </div>
    </div>
  )
}

function SideChatTopicView({ topic, live }: { topic: SideQuestionTopic; live: string }) {
  const lastLive = isTopicRunning(topic) ? live : ''
  const turns = useMemo(() => [topic, ...topic.followUps], [topic])
  return (
    <div className="side-chat__topic">
      {turns.map((turn, index) => (
        <SideChatTurn key={`${turn.createdAt}:${index}`} turn={turn} live={index === turns.length - 1 ? lastLive : ''} />
      ))}
    </div>
  )
}

export const SideChatPanel = memo(function SideChatPanel({ state, hasSession, onAsk, onCancel, onSelectTopic, onClose }: SideChatPanelProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const threadRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const running = sideChatBusy(state)
  const activeTopic = state.topics.find((topic) => topic.id === state.activeTopicId) ?? null
  const liveText = activeTopic ? (state.live[activeTopic.id] ?? '') : ''

  // Stay pinned to the newest text while the user is already near the bottom.
  useEffect(() => {
    const thread = threadRef.current
    if (!thread || !pinnedRef.current) return
    thread.scrollTop = thread.scrollHeight
  }, [state.topics, state.live, state.activeTopicId, state.sending])

  const fitTextarea = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 110)}px`
  }

  const submit = (value?: string) => {
    const question = (value ?? draft).trim()
    if (!question || running || !hasSession) return
    setDraft('')
    fitTextarea()
    onAsk(question, activeTopic?.id)
  }

  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return (
    <aside className="side-chat" aria-label={t('sidechat.aria')}>
      <header className="side-chat__header">
        <div className="side-chat__topic-picker">
          {state.topics.length > 0 ? (
            <label className="side-chat__topic-select">
              <select
                aria-label={t('sidechat.topicSwitcher')}
                value={state.activeTopicId ?? ''}
                onChange={(event) => onSelectTopic(event.target.value || null)}
              >
                <option value="">{t('sidechat.newTopic')}</option>
                {state.topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.question.length > 42 ? `${topic.question.slice(0, 42)}…` : topic.question}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </label>
          ) : null}
        </div>
        <div className="side-chat__header-actions">
          <IconButton size="small" label={running ? t('sidechat.newTopicBusy') : t('sidechat.newTopic')} disabled={running} onClick={() => { onSelectTopic(null); textareaRef.current?.focus() }}>
            <Plus size={14} />
          </IconButton>
          <IconButton size="small" label={t('sidechat.close')} onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
      </header>

      <div
        className="side-chat__thread"
        ref={threadRef}
        onScroll={(event) => {
          const node = event.currentTarget
          pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < SCROLL_PIN_THRESHOLD
        }}
      >
        {!hasSession ? (
          <div className="side-chat__empty">
            <CirclePlus size={26} aria-hidden="true" />
            <p>{t('sidechat.noSession')}</p>
          </div>
        ) : activeTopic === null ? (
          <div className="side-chat__empty">
            <CirclePlus size={26} aria-hidden="true" />
            <strong>{t('sidechat.empty.title')}</strong>
            <p>{t('sidechat.empty.body')}</p>
          </div>
        ) : (
          <SideChatTopicView topic={activeTopic} live={liveText} />
        )}
      </div>

      <form
        className="side-chat__composer"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          className="side-chat__input"
          placeholder={activeTopic ? t('sidechat.input.followUp') : t('sidechat.input.placeholder')}
          aria-label={activeTopic ? t('sidechat.input.followUp') : t('sidechat.input.placeholder')}
          disabled={!hasSession}
          onChange={(event) => {
            setDraft(event.target.value)
            fitTextarea()
          }}
          onKeyDown={onComposerKey}
        />
        {running ? (
          <button
            type="button"
            className="send-button send-button--stop"
            aria-label={t('sidechat.cancel')}
            onClick={() => onCancel(activeTopic?.id)}
          >
            <Square size={10} fill="currentColor" stroke="none" />
          </button>
        ) : (
          <button type="submit" className="send-button" aria-label={t('sidechat.send')} disabled={!draft.trim() || !hasSession}>
            <ArrowUp size={15} />
          </button>
        )}
      </form>
    </aside>
  )
})
