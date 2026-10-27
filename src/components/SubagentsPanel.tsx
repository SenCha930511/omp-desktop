import { Bot, ChevronDown, MessageSquare, Users } from 'lucide-react'
import { memo, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { combineSubagentMessages, type SubagentPanelState, type SubagentView } from '@/hooks/useSubagents'
import { string } from '@/lib/events/parse'
import { subagentTranscript } from '@/lib/subagent-transcript'
import { ActivityMessage, AssistantMessage, UserMessage } from './transcript/messages'
import { useI18n } from '@/lib/i18n'
import { subagentExecution } from '@/lib/subagent-activity'
import type { ExecutionState } from '@/lib/execution-state'
import { ExecutionStatus } from './ExecutionStatus'
import { SubagentRoster } from './SubagentRoster'
import { useTranscriptScroll } from './transcript/scroll'
import { SearchMessage, TranscriptSearchBar, useTranscriptSearch } from './TranscriptSearch'
import { useSubagentAttention } from '@/hooks/useSubagentAttention'
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
  return <form className="subagents__steer" onSubmit={(event) => { void submit(event) }}>
    <input value={draft} onChange={(event) => { setDraft(event.target.value); setError(undefined) }} disabled={pending} maxLength={32_000}
      placeholder={t('agents.steerPlaceholder')} aria-label={t('agents.steerLabel', { name: agent.agent })} />
    <button type="submit" disabled={pending || !draft.trim()}>{t('agents.steerSend')}</button>
    {error && <p className="subagents__steer-error" role="alert">{error}</p>}
  </form>
}

const AgentTranscript = memo(function AgentTranscript({ agent, showReasoning, showTools, active, pendingActions, onLoadEarlier, onSteer }: {
  agent: SubagentView; showReasoning: boolean; showTools: boolean; active: boolean
  pendingActions?: ReadonlySet<string>; onLoadEarlier?(id: string): void; onSteer?(id: string, message: string): Promise<void>
}) {
  const { t, locale } = useI18n()
  const progress = agent.progress
  const messages = useMemo(() => subagentTranscript(combineSubagentMessages(agent.history, agent.messages), agent.status === 'running'), [agent.history, agent.messages, agent.status])
  const historyPending = pendingActions?.has(`history:${agent.id}`) ?? false
  const showLoadEarlier = Boolean(onLoadEarlier) && agent.historyDone !== true
  const { scrollRef, updatePinnedState, awayFromBottom, scrollToBottom, visibleMessages, hiddenCount, hiddenAfter, showEarlier, showNewer, revealIndex, hasNewContent } = useTranscriptScroll(messages, active)
  const search = useTranscriptSearch(messages, scrollRef, revealIndex, active)
  const execution = useMemo(() => subagentExecution(agent), [agent])
  const metrics = [
    [t('agents.tools'), progress?.toolCount], [t('agents.requests'), progress?.requests], [t('agents.tokens'), progress?.tokens],
    [t('agents.elapsed'), typeof progress?.durationMs === 'number' ? t('agents.seconds', { count: Math.round(progress.durationMs / 1_000) }) : undefined],
  ].filter(([, value]) => typeof value === 'string' || typeof value === 'number')
  return <article className="subagents__transcript" aria-label={t('agents.transcript', { name: agent.agent })}>
    <TranscriptSearchBar state={search} />
    <div className="subagents__overview">
    <header className="subagents__heading">
      <div className="subagents__avatar"><Bot size={20} /></div>
      <div><h2>{agent.agent}</h2><ExecutionStatus state={execution} compact /></div>
    </header>
    {typeof progress?.currentTool === 'string' && agent.status === 'running' && <div className="subagents__activity">{string(progress.currentToolIntent) ?? t('agents.runningTool', { tool: progress.currentTool })}</div>}
    <details className="subagents__details"><summary>{t('agents.details')}</summary>
    <div className="subagents__assignment"><strong>{t('agents.assignment')}</strong><div>{agent.task ?? agent.description}</div></div>
    {metrics.length > 0 && <div className="subagents__metrics">{metrics.map(([label, value]) => <span key={String(label)}><small>{String(label)}</small><strong>{typeof value === 'number' ? value.toLocaleString(locale) : String(value)}</strong></span>)}</div>}
    {typeof progress?.resolvedModel === 'string' && <p className="subagents__model">{progress.resolvedModel}</p>}
    </details>
    </div>
    <div className="subagents__messages" ref={scrollRef} tabIndex={-1} onScroll={updatePinnedState}><div className="transcript__inner">
    {showLoadEarlier && <button type="button" className="transcript__show-earlier" disabled={historyPending} onClick={() => onLoadEarlier?.(agent.id)}>{t(historyPending ? 'agents.loadingEarlier' : 'agents.loadEarlier')}</button>}
    {hiddenCount > 0 && <button type="button" className="transcript__show-earlier" onClick={showEarlier}>{t('transcript.showEarlier', { count: Math.min(hiddenCount, 250) })}</button>}
    {!messages.length && agent.status === 'running' && <div className="subagents__empty"><p>{t('agents.waiting')}</p></div>}
    {visibleMessages.map((message) => <SearchMessage key={message.id} id={message.id} reveal={search.matchId === message.id}>{message.role === 'user'
      ? <details className="subagents__instruction" key={message.id}><summary>{t('agents.parentInstruction')}</summary><div><UserMessage message={message} /></div></details>
      : <div className="subagents__message" key={message.id}>{message.role === 'assistant'
        ? <AssistantMessage message={message} showReasoning={showReasoning || search.matchId === message.id} showTools={showTools || search.matchId === message.id} />
        : <ActivityMessage message={message} />}</div>}</SearchMessage>)}
    {hiddenAfter > 0 && <button type="button" className="transcript__show-earlier" onClick={showNewer}>{t('conversation.search.newer', { count: Math.min(250, hiddenAfter) })}</button>}
    </div></div>
    {awayFromBottom && <button type="button" className="subagents__jump" onClick={scrollToBottom}><ChevronDown size={14} />{t(hasNewContent ? 'agents.newContent' : 'transcript.jumpToBottom')}</button>}
    {agent.status === 'running' && onSteer && <SteerForm agent={agent} pending={pendingActions?.has(`steer:${agent.id}`) ?? false} onSteer={onSteer} />}
  </article>
})

export function SubagentsPanel({ state, connected, showReasoning = true, showTools = true, pinned = false, onPinnedChange, execution, children }: {
  state: SubagentPanelState; connected: boolean; showReasoning?: boolean; showTools?: boolean
  pinned?: boolean; onPinnedChange?(pinned: boolean): void; execution?: ExecutionState; children?: ReactNode
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [visited, setVisited] = useState<string[]>([])
  const [actionError, setActionError] = useState<string>()
  const selected = state.agents.find((agent) => agent.id === state.selectedId)
  const retained = selected ? [...visited.filter((id) => id !== selected.id), selected.id].slice(-3) : visited
  const unread = useSubagentAttention(state.agents, selected?.id)
  useEffect(() => {
    if (selected) setVisited((ids) => [...ids.filter((id) => id !== selected.id), selected.id].slice(-3))
  }, [selected?.id])
  useEffect(() => { setActionError(undefined) }, [selected?.id])
  const selectedExecution = useMemo(() => selected ? subagentExecution(selected) : undefined, [selected])
  const running = state.agents.filter((agent) => agent.status === 'running').length
  const back = () => { state.select(undefined); setOpen(false) }
  const closeRoster = () => { setOpen(false); onPinnedChange?.(false) }
  // 取消回報:false = 上游確認不在執行(不當作取消成功);RPC 失敗如實顯示。
  const cancelAgent = async (id: string) => {
    if (!state.cancel) return
    setActionError(undefined)
    try {
      if (!(await state.cancel(id))) setActionError(t('agents.cancelNotRunning'))
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const loadEarlierAgent = async (id: string) => {
    if (!state.loadEarlier) return
    setActionError(undefined)
    try {
      await state.loadEarlier(id)
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const changeSubscription = async (level: 'off' | 'progress' | 'events') => {
    if (!state.setSubscriptionLevel) return
    setActionError(undefined)
    try {
      await state.setSubscriptionLevel(level)
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const roster = <SubagentRoster agents={state.agents} selectedId={selected?.id} connected={connected} pinned={pinned} unread={unread}
    onPin={() => { onPinnedChange?.(!pinned); setOpen(pinned) }} onClose={closeRoster}
    onSelect={(id) => { state.select(id); if (!pinned) setOpen(false) }}
    onCancel={state.cancel ? (id) => { void cancelAgent(id) } : undefined} pendingActions={state.pendingActions}
    subscriptionLevel={state.subscriptionLevel} onSubscriptionChange={state.setSubscriptionLevel ? (level) => { void changeSubscription(level) } : undefined} />
  const error = state.error?.includes('invalid subagent roster') ? t('agents.error.roster') : state.error?.includes('Invalid subagent transcript') ? t('agents.error.transcript') : state.error
  return <section className={`subagents ${selected ? 'has-selection' : ''} ${pinned ? 'has-pinned-roster' : ''}`} aria-label={t('agents.title')}>
    <div className="subagents__toolbar">
      <button className={`subagents__tab ${!selected ? 'is-active' : ''}`} type="button" onClick={back}><MessageSquare size={14} />{t('agents.conversation')}</button>
      {selected && <button className="subagents__tab is-active" type="button"><Bot size={14} />{selected.agent}{selectedExecution && <ExecutionStatus state={selectedExecution} compact />}</button>}
      {!selected && execution && <ExecutionStatus state={execution} />}
      <button className="subagents__roster-toggle" type="button" aria-expanded={pinned || open} aria-label={t('agents.rosterAria', { running, total: state.agents.length })} onClick={() => pinned ? closeRoster() : setOpen(!open)}>
        <Users size={14} /><span>{t('agents.title')}</span><span className="subagents__count">{state.agents.length}</span><ChevronDown size={12} />
      </button>
      <div className="subagents__search-slot" />
    </div>
    {open && !pinned && roster}
    {error && (open || pinned || selected) && <p className="subagents__error" role="alert">{error}</p>}
    {actionError && <p className="subagents__error" role="alert">{actionError}</p>}
    <div className="subagents__body">
    {children}
    {state.agents.filter((agent) => retained.includes(agent.id)).map((agent) => <div className="subagents__page" key={`${agent.id}:${agent.revision ?? 0}`} hidden={agent.id !== selected?.id}>
      <AgentTranscript agent={agent} active={agent.id === selected?.id} showReasoning={showReasoning} showTools={showTools}
        pendingActions={state.pendingActions} onSteer={state.steer} onLoadEarlier={state.loadEarlier ? (id) => { void loadEarlierAgent(id) } : undefined} />
    </div>)}
    {pinned && roster}
    </div>
  </section>
}
