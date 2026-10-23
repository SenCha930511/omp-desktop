import {
  Bell,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronRight,
  Copy,
  Download,
  Folder,
  FolderOpen,
  FolderPlus,
  ListFilter,
  LoaderCircle,
  MoreHorizontal,
  NotebookPen,
  PackageOpen,
  PanelLeftClose,
  Pin,
  Search,
  Settings,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { memo, useEffect, useMemo, useState } from 'react'
import { sessionAttentionSignature, signatureCleared } from '@/app/session-attention'
import { HARNESS_PRODUCT_NAMES } from '@/lib/harness'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import { sortProjects } from '@/lib/project-order'
import { type AppUpdateState, type HarnessId, type HarnessUpdateState, PROJECT_SORT_MODES, type ProjectRecord, type ProjectSortMode, type SessionRecord, type WorkspaceView } from '@/types/api'
import { IconButton, Modal, useFocusTrap } from './ui'

const PROJECT_SORT_LABEL_KEYS = { recent: 'projects.sort.recent', alphabetical: 'projects.sort.alphabetical' } as const satisfies Record<ProjectSortMode, MessageKey>

export interface SidebarProps {
  projects: ProjectRecord[]
  sessions: SessionRecord[]
  activeProjectId?: string
  activeSessionId?: string
  activeView: WorkspaceView
  activeHarness?: HarnessId
  clearedAttention?: Record<string, string>
  updateState?: AppUpdateState
  harnessUpdateState?: HarnessUpdateState
  onHarnessUpdateAction?(): void
  onUpdateAction?(): void | Promise<void>
  onSelectProject(project: ProjectRecord): void
  onSelectSession(session: SessionRecord): void
  onNavigate(view: WorkspaceView): void
  onNewSession(project?: ProjectRecord): void
  /** Selects the draft-session placeholder row without clearing the composer draft. */
  onSelectDraftSession?(project: ProjectRecord): void
  /** Discards the draft placeholder; no confirmation, no backend call. */
  onDiscardDraftSession?(project: ProjectRecord): void | Promise<void>
  onAddProject(): void
  onRemoveProject(project: ProjectRecord): void
  projectSortMode?: ProjectSortMode
  onSetProjectSortMode?(mode: ProjectSortMode): void
  onTogglePinProject?(project: ProjectRecord): void
  onClose(): void
  onOpenPalette(): void
  onRenameSession(session: SessionRecord, title: string): Promise<void>
  onArchiveSession(session: SessionRecord): Promise<void>
  overlay?: boolean
  platform?: NodeJS.Platform
}

export const SIDEBAR_SESSION_LIMIT = 7

export interface SidebarIndexStats {
  projectPaths: number
  sessionScans: number
}

export function indexSidebarSessions(
  projects: ProjectRecord[],
  sessions: SessionRecord[],
  stats?: SidebarIndexStats,
): { activeSessions: SessionRecord[]; sessionsByProject: Map<string, SessionRecord[]> } {
  const activeSessions: SessionRecord[] = []
  const owners = new Map<string, string[]>()
  const sessionsByProject = new Map(projects.map((project) => [project.id, [] as SessionRecord[]]))
  for (const project of projects)
    for (const path of new Set([project.path, ...project.folders])) {
      if (stats) stats.projectPaths += 1
      const entries = owners.get(path) ?? []
      entries.push(project.id)
      owners.set(path, entries)
    }
  for (const session of sessions) {
    if (stats) stats.sessionScans += 1
    if (session.archived) continue
    activeSessions.push(session)
    for (const projectId of owners.get(session.projectPath) ?? []) sessionsByProject.get(projectId)?.push(session)
  }
  const compareByLastUserMessage = (left: SessionRecord, right: SessionRecord) => {
    const difference = Date.parse(right.lastUserMessageAt ?? right.createdAt) - Date.parse(left.lastUserMessageAt ?? left.createdAt)
    return difference || right.createdAt.localeCompare(left.createdAt) || left.filePath.localeCompare(right.filePath)
  }
  // Rows never jump when clicked: selecting a session leaves ordering
  // untouched, so re-sorts happen only on the refresh that publishes new
  // message timestamps — not on mere navigation. Deliberately no "active
  // first" override here; earlier behavior re-ordered the list under the
  // user's cursor on every click.
  activeSessions.sort(compareByLastUserMessage)
  for (const projectSessions of sessionsByProject.values()) projectSessions.sort(compareByLastUserMessage)
  return { activeSessions, sessionsByProject }
}

export function boundedSidebarSessions(sessions: SessionRecord[]): SessionRecord[] {
  return sessions.slice(0, SIDEBAR_SESSION_LIMIT)
}

type Translator = (key: MessageKey, values?: Record<string, string | number>) => string

export function updateControlCopy(state: AppUpdateState, t: Translator): { label: string; title: string } {
  const version = state.version ? ` ${state.version}` : ''
  switch (state.phase) {
    case 'checking':
      return { label: t('sidebar.update.checkingLabel'), title: t('sidebar.update.checkingTitle') }
    case 'available':
      return { label: t('sidebar.update.availableLabel', { version }), title: t('sidebar.update.availableTitle', { version }) }
    case 'downloading':
      return {
        label: state.percent === undefined ? t('sidebar.update.downloadingLabel', { version }) : t('sidebar.update.downloadingPercent', { version, percent: state.percent }),
        title: t('sidebar.update.downloadingTitle', { version }),
      }
    case 'downloaded':
      return { label: t('sidebar.update.downloadedLabel', { version }), title: t('sidebar.update.downloadedTitle', { version }) }
    case 'not-available':
      return { label: t('sidebar.update.upToDateLabel'), title: t('sidebar.update.upToDateTitle') }
    case 'error':
      return { label: version ? t('sidebar.update.retryLabel', { version }) : t('sidebar.update.retryPlainLabel'), title: state.message ?? t('sidebar.update.errorTitle') }
    case 'unsupported':
      return { label: t('sidebar.update.automaticLabel'), title: state.message ?? t('sidebar.update.automaticTitle') }
    default:
      return { label: t('sidebar.update.releaseLabel'), title: t('sidebar.update.releaseTitle') }
  }
}

/** Announced without the percentage so progress ticks do not spam assistive tech. */
function updateAnnouncement(state: AppUpdateState, t: Translator): string {
  const version = state.version ? ` ${state.version}` : ''
  switch (state.phase) {
    case 'available':
      return t('sidebar.update.announceAvailable', { version })
    case 'downloading':
      return t('sidebar.update.announceDownloading', { version })
    case 'downloaded':
      return t('sidebar.update.announceDownloaded', { version })
    case 'error':
      return t('sidebar.update.announceError', { message: state.message ?? t('sidebar.update.tryAgain') })
    default:
      return ''
  }
}

export function updateConfirmCopy(state: AppUpdateState, t: Translator): { title: string; body: string } {
  if (state.phase === 'downloaded')
    return {
      title: t('sidebar.update.confirmRestartTitle'),
      body: t('sidebar.update.confirmRestartBody'),
    }
  return {
    title: t('sidebar.update.confirmDownloadTitle'),
    body: t('sidebar.update.confirmDownloadBody'),
  }
}

/** Sidebar-row copy for the omp harness update lifecycle. */
export function harnessUpdateControlCopy(state: HarnessUpdateState, t: Translator): { label: string; title: string } {
  switch (state.phase) {
    case 'available':
      return { label: t('sidebar.harnessUpdate.availableLabel', { version: state.availableVersion ?? '' }), title: t('sidebar.harnessUpdate.confirmBody', { version: state.availableVersion ?? '' }) }
    case 'installing':
      return { label: t('sidebar.harnessUpdate.installingLabel'), title: t('sidebar.harnessUpdate.installingLabel') }
    case 'installed':
      return { label: t('sidebar.harnessUpdate.installedLabel', { version: state.availableVersion ?? '' }), title: t('sidebar.harnessUpdate.installedLabel', { version: state.availableVersion ?? '' }) }
    case 'error':
      return { label: t('sidebar.harnessUpdate.errorLabel'), title: state.message ?? t('sidebar.harnessUpdate.errorLabel') }
    default:
      return { label: '', title: '' }
  }
}

async function copySessionUuid(id: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(id)
      return
    } catch {
      // Fall back to the document copy command when clipboard permission is unavailable.
    }
  }
  const input = document.createElement('textarea')
  input.value = id
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.append(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error('Copy is unavailable')
}

function SidebarView({
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  activeView,
  activeHarness = 'omp',
  clearedAttention = {},
  updateState = { phase: 'unsupported' },
  harnessUpdateState,
  onHarnessUpdateAction,
  onUpdateAction,
  onSelectProject,
  onSelectSession,
  onNavigate,
  onNewSession,
  onSelectDraftSession = () => undefined,
  onDiscardDraftSession = () => undefined,
  onAddProject,
  onRemoveProject,
  projectSortMode = 'recent',
  onSetProjectSortMode = () => undefined,
  onTogglePinProject = () => undefined,
  onClose,
  onOpenPalette,
  onRenameSession,
  onArchiveSession,
  overlay = false,
  platform = 'darwin',
}: SidebarProps) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const allCollapsed = projects.length > 0 && projects.every((project) => collapsed[project.id] ?? false)
  const [searchOpen, setSearchOpen] = useState(false)
  const sidebarRef = useFocusTrap<HTMLElement>(overlay, onClose)
  const [projectMenu, setProjectMenu] = useState<string | null>(null)
  const [projectSortMenuOpen, setProjectSortMenuOpen] = useState(false)
  const [sessionMenu, setSessionMenu] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<SessionRecord | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [archiveTarget, setArchiveTarget] = useState<SessionRecord | null>(null)
  const [removeTarget, setRemoveTarget] = useState<ProjectRecord | null>(null)
  const [confirmUpdate, setConfirmUpdate] = useState(false)
  // Projects can hold far more sessions than the collapsed preview shows;
  // expansion is per project and survives refreshes within the session.
  // Search bypasses the cap entirely so any matching row stays reachable.
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => new Set())
  const [updateErrorOpen, setUpdateErrorOpen] = useState(false)
  // activeSessionId is deliberately absent from the memo input: selection
  // must not re-index (and thereby re-sort) the rows.
  const { activeSessions, sessionsByProject } = useMemo(() => indexSidebarSessions(projects, sessions, undefined), [projects, sessions])
  // Draft state: a project is active but no session has been created yet. The
  // placeholder row stands in until the first prompt adopts a real session.
  const draftProjectId = activeProjectId && !activeSessionId ? activeProjectId : undefined
  const needsAttention = (session: SessionRecord) => {
    const signature = sessionAttentionSignature(session)
    return Boolean(signature && !signatureCleared(signature, clearedAttention[session.id], session.unread))
  }
  const unreadCount = activeSessions.reduce((count, session) => count + Number(needsAttention(session)), 0)
  const newSessionShortcut = shortcutLabel(platform, ['Primary', 'N'])
  const sidebarShortcut = shortcutLabel(platform, ['Primary', 'B'])
  const commandsShortcut = shortcutLabel(platform, ['Primary', 'K'])
  const settingsShortcut = shortcutLabel(platform, ['Primary', ','])
  const updateCopy = updateControlCopy(updateState, t)
  const updateConfirm = updateConfirmCopy(updateState, t)
  const updateBusy = updateState.phase === 'checking' || updateState.phase === 'downloading'
  const updateIndeterminate = updateState.phase === 'downloading' && updateState.percent === undefined
  const updateVisible = updateState.phase === 'available' || updateState.phase === 'downloading' || updateState.phase === 'downloaded' || updateState.phase === 'error'
  const harnessUpdateCopy = harnessUpdateState ? harnessUpdateControlCopy(harnessUpdateState, t) : null
  const harnessUpdateVisible = Boolean(harnessUpdateState && harnessUpdateState.phase !== 'idle' && harnessUpdateState.phase !== 'up-to-date')
  useEffect(() => {
    if (!projectMenu) return
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.project-group')) setProjectMenu(null)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setProjectMenu(null)
      }
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', dismissOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', dismissOnEscape, true)
    }
  }, [projectMenu])
  useEffect(() => {
    if (!projectSortMenuOpen) return
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.sidebar__sort-menu, .sidebar__sort-toggle')) setProjectSortMenuOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setProjectSortMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', dismissOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', dismissOnEscape, true)
    }
  }, [projectSortMenuOpen])
  useEffect(() => {
    if (!sessionMenu) return
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.session-row-wrap')) setSessionMenu(null)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setSessionMenu(null)
      }
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', dismissOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', dismissOnEscape, true)
    }
  }, [sessionMenu])
  const normalized = query.trim().toLowerCase()
  const visibleProjects = useMemo(
    () =>
      sortProjects(
        projects.filter(
          (project) =>
            !normalized ||
            project.name.toLowerCase().includes(normalized) ||
            (sessionsByProject.get(project.id) ?? []).some((session) => `${session.title} ${session.preview ?? ''}`.toLowerCase().includes(normalized)),
        ),
        projectSortMode,
      ),
    [projects, sessionsByProject, normalized, projectSortMode],
  )

  return (
    <aside ref={sidebarRef} className="sidebar" aria-label={t('sidebar.aria')} tabIndex={overlay ? -1 : undefined}>
      <div className="sidebar__titlebar drag-region">
        <div className="traffic-light-clearance" aria-hidden="true" />
        <div className="sidebar__title-actions no-drag">
          <IconButton label={t('sidebar.newSessionShortcut', { shortcut: newSessionShortcut })} onClick={() => onNewSession()}>
            <NotebookPen size={16} />
          </IconButton>
          <IconButton label={t('sidebar.hideSidebar', { shortcut: sidebarShortcut })} onClick={onClose}>
            <PanelLeftClose size={16} />
          </IconButton>
        </div>
      </div>

      <nav className="sidebar__primary" aria-label={t('sidebar.primaryAria')}>
        <button type="button" title={t('sidebar.newSessionShortcut', { shortcut: newSessionShortcut })} onClick={() => onNewSession()}>
          <NotebookPen size={15} />
          <span>{t('sidebar.newSession')}</span>
          <kbd>{newSessionShortcut}</kbd>
        </button>
        <button
          type="button"
          title={t('sidebar.search')}
          onClick={() => {
            setSearchOpen((open) => !open)
            window.setTimeout(() => document.getElementById('session-search')?.focus(), 0)
          }}
          className={searchOpen ? 'is-active' : ''}
        >
          <Search size={15} />
          <span>{t('sidebar.search')}</span>
        </button>
        {searchOpen ? (
          <div className="sidebar-search">
            <Search size={13} />
            <input id="session-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('sidebar.searchPlaceholder')} aria-label={t('sidebar.searchAria')} />
            {query ? (
              <button type="button" title={t('sidebar.clearSearch')} aria-label={t('sidebar.clearSearch')} onClick={() => setQuery('')}>
                ×
              </button>
            ) : null}
          </div>
        ) : null}
        <button type="button" title={t('nav.projects')} className={activeView === 'projects' ? 'is-active' : ''} onClick={() => onNavigate('projects')}>
          <Folder size={15} />
          <span>{t('nav.projects')}</span>
        </button>
        <button type="button" title={t('nav.activity')} className={activeView === 'activity' ? 'is-active' : ''} onClick={() => onNavigate('activity')}>
          <Bell size={15} />
          <span>{t('nav.activity')}</span>
          {unreadCount ? <span className="nav-count">{unreadCount}</span> : null}
        </button>
        <button type="button" title={t('nav.scheduled')} className={activeView === 'scheduled' ? 'is-active' : ''} onClick={() => onNavigate('scheduled')}>
          <CalendarClock size={15} />
          <span>{t('nav.scheduled')}</span>
        </button>
        <button type="button" title={t('nav.capabilities')} className={activeView === 'plugins' ? 'is-active' : ''} onClick={() => onNavigate('plugins')}>
          <PackageOpen size={15} />
          <span>{t('nav.capabilities')}</span>
        </button>
      </nav>

      <div className="sidebar__scroll scroll-area">
        <div className="sidebar__section-heading">
          <span>{t('nav.projects')}</span>
          <span className="sidebar__section-heading-actions">
            <IconButton
              size="small"
              label={t(allCollapsed ? 'projects.expandAll' : 'projects.collapseAll')}
              disabled={projects.length === 0}
              onClick={() => setCollapsed(allCollapsed ? {} : Object.fromEntries(projects.map((project) => [project.id, true])))}
            >
              {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
            </IconButton>
            <IconButton
              size="small"
              className="sidebar__sort-toggle"
              aria-haspopup="menu"
              aria-expanded={projectSortMenuOpen}
              label={t('projects.sort')}
              onClick={() => setProjectSortMenuOpen((open) => !open)}
            >
              <ListFilter size={13} />
            </IconButton>
            <IconButton size="small" label={t('sidebar.addProject')} onClick={onAddProject}>
              <FolderPlus size={13} />
            </IconButton>
            {projectSortMenuOpen ? (
              <div className="sidebar__sort-menu" role="menu" aria-label={t('projects.sort.menu')}>
                {PROJECT_SORT_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="menuitemradio"
                    aria-checked={projectSortMode === mode}
                    className={projectSortMode === mode ? 'is-active' : ''}
                    onClick={() => {
                      setProjectSortMenuOpen(false)
                      onSetProjectSortMode(mode)
                    }}
                  >
                    {t(PROJECT_SORT_LABEL_KEYS[mode])}
                    {projectSortMode === mode ? <Check size={12} aria-hidden="true" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </span>
        </div>
        {visibleProjects.length === 0 ? <p className="sidebar__empty">{t('sidebar.noMatchingWork')}</p> : null}
        {visibleProjects.map((project) => {
          const projectSessions = (sessionsByProject.get(project.id) ?? []).filter(
            (session) => !normalized || `${session.title} ${session.preview ?? ''}`.toLowerCase().includes(normalized) || project.name.toLowerCase().includes(normalized),
          )
          const isCollapsed = collapsed[project.id] ?? false
          const running = projectSessions.some((session) => session.status === 'running')
          const sessionRows = normalized || expandedProjects.has(project.id) ? projectSessions : boundedSidebarSessions(projectSessions)
          return (
            <div className="project-group" key={project.id}>
              <div
                // Selection belongs to the session row while the project is
                // expanded; a collapsed project row carries it for both.
                className={`project-row ${activeProjectId === project.id && activeView === 'session' && draftProjectId !== project.id && isCollapsed ? 'is-selected' : ''}`}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setProjectMenu(project.id)
                }}
              >
                <button
                  className="project-row__collapse"
                  type="button"
                  aria-label={t(isCollapsed ? 'sidebar.expandProject' : 'sidebar.collapseProject', { name: project.name })}
                  title={t(isCollapsed ? 'sidebar.expandProject' : 'sidebar.collapseProject', { name: project.name })}
                  onClick={() => {
                    setProjectMenu(null)
                    setCollapsed((value) => ({ ...value, [project.id]: !isCollapsed }))
                  }}
                >
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
                <button
                  className="project-row__main"
                  type="button"
                  onClick={() => {
                    setProjectMenu(null)
                    onSelectProject(project)
                  }}
                  title={project.path}
                >
                  {activeProjectId === project.id ? <FolderOpen size={14} /> : <Folder size={14} />}
                  <span>{project.name}</span>
                  {project.pinned ? <Pin className="project-row__pin" size={11} fill="currentColor" /> : null}
                </button>
                <IconButton
                  size="small"
                  className="project-row__new-session row-action"
                  label={t('sidebar.newSessionIn', { name: project.name })}
                  onClick={() => {
                    setProjectMenu(null)
                    onNewSession(project)
                  }}
                >
                  <NotebookPen size={13} />
                </IconButton>
                {running && isCollapsed ? (
                  <span className="project-working" title={t('sidebar.agentWorking')}>
                    <LoaderCircle className="spin" size={13} />
                  </span>
                ) : null}
                {projectMenu === project.id ? (
                  <div className="project-row__menu" role="menu" aria-label={t('sidebar.projectOptions', { name: project.name })}>
                    {!project.inferred ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setProjectMenu(null)
                          onTogglePinProject(project)
                        }}
                      >
                        <Pin size={12} /> {t(project.pinned ? 'projects.unpin' : 'projects.pin')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setProjectMenu(null)
                        setRemoveTarget(project)
                      }}
                    >
                      <Trash2 size={12} /> {t('sidebar.removeProject')}
                    </button>
                  </div>
                ) : null}
              </div>
              {!isCollapsed ? (
                <div className="session-list">
                  {draftProjectId === project.id ? (
                    <div className={`session-row-wrap is-placeholder ${activeView === 'session' ? 'is-selected' : ''}`}>
                      <button
                        type="button"
                        title={t('sidebar.untitledSession')}
                        className="session-row"
                        onClick={() => {
                          setSessionMenu(null)
                          onSelectDraftSession(project)
                        }}
                      >
                        <span className="session-row__text">
                          <span className="session-row__title">{t('sidebar.untitledSession')}</span>
                        </span>
                      </button>
                      <IconButton
                        size="small"
                        className="session-row__archive"
                        label={t('sessions.deleteNamed', { name: t('sidebar.untitledSession') })}
                        onClick={() => {
                          setSessionMenu(null)
                          void onDiscardDraftSession(project)
                        }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </div>
                  ) : null}
                  {sessionRows.map((session) => (
                    <div
                      key={session.id}
                      className={`session-row-wrap session-row-wrap--${session.status} ${needsAttention(session) ? 'has-attention' : ''} ${activeSessionId === session.id && activeView === 'session' ? 'is-selected' : ''}`}
                    >
                      <button
                        type="button"
                        title={session.title}
                        className="session-row"
                        onClick={() => {
                          setSessionMenu(null)
                          onSelectSession(session)
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setSessionMenu(session.id)
                        }}
                      >
                        <span className="session-row__text">
                          <span className="session-row__title">{session.title}</span>
                        </span>
                        {session.status === 'running' ? <span className="session-row__spinner" title={t('sidebar.sessionWorking')}><LoaderCircle className="spin" size={13} /></span> : null}
                      </button>
                      <IconButton
                        size="small"
                        className={`session-row__archive ${archiveTarget?.id === session.id ? 'is-confirming' : ''}`}
                        label={t('sessions.deleteNamed', { name: session.title })}
                        data-archive-confirming={archiveTarget?.id === session.id}
                        onClick={() => {
                          setSessionMenu(null)
                          setArchiveTarget(session)
                        }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                      <IconButton
                        size="small"
                        className="session-row__more"
                        label={t('sidebar.sessionOptions', { name: session.title })}
                        onClick={() => setSessionMenu((current) => (current === session.id ? null : session.id))}
                      >
                        <MoreHorizontal size={13} />
                      </IconButton>
                      {sessionMenu === session.id ? (
                        <div className="session-row__menu" aria-label={t('sidebar.sessionOptionsMenu')}>
                          <button
                            type="button"
                            onClick={() => {
                              void copySessionUuid(session.id)
                              setSessionMenu(null)
                            }}
                          >
                            <Copy size={12} /> {t('sidebar.copySessionUuid')}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRenameTarget(session)
                              setRenameValue(session.title)
                              setSessionMenu(null)
                            }}
                          >
                            <SquarePen size={12} /> {t('sidebar.rename')}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                  {projectSessions.length > SIDEBAR_SESSION_LIMIT && !normalized ? (
                    <button
                      type="button"
                      className="session-row session-row--expand"
                      aria-expanded={expandedProjects.has(project.id)}
                      onClick={() =>
                        setExpandedProjects((current) => {
                          const next = new Set(current)
                          if (next.has(project.id)) next.delete(project.id)
                          else next.add(project.id)
                          return next
                        })
                      }
                    >
                      <ChevronDown size={12} className={expandedProjects.has(project.id) ? 'is-expanded' : undefined} />
                      {expandedProjects.has(project.id) ? t('sidebar.showLessSessions') : t('sidebar.showAllSessions', { count: projectSessions.length })}
                    </button>
                  ) : null}
                  {projectSessions.length === 0 && draftProjectId !== project.id ? (
                    <button
                      type="button"
                      title={t('sidebar.newSessionIn', { name: project.name })}
                      className="session-row session-row--empty"
                      onClick={() => {
                        setProjectMenu(null)
                        onNewSession(project)
                      }}
                    >
                      <NotebookPen size={12} /> {t('sidebar.newSession')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="sidebar__footer">
        <button type="button" title={t('sidebar.commands')} onClick={onOpenPalette}>
          <Search size={15} />
          <span>{t('sidebar.commands')}</span>
          <kbd>{commandsShortcut}</kbd>
        </button>
        {updateVisible ? (
          <>
            <span className="sr-only" role="status" aria-live="polite">
              {updateAnnouncement(updateState, t)}
            </span>
            <button
              type="button"
              className={`sidebar-update sidebar-update--${updateState.phase} ${updateIndeterminate ? 'sidebar-update--indeterminate' : ''}`}
              title={updateCopy.title}
              aria-label={updateCopy.title}
              disabled={updateBusy}
              onClick={() => {
                if (updateState.phase === 'error') setUpdateErrorOpen(true)
                else setConfirmUpdate(true)
              }}
            >
              <span className="sidebar-update__icon">
                {updateState.phase === 'checking' || updateState.phase === 'downloading' ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
              </span>
              <span>{updateCopy.label}</span>
            </button>
          </>
        ) : null}
        {harnessUpdateVisible && harnessUpdateCopy ? (
          <button
            type="button"
            className={`sidebar-update sidebar-update--harness-${harnessUpdateState?.phase}`}
            title={harnessUpdateCopy.title}
            aria-label={harnessUpdateCopy.title}
            disabled={harnessUpdateState?.phase === 'installing'}
            onClick={() => onHarnessUpdateAction?.()}
          >
            <span className="sidebar-update__icon">
              {harnessUpdateState?.phase === 'installing' ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
            </span>
            <span>{harnessUpdateCopy.label}</span>
          </button>
        ) : null}
        <button type="button" title={t('nav.settings')} className={activeView === 'settings' ? 'is-active' : ''} onClick={() => onNavigate('settings')}>
          <Settings size={15} />
          <span>{t('nav.settings')}</span>
          <kbd>{settingsShortcut}</kbd>
        </button>
      </div>
      {renameTarget ? (
        <Modal
          title={t('sidebar.renameSessionTitle')}
          onClose={() => setRenameTarget(null)}
          footer={
            <>
              <button type="button" className="button" onClick={() => setRenameTarget(null)}>
                {t('sidebar.cancel')}
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={!renameValue.trim()}
                onClick={() => {
                  const target = renameTarget
                  const title = renameValue.trim()
                  setRenameTarget(null)
                  void onRenameSession(target, title)
                }}
              >
                {t('sidebar.rename')}
              </button>
            </>
          }
        >
          <label className="field">
            <span>{t('sidebar.sessionName')}</span>
            <input
              autoFocus
              value={renameValue}
              maxLength={200}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && renameValue.trim()) {
                  event.preventDefault()
                  const target = renameTarget
                  const title = renameValue.trim()
                  setRenameTarget(null)
                  void onRenameSession(target, title)
                }
              }}
            />
          </label>
        </Modal>
      ) : null}
      {removeTarget ? (
        <Modal
          title={t('sidebar.removeProject')}
          onClose={() => setRemoveTarget(null)}
          footer={
            <>
              <button type="button" className="button" onClick={() => setRemoveTarget(null)}>
                {t('sidebar.cancel')}
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={() => {
                  const target = removeTarget
                  setRemoveTarget(null)
                  onRemoveProject(target)
                }}
              >
                {t('sidebar.remove')}
              </button>
            </>
          }
        >
          <p>{t('sidebar.removeProjectBody', { name: removeTarget.name, product: HARNESS_PRODUCT_NAMES[activeHarness] })}</p>
        </Modal>
      ) : null}
      {archiveTarget ? <Modal title={t('sessions.deleteTitle')} onClose={() => setArchiveTarget(null)} footer={<>
        <button type="button" className="button" onClick={() => setArchiveTarget(null)}>{t('sessions.deleteCancel')}</button>
        <button type="button" className="button button--danger" onClick={() => { const target = archiveTarget; setArchiveTarget(null); void onArchiveSession(target) }}>{t('sessions.deleteConfirm')}</button>
      </>}><p>{t('sessions.deleteBody', { name: archiveTarget.title })}</p></Modal> : null}
      {updateErrorOpen && updateState.phase === 'error' ? (
        <Modal
          title={t('sidebar.update.errorDialogTitle')}
          onClose={() => setUpdateErrorOpen(false)}
          footer={
            <>
              <button type="button" className="button" onClick={() => setUpdateErrorOpen(false)}>{t('sidebar.no')}</button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => {
                  setUpdateErrorOpen(false)
                  void onUpdateAction?.()
                }}
              >
                {t('sidebar.update.retryPlainLabel')}
              </button>
            </>
          }
        >
          <p>{updateState.message ?? t('sidebar.update.errorTitle')}</p>
        </Modal>
      ) : null}
      {confirmUpdate ? (
        <Modal
          title={updateConfirm.title}
          onClose={() => setConfirmUpdate(false)}
          footer={
            <>
              <button type="button" className="button" onClick={() => setConfirmUpdate(false)}>
                {t('sidebar.no')}
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => {
                  setConfirmUpdate(false)
                  void onUpdateAction?.()
                }}
              >
                {t('sidebar.yes')}
              </button>
            </>
          }
        >
          <p>{updateConfirm.body}</p>
        </Modal>
      ) : null}
    </aside>
  )
}

export function areSidebarPropsEqual(previous: SidebarProps, next: SidebarProps): boolean {
  return (
    previous.projects === next.projects &&
    previous.sessions === next.sessions &&
    previous.activeProjectId === next.activeProjectId &&
    previous.activeSessionId === next.activeSessionId &&
    previous.activeView === next.activeView &&
    previous.activeHarness === next.activeHarness &&
    previous.clearedAttention === next.clearedAttention &&
    previous.updateState === next.updateState &&
    previous.harnessUpdateState === next.harnessUpdateState &&
    previous.onHarnessUpdateAction === next.onHarnessUpdateAction &&
    previous.onUpdateAction === next.onUpdateAction &&
    previous.onSelectProject === next.onSelectProject &&
    previous.onSelectSession === next.onSelectSession &&
    previous.onNavigate === next.onNavigate &&
    previous.onNewSession === next.onNewSession &&
    previous.onSelectDraftSession === next.onSelectDraftSession &&
    previous.onDiscardDraftSession === next.onDiscardDraftSession &&
    previous.onAddProject === next.onAddProject &&
    previous.onRemoveProject === next.onRemoveProject &&
    previous.projectSortMode === next.projectSortMode &&
    previous.onSetProjectSortMode === next.onSetProjectSortMode &&
    previous.onTogglePinProject === next.onTogglePinProject &&
    previous.onClose === next.onClose &&
    previous.onOpenPalette === next.onOpenPalette &&
    previous.onRenameSession === next.onRenameSession &&
    previous.onArchiveSession === next.onArchiveSession &&
    previous.overlay === next.overlay &&
    previous.platform === next.platform
  )
}

export const Sidebar = memo(SidebarView, areSidebarPropsEqual)
