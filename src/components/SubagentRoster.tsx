import { Bot, Pin, PinOff, Users, X, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { SubagentSubscriptionLevel, SubagentView } from '@/hooks/useSubagents'
import { useI18n } from '@/lib/i18n'
import { prioritizeSubagents, subagentExecution } from '@/lib/subagent-activity'
import { ExecutionStatus, EXECUTION_LABELS } from './ExecutionStatus'

const SUBSCRIPTION_LEVELS: readonly SubagentSubscriptionLevel[] = ['off', 'progress', 'events']

export function SubagentRoster({ agents, selectedId, connected, pinned, onPin, onClose, onSelect, unread, onCancel, pendingActions, subscriptionLevel, onSubscriptionChange }: {
  agents: SubagentView[]; selectedId?: string; connected: boolean; pinned: boolean
  onPin(): void; onClose(): void; onSelect(id: string): void
  unread: ReadonlySet<string>
  onCancel?(id: string): void; pendingActions?: ReadonlySet<string>
  subscriptionLevel?: SubagentSubscriptionLevel; onSubscriptionChange?(level: SubagentSubscriptionLevel): void
}) {
  const { t } = useI18n()
  const [filter, setFilter] = useState<'all' | 'running' | 'attention' | 'completed'>('all')
  const entries = useMemo(() => prioritizeSubagents(agents).map((agent) => ({ agent, activity: subagentExecution(agent) })), [agents])
  const filtered = entries.filter(({ agent, activity }) => {
    if (filter === 'running') return ['starting', 'running', 'thinking', 'compacting'].includes(activity.phase)
    if (filter === 'attention') return ['waiting', 'failed'].includes(activity.phase) || unread.has(agent.id)
    if (filter === 'completed') return ['completed', 'cancelled'].includes(activity.phase)
    return true
  })
  return <div className={`subagents__roster ${pinned ? 'is-pinned' : ''}`} aria-label={t('agents.list')}>
    <div className="subagents__roster-heading"><span>{t('agents.sessionAgents')}</span>
      <div><button type="button" aria-label={t(pinned ? 'agents.unpin' : 'agents.pin')} aria-pressed={pinned} onClick={onPin}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
      <button type="button" aria-label={t('agents.closeList')} onClick={onClose}><X size={14} /></button></div>
    </div>
    <label className="subagents__filter"><select aria-label={t('conversation.agents.filter')} value={filter} onChange={(event) => { const value = event.target.value; if (value === 'all' || value === 'running' || value === 'attention' || value === 'completed') setFilter(value) }}>
      {(['all', 'running', 'attention', 'completed'] as const).map((value) => <option key={value} value={value}>{t(`conversation.agents.${value}`)}</option>)}
    </select></label>
    {onSubscriptionChange && <label className="subagents__subscription"><span>{t('agents.subscription.label')}</span>
      <select aria-label={t('agents.subscription.label')} value={subscriptionLevel ?? 'events'} disabled={pendingActions?.has('subscription')}
        onChange={(event) => { const value = event.target.value; if (SUBSCRIPTION_LEVELS.includes(value as SubagentSubscriptionLevel)) onSubscriptionChange(value as SubagentSubscriptionLevel) }}>
        {SUBSCRIPTION_LEVELS.map((value) => <option key={value} value={value}>{t(`agents.subscription.${value}`)}</option>)}
      </select></label>}
    <div className="subagents__roster-scroll">
      {!connected && <div className="subagents__empty"><Users size={20} /><p>{t('agents.connect')}</p></div>}
      {connected && !agents.length && <div className="subagents__empty"><Bot size={20} /><p>{t('agents.empty')}</p><small>{t('agents.emptyDetail')}</small></div>}
      {connected && agents.length > 0 && !filtered.length && <p className="subagents__empty">{t('conversation.agents.noMatches')}</p>}
      {filtered.map(({ agent, activity }) => {
        const duration = agent.progress?.durationMs
        // 上游 cancel_subagent 只對 live registry 中 running/pending 的子代理有效;
        // 其餘狀態(完成/失敗/中止)已收斂,不提供按鈕。
        const cancellable = agent.status === 'running' || agent.status === 'pending'
        const cancelPending = pendingActions?.has(`cancel:${agent.id}`) ?? false
        return <div className="subagents__agent-row" key={agent.id}>
          <button className={`subagents__agent is-${activity.phase}`} type="button" aria-pressed={agent.id === selectedId}
            aria-label={`${agent.agent} · ${t(EXECUTION_LABELS[activity.phase])} · ${agent.description ?? agent.task ?? ''}${unread.has(agent.id) ? ` · ${t('conversation.agents.unread')}` : ''}`} onClick={() => onSelect(agent.id)}>
            <div className="subagents__agent-icon"><Bot size={16} /></div>
            <div><div className="subagents__agent-title"><strong>{agent.agent}</strong>{unread.has(agent.id) && <span className="subagents__unread" aria-label={t('conversation.agents.unread')} />}{typeof duration === 'number' && <small>{t('agents.seconds', { count: Math.round(duration / 1_000) })}</small>}</div>
              <span className="subagents__agent-task" title={agent.task ?? agent.description}>{agent.description ?? agent.task ?? agent.id}</span>
              <ExecutionStatus state={activity} compact />
            </div>
          </button>
          {cancellable && onCancel && <button className="subagents__cancel" type="button" disabled={cancelPending}
            aria-label={cancelPending ? t('agents.cancelling', { name: agent.agent }) : t('agents.cancelAgent', { name: agent.agent })}
            onClick={(event) => { event.stopPropagation(); onCancel(agent.id) }}><XCircle size={15} /></button>}
        </div>
      })}
    </div>
  </div>
}
