import { GitBranch, PanelLeft, PanelRight, Terminal } from 'lucide-react'
import type { MouseEvent } from 'react'
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

interface TitleToolbarProps {
  project?: ProjectRecord
  gitBranch?: string
  /** Active session name; the session view's title takes it over the project name. */
  sessionTitle?: string
  view: WorkspaceView
  /** Active harness product name; the session view's fallback title. */
  productName?: string
  sidebarOpen: boolean
  inspectorOpen: boolean
  terminalOpen: boolean
  onToggleSidebar(): void
  onToggleInspector(): void
  onToggleTerminal(): void
  onOpenBrowser(): void
  activeProjectScriptKind?: ProjectScriptKind
  onRunProjectScript?(kind: ProjectScriptKind): Promise<void> | void
  onStopProjectScript?(): void
  onSaveProjectScripts?(scripts: { setup: string; run: string }): Promise<void>
  platform?: NodeJS.Platform
}

export function TitleToolbar({
  project,
  gitBranch,
  sessionTitle,
  view,
  productName = 'OMP Desktop',
  sidebarOpen,
  inspectorOpen,
  terminalOpen,
  onToggleSidebar,
  onToggleInspector,
  onToggleTerminal,
  onOpenBrowser,
  platform = 'darwin',
}: TitleToolbarProps) {
  const { t } = useI18n()
  const sidebarShortcut = shortcutLabel(platform, ['Primary', 'B'])
  const terminalShortcut = shortcutLabel(platform, ['Primary', 'J'])
  const browserShortcut = shortcutLabel(platform, ['Primary', 'Shift', 'B'])
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
        {view === 'session' ? (
          <IconButton className={terminalOpen ? 'is-active' : ''} label={t('toolbar.toggleTerminal', { shortcut: terminalShortcut })} onClick={onToggleTerminal}>
            <Terminal size={17} />
          </IconButton>
        ) : null}
        {view === 'session' ? (
          <IconButton label={t('toolbar.openBrowser', { shortcut: browserShortcut })} onClick={onOpenBrowser}>
            <BrowserGlobe size={18} />
          </IconButton>
        ) : null}
        {view === 'session' ? (
          <IconButton className={inspectorOpen ? 'is-active' : ''} label={t('toolbar.toggleInspector')} onClick={onToggleInspector}>
            <PanelRight size={16} />
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
