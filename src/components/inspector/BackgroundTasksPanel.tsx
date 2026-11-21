import { AlertCircle, Ban, CheckCircle2, LoaderCircle, RefreshCw, Terminal, X } from 'lucide-react'
import { memo } from 'react'
import { useI18n } from '@/lib/i18n'
import type { OmpBackgroundTask } from '@/lib/omp-background-tasks'
import { IconButton } from '../ui'

interface BackgroundTasksPanelProps {
  tasks: OmpBackgroundTask[]
  hasRuntime?: boolean
  onCancelTask?(task: OmpBackgroundTask): void
  onRefreshTasks?(): void
}

function StatusIcon({ status }: { status: OmpBackgroundTask['status'] }) {
  if (status === 'running') return <LoaderCircle size={14} className="spin" />
  if (status === 'failed') return <AlertCircle size={14} />
  if (status === 'cancelled') return <Ban size={14} />
  return <CheckCircle2 size={14} />
}

/** Shows OMP's active and recent session background tasks rather than scheduled automations. */
export const BackgroundTasksPanel = memo(function BackgroundTasksPanel({ tasks, hasRuntime = false, onCancelTask, onRefreshTasks }: BackgroundTasksPanelProps) {
  const { t } = useI18n()
  return (
    <div className="inspector-scroll scroll-area background-tasks">
      <header className="background-tasks__header">
        <div>
          <h2>{t('inspector.tasks.title')}</h2>
          <small>{t('inspector.tasks.count', { count: tasks.length })}</small>
        </div>
        {hasRuntime && onRefreshTasks ? (
          <IconButton size="small" label={t('inspector.tasks.refresh')} onClick={onRefreshTasks}>
            <RefreshCw size={13} />
          </IconButton>
        ) : null}
      </header>
      {tasks.length ? (
        <div className="background-tasks__list">
          {tasks.map((task) => (
            <div className={`background-task-row is-${task.status}`} key={task.id}>
              <span className={`summary-automation-icon background-task-row__icon is-${task.status}`}>
                {task.kind === 'bash' || task.kind === 'script' ? <Terminal size={14} /> : <StatusIcon status={task.status} />}
              </span>
              <span className="background-task-row__copy">
                <strong title={task.title}>{task.title}</strong>
                <small>
                  {task.type} · {t(`inspector.tasks.status.${task.status}`)}
                  {task.detail ? ` · ${task.detail}` : ''}
                </small>
              </span>
              {task.status === 'running' && task.cancellable && onCancelTask ? (
                <IconButton size="small" label={t('inspector.tasks.cancel')} onClick={() => onCancelTask(task)}>
                  <X size={13} />
                </IconButton>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="background-tasks__empty">
          <p>{t('inspector.tasks.empty')}</p>
          {hasRuntime && onRefreshTasks ? (
            <button type="button" onClick={onRefreshTasks}>
              {t('inspector.tasks.refresh')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
})
