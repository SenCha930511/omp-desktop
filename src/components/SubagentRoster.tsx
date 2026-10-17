import { Bot, Pin, PinOff, Users, X } from 'lucide-react'
import { useMemo } from 'react'
import type { SubagentView } from '@/hooks/useSubagents'
import { useI18n } from '@/lib/i18n'
import { prioritizeSubagents, subagentExecution } from '@/lib/subagent-activity'
import { ExecutionStatus, EXECUTION_LABELS } from './ExecutionStatus'

export function SubagentRoster({ agents, selectedId, connected, pinned, onPin, onClose, onSelect }: {
  agents: SubagentView[]; selectedId?: string; connected: boolean; pinned: boolean
  onPin(): void; onClose(): void; onSelect(id: string): void
}) {
  const { t } = useI18n()
  const entries = useMemo(() => prioritizeSubagents(agents).map((agent) => ({ agent, activity: subagentExecution(agent) })), [agents])
  return <div className={`subagents__roster ${pinned ? 'is-pinned' : ''}`} aria-label={t('agents.list')}>
    <div className="subagents__roster-heading"><span>{t('agents.sessionAgents')}</span>
      <div><button type="button" aria-label={t(pinned ? 'agents.unpin' : 'agents.pin')} aria-pressed={pinned} onClick={onPin}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
      <button type="button" aria-label={t('agents.closeList')} onClick={onClose}><X size={14} /></button></div>
    </div>
    <div className="subagents__roster-scroll">
      {!connected && <div className="subagents__empty"><Users size={20} /><p>{t('agents.connect')}</p></div>}
      {connected && !agents.length && <div className="subagents__empty"><Bot size={20} /><p>{t('agents.empty')}</p><small>{t('agents.emptyDetail')}</small></div>}
      {entries.map(({ agent, activity }) => {
        const duration = agent.progress?.durationMs
        return <button className={`subagents__agent is-${activity.phase}`} type="button" key={agent.id} aria-pressed={agent.id === selectedId}
          aria-label={`${agent.agent} · ${t(EXECUTION_LABELS[activity.phase])} · ${agent.description ?? agent.task ?? ''}`} onClick={() => onSelect(agent.id)}>
          <div className="subagents__agent-icon"><Bot size={16} /></div>
          <div><div className="subagents__agent-title"><strong>{agent.agent}</strong>{typeof duration === 'number' && <small>{t('agents.seconds', { count: Math.round(duration / 1_000) })}</small>}</div>
            <span className="subagents__agent-task" title={agent.task ?? agent.description}>{agent.description ?? agent.task ?? agent.id}</span>
            <ExecutionStatus state={activity} compact />
          </div>
        </button>
      })}
    </div>
  </div>
}
