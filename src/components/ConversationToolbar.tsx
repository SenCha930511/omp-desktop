import { Users } from 'lucide-react'
import type { ExecutionState } from '@/lib/execution-state'
import { useI18n } from '@/lib/i18n'
import { ExecutionStatus } from './ExecutionStatus'

/**
 * Conversation header row. It owns the `.subagents__search-slot` the main
 * transcript portals its search trigger into, and the Agents button that opens
 * the inspector's Agents tab. Rendered inside the app's I18nProvider so its
 * chrome follows the UI language.
 */
export function ConversationToolbar({ execution, agentCount, runningCount, onOpenAgents }: {
  execution?: ExecutionState
  agentCount: number
  runningCount: number
  onOpenAgents(): void
}) {
  const { t } = useI18n()
  return (
    <div className="conversation-toolbar">
      {execution && <ExecutionStatus state={execution} />}
      <button
        className="conversation-toolbar__agents"
        type="button"
        aria-label={t('agents.rosterAria', { running: runningCount, total: agentCount })}
        title={t('agents.title')}
        onClick={onOpenAgents}
      >
        <Users size={14} />
        <span>{t('agents.title')}</span>
        <span className="subagents__count">{agentCount}</span>
      </button>
      <div className="subagents__search-slot" />
    </div>
  )
}
