import {
  AlertCircle,
  Ban,
  Check,
  CheckCircle2,
  Code2,
  FileJson2,
  FileText,
  FolderOpen,
  GitCompare,
  Globe,
  Image as ImageIcon,
  ListTodo,
  LoaderCircle,
  MessageSquareMore,
  MoreVertical,
  Plus,
  Search,
  Terminal,
  Users,
  X,
} from 'lucide-react'
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { TranscriptStore } from '@/app/transcript-store'
import type { StampedPointerEvent } from '@/hooks/useAgentBrowserTabs'
import type { BrowserAnnotationsApi } from '@/hooks/useBrowserAnnotations'
import type { CommandResult } from '@/hooks/useCommandOutput'
import { basename } from '@/lib/data'
import { useI18n } from '@/lib/i18n'
import { deriveOmpBackgroundTasks, type ActiveProjectScriptSummary, type OmpBackgroundTask } from '@/lib/omp-background-tasks'
import { subagentExecution } from '@/lib/subagent-activity'
import type { AgentBrowserTabRecord, GitStatus, InspectorTab, ProjectRecord, TranscriptMessage } from '@/types/api'
import type { AgentSlotRect } from './AgentBrowserLayer'
import { EXECUTION_LABELS } from './ExecutionStatus'
import type { SideChatPanelProps } from './SideChatPanel'
import { SideChatPanel } from './SideChatPanel'
import type { SubagentsTabPanelProps } from './inspector/SubagentsTabPanel'
import { BackgroundTasksPanel } from './inspector/BackgroundTasksPanel'
import { BrowserPanel } from './inspector/BrowserPanel'
import { ChangesPanel } from './inspector/ChangesPanel'
import { FilesPanel } from './inspector/FilesPanel'
import { SubagentsTabPanel } from './inspector/SubagentsTabPanel'
import { IconButton, useFocusTrap } from './ui'

const FilePreviewPanel = lazy(() => import('./inspector/FilePreviewPanel').then((module) => ({ default: module.FilePreviewPanel })))

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
  previewFiles?: string[]
  activePreviewFile?: string | null
  previewActivationRevision?: number
  onSelectPreviewFile?(path: string | null): void
  onClosePreviewFile?(path: string): void
  onOpenPreviewFile?(path: string): void
  /** Side-question conversation mounted when the Side questions tab is open. */
  sideChat?: SideChatPanelProps
  /** Session roster and selected agent transcript for the Agents tab. */
  subagents?: SubagentsTabPanelProps
  overlay?: boolean
}

const NOOP_SUBSCRIBE = () => () => undefined
const NOOP = () => undefined
const EMPTY_MESSAGES: TranscriptMessage[] = []
const EMPTY_HISTORY: readonly CommandResult[] = []
const EMPTY_PREVIEW_FILES: string[] = []
const EMPTY_AGENT_BROWSER_TABS: AgentBrowserTabRecord[] = []
const MAX_EXTRA_BROWSER_TABS = 8

const TAB_IDS: InspectorTab[] = ['changes', 'files', 'browser', 'sidechat', 'agents', 'tasks']
const TAB_ICONS = {
  changes: GitCompare,
  files: FolderOpen,
  browser: Globe,
  sidechat: MessageSquareMore,
  agents: Users,
  tasks: ListTodo,
} as const

interface ExtraBrowserTab {
  id: string
  initialUrl: string
  title?: string
}

type TabMenuState =
  | { kind: 'builtin'; tab: InspectorTab; x: number; y: number }
  | { kind: 'extraBrowser'; id: string; label: string; x: number; y: number }
  | { kind: 'file'; path: string; label: string; x: number; y: number }

interface MenuPoint {
  x: number
  y: number
}

function fileTabIcon(filePath: string) {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return Globe
  if (/\.(png|jpe?g|jfif|gif|webp|svg|bmp|ico|avif|heic|heif|tiff?|jp2|icns|psd|tga|dng)$/.test(lower)) return ImageIcon
  if (lower.endsWith('.json') || lower.endsWith('.jsonc') || lower.endsWith('.jsonl')) return FileJson2
  if (/\.(tsx?|jsx?|mts|cts|css|scss|less|py|rs|go|java|kt|swift|c|cpp|h|cs|rb|php|sh|bash|zsh|sql|ya?ml|toml|vue|svelte|astro)$/.test(lower)) {
    return Code2
  }
  return FileText
}

function urlHostFallback(raw: string): string | undefined {
  try {
    const parsed = new URL(raw)
    if (parsed.hostname) return parsed.hostname
  } catch {
    /* ignore about:blank and non-URLs */
  }
  return undefined
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
  previewFiles = EMPTY_PREVIEW_FILES,
  activePreviewFile = null,
  previewActivationRevision,
  onSelectPreviewFile,
  onClosePreviewFile,
  onOpenPreviewFile,
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
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  const [query, setQuery] = useState('')
  const [draggedTab, setDraggedTab] = useState<InspectorTab | null>(null)
  const draggedTabRef = useRef<InspectorTab | null>(null)
  const [dropTargetTab, setDropTargetTab] = useState<InspectorTab | null>(null)
  const [browserNavRequest, setBrowserNavRequest] = useState<{ id: number; url: string } | null>(null)
  const browserNavSeqRef = useRef(0)
  const [extraBrowserTabs, setExtraBrowserTabs] = useState<ExtraBrowserTab[]>([])
  const [activeExtraBrowserId, setActiveExtraBrowserId] = useState<string | null>(null)
  const extraBrowserSeqRef = useRef(0)
  const panelMenuRef = useRef<HTMLDivElement>(null)
  const tabMenuRef = useRef<HTMLDivElement>(null)
  const lastActiveRef = useRef(resolvedActiveTab)
  const lastActivationRevisionRef = useRef(tabActivationRevision)
  const lastPreviewRevisionRef = useRef(previewActivationRevision)
  const onSelectPreviewFileRef = useRef(onSelectPreviewFile)
  onSelectPreviewFileRef.current = onSelectPreviewFile
  const inspectorRef = useFocusTrap<HTMLElement>(overlay, onClose)

  // Tabs opened by other surfaces (openChanges, browser activity, /btw, …)
  // join the strip and dismiss the new-tab page and file/extra overlays.
  useEffect(() => {
    const activeChanged = resolvedActiveTab !== lastActiveRef.current
    const revisionChanged = tabActivationRevision !== lastActivationRevisionRef.current
    if (!activeChanged && !revisionChanged) return
    lastActiveRef.current = resolvedActiveTab
    lastActivationRevisionRef.current = tabActivationRevision
    if (!isControlled) {
      setInternalOpenTabs((tabs) => (tabs.includes(resolvedActiveTab) ? tabs : [...tabs, resolvedActiveTab]))
    }
    setActiveExtraBrowserId(null)
    setNewTabOpen(false)
    onSelectPreviewFileRef.current?.(null)
  }, [isControlled, resolvedActiveTab, tabActivationRevision])

  // Opening a file from the Files panel or transcript dismisses the new-tab
  // page and focuses that file tab directly in the top strip.
  useEffect(() => {
    if (previewActivationRevision === undefined || previewActivationRevision === lastPreviewRevisionRef.current) return
    lastPreviewRevisionRef.current = previewActivationRevision
    setActiveExtraBrowserId(null)
    setNewTabOpen(false)
  }, [previewActivationRevision])

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
  const hasActiveExtraBrowser = Boolean(activeExtraBrowserId && extraBrowserTabs.some((item) => item.id === activeExtraBrowserId))
  const hasActiveFile = Boolean(activePreviewFile && previewFiles.includes(activePreviewFile) && !hasActiveExtraBrowser)
  const showNewTab =
    newTabOpen ||
    (openTabs.length === 0 && previewFiles.length === 0 && extraBrowserTabs.length === 0) ||
    (!hasActiveFile && !hasActiveExtraBrowser && !openTabs.includes(resolvedActiveTab))
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
  const agentPreview = useMemo(
    () => agentItems.slice(0, 3).map((agent) => ({ agent, phase: subagentExecution(agent).phase })),
    [agentItems],
  )
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
    setActiveExtraBrowserId(null)
    onSelectPreviewFile?.(null)
    if (!isControlled) setInternalOpenTabs((tabs) => (tabs.includes(tab) ? tabs : [...tabs, tab]))
    onTabChange(tab)
  }

  const activateExtraBrowser = (id: string) => {
    setNewTabOpen(false)
    setPanelMenu(null)
    setTabMenu(null)
    setQuery('')
    onSelectPreviewFile?.(null)
    setActiveExtraBrowserId(id)
  }

  const activatePreviewFile = (filePath: string) => {
    setNewTabOpen(false)
    setPanelMenu(null)
    setTabMenu(null)
    setQuery('')
    setActiveExtraBrowserId(null)
    onSelectPreviewFile?.(filePath)
  }

  const openNewBrowserTab = (url?: string, title?: string) => {
    setNewTabOpen(false)
    setPanelMenu(null)
    setTabMenu(null)
    setQuery('')
    if (!openTabs.includes('browser')) {
      if (url) {
        browserNavSeqRef.current += 1
        setBrowserNavRequest({ id: browserNavSeqRef.current, url })
      }
      activate('browser')
      return
    }
    extraBrowserSeqRef.current += 1
    const id = `browser-extra-${extraBrowserSeqRef.current}`
    const nextTab: ExtraBrowserTab = { id, initialUrl: url || browserHome, title }
    setExtraBrowserTabs((current) => {
      const next = [...current, nextTab]
      return next.length > MAX_EXTRA_BROWSER_TABS ? next.slice(next.length - MAX_EXTRA_BROWSER_TABS) : next
    })
    onSelectPreviewFile?.(null)
    setActiveExtraBrowserId(id)
  }

  const updateExtraBrowserTitle = useCallback((id: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return
    setExtraBrowserTabs((current) => {
      let changed = false
      const next = current.map((item) => {
        if (item.id !== id || item.title === trimmed) return item
        changed = true
        return { ...item, title: trimmed }
      })
      return changed ? next : current
    })
  }, [])

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
    else if (extraBrowserTabs[0]) setActiveExtraBrowserId(extraBrowserTabs[0].id)
    else if (previewFiles[0]) onSelectPreviewFile?.(previewFiles[0])
    else setNewTabOpen(true)
  }

  const closeExtraBrowserTab = (id: string) => {
    const index = extraBrowserTabs.findIndex((item) => item.id === id)
    if (index === -1) return
    const remaining = extraBrowserTabs.filter((item) => item.id !== id)
    setExtraBrowserTabs(remaining)
    if (activeExtraBrowserId !== id) return
    const nextExtra = remaining[Math.min(index, remaining.length - 1)]
    if (nextExtra) {
      setActiveExtraBrowserId(nextExtra.id)
      return
    }
    setActiveExtraBrowserId(null)
    if (previewFiles[0] && !openTabs.includes(resolvedActiveTab)) {
      onSelectPreviewFile?.(previewFiles[0])
    } else if (openTabs.length === 0 && previewFiles.length === 0) {
      setNewTabOpen(true)
    }
  }

  const closeFileTab = (filePath: string) => {
    const closingOnlyFile = activePreviewFile === filePath && previewFiles.length === 1 && !hasActiveExtraBrowser
    onClosePreviewFile?.(filePath)
    if (closingOnlyFile && openTabs.length === 0 && extraBrowserTabs.length === 0) {
      setNewTabOpen(true)
    }
  }

  const closeAllBuiltInTabsExcept = (keep?: InspectorTab) => {
    if (keep) {
      if (isControlled && onCloseOtherTabs) onCloseOtherTabs(keep)
      else {
        setInternalOpenTabs([keep])
        if (keep !== resolvedActiveTab) onTabChange(keep)
      }
      return
    }
    for (const tab of openTabs) {
      if (isControlled && onCloseTab) onCloseTab(tab)
    }
    if (!isControlled) setInternalOpenTabs([])
  }

  const closeOthers = (target: TabMenuState) => {
    setNewTabOpen(false)
    if (target.kind === 'builtin') {
      closeAllBuiltInTabsExcept(target.tab)
      setExtraBrowserTabs([])
      setActiveExtraBrowserId(null)
      for (const filePath of previewFiles) onClosePreviewFile?.(filePath)
      onSelectPreviewFile?.(null)
      return
    }
    if (target.kind === 'extraBrowser') {
      closeAllBuiltInTabsExcept()
      setExtraBrowserTabs((current) => current.filter((item) => item.id === target.id))
      setActiveExtraBrowserId(target.id)
      for (const filePath of previewFiles) onClosePreviewFile?.(filePath)
      onSelectPreviewFile?.(null)
      return
    }
    closeAllBuiltInTabsExcept()
    setExtraBrowserTabs([])
    setActiveExtraBrowserId(null)
    for (const filePath of previewFiles) {
      if (filePath !== target.path) onClosePreviewFile?.(filePath)
    }
    onSelectPreviewFile?.(target.path)
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

  const copyTitle = (text: string) => {
    void navigator.clipboard?.writeText(text)
  }

  const clampMenuPosition = (x: number, y: number): MenuPoint => ({
    x: Math.max(8, Math.min(x, window.innerWidth - 210)),
    y: Math.max(8, Math.min(y, window.innerHeight - 190)),
  })

  const showTabMenu = (target: TabMenuState) => {
    setPanelMenu(null)
    const { x, y } = clampMenuPosition(target.x, target.y)
    setTabMenu({ ...target, x, y })
  }

  const showPanelMenu = (button: HTMLElement) => {
    const rect = button.getBoundingClientRect()
    setTabMenu(null)
    setPanelMenu((current) => (current ? null : { x: Math.max(8, Math.min(rect.right - 240, window.innerWidth - 248)), y: rect.bottom + 4 }))
  }

  const extraBrowserLabel = (item: ExtraBrowserTab, index: number) =>
    item.title || urlHostFallback(item.initialUrl) || `${label('browser')} ${index + 2}`

  const focusTabDescriptors = [
    ...openTabs.map((tab) => ({ domId: `inspector-tab-${tab}`, select: () => activate(tab) })),
    ...extraBrowserTabs.map((item) => ({ domId: `inspector-tab-${item.id}`, select: () => activateExtraBrowser(item.id) })),
    ...previewFiles.map((filePath, index) => ({ domId: `inspector-tab-file-${index}`, select: () => activatePreviewFile(filePath) })),
  ]

  const moveTab = (current: number, key: string) => {
    if (focusTabDescriptors.length === 0 || current < 0) return
    let next = current
    if (key === 'ArrowRight') next = (current + 1) % focusTabDescriptors.length
    else if (key === 'ArrowLeft') next = (current - 1 + focusTabDescriptors.length) % focusTabDescriptors.length
    else if (key === 'Home') next = 0
    else if (key === 'End') next = focusTabDescriptors.length - 1
    else return
    const target = focusTabDescriptors[next]
    if (!target) return
    target.select()
    // Keep consecutive key events on the newly selected tab. Deferring focus
    // lets the next arrow arrive before the frame and repeat the same move.
    document.getElementById(target.domId)?.focus()
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
          onNewBrowserTab={() => openNewBrowserTab()}
        />
      )
    }
    if (tab === 'files') return <FilesPanel project={project} git={git} onReveal={onRevealPath} onOpenFile={onOpenPreviewFile} />
    if (tab === 'sidechat') return sideChat ? <SideChatPanel {...sideChat} /> : null
    if (tab === 'agents') return subagents ? <SubagentsTabPanel {...subagents} /> : null
    return <BackgroundTasksPanel tasks={taskItems} hasRuntime={hasRuntime} onCancelTask={onCancelBackgroundTask} onRefreshTasks={onRefreshBackgroundTasks} />
  }

  const normalizedQuery = query.trim().toLowerCase()
  const availableTabs = sideChat ? TAB_IDS : TAB_IDS.filter((tab) => tab !== 'sidechat')
  const filteredTabs = availableTabs.filter((tab) => label(tab).toLowerCase().includes(normalizedQuery))
  const tabMenuLabel = tabMenu ? (tabMenu.kind === 'builtin' ? label(tabMenu.tab) : tabMenu.label) : ''
  const activeMenuTarget = (): TabMenuState | null => {
    if (showNewTab) return null
    if (hasActiveExtraBrowser && activeExtraBrowserId) {
      const idx = extraBrowserTabs.findIndex((item) => item.id === activeExtraBrowserId)
      const item = extraBrowserTabs[idx]
      if (!item) return null
      return { kind: 'extraBrowser', id: item.id, label: extraBrowserLabel(item, idx), x: 0, y: 0 }
    }
    if (hasActiveFile && activePreviewFile) {
      return { kind: 'file', path: activePreviewFile, label: basename(activePreviewFile) || activePreviewFile, x: 0, y: 0 }
    }
    if (openTabs.includes(resolvedActiveTab)) {
      return { kind: 'builtin', tab: resolvedActiveTab, x: 0, y: 0 }
    }
    return null
  }

  return (
    <aside ref={inspectorRef} className="inspector" aria-label={t('inspector.aria')} tabIndex={overlay ? -1 : undefined}>
      <div className="inspector__tabs">
        <div className="inspector__tab-list" role="tablist" aria-label={t('inspector.tabs.aria')}>
          {openTabs.map((tab, tabIndex) => {
            const active = !showNewTab && !hasActiveFile && !hasActiveExtraBrowser && tab === resolvedActiveTab
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
                    showTabMenu({ kind: 'builtin', tab, x: event.clientX, y: event.clientY })
                  }}
                  onKeyDown={(event) => {
                    if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault()
                      moveTab(tabIndex, event.key)
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

          {extraBrowserTabs.map((item, extraIndex) => {
            const active = !showNewTab && activeExtraBrowserId === item.id
            const itemLabel = extraBrowserLabel(item, extraIndex)
            const focusIndex = openTabs.length + extraIndex
            return (
              <div className={`inspector-tab${active ? ' is-active' : ''}`} key={item.id} role="presentation">
                <button
                  id={`inspector-tab-${item.id}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`inspector-panel-${item.id}`}
                  tabIndex={active ? 0 : -1}
                  title={item.title ? `${item.title} (${item.initialUrl})` : item.initialUrl}
                  className="inspector-tab__button"
                  onClick={() => activateExtraBrowser(item.id)}
                  onMouseDown={(event) => {
                    if (event.button !== 1) return
                    event.preventDefault()
                    closeExtraBrowserTab(item.id)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    showTabMenu({ kind: 'extraBrowser', id: item.id, label: itemLabel, x: event.clientX, y: event.clientY })
                  }}
                  onKeyDown={(event) => {
                    if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault()
                      moveTab(focusIndex, event.key)
                    }
                  }}
                >
                  <Globe size={13} />
                  <span>{itemLabel}</span>
                </button>
                <button
                  type="button"
                  className="inspector-tab__close"
                  tabIndex={-1}
                  aria-label={t('inspector.tabs.close', { name: itemLabel })}
                  onClick={() => closeExtraBrowserTab(item.id)}
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}

          {previewFiles.map((filePath, fileIndex) => {
            const active = !showNewTab && !hasActiveExtraBrowser && activePreviewFile === filePath
            const name = basename(filePath) || filePath
            const Icon = fileTabIcon(filePath)
            const focusIndex = openTabs.length + extraBrowserTabs.length + fileIndex
            return (
              <div className={`inspector-tab${active ? ' is-active' : ''}`} key={filePath} role="presentation">
                <button
                  id={`inspector-tab-file-${fileIndex}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`inspector-panel-file-${fileIndex}`}
                  tabIndex={active ? 0 : -1}
                  title={filePath}
                  className="inspector-tab__button"
                  onClick={() => activatePreviewFile(filePath)}
                  onMouseDown={(event) => {
                    if (event.button !== 1) return
                    event.preventDefault()
                    closeFileTab(filePath)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    showTabMenu({ kind: 'file', path: filePath, label: name, x: event.clientX, y: event.clientY })
                  }}
                  onKeyDown={(event) => {
                    if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault()
                      moveTab(focusIndex, event.key)
                    }
                  }}
                >
                  <Icon size={13} />
                  <span>{name}</span>
                </button>
                <button
                  type="button"
                  className="inspector-tab__close"
                  tabIndex={-1}
                  aria-label={t('inspector.tabs.close', { name })}
                  onClick={() => closeFileTab(filePath)}
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
        {openTabs.map((tab) => {
          const active = !showNewTab && !hasActiveFile && !hasActiveExtraBrowser && tab === resolvedActiveTab
          return (
            <div
              key={tab}
              id={`inspector-panel-${tab}`}
              className="inspector__panel"
              role="tabpanel"
              aria-labelledby={`inspector-tab-${tab}`}
              tabIndex={0}
              hidden={!active}
            >
              {renderPanel(tab)}
            </div>
          )
        })}

        {extraBrowserTabs.map((item) => {
          const active = !showNewTab && activeExtraBrowserId === item.id
          return (
            <div
              key={item.id}
              id={`inspector-panel-${item.id}`}
              className="inspector__panel"
              role="tabpanel"
              aria-labelledby={`inspector-tab-${item.id}`}
              tabIndex={0}
              hidden={!active}
            >
              <BrowserPanel
                platform={platform}
                home={item.initialUrl}
                onOpenExternal={onOpenExternal}
                annotations={browserAnnotations}
                agentTabs={EMPTY_AGENT_BROWSER_TABS}
                activeAgentTabId={null}
                previewSelected
                onSelectAgentTab={NOOP}
                onCloseAgentTab={NOOP}
                onShowPreview={NOOP}
                onTitleChange={(title) => updateExtraBrowserTitle(item.id, title)}
                onNewBrowserTab={() => openNewBrowserTab()}
              />
            </div>
          )
        })}

        {previewFiles.map((filePath, fileIndex) => {
          const active = !showNewTab && !hasActiveExtraBrowser && activePreviewFile === filePath
          return (
            <div
              key={filePath}
              id={`inspector-panel-file-${fileIndex}`}
              className="inspector__panel"
              role="tabpanel"
              aria-labelledby={`inspector-tab-file-${fileIndex}`}
              tabIndex={0}
              hidden={!active}
            >
              <Suspense fallback={null}>
                <FilePreviewPanel
                  filePath={filePath}
                  onOpenFile={(nextPath) => onOpenPreviewFile?.(nextPath)}
                  onOpenInBrowser={(url, title) => openNewBrowserTab(url, title)}
                  onReveal={onRevealPath}
                />
              </Suspense>
            </div>
          )
        })}

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
                      openNewBrowserTab(query.trim())
                      return
                    }
                    const first = filteredTabs[0]
                    if (first) {
                      if (first === 'browser') openNewBrowserTab()
                      else activate(first)
                    }
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
                  <button
                    type="button"
                    className="inspector-new-tab__item"
                    key={tab}
                    onClick={() => (tab === 'browser' ? openNewBrowserTab() : activate(tab))}
                  >
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
                    {agentPreview.map(({ agent, phase }) => (
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
                        <span className="inspector-new-tab__detail">{t(EXECUTION_LABELS[phase])}</span>
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
              disabled={!activeMenuTarget()}
              onClick={(event) => {
                const target = activeMenuTarget()
                if (!target) return
                const rect = event.currentTarget.getBoundingClientRect()
                showTabMenu({ ...target, x: rect.right - 190, y: rect.bottom + 4 })
              }}
            >
              <MoreVertical size={13} />
            </IconButton>
          </div>
          {availableTabs.map((tab) => {
            const Icon = TAB_ICONS[tab]
            const detail = tabDetail(tab)
            const selected = !showNewTab && !hasActiveFile && !hasActiveExtraBrowser && tab === resolvedActiveTab
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
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (tabMenu.kind === 'builtin') closeTab(tabMenu.tab)
              else if (tabMenu.kind === 'extraBrowser') closeExtraBrowserTab(tabMenu.id)
              else closeFileTab(tabMenu.path)
              setTabMenu(null)
            }}
          >
            <X size={13} />
            <span>{t('inspector.tabs.close', { name: tabMenuLabel })}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeOthers(tabMenu)
              setTabMenu(null)
            }}
          >
            <X size={13} />
            <span>{t('inspector.tabs.closeOthers')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              copyTitle(tabMenuLabel)
              setTabMenu(null)
            }}
          >
            <FileText size={13} />
            <span>{t('inspector.tabs.copyTitle')}</span>
          </button>
          {tabMenu.kind === 'file' ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onRevealPath(tabMenu.path)
                setTabMenu(null)
              }}
            >
              <FolderOpen size={13} />
              <span>{t('filePreview.reveal')}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  )
})
