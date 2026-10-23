import { CalendarClock, Check, CircleDot, GitBranch, LoaderCircle } from 'lucide-react'
import { memo, useMemo } from 'react'
import { formatRelative } from '@/lib/data'
import { formatSessionCost, formatSessionTokens } from '@/lib/format-cost'
import { useI18n } from '@/lib/i18n'
import type { AutomationScheduleRecord, GitStatus, ProjectRecord, RuntimeInfo, TranscriptMessage } from '@/types/api'
import { MarkdownText } from '../MarkdownText'

interface SummaryPanelProps {
  /** Active harness agent name ("OMP"). */
  agentName?: string
  /** Short harness name for working copy ("OMP"). */
  shortName?: string
  project?: ProjectRecord
  runtime?: RuntimeInfo | null
  messages: TranscriptMessage[]
  git: GitStatus
  automations: AutomationScheduleRecord[]
  onOpenAutomation(id: string): void
}

export interface TranscriptSummary {
  toolCount: number
  lastText?: string
}

/** One pass for the tool count; one reverse walk that stops at the first text part. */
export function summarizeTranscript(messages: TranscriptMessage[]): TranscriptSummary {
  let toolCount = 0
  for (const message of messages) {
    for (const part of message.parts) if (part.type === 'toolCall') toolCount += 1
  }
  let lastText: string | undefined
  for (let index = messages.length - 1; index >= 0 && lastText === undefined; index -= 1) {
    if (messages[index].role !== 'assistant') continue
    const parts = messages[index].parts
    for (let cursor = parts.length - 1; cursor >= 0; cursor -= 1) {
      const part = parts[cursor]
      if (part.type === 'text') {
        lastText = part.text
        break
      }
    }
  }
  return { toolCount, lastText }
}

export const SummaryPanel = memo(function SummaryPanel({ agentName = 'OMP', shortName = 'OMP', project, runtime, messages, git, automations, onOpenAutomation }: SummaryPanelProps) {
  const { t } = useI18n()
  const { toolCount, lastText } = useMemo(() => summarizeTranscript(messages), [messages])
  const active = Boolean(runtime?.isStreaming || runtime?.isCompacting)
  const sessionCost = formatSessionCost(runtime?.sessionUsage)
  const sessionTokens = formatSessionTokens(runtime?.sessionUsage)
  return (
    <div className="inspector-scroll scroll-area summary-panel">
      <section className="summary-hero">
        <span className={`run-state ${active ? 'is-running' : ''}`}>
          {active ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
          {runtime?.isCompacting ? t('inspector.state.compacting') : active ? t('inspector.state.working', { name: shortName }) : t('inspector.state.ready')}
        </span>
        <h2>{runtime?.isCompacting ? t('inspector.title.compacting') : active ? t('inspector.title.working') : t('inspector.title.overview')}</h2>
        {lastText !== undefined ? <><h3>{t('inspector.summary.latestReply')}</h3><MarkdownText text={lastText.length > 220 ? `${lastText.slice(0, 220)}…` : lastText} /></> : <MarkdownText text={t('inspector.summary.empty')} />}
      </section>
      <section className="summary-section">
        <h3>{t('inspector.summary.workspace')}</h3>
        <dl className="detail-list">
          <div>
            <dt>{t('inspector.summary.project')}</dt>
            <dd>{project?.name ?? t('inspector.summary.noProject')}</dd>
          </div>
          <div>
            <dt>{t('inspector.summary.branch')}</dt>
            <dd>
              <GitBranch size={12} />
              {git.branch ?? project?.gitBranch ?? '—'}
            </dd>
          </div>
          <div>
            <dt>{t('inspector.summary.environment')}</dt>
            <dd>{t('inspector.summary.environmentLocal')}</dd>
          </div>
          <div>
            <dt>{t('inspector.summary.workingDirectory')}</dt>
            <dd title={project?.primaryFolder} className="mono truncate">
              {project?.primaryFolder ?? '—'}
            </dd>
          </div>
        </dl>
      </section>
      <section className="summary-section">
        <h3>{t('inspector.summary.progress')}</h3>
        <div className="progress-list">
          <div>
            <Check size={13} />
            <span>{t('inspector.summary.contextLoaded')}</span>
          </div>
          <div>
            <Check size={13} />
            <span>{t('inspector.summary.toolCalls', { count: toolCount })}</span>
          </div>
          <div className={git.files.length ? 'is-current' : ''}>
            <CircleDot size={13} />
            <span>{git.files.length ? t('inspector.summary.filesReady', { count: git.files.length }) : git.isRepo ? t('inspector.summary.noChanges') : t('inspector.summary.noRepo')}</span>
          </div>
        </div>
      </section>
      {automations.length ? (
        <section className="summary-section">
          <h3>{t('inspector.summary.automations')}</h3>
          <div className="summary-automation-list">
            {automations.slice(0, 2).map((task) => (
              <button type="button" key={task.id} onClick={() => onOpenAutomation(task.id)}>
                <span className="summary-automation-icon">
                  <CalendarClock size={14} />
                </span>
                <span>
                  <strong>{task.title}</strong>
                  <small>
                    {task.status}
                    {task.nextRunAt ? t('inspector.summary.automationNext', { time: formatRelative(task.nextRunAt) }) : ''}
                  </small>
                </span>
              </button>
            ))}
            {automations.length > 2 ? (
              <button type="button" className="summary-automation-more" onClick={() => onOpenAutomation(automations[0]!.id)}>
                {t('inspector.summary.viewAllAutomations', { count: automations.length })}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
      <section className="summary-section">
        <h3>{t('inspector.summary.context')}</h3>
        <div className="context-meter">
          <div>
            <span>{t('inspector.summary.sessionContext')}</span>
            <span>{t('inspector.summary.managed')}</span>
          </div>
          <small>{t('inspector.summary.managedDescription', { name: agentName })}</small>
        </div>
        {sessionCost !== null ? (
          <dl className="detail-list summary-cost">
            <div>
              <dt>{t('inspector.summary.cost')}</dt>
              <dd title={sessionTokens ?? undefined}>{sessionCost}</dd>
            </div>
            {sessionTokens ? (
              <div>
                <dt>{t('inspector.summary.tokens')}</dt>
                <dd className="mono truncate" title={sessionTokens}>
                  {sessionTokens}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </section>
    </div>
  )
})
