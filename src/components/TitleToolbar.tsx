import { GitBranch, LayoutDashboard, ListTree, PanelLeft, PanelRight, PanelRightClose, Settings, SquarePen } from 'lucide-react'
import { memo, useEffect, useId, useRef, useState, type MouseEvent } from 'react'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import type { ApplicationMenuName, ProjectRecord, WorkspaceView } from '@/types/api'
import type { ProjectScriptKind } from './ProjectRunControl'
import { BrowserGlobe, IconButton } from './ui'

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

function openApplicationMenu(menu: ApplicationMenuName, event: MouseEvent<HTMLButtonElement>): void {
  const rect = event.currentTarget.getBoundingClientRect()
  void window.desktop?.app.popupMenu?.(menu, rect.left, rect.bottom).catch(() => undefined)
}

export interface TitleToolbarProps {
  project?: ProjectRecord
  gitBranch?: string
  /** Active session name; the session view's title takes it over the project name. */
  sessionTitle?: string
  view: WorkspaceView
  /** Active harness product name; the session view's fallback title. */
  productName?: string
  sidebarOpen: boolean
  inspectorOpen: boolean
  onToggleSidebar(): void
  onToggleInspector(): void
  onOpenBrowser(): void
  /** Opens the session tree dialog; only rendered in the session view. */
  onOpenSessionTree?(): void
  /** Starts a fresh session in the active project; only rendered in the session view. */
  onNewSession?(): void
  /** Workspace totals shown in the Overview popover. */
  projectCount?: number
  sessionCount?: number
  agentCount?: number
  runningAgentCount?: number
  /** Enabled (active) automation schedules. */
  scheduleCount?: number
  /** Opens Settings; the Overview popover's secondary action. */
  onOpenSettings?(): void
  activeProjectScriptKind?: ProjectScriptKind
  onRunProjectScript?(kind: ProjectScriptKind): Promise<void> | void
  onStopProjectScript?(): void
  onSaveProjectScripts?(scripts: { setup: string; run: string }): Promise<void>
  platform?: NodeJS.Platform
}

function TitleToolbarView({
  project,
  gitBranch,
  sessionTitle,
  view,
  productName = 'OMP Desktop',
  sidebarOpen,
  inspectorOpen,
  onToggleSidebar,
  onToggleInspector,
  onOpenBrowser,
  onOpenSessionTree,
  onNewSession,
  projectCount = 0,
  sessionCount = 0,
  agentCount = 0,
  runningAgentCount = 0,
  scheduleCount = 0,
  onOpenSettings,
  platform = 'darwin',
}: TitleToolbarProps) {
  const { t } = useI18n()
  const overviewId = useId()
  const overviewRef = useRef<HTMLDivElement>(null)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const sidebarShortcut = shortcutLabel(platform, ['Primary', 'B'])
  const browserShortcut = shortcutLabel(platform, ['Primary', 'Shift', 'B'])
  const overviewCounts: ReadonlyArray<{ label: MessageKey; value: number }> = [
    { label: 'toolbar.overviewProjects', value: projectCount },
    { label: 'toolbar.overviewSessions', value: sessionCount },
    { label: 'toolbar.overviewAgents', value: agentCount },
    { label: 'toolbar.overviewRunningAgents', value: runningAgentCount },
    { label: 'toolbar.overviewSchedules', value: scheduleCount },
  ]
  // Escape and an outside pointer both dismiss the popover, mirroring the
  // other toolbar menus; actions close it themselves before they run.
  useEffect(() => {
    if (!overviewOpen) return
    const dismiss = (event: PointerEvent) => {
      if (!overviewRef.current?.contains(event.target as Node)) setOverviewOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOverviewOpen(false)
      }
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', dismissOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', dismissOnEscape, true)
    }
  }, [overviewOpen])
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
          <span className="branch-pill">
            <GitBranch size={12} />
            {gitBranch ?? project?.gitBranch}
          </span>
        ) : null}
      </div>
      <div className="title-toolbar__actions no-drag">
        {view === 'session' && onNewSession ? (
          <IconButton label={t('toolbar.newSession')} onClick={onNewSession}>
            <SquarePen size={17} />
          </IconButton>
        ) : null}
        {view === 'session' ? (
          <div ref={overviewRef} className="title-toolbar__overview">
            <IconButton
              className={overviewOpen ? 'is-active' : ''}
              label={t('toolbar.overview')}
              aria-haspopup="dialog"
              aria-expanded={overviewOpen}
              aria-controls={overviewOpen ? overviewId : undefined}
              onClick={() => setOverviewOpen((open) => !open)}
            >
              <LayoutDashboard size={16} />
            </IconButton>
            {overviewOpen ? (
              <section id={overviewId} className="toolbar-overview" role="dialog" aria-label={t('toolbar.overviewTitle')}>
                <dl className="toolbar-overview__counts">
                  {overviewCounts.map(({ label, value }) => (
                    <div key={label}>
                      <dt>{t(label)}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="toolbar-overview__actions">
                  {onNewSession ? (
                    <button
                      type="button"
                      className="toolbar-overview__action"
                      onClick={() => {
                        setOverviewOpen(false)
                        onNewSession?.()
                      }}
                    >
                      <SquarePen size={14} />
                      {t('toolbar.overviewNewSession')}
                    </button>
                  ) : null}
                  {onOpenSettings ? (
                    <button
                      type="button"
                      className="toolbar-overview__action"
                      onClick={() => {
                        setOverviewOpen(false)
                        onOpenSettings?.()
                      }}
                    >
                      <Settings size={14} />
                      {t('toolbar.overviewOpenSettings')}
                    </button>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
        {view === 'session' && onOpenSessionTree ? (
          <IconButton label={t('toolbar.sessionTree')} onClick={onOpenSessionTree}>
            <ListTree size={17} />
          </IconButton>
        ) : null}
        {view === 'session' ? (
          <IconButton label={t('toolbar.openBrowser', { shortcut: browserShortcut })} onClick={onOpenBrowser}>
            <BrowserGlobe size={18} />
          </IconButton>
        ) : null}
        {view === 'session' ? (
          <IconButton className={inspectorOpen ? 'is-active' : ''} label={t('toolbar.toggleInspector')} onClick={onToggleInspector}>
            {inspectorOpen ? <PanelRightClose size={16} /> : <PanelRight size={16} />}
          </IconButton>
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
