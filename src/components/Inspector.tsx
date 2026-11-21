import { AlertCircle, Ban, Check, CheckCircle2, FileText, FolderOpen, GitCompare, Globe, ListTodo, LoaderCircle, MessageSquareMore, MoreVertical, Plus, Search, Terminal, Users, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { TranscriptStore } from '@/app/transcript-store'
import type { StampedPointerEvent } from '@/hooks/useAgentBrowserTabs'
import type { BrowserAnnotationsApi } from '@/hooks/useBrowserAnnotations'
import type { CommandResult } from '@/hooks/useCommandOutput'
import { useI18n } from '@/lib/i18n'
import { deriveOmpBackgroundTasks, type ActiveProjectScriptSummary, type OmpBackgroundTask } from '@/lib/omp-background-tasks'
import type { AgentBrowserTabRecord, GitStatus, InspectorTab, ProjectRecord, TranscriptMessage } from '@/types/api'
import type { AgentSlotRect } from './AgentBrowserLayer'
import type { SideChatPanelProps } from './SideChatPanel'
import { SideChatPanel } from './SideChatPanel'
import type { SubagentsTabPanelProps } from './inspector/SubagentsTabPanel'
import { BackgroundTasksPanel } from './inspector/BackgroundTasksPanel'
import { BrowserPanel } from './inspector/BrowserPanel'
import { ChangesPanel } from './inspector/ChangesPanel'
import { FilesPanel } from './inspector/FilesPanel'
import { SubagentsTabPanel } from './inspector/SubagentsTabPanel'
import { IconButton, useFocusTrap } from './ui'

export interface InspectorProps {
  platform?: NodeJS.Platform
  openTabs?: InspectorTab[]
  activeTab: InspectorTab
  tabActivationRevision?: number
  onTabChange(tab: InspectorTab): void
  onCloseTab?(tab: InspectorTab): void
  onCloseOtherTabs?(tab: InspectorTab): void
  onReorderTabs?(sourceTab: InspectorTab, targetTab: InspectorTab): void
  onClose(): void
  project?: ProjectRecord
  cwd?: string
  git: GitStatus
  transcript?: TranscriptStore
  isStreaming?: boolean
  hasRuntime?: boolean
  commandOutputHistory?: readonly CommandResult[]
  activeProjectScript?: ActiveProjectScriptSummary
  backgroundTasks?: OmpBackgroundTask[]
  onCancelBackgroundTask?(task: OmpBackgroundTask): void
  onRefreshBackgroundTasks?(): void
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
  /** Side-question conversation mounted when the Side questions tab is open. */
  sideChat?: SideChatPanelProps
  /** Session roster and selected agent transcript for the Agents tab. */
  subagents?: SubagentsTabPanelProps
  overlay?: boolean
}

const NOOP_SUBSCRIBE = () => () => undefined
const EMPTY_MESSAGES: TranscriptMessage[] = []
const EMPTY_HISTORY: readonly CommandResult[] = []

const TAB_IDS: InspectorTab[] = ['changes', 'files', 'browser', 'sidechat', 'agents', 'tasks']
const TAB_ICONS = {
  changes: GitCompare,
  files: FolderOpen,
  browser: Globe,
  sidechat: MessageSquareMore,
  agents: Users,
  tasks: ListTodo,
} as const

interface MenuPoint {
  x: number
  y: number
}

function TaskStatusIcon({ task }: { task: OmpBackgroundTask }) {
  if (task.kind === 'bash' || task.kind === 'script') return <Terminal size={14} />
  if (task.status === 'running') return <LoaderCircle size={14} className="spin" />
  if (task.status === 'failed') return <AlertCircle size={14} />
  if (task.status === 'cancelled') return <Ban size={14} />
  return <CheckCircle2 size={14} />
}

function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  if (/^https?:\/\//i.test(trimmed)) return true
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed)) return true
  return /^[^\s/]+\.[^\s]{2,}/.test(trimmed)
}

/** Memoized so App renders only reopen the inspector when its own props change.
 * Open tabs stay mounted while hidden, so switching tabs preserves panel state. */
export const Inspector = memo(function Inspector({
  openTabs: controlledOpenTabs,
  activeTab,
  tabActivationRevision,
  onTabChange,
  onCloseTab,
  onCloseOtherTabs,
  onReorderTabs,
  onClose,
  project,
  cwd,
  git,
  transcript,
  isStreaming = false,
  hasRuntime = false,
  commandOutputHistory = EMPTY_HISTORY,
  activeProjectScript,
  backgroundTasks,
  onCancelBackgroundTask,
  onRefreshBackgroundTasks,
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
  sideChat,
  subagents,
  overlay = false,
  platform = 'darwin',
}: InspectorProps) {
  const { t } = useI18n()
  const isControlled = controlledOpenTabs !== undefined
  const resolvedActiveTab: InspectorTab = TAB_IDS.includes(activeTab) ? activeTab : 'changes'
  const [internalOpenTabs, setInternalOpenTabs] = useState<InspectorTab[]>(() => [resolvedActiveTab])
  const openTabs = isControlled ? controlledOpenTabs : internalOpenTabs
  const [newTabOpen, setNewTabOpen] = useState(false)
  const [panelMenu, setPanelMenu] = useState<MenuPoint | null>(null)
  const [tabMenu, setTabMenu] = useState<{ tab: InspectorTab; x: number; y: number } | null>(null)
  const [query, setQuery] = useState('')
  const [draggedTab, setDraggedTab] = useState<InspectorTab | null>(null)
  const draggedTabRef = useRef<InspectorTab | null>(null)
  const [dropTargetTab, setDropTargetTab] = useState<InspectorTab | null>(null)
  const [browserNavRequest, setBrowserNavRequest] = useState<{ id: number; url: string } | null>(null)
  const browserNavSeqRef = useRef(0)
  const panelMenuRef = useRef<HTMLDivElement>(null)
  const tabMenuRef = useRef<HTMLDivElement>(null)
  const lastActiveRef = useRef(resolvedActiveTab)
  const lastActivationRevisionRef = useRef(tabActivationRevision)
  const inspectorRef = useFocusTrap<HTMLElement>(overlay, onClose)

  // Tabs opened by other surfaces (openChanges, browser activity, /btw, …)
  // join the strip and dismiss the new-tab page.
  useEffect(() => {
    const activeChanged = resolvedActiveTab !== lastActiveRef.current
    const revisionChanged = tabActivationRevision !== lastActivationRevisionRef.current
    if (!activeChanged && !revisionChanged) return
    lastActiveRef.current = resolvedActiveTab
    lastActivationRevisionRef.current = tabActivationRevision
    if (!isControlled) {
      setInternalOpenTabs((tabs) => (tabs.includes(resolvedActiveTab) ? tabs : [...tabs, resolvedActiveTab]))
    }
    setNewTabOpen(false)
  }, [isControlled, resolvedActiveTab, tabActivationRevision])

  useEffect(() => {
    if (!panelMenu && !tabMenu) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelMenuRef.current?.contains(target) || tabMenuRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('.inspector__tab-actions, .inspector-new-tab__search-row')) return
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
  const showNewTab = newTabOpen || openTabs.length === 0 || !openTabs.includes(resolvedActiveTab)
  const observeTasks = !backgroundTasks && Boolean(transcript) && (showNewTab || resolvedActiveTab === 'tasks' || openTabs.includes('tasks'))
  const subscribeMessages = useCallback(
    (listener: () => void) => (observeTasks && transcript ? transcript.subscribe(listener) : NOOP_SUBSCRIBE()),
    [observeTasks, transcript],
  )
  const getMessages = useCallback(
    () => (observeTasks && transcript ? transcript.getSnapshot() : EMPTY_MESSAGES),
    [observeTasks, transcript],
  )
  const observedMessages = useSyncExternalStore(subscribeMessages, getMessages)
  const taskItems = useMemo(
    () =>
      backgroundTasks ??
      deriveOmpBackgroundTasks({
        messages: observedMessages,
        isStreaming,
        commandOutputHistory,
        activeProjectScript,
      }),
    [activeProjectScript, backgroundTasks, commandOutputHistory, isStreaming, observedMessages],
  )
  const changeTotals = git.files.reduce(
    (totals, file) => ({ additions: totals.additions + (file.additions ?? 0), deletions: totals.deletions + (file.deletions ?? 0) }),
    { additions: 0, deletions: 0 },
  )
  const agentItems = subagents?.state.agents ?? []
  const runningTaskItems = useMemo(() => taskItems.filter((task) => task.status === 'running'), [taskItems])
  const tabCount = (tab: InspectorTab): number | undefined => {
    if (tab === 'changes' || tab === 'files') return git.files.length || undefined
    if (tab === 'sidechat') return sideChat?.state.topics.length || undefined
    if (tab === 'agents') return agentItems.length || undefined
    if (tab === 'tasks') return runningTaskItems.length || undefined
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
    if (!isControlled) setInternalOpenTabs((tabs) => (tabs.includes(tab) ? tabs : [...tabs, tab]))
    onTabChange(tab)
  }
  const openNewTab = () => {
    setNewTabOpen(true)
    setPanelMenu(null)
    setTabMenu(null)
    setQuery('')
  }
  const closeTab = (tab: InspectorTab) => {
    if (isControlled && onCloseTab) {
      onCloseTab(tab)
      return
    }
    const index = openTabs.indexOf(tab)
    const remaining = openTabs.filter((id) => id !== tab)
    setInternalOpenTabs(remaining)
    if (tab !== resolvedActiveTab) return
    const next = remaining[Math.min(index, remaining.length - 1)]
    if (next) onTabChange(next)
    else setNewTabOpen(true)
  }
  const closeOthers = (tab: InspectorTab) => {
    setNewTabOpen(false)
    if (isControlled && onCloseOtherTabs) {
      onCloseOtherTabs(tab)
      return
    }
    setInternalOpenTabs([tab])
    if (tab !== resolvedActiveTab) onTabChange(tab)
  }
  const reorderTabs = (sourceTab: InspectorTab, targetTab: InspectorTab) => {
    if (sourceTab === targetTab) return
    if (isControlled && onReorderTabs) {
      onReorderTabs(sourceTab, targetTab)
      return
    }
    setInternalOpenTabs((current) => {
      const sourceIndex = current.indexOf(sourceTab)
      const targetIndex = current.indexOf(targetTab)
      if (sourceIndex === -1 || targetIndex === -1) return current
      const next = [...current]
      const [moved] = next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, moved)
      return next
    })
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
          navigationRequest={browserNavRequest}
          onNavigationRequestHandled={(id) => {
            setBrowserNavRequest((current) => (current?.id === id ? null : current))
          }}
        />
      )
    }
    if (tab === 'files') return <FilesPanel project={project} git={git} onReveal={onRevealPath} />
    if (tab === 'sidechat') return sideChat ? <SideChatPanel {...sideChat} /> : null
    if (tab === 'agents') return subagents ? <SubagentsTabPanel {...subagents} /> : null
    return <BackgroundTasksPanel tasks={taskItems} hasRuntime={hasRuntime} onCancelTask={onCancelBackgroundTask} onRefreshTasks={onRefreshBackgroundTasks} />
  }

  const normalizedQuery = query.trim().toLowerCase()
  const availableTabs = sideChat ? TAB_IDS : TAB_IDS.filter((tab) => tab !== 'sidechat')
  const filteredTabs = availableTabs.filter((tab) => label(tab).toLowerCase().includes(normalizedQuery))
  const tabMenuLabel = tabMenu ? label(tabMenu.tab) : ''

  return (
    <aside ref={inspectorRef} className="inspector" aria-label={t('inspector.aria')} tabIndex={overlay ? -1 : undefined}>
      <div className="inspector__tabs">
        <div className="inspector__tab-list" role="tablist" aria-label={t('inspector.tabs.aria')}>
          {openTabs.map((tab) => {
            const active = !showNewTab && tab === resolvedActiveTab
            const Icon = TAB_ICONS[tab]
            const count = tabCount(tab)
            return (
              <div
                className={`inspector-tab${active ? ' is-active' : ''}${dropTargetTab === tab ? ' is-drop-target' : ''}`}
                key={tab}
                role="presentation"
                draggable
                onDragStart={(event) => {
                  draggedTabRef.current = tab
                  setDraggedTab(tab)
                  if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', tab)
                  }
                }}
                onDragOver={(event) => {
                  const source = draggedTabRef.current ?? draggedTab
                  if (!source || source === tab) return
                  event.preventDefault()
                  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
                  if (dropTargetTab !== tab) setDropTargetTab(tab)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const dataTab = event.dataTransfer?.getData('text/plain')
                  const source = draggedTabRef.current ?? draggedTab ?? (TAB_IDS.includes(dataTab as InspectorTab) ? (dataTab as InspectorTab) : null)
                  if (source && source !== tab) reorderTabs(source, tab)
                  draggedTabRef.current = null
                  setDraggedTab(null)
                  setDropTargetTab(null)
                }}
                onDragEnd={() => {
                  draggedTabRef.current = null
                  setDraggedTab(null)
                  setDropTargetTab(null)
                }}
              >
                <button
                  id={`inspector-tab-${tab}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`inspector-panel-${tab}`}
                  tabIndex={active ? 0 : -1}
                  className="inspector-tab__button"
                  onClick={() => activate(tab)}
                  onMouseDown={(event) => {
                    if (event.button !== 1) return
                    event.preventDefault()
                    closeTab(tab)
                  }}
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
          <IconButton size="small" label={t('inspector.tabs.menu')} aria-haspopup="menu" aria-expanded={Boolean(panelMenu)} onClick={(event) => showPanelMenu(event.currentTarget)}>
            <MoreVertical size={15} />
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
            hidden={showNewTab || tab !== resolvedActiveTab}
          >
            {renderPanel(tab)}
          </div>
        ))}
        {showNewTab ? (
          <div className="inspector-new-tab">
            <div className="inspector-new-tab__search-row">
              <div className="inspector-new-tab__search">
                <Search size={15} />
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    if (looksLikeUrl(query)) {
                      browserNavSeqRef.current += 1
                      setBrowserNavRequest({ id: browserNavSeqRef.current, url: query.trim() })
                      activate('browser')
                      return
                    }
                    const first = filteredTabs[0]
                    if (first) activate(first)
                  }}
                  placeholder={t('inspector.newTab.search')}
                  aria-label={t('inspector.newTab.search')}
                />
              </div>
              <IconButton
                size="small"
                label={t('inspector.tabs.menu')}
                aria-haspopup="menu"
                aria-expanded={Boolean(panelMenu)}
                onClick={(event) => showPanelMenu(event.currentTarget)}
              >
                <MoreVertical size={15} />
              </IconButton>
            </div>
            <div className="inspector-new-tab__list">
              {filteredTabs.map((tab) => {
                const Icon = TAB_ICONS[tab]
                const detail = tabDetail(tab)
                return (
                  <button type="button" className="inspector-new-tab__item" key={tab} onClick={() => activate(tab)}>
                    <Icon size={15} />
                    <span>{label(tab)}</span>
                    {tab === 'changes' && (changeTotals.additions || changeTotals.deletions) ? (
                      <span className="inspector-new-tab__detail inspector-new-tab__diff">
                        <span className="is-add">+{changeTotals.additions}</span>
                        <span className="is-del">-{changeTotals.deletions}</span>
                      </span>
                    ) : detail ? (
                      <span className="inspector-new-tab__detail">{detail}</span>
                    ) : null}
                  </button>
                )
              })}
              {!filteredTabs.length ? <p className="inspector-new-tab__empty">{t('inspector.newTab.empty')}</p> : null}
            </div>

            {!normalizedQuery && ((subagents && agentItems.length > 0) || runningTaskItems.length > 0) ? (
              <div className="inspector-new-tab__sections">
                {subagents && agentItems.length > 0 ? (
                  <section className="inspector-new-tab__section">
                    <div className="inspector-new-tab__section-header">
                      <span>{label('agents')}</span>
                      <span className="inspector-new-tab__badge">{agentItems.length}</span>
                    </div>
                    {agentItems.slice(0, 3).map((agent) => (
                      <button
                        type="button"
                        key={agent.id}
                        className="inspector-new-tab__item inspector-new-tab__subitem"
                        onClick={() => {
                          subagents.state.select(agent.id)
                          activate('agents')
                        }}
                      >
                        <Users size={14} />
                        <span>{agent.agent}</span>
                        <span className="inspector-new-tab__detail">{agent.status}</span>
                      </button>
                    ))}
                    <button type="button" className="inspector-new-tab__see-all" onClick={() => activate('agents')}>
                      {t('inspector.newTab.seeAll')}
                    </button>
                  </section>
                ) : null}
                {runningTaskItems.length > 0 ? (
                  <section className="inspector-new-tab__section">
                    <div className="inspector-new-tab__section-header">
                      <span>{label('tasks')}</span>
                      <span className="inspector-new-tab__badge">{runningTaskItems.length}</span>
                    </div>
                    {runningTaskItems.slice(0, 3).map((task) => (
                      <button
                        type="button"
                        key={task.id}
                        className="inspector-new-tab__item inspector-new-tab__subitem"
                        onClick={() => activate('tasks')}
                      >
                        <TaskStatusIcon task={task} />
                        <span>{task.title}</span>
                        <span className="inspector-new-tab__detail">{t(`inspector.tasks.status.${task.status}`)}</span>
                      </button>
                    ))}
                    <button type="button" className="inspector-new-tab__see-all" onClick={() => activate('tasks')}>
                      {t('inspector.newTab.seeAll')}
                    </button>
                  </section>
                ) : null}
              </div>
            ) : null}
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
              disabled={showNewTab || !openTabs.includes(resolvedActiveTab)}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                showTabMenu(resolvedActiveTab, rect.right - 190, rect.bottom + 4)
              }}
            >
              <MoreVertical size={13} />
            </IconButton>
          </div>
          {availableTabs.map((tab) => {
            const Icon = TAB_ICONS[tab]
            const detail = tabDetail(tab)
            const selected = !showNewTab && tab === resolvedActiveTab
            return (
              <button type="button" role="menuitem" key={tab} className={selected ? 'is-active' : ''} onClick={() => activate(tab)}>
                <Icon size={14} />
                <span>{label(tab)}</span>
                {tab === 'changes' && (changeTotals.additions || changeTotals.deletions) ? (
                  <span className="inspector-tab-menu__detail inspector-new-tab__diff">
                    <span className="is-add">+{changeTotals.additions}</span>
                    <span className="is-del">-{changeTotals.deletions}</span>
                  </span>
                ) : detail ? (
                  <span className="inspector-tab-menu__detail">{detail}</span>
                ) : null}
                {selected ? <Check size={13} /> : null}
              </button>
            )
          })}
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
        </div>
      ) : null}
    </aside>
  )
})
