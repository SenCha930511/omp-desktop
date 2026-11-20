import { CalendarClock, Clock } from 'lucide-react'
import { memo } from 'react'
import { formatRelative } from '@/lib/data'
import { useI18n } from '@/lib/i18n'
import type { AutomationScheduleRecord } from '@/types/api'

interface BackgroundTasksPanelProps {
  automations: AutomationScheduleRecord[]
  onOpenAutomation(id: string): void
  onOpenSchedules(): void
}

/** Full automation list, unsliced unlike the Summary tab's two-row preview. */
export const BackgroundTasksPanel = memo(function BackgroundTasksPanel({ automations, onOpenAutomation, onOpenSchedules }: BackgroundTasksPanelProps) {
  const { t } = useI18n()
  return (
    <div className="inspector-scroll scroll-area background-tasks">
      <header className="background-tasks__header">
        <h2>{t('inspector.tasks.title')}</h2>
        <small>{t('inspector.tasks.count', { count: automations.length })}</small>
      </header>
      {automations.length ? (
        <div className="summary-automation-list background-tasks__list">
          {automations.map((task) => (
            <button type="button" key={task.id} onClick={() => onOpenAutomation(task.id)}>
              <span className="summary-automation-icon">
                {task.blockedReason ? <Clock size={14} /> : <CalendarClock size={14} />}
              </span>
              <span>
                <strong>{task.title}</strong>
                <small>
                  {task.status}
                  {task.nextRunAt ? ` · ${t('inspector.tasks.nextRun', { time: formatRelative(task.nextRunAt) })}` : ''}
                </small>
                {task.blockedReason ? <small className="background-tasks__blocked">{t('inspector.tasks.blocked', { reason: task.blockedReason })}</small> : null}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="background-tasks__empty">
          <p>{t('inspector.tasks.empty')}</p>
          <button type="button" onClick={onOpenSchedules}>
            {t('inspector.tasks.open')}
          </button>
        </div>
      )}
    </div>
  )
})
