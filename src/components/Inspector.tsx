import { Check, ChevronRight, FileText, FolderOpen, GitCompare, Globe, ListTodo, MoreHorizontal, PackageOpen, Plus, Search, Users, X } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import type { StampedPointerEvent } from '@/hooks/useAgentBrowserTabs'
import type { BrowserAnnotationsApi } from '@/hooks/useBrowserAnnotations'
import { useI18n } from '@/lib/i18n'
import type { AgentBrowserTabRecord, AutomationScheduleRecord, GitStatus, InspectorTab, ProjectRecord } from '@/types/api'
import type { AgentSlotRect } from './AgentBrowserLayer'
import type { SubagentsTabPanelProps } from './inspector/SubagentsTabPanel'
import { BackgroundTasksPanel } from './inspector/BackgroundTasksPanel'
import { BrowserPanel } from './inspector/BrowserPanel'
import { ChangesPanel } from './inspector/ChangesPanel'
import { FilesPanel } from './inspector/FilesPanel'
import { SubagentsTabPanel } from './inspector/SubagentsTabPanel'
import { IconButton, useFocusTrap } from './ui'

export interface InspectorProps {
  platform?: NodeJS.Platform
  activeTab: InspectorTab
  onTabChange(tab: InspectorTab): void
  onClose(): void
  project?: ProjectRecord
  cwd?: string
  git: GitStatus
  automations: AutomationScheduleRecord[]
  /** Every automation for the harness; the Background Tasks tab lists these unsliced. */
  backgroundTasks?: AutomationScheduleRecord[]
  onOpenAutomation(id: string): void
  onOpenSchedules(): void
  browserHome: string
  browserAnnotations: BrowserAnnotationsApi
  agentBrowserTabs: AgentBrowserTabRecord[]
  activeAgentTabId: string | null
  agentPreviewSelected: boolean
  onSelectAgentTab(tabId: string): void
  onCloseAgentTab(tabId: string): void
  onShowBrowserPreview(): void
  onAgentSlotRect(rect: AgentSlotRect | null): void
  agentSessionKey?: string
  onPreviewContext(webContentsId: number | null, sessionFile: string | null): void
  previewPointerEvent: StampedPointerEvent | null
  onNavigateAgentTab(tabId: string, action: 'back' | 'forward' | 'reload'): void
  onRefreshGit(): Promise<void> | void
  onOpenExternal(url: string): void
  onRevealPath(path: string): void
  onGrantProject(): Promise<void> | void
  /** Session roster and selected agent transcript for the Agents tab. */
  subagents?: SubagentsTabPanelProps
  /** Opens the app's Capabilities page from the tab menus. */
  onOpenPlugins?(): void
  overlay?: boolean
}

const TAB_IDS: InspectorTab[] = ['changes', 'files', 'browser', 'agents', 'tasks']
const TAB_ICONS = {
  changes: GitCompare,
  files: FolderOpen,
  browser: Globe,
  agents: Users,
  tasks: ListTodo,
} as const

interface MenuPoint {
  x: number
  y: number
}

/** Memoized so App renders only reopen the inspector when its own props change.
 * Open tabs stay mounted while hidden, so switching tabs preserves panel state. */
export const Inspector = memo(function Inspector({
  activeTab,
  onTabChange,
  onClose,
  project,
  cwd,
  git,
  automations,
  backgroundTasks,
  onOpenAutomation,
  onOpenSchedules,
  browserHome,
  browserAnnotations,
  agentBrowserTabs,
  activeAgentTabId,
  agentPreviewSelected,
  onSelectAgentTab,
  onCloseAgentTab,
  onShowBrowserPreview,
  onAgentSlotRect,
  agentSessionKey,
  onPreviewContext,
  previewPointerEvent,
  onNavigateAgentTab,
  onRefreshGit,
  onOpenExternal,
  onRevealPath,
  onGrantProject,
  subagents,
  onOpenPlugins,
  overlay = false,
  platform = 'darwin',
}: InspectorProps) {
  const { t } = useI18n()
  const resolvedActiveTab: InspectorTab = TAB_IDS.includes(activeTab) ? activeTab : 'changes'
  const [openTabs, setOpenTabs] = useState<InspectorTab[]>(() => [resolvedActiveTab])
  const [newTabOpen, setNewTabOpen] = useState(false)
  const [panelMenu, setPanelMenu] = useState<MenuPoint | null>(null)
  const [tabMenu, setTabMenu] = useState<{ tab: InspectorTab; x: number; y: number } | null>(null)
  const [query, setQuery] = useState('')
  const panelMenuRef = useRef<HTMLDivElement>(null)
  const tabMenuRef = useRef<HTMLDivElement>(null)
  const lastActiveRef = useRef(resolvedActiveTab)
  const inspectorRef = useFocusTrap<HTMLElement>(overlay, onClose)

  // Tabs opened by other surfaces (openChanges, browser activity, …) join the
  // strip and replace the new-tab page. The ref keeps a tab the user just
  // closed from being re-added.
  useEffect(() => {
    if (resolvedActiveTab === lastActiveRef.current) return
    lastActiveRef.current = resolvedActiveTab
    setOpenTabs((tabs) => (tabs.includes(resolvedActiveTab) ? tabs : [...tabs, resolvedActiveTab]))
    setNewTabOpen(false)
  }, [resolvedActiveTab])

  useEffect(() => {
    if (!panelMenu && !tabMenu) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelMenuRef.current?.contains(target) || tabMenuRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('.inspector__tab-actions')) return
      setPanelMenu(null)
      setTabMenu(null)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setPanelMenu(null)
      setTabMenu(null)
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', dismissOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', dismissOnEscape, true)
    }
  }, [panelMenu, tabMenu])

  const label = (tab: InspectorTab) => t(`inspector.tab.${tab}`)
  const changeTotals = git.files.reduce(
    (totals, file) => ({ additions: totals.additions + (file.additions ?? 0), deletions: totals.deletions + (file.deletions ?? 0) }),
    { additions: 0, deletions: 0 },
  )
  const tabCount = (tab: InspectorTab): number | undefined => {
    if (tab === 'changes' || tab === 'files') return git.files.length || undefined
    if (tab === 'agents') return subagents?.state.agents.length || undefined
    if (tab === 'tasks') return (backgroundTasks ?? automations).length || undefined
    return undefined
  }
  const tabDetail = (tab: InspectorTab): string | undefined => {
    if (tab === 'changes' && (changeTotals.additions || changeTotals.deletions)) return `+${changeTotals.additions} -${changeTotals.deletions}`
    const count = tabCount(tab)
    return count ? String(count) : undefined
  }

  const activate = (tab: InspectorTab) => {
    setNewTabOpen(false)
    setPanelMenu(null)
    setTabMenu(null)
    setQuery('')
    setOpenTabs((tabs) => (tabs.includes(tab) ? tabs : [...tabs, tab]))
    onTabChange(tab)
  }
  const openNewTab = () => {
    setNewTabOpen(true)
    setPanelMenu(null)
    setTabMenu(null)
    setQuery('')
  }
  const closeTab = (tab: InspectorTab) => {
    const index = openTabs.indexOf(tab)
    const remaining = openTabs.filter((id) => id !== tab)
    setOpenTabs(remaining)
    if (tab !== resolvedActiveTab) return
    const next = remaining[Math.min(index, remaining.length - 1)]
    if (next) onTabChange(next)
    else if (!newTabOpen) onClose()
  }
  const closeOthers = (tab: InspectorTab) => {
    setOpenTabs([tab])
    setNewTabOpen(false)
    if (tab !== resolvedActiveTab) onTabChange(tab)
  }
  const openPlugins = () => {
    setPanelMenu(null)
    setTabMenu(null)
    onOpenPlugins?.()
  }
  const copyTitle = (tab: InspectorTab) => {
    void navigator.clipboard?.writeText(label(tab))
  }
  const showTabMenu = (tab: InspectorTab, x: number, y: number) => {
    setPanelMenu(null)
    setTabMenu({ tab, x: Math.max(8, Math.min(x, window.innerWidth - 200)), y: Math.max(8, Math.min(y, window.innerHeight - 180)) })
  }
  const showPanelMenu = (button: HTMLElement) => {
    const rect = button.getBoundingClientRect()
    setTabMenu(null)
    setPanelMenu((current) => (current ? null : { x: Math.max(8, Math.min(rect.right - 240, window.innerWidth - 248)), y: rect.bottom + 4 }))
  }

  const moveTab = (current: number, key: string) => {
    if (openTabs.length === 0) return
    let next = current
    if (key === 'ArrowRight') next = (current + 1) % openTabs.length
    else if (key === 'ArrowLeft') next = (current - 1 + openTabs.length) % openTabs.length
    else if (key === 'Home') next = 0
    else if (key === 'End') next = openTabs.length - 1
    else return
    const tab = openTabs[next]
    if (!tab) return
    activate(tab)
    requestAnimationFrame(() => document.getElementById(`inspector-tab-${tab}`)?.focus())
  }

  const renderPanel = (tab: InspectorTab) => {
    if (tab === 'changes') {
      return <ChangesPanel key={cwd ?? 'no-workspace'} cwd={cwd} git={git} readOnly={project?.readOnly === true} onGrantProject={onGrantProject} onRefreshGit={onRefreshGit} />
    }
    if (tab === 'browser') {
      return (
        <BrowserPanel
          platform={platform}
          home={browserHome}
          onOpenExternal={onOpenExternal}
          annotations={browserAnnotations}
          agentTabs={agentBrowserTabs}
          activeAgentTabId={activeAgentTabId}
          previewSelected={agentPreviewSelected}
          onSelectAgentTab={onSelectAgentTab}
          onCloseAgentTab={onCloseAgentTab}
          onShowPreview={onShowBrowserPreview}
          onAgentSlotRect={onAgentSlotRect}
          agentSessionKey={agentSessionKey}
          onPreviewContext={onPreviewContext}
          previewPointerEvent={previewPointerEvent}
          onNavigateAgentTab={onNavigateAgentTab}
        />
      )
    }
    if (tab === 'files') return <FilesPanel project={project} git={git} onReveal={onRevealPath} />
    if (tab === 'agents') return subagents ? <SubagentsTabPanel {...subagents} /> : null
    return <BackgroundTasksPanel automations={backgroundTasks ?? automations} onOpenAutomation={onOpenAutomation} onOpenSchedules={onOpenSchedules} />
  }

  const normalizedQuery = query.trim().toLowerCase()
  const filteredTabs = TAB_IDS.filter((tab) => label(tab).toLowerCase().includes(normalizedQuery))
  const pluginsLabel = t('nav.capabilities')
  const pluginsVisible = Boolean(onOpenPlugins) && (!normalizedQuery || pluginsLabel.toLowerCase().includes(normalizedQuery))
  const tabMenuLabel = tabMenu ? label(tabMenu.tab) : ''

  return (
    <aside ref={inspectorRef} className="inspector" aria-label={t('inspector.aria')} tabIndex={overlay ? -1 : undefined}>
      <div className="inspector__tabs">
        <div className="inspector__tab-list" role="tablist" aria-label={t('inspector.tabs.aria')}>
          {openTabs.map((tab) => {
            const active = !newTabOpen && tab === resolvedActiveTab
            const Icon = TAB_ICONS[tab]
            const count = tabCount(tab)
            return (
              <div className={`inspector-tab${active ? ' is-active' : ''}`} key={tab} role="presentation">
                <button
                  id={`inspector-tab-${tab}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`inspector-panel-${tab}`}
                  tabIndex={active ? 0 : -1}
                  className="inspector-tab__button"
                  onClick={() => activate(tab)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    showTabMenu(tab, event.clientX, event.clientY)
                  }}
                  onKeyDown={(event) => {
                    if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault()
                      moveTab(openTabs.indexOf(tab), event.key)
                    }
                  }}
                >
                  <Icon size={13} />
                  <span>{label(tab)}</span>
                  {count ? <span className="inspector-tab__count">{count}</span> : null}
                </button>
                <button
                  type="button"
                  className="inspector-tab__close"
                  tabIndex={-1}
                  aria-label={t('inspector.tabs.close', { name: label(tab) })}
                  onClick={() => closeTab(tab)}
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
        </div>
        <div className="inspector__tab-actions">
          <IconButton size="small" label={t('inspector.tabs.new')} onClick={openNewTab}>
            <Plus size={15} />
          </IconButton>
          <IconButton
            size="small"
            label={t('inspector.tabs.actions')}
            disabled={newTabOpen || !openTabs.includes(resolvedActiveTab)}
            onClick={(event) => {
              if (tabMenu) {
                setTabMenu(null)
                return
              }
              const rect = event.currentTarget.getBoundingClientRect()
              showTabMenu(resolvedActiveTab, rect.right - 190, rect.bottom + 4)
            }}
          >
            <MoreHorizontal size={15} />
          </IconButton>
          <IconButton size="small" label={t('inspector.tabs.menu')} aria-haspopup="menu" aria-expanded={Boolean(panelMenu)} onClick={(event) => showPanelMenu(event.currentTarget)}>
            <FileText size={15} />
          </IconButton>
        </div>
      </div>

      <div className="inspector__body">
        {openTabs.map((tab) => (
          <div
            key={tab}
            id={`inspector-panel-${tab}`}
            className="inspector__panel"
            role="tabpanel"
            aria-labelledby={`inspector-tab-${tab}`}
            tabIndex={0}
            hidden={newTabOpen || tab !== resolvedActiveTab}
          >
            {renderPanel(tab)}
          </div>
        ))}
        {newTabOpen ? (
          <div className="inspector-new-tab">
            <div className="inspector-new-tab__search">
              <Search size={15} />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  const first = filteredTabs[0]
                  if (first) activate(first)
                  else if (pluginsVisible) openPlugins()
                }}
                placeholder={t('inspector.newTab.search')}
                aria-label={t('inspector.newTab.search')}
              />
            </div>
            <div className="inspector-new-tab__list">
              {filteredTabs.map((tab) => {
                const Icon = TAB_ICONS[tab]
                const detail = tabDetail(tab)
                return (
                  <button type="button" className="inspector-new-tab__item" key={tab} onClick={() => activate(tab)}>
                    <Icon size={15} />
                    <span>{label(tab)}</span>
                    {detail ? <span className="inspector-new-tab__detail">{detail}</span> : null}
                  </button>
                )
              })}
              {pluginsVisible ? (
                <button type="button" className="inspector-new-tab__item" onClick={openPlugins}>
                  <PackageOpen size={15} />
                  <span>{pluginsLabel}</span>
                  <ChevronRight size={13} className="inspector-new-tab__chevron" />
                </button>
              ) : null}
              {!filteredTabs.length && !pluginsVisible ? <p className="inspector-new-tab__empty">{t('inspector.newTab.empty')}</p> : null}
            </div>
          </div>
        ) : null}
      </div>

      {panelMenu ? (
        <div
          ref={panelMenuRef}
          className="inspector-tab-menu"
          role="menu"
          aria-label={t('inspector.tabs.menu')}
          style={{ left: panelMenu.x, top: panelMenu.y }}
        >
          <div className="inspector-tab-menu__header">
            <span>{t('inspector.menu.title')}</span>
            <IconButton
              size="small"
              label={t('inspector.tabs.actions')}
              disabled={newTabOpen || !openTabs.includes(resolvedActiveTab)}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                showTabMenu(resolvedActiveTab, rect.right - 190, rect.bottom + 4)
              }}
            >
              <MoreHorizontal size={13} />
            </IconButton>
          </div>
          {TAB_IDS.map((tab) => {
            const Icon = TAB_ICONS[tab]
            const detail = tabDetail(tab)
            const selected = !newTabOpen && tab === resolvedActiveTab
            return (
              <button type="button" role="menuitem" key={tab} className={selected ? 'is-active' : ''} onClick={() => activate(tab)}>
                <Icon size={14} />
                <span>{label(tab)}</span>
                {detail ? <span className="inspector-tab-menu__detail">{detail}</span> : null}
                {selected ? <Check size={13} /> : null}
              </button>
            )
          })}
          {onOpenPlugins ? (
            <>
              <div className="inspector-tab-menu__separator" />
              <button type="button" role="menuitem" onClick={openPlugins}>
                <PackageOpen size={14} />
                <span>{pluginsLabel}</span>
                <ChevronRight size={13} />
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {tabMenu ? (
        <div ref={tabMenuRef} className="inspector-tab-context" role="menu" style={{ left: tabMenu.x, top: tabMenu.y }}>
          <button type="button" role="menuitem" onClick={() => { closeTab(tabMenu.tab); setTabMenu(null) }}>
            <X size={13} />
            <span>{t('inspector.tabs.close', { name: tabMenuLabel })}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { closeOthers(tabMenu.tab); setTabMenu(null) }}>
            <X size={13} />
            <span>{t('inspector.tabs.closeOthers')}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { copyTitle(tabMenu.tab); setTabMenu(null) }}>
            <FileText size={13} />
            <span>{t('inspector.tabs.copyTitle')}</span>
          </button>
          {onOpenPlugins ? (
            <button type="button" role="menuitem" onClick={openPlugins}>
              <PackageOpen size={13} />
              <span>{pluginsLabel}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  )
})
