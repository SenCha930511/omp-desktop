import { Bell, CheckCircle2, CircleAlert, Clock3, LoaderCircle, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { activityNotificationSignature, signatureCleared } from '@/app/session-attention'
import { EmptyState, Segmented } from '@/components/ui'
import { formatRelative } from '@/lib/data'
import { useI18n } from '@/lib/i18n'
import type { ProjectRecord, SessionRecord } from '@/types/api'

export type ActivityFilter = 'all' | 'attention' | 'running'
export const ACTIVITY_BATCH = 250

export interface ActivityViewState {
  filter: ActivityFilter
  query: string
  visibleLimit: number
}

export function updateActivityCriteria(state: ActivityViewState, criteria: Partial<Pick<ActivityViewState, 'filter' | 'query'>>): ActivityViewState {
  return { ...state, ...criteria, visibleLimit: ACTIVITY_BATCH }
}

export function growActivityBatch(state: ActivityViewState, total: number): ActivityViewState {
  return { ...state, visibleLimit: Math.min(total, state.visibleLimit + ACTIVITY_BATCH) }
}

interface ActivityPageProps {
  sessions: SessionRecord[]
  projects: ProjectRecord[]
  clearedActivity: Record<string, string>
  onOpen(session: SessionRecord): void
  onClear(sessions: SessionRecord[]): void
}

export function ActivityPage({ sessions, projects, clearedActivity, onOpen, onClear }: ActivityPageProps) {
  const { t } = useI18n()
  const [viewState, setViewState] = useState<ActivityViewState>({ filter: 'all', query: '', visibleLimit: ACTIVITY_BATCH })
  const { filter, query, visibleLimit } = viewState
  const projectNames = useMemo(() => new Map(projects.flatMap((project) => [...new Set([project.path, ...project.folders])].map((path) => [path, project.name] as const))), [projects])
  const normalized = query.trim().toLowerCase()
  const clearable = useMemo(
    () =>
      sessions.filter((session) => {
        const signature = activityNotificationSignature(session)
        return Boolean(signature && !signatureCleared(signature, clearedActivity[session.id], session.unread))
      }),
    [clearedActivity, sessions],
  )
  const visible = useMemo(
    () =>
      sessions
        .filter((session) => {
          const signature = activityNotificationSignature(session)
          const statusMatches =
            !session.archived &&
            (!signature || !signatureCleared(signature, clearedActivity[session.id], session.unread)) &&
            (filter === 'all' || (filter === 'attention' && (session.unread || session.status === 'waiting' || session.status === 'failed')) || (filter === 'running' && session.status === 'running'))
          return statusMatches && (!normalized || `${session.title} ${session.preview ?? ''}`.toLowerCase().includes(normalized))
        })
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [clearedActivity, sessions, filter, normalized],
  )
  const displayed = visible.slice(0, visibleLimit)
  const projectName = (path: string) => projectNames.get(path) ?? path.split('/').at(-1)

  return (
    <div className="page scroll-area">
      <div className="page-container page-container--narrow">
        <header className="page-header">
          <div>
            <h1>{t('activity.title')}</h1>
            <p>{t('activity.subtitle')}</p>
          </div>
        </header>
        <div className="page-tools page-tools--activity">
          <Segmented
            value={filter}
            label={t('activity.filterLabel')}
            onChange={(value) => setViewState((current) => updateActivityCriteria(current, { filter: value as ActivityFilter }))}
            options={[
              { value: 'all', label: t('activity.filterAll') },
              { value: 'attention', label: t('activity.filterAttention') },
              { value: 'running', label: t('activity.filterRunning') },
            ]}
          />
          <div className="activity-tools__right">
            <label className="page-search page-search--small">
              <Search size={13} />
              <input value={query} onChange={(event) => setViewState((current) => updateActivityCriteria(current, { query: event.target.value }))} placeholder={t('activity.searchPlaceholder')} />
            </label>
            <button type="button" className="button button--compact activity-clear-all" disabled={!clearable.length} onClick={() => onClear(clearable)}>
              {t('activity.clearAll')}
            </button>
          </div>
        </div>
        {displayed.length ? (
          <div className="activity-list">
            {displayed.map((session) => {
              const clearableSession = Boolean(activityNotificationSignature(session))
              return (
                <div className="activity-row" key={session.id}>
                  <button type="button" className="activity-row__main" aria-label={t('activity.openSession', { name: session.title })} onClick={() => onOpen(session)}>
                    <span className={`activity-icon activity-icon--${session.status}`}>
                      {session.status === 'running' ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : session.status === 'failed' || session.status === 'waiting' ? (
                        <CircleAlert size={15} />
                      ) : (
                        <CheckCircle2 size={15} />
                      )}
                    </span>
                    <span className="activity-main">
                      <span>
                        <strong>{session.title}</strong>
                        {session.unread ? <i>{t('activity.new')}</i> : null}
                      </span>
                      <small>{session.preview ?? t('activity.previewFallback')}</small>
                      <span>
                        <span>{projectName(session.projectPath)}</span>
                        <span>
                          <Clock3 size={11} />
                          {formatRelative(session.updatedAt)}
                        </span>
                      </span>
                    </span>
                    <span className={`activity-status activity-status--${session.status}`}>
                      {session.status === 'waiting' ? t('activity.needsAttention') : session.status === 'complete' ? t('activity.finished') : session.status}
                    </span>
                  </button>
                  {clearableSession ? (
                    <button
                      type="button"
                      className={`activity-row__clear activity-row__clear--${session.status}`}
                      aria-label={t('activity.clearSession', { name: session.title })}
                      title={t('activity.clearActivity')}
                      onClick={() => onClear([session])}
                    >
                      <X size={15} />
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : (
          <EmptyState icon={<Bell size={24} />} title={t('activity.emptyTitle')}>
            {t('activity.emptyBody')}
          </EmptyState>
        )}
        {visible.length > displayed.length ? (
          <button type="button" className="page-show-more" onClick={() => setViewState((current) => growActivityBatch(current, visible.length))}>
            {t('activity.showMore', { count: Math.min(ACTIVITY_BATCH, visible.length - displayed.length) })}
          </button>
        ) : null}
      </div>
    </div>
  )
}
