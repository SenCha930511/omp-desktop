import { Check, CircleDot, FileText, GitBranch, LoaderCircle, PanelLeft, PanelRight, PanelRightClose, Users } from 'lucide-react'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type RefObject } from 'react'
import { EMPTY_TRANSCRIPT_SUMMARY, type TranscriptStore } from '@/app/transcript-store'
import type { SubagentView } from '@/hooks/useSubagents'
import { formatSessionCost, formatSessionTokens } from '@/lib/format-cost'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import { subagentExecution } from '@/lib/subagent-activity'
import type { ApplicationMenuName, GitStatus, InspectorTab, ProjectRecord, RuntimeInfo, WorkspaceView } from '@/types/api'
import { EXECUTION_LABELS } from './ExecutionStatus'
import { MarkdownText } from './MarkdownText'
import type { ProjectScriptKind } from './ProjectRunControl'
import { IconButton } from './ui'

const viewTitles: Record<Exclude<WorkspaceView, 'session'>, MessageKey> = {
  projects: 'nav.projects',
  activity: 'nav.activity',
  scheduled: 'nav.scheduled',
  plugins: 'nav.capabilities',
  settings: 'nav.settings',
}

const windowsMenus: ReadonlyArray<{ name: ApplicationMenuName; label: MessageKey }> = [
  { name: 'file', label: 'toolbar.menuFile' },
  { name: 'edit', label: 'toolbar.menuEdit' },
  { name: 'view', label: 'toolbar.menuView' },
  { name: 'window', label: 'toolbar.menuWindow' },
  { name: 'help', label: 'toolbar.menuHelp' },
]

const EMPTY_GIT: GitStatus = { isRepo: false, files: [] }
const EMPTY_SUBAGENTS: SubagentView[] = []
const NOOP_SUBSCRIBE = () => () => undefined
const EMPTY_SUMMARY = () => EMPTY_TRANSCRIPT_SUMMARY

function openApplicationMenu(menu: ApplicationMenuName, event: MouseEvent<HTMLButtonElement>): void {
  const rect = event.currentTarget.getBoundingClientRect()
  void window.desktop?.app.popupMenu?.(menu, rect.left, rect.bottom).catch(() => undefined)
}

// Escape and an outside pointer both dismiss a toolbar popover, mirroring the
// other toolbar menus; actions close it themselves before they run.
function useToolbarPopoverDismiss(open: boolean, setOpen: (open: boolean) => void, ref: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', dismissOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', dismissOnEscape, true)
    }
  }, [open, ref, setOpen])
}

export interface TitleToolbarProps {
  project?: ProjectRecord
  gitBranch?: string
  /** Active session name; the session view's title takes it over the project name. */
  sessionTitle?: string
  view: WorkspaceView
  /** Active harness product name; the session view's fallback title. */
  productName?: string
  /** Short harness name shown in status badge copy. */
  shortName?: string
  /** Agent display name shown in context management copy. */
  agentName?: string
  sidebarOpen: boolean
  inspectorOpen: boolean
  onToggleSidebar(): void
  onToggleInspector(): void
  /** Opens a specific panel tab in the Inspector (e.g. Agents from Subagents section). */
  onSelectInspectorTab?(tab: InspectorTab): void
  /** Git status shown in workspace summary. */
  git?: GitStatus
  /** Live session transcript store; subscribed only while Overview is open. */
  transcript?: TranscriptStore
  /** Active session runtime snapshot for status and usage metrics. */
  runtime?: RuntimeInfo | null
  /** Active session subagents shown in the Overview card. */
  subagents?: SubagentView[]
  /** Focuses a subagent and opens the Agents inspector tab. */
  onSelectSubagent?(id: string): void
  activeProjectScriptKind?: ProjectScriptKind
  onRunProjectScript?(kind: ProjectScriptKind): Promise<void> | void
  onStopProjectScript?(): void
  onSaveProjectScripts?(scripts: { setup: string; run: string }): Promise<void>
  platform?: NodeJS.Platform
}

function ToolbarOverviewContent({
  overviewId,
  agentName,
  shortName,
  project,
  gitBranch,
  git,
  transcript,
  runtime,
  subagents,
  onSelectSubagent,
  onSelectInspectorTab,
  onClose,
}: {
  overviewId: string
  agentName: string
  shortName: string
  project?: ProjectRecord
  gitBranch?: string
  git: GitStatus
  transcript?: TranscriptStore
  runtime?: RuntimeInfo | null
  subagents: SubagentView[]
  onSelectSubagent?(id: string): void
  onSelectInspectorTab?(tab: InspectorTab): void
  onClose(): void
}) {
  const { t } = useI18n()
  const subagentPreview = useMemo(
    () => subagents.slice(0, 3).map((agent) => ({ agent, phase: subagentExecution(agent).phase })),
    [subagents],
  )
  const subscribeSummary = useCallback(
    (listener: () => void) => (transcript ? transcript.subscribeSummary(listener) : NOOP_SUBSCRIBE()),
    [transcript],
  )
  const getSummary = useCallback(
    () => (transcript ? transcript.getSummary() : EMPTY_SUMMARY()),
    [transcript],
  )
  const summary = useSyncExternalStore(subscribeSummary, getSummary)
  const active = Boolean(runtime?.isStreaming || runtime?.isCompacting || summary.streaming)
  const sessionCost = formatSessionCost(runtime?.sessionUsage)
  const sessionTokens = formatSessionTokens(runtime?.sessionUsage)

  return (
    <section id={overviewId} className="toolbar-overview" role="dialog" aria-label={t('toolbar.overviewTitle')}>
      <section className="summary-hero toolbar-overview__hero">
        <span className={`run-state ${active ? 'is-running' : ''}`}>
          {active ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
          {runtime?.isCompacting ? t('inspector.state.compacting') : active ? t('inspector.state.working', { name: shortName }) : t('inspector.state.ready')}
        </span>
        <h2>{runtime?.isCompacting ? t('inspector.title.compacting') : active ? t('inspector.title.working') : t('inspector.title.overview')}</h2>
        {summary.lastText !== undefined ? (
          <>
            <h3>{t('inspector.summary.latestReply')}</h3>
            <MarkdownText streaming={active} text={summary.lastText} />
          </>
        ) : (
          <p className="toolbar-overview__empty">{t('inspector.summary.empty')}</p>
        )}
      </section>

      <section className="summary-section toolbar-overview__summary-section">
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
              {gitBranch ?? git.branch ?? project?.gitBranch ?? '—'}
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

      <section className="summary-section toolbar-overview__summary-section">
        <h3>{t('inspector.summary.progress')}</h3>
        <div className="progress-list">
          <div>
            <Check size={13} />
            <span>{t('inspector.summary.contextLoaded')}</span>
          </div>
          <div>
            <Check size={13} />
            <span>{t('inspector.summary.toolCalls', { count: summary.toolCount })}</span>
          </div>
          <div className={git.files.length ? 'is-current' : ''}>
            <CircleDot size={13} />
            <span>{git.files.length ? t('inspector.summary.filesReady', { count: git.files.length }) : git.isRepo ? t('inspector.summary.noChanges') : t('inspector.summary.noRepo')}</span>
          </div>
        </div>
      </section>

      <section className="toolbar-overview__section">
        <div className="toolbar-overview__section-header">
          <span>{t('inspector.tab.agents')}</span>
          <span className="toolbar-overview__badge">{subagents.length}</span>
          {onSelectInspectorTab ? (
            <button
              type="button"
              className="toolbar-overview__see-all"
              onClick={() => {
                onClose()
                onSelectInspectorTab('agents')
              }}
            >
              {t('inspector.newTab.seeAll')}
            </button>
          ) : null}
        </div>
        {subagentPreview.map(({ agent, phase }) => (
          <button
            key={agent.id}
            type="button"
            className="toolbar-overview__action toolbar-overview__subitem"
            onClick={() => {
              onClose()
              onSelectSubagent?.(agent.id)
              onSelectInspectorTab?.('agents')
            }}
          >
            <Users size={13} />
            <span>{agent.agent}</span>
            <span className="toolbar-overview__status">{t(EXECUTION_LABELS[phase])}</span>
          </button>
        ))}
      </section>

      <section className="summary-section toolbar-overview__summary-section">
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
    </section>
  )
}

function TitleToolbarView({
  project,
  gitBranch,
  sessionTitle,
  view,
  productName = 'OMP Desktop',
  shortName = 'OMP',
  agentName = 'OMP',
  sidebarOpen,
  inspectorOpen,
  onToggleSidebar,
  onToggleInspector,
  onSelectInspectorTab,
  git = EMPTY_GIT,
  transcript,
  runtime = null,
  subagents = EMPTY_SUBAGENTS,
  onSelectSubagent,
  platform = 'darwin',
}: TitleToolbarProps) {
  const { t } = useI18n()
  const overviewId = useId()
  const overviewRef = useRef<HTMLDivElement>(null)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const sidebarShortcut = shortcutLabel(platform, ['Primary', 'B'])
  useToolbarPopoverDismiss(overviewOpen, setOverviewOpen, overviewRef)
  return (
    <header className="title-toolbar drag-region">
      {!sidebarOpen && platform === 'darwin' ? <div className="traffic-light-clearance traffic-light-clearance--toolbar" aria-hidden="true" /> : null}
      {platform === 'win32' ? (
        <nav className="windows-app-menu" aria-label={t('toolbar.applicationMenu')}>
          {windowsMenus.map(({ name, label }) => (
            <button key={name} type="button" className="windows-app-menu__button" onClick={(event) => openApplicationMenu(name, event)}>
              {t(label)}
            </button>
          ))}
        </nav>
      ) : null}
      <div className="title-toolbar__nav no-drag">
        {!sidebarOpen ? (
          <IconButton label={t('toolbar.showSidebar', { shortcut: sidebarShortcut })} onClick={onToggleSidebar}>
            <PanelLeft size={16} />
          </IconButton>
        ) : null}
      </div>
      <div className="title-toolbar__identity">
        <strong>{view === 'session' ? (sessionTitle ?? project?.name ?? productName) : (project?.name ?? t(viewTitles[view]))}</strong>
        {(gitBranch ?? project?.gitBranch) && view === 'session' ? (
          <span className="branch-pill" title={gitBranch ?? project?.gitBranch}>
            <GitBranch size={12} />
            <span className="branch-pill__name">{gitBranch ?? project?.gitBranch}</span>
          </span>
        ) : null}
      </div>
      <div className="title-toolbar__actions no-drag">
        {view === 'session' ? (
          <>
            <div ref={overviewRef} className="title-toolbar__overview">
              <IconButton
                className={overviewOpen ? 'is-active' : ''}
                label={t('toolbar.overview')}
                aria-haspopup="dialog"
                aria-expanded={overviewOpen}
                aria-controls={overviewOpen ? overviewId : undefined}
                onClick={() => setOverviewOpen((open) => !open)}
              >
                <FileText size={16} />
              </IconButton>
              {overviewOpen ? (
                <ToolbarOverviewContent
                  overviewId={overviewId}
                  agentName={agentName}
                  shortName={shortName}
                  project={project}
                  gitBranch={gitBranch}
                  git={git}
                  transcript={transcript}
                  runtime={runtime}
                  subagents={subagents}
                  onSelectSubagent={onSelectSubagent}
                  onSelectInspectorTab={onSelectInspectorTab}
                  onClose={() => setOverviewOpen(false)}
                />
              ) : null}
            </div>
            <IconButton
              className={inspectorOpen ? 'is-active' : ''}
              label={t('toolbar.toggleInspector')}
              aria-pressed={inspectorOpen}
              onClick={onToggleInspector}
            >
              {inspectorOpen ? <PanelRightClose size={16} /> : <PanelRight size={16} />}
            </IconButton>
          </>
        ) : null}
        {view !== 'session' && sidebarOpen ? (
          <IconButton label={t('toolbar.hideSidebar', { shortcut: sidebarShortcut })} onClick={onToggleSidebar}>
            <PanelLeft size={16} />
          </IconButton>
        ) : null}
      </div>
    </header>
  )
}

// Every prop takes part in the default shallow compare: the toolbar only
// re-renders when its own chrome state, titles, or handlers actually change.
export const TitleToolbar = memo(TitleToolbarView)
