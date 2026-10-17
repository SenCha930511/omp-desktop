import { Bot, Check, ChevronDown, Circle, LoaderCircle, MessageSquare, Users, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { SubagentView, useSubagents } from '@/hooks/useSubagents'
import { string } from '@/lib/events/parse'
import { subagentTranscript } from '@/lib/subagent-transcript'
import { ActivityMessage, AssistantMessage, UserMessage } from './transcript/messages'
import { useI18n, type MessageKey } from '@/lib/i18n'
import './subagents.css'

function Status({ status }: { status: string }) {
  const { t } = useI18n()
  const statusKey = ['pending', 'running', 'completed', 'failed', 'error', 'aborted'].includes(status) ? `agents.status.${status}` as MessageKey : 'agents.status.unknown'
  const running = status === 'running'
  const failed = status === 'failed' || status === 'error'
  return <span className={`subagent-status ${running ? 'is-running' : failed ? 'is-failed' : ''}`}>
    {running ? <LoaderCircle size={12} className="is-spinning" /> : failed ? <X size={12} /> : status === 'completed' ? <Check size={12} /> : <Circle size={10} />}
    {t(statusKey)}
  </span>
}

function AgentTranscript({ agent, showReasoning, showTools }: { agent: SubagentView; showReasoning: boolean; showTools: boolean }) {
  const { t, locale } = useI18n()
  const progress = agent.progress
  const messages = useMemo(() => subagentTranscript(agent.messages, agent.status === 'running'), [agent.messages, agent.status])
  const metrics = [
    [t('agents.tools'), progress?.toolCount], [t('agents.requests'), progress?.requests], [t('agents.tokens'), progress?.tokens],
    [t('agents.elapsed'), typeof progress?.durationMs === 'number' ? t('agents.seconds', { count: Math.round(progress.durationMs / 1_000) }) : undefined],
  ].filter(([, value]) => typeof value === 'string' || typeof value === 'number')
  return <article className="subagents__transcript" aria-label={t('agents.transcript', { name: agent.agent })}>
    <div className="subagents__overview">
    <header className="subagents__heading">
      <div className="subagents__avatar"><Bot size={20} /></div>
      <div><h2>{agent.agent}</h2><Status status={agent.status} /></div>
    </header>
    {typeof progress?.currentTool === 'string' && agent.status === 'running' && <div className="subagents__activity">{string(progress.currentToolIntent) ?? t('agents.runningTool', { tool: progress.currentTool })}</div>}
    <details className="subagents__details"><summary>{t('agents.details')}</summary>
    <div className="subagents__assignment"><strong>{t('agents.assignment')}</strong><div>{agent.task ?? agent.description}</div></div>
    {metrics.length > 0 && <div className="subagents__metrics">{metrics.map(([label, value]) => <span key={String(label)}><small>{String(label)}</small><strong>{typeof value === 'number' ? value.toLocaleString(locale) : String(value)}</strong></span>)}</div>}
    {typeof progress?.resolvedModel === 'string' && <p className="subagents__model">{progress.resolvedModel}</p>}
    </details>
    </div>
    <div className="subagents__messages">
    {!messages.length && agent.status === 'running' && <div className="subagents__empty"><p>{t('agents.waiting')}</p></div>}
    {messages.map((message) => message.role === 'user'
      ? <details className="subagents__instruction" key={message.id}><summary>{t('agents.parentInstruction')}</summary><div><UserMessage message={message} /></div></details>
      : <div className="subagents__message" key={message.id}>{message.role === 'assistant'
        ? <AssistantMessage message={message} showReasoning={showReasoning} showTools={showTools} />
        : <ActivityMessage message={message} />}</div>)}
    </div>
  </article>
}

export function SubagentsPanel({ state, connected, showReasoning = true, showTools = true }: { state: ReturnType<typeof useSubagents>; connected: boolean; showReasoning?: boolean; showTools?: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const selected = state.agents.find((agent) => agent.id === state.selectedId)
  const running = state.agents.filter((agent) => agent.status === 'running').length
  const back = () => { state.select(undefined); setOpen(false) }
  const error = state.error?.includes('invalid subagent roster') ? t('agents.error.roster') : state.error?.includes('Invalid subagent transcript') ? t('agents.error.transcript') : state.error
  return <section className={`subagents ${selected ? 'has-selection' : ''}`} aria-label={t('agents.title')}>
    <div className="subagents__toolbar">
      <button className={`subagents__tab ${!selected ? 'is-active' : ''}`} type="button" onClick={back}><MessageSquare size={14} />{t('agents.conversation')}</button>
      {selected && <button className="subagents__tab is-active" type="button"><Bot size={14} />{selected.agent}<Status status={selected.status} /></button>}
      <button className="subagents__roster-toggle" type="button" aria-expanded={open} aria-label={t('agents.rosterAria', { running, total: state.agents.length })} onClick={() => setOpen(!open)}>
        <Users size={14} /><span>{t('agents.title')}</span><span className="subagents__count">{state.agents.length}</span><ChevronDown size={12} />
      </button>
    </div>
    {open && <div className="subagents__roster" aria-label={t('agents.list')}>
      <div className="subagents__roster-heading"><span>{t('agents.sessionAgents')}</span><small>{t('agents.runningCount', { count: running })}</small></div>
      {!connected && <div className="subagents__empty"><Users size={20} /><p>{t('agents.connect')}</p></div>}
      {connected && !state.agents.length && <div className="subagents__empty"><Bot size={20} /><p>{t('agents.empty')}</p><small>{t('agents.emptyDetail')}</small></div>}
      {state.agents.map((agent) => <button className="subagents__agent" type="button" key={agent.id} aria-pressed={agent.id === selected?.id} onClick={() => { state.select(agent.id); setOpen(false) }}>
        <div className="subagents__agent-icon"><Bot size={16} /></div><div><strong>{agent.agent}</strong><span>{agent.description ?? agent.task ?? agent.id}</span></div><Status status={agent.status} />
      </button>)}
    </div>}
    {error && (open || selected) && <p className="subagents__error" role="alert">{error}</p>}
    {selected && <div className="subagents__page">
      <AgentTranscript key={selected.id} agent={selected} showReasoning={showReasoning} showTools={showTools} />
    </div>}
  </section>
}
