import { Bell, CalendarClock, Folder, LayoutPanelLeft, NotebookPen, PackageOpen, Search, Settings, Terminal } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '@/lib/i18n'
import { isImeComposingOrGuarded } from '@/lib/message-shortcuts'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import type { WorkspaceView } from '@/types/api'
import { BrowserGlobe, useAppShellOverlay, useFocusTrap } from './ui'

interface Command {
  id: string
  label: string
  detail: string
  shortcut?: string
  icon: ReactNode
  run(): void
}

export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onNewSession,
  onToggleSidebar,
  onToggleTerminal,
  onOpenBrowser,
  platform = 'darwin',
}: {
  open: boolean
  onClose(): void
  onNavigate(view: WorkspaceView): void
  onNewSession(): void
  onToggleSidebar(): void
  onToggleTerminal(): void
  onOpenBrowser(): void
  platform?: NodeJS.Platform
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const paletteRef = useFocusTrap<HTMLDivElement>(open, onClose)
  // IME composition owns the arrow/enter/escape keys while the candidate
  // window is up; the shared guard also covers the post-commit key leak.
  const composingRef = useRef(false)
  const lastCompositionEndAtRef = useRef<number | null>(null)
  const commands: Command[] = [
    { id: 'new', label: t('palette.newSession'), detail: t('palette.newSessionDetail'), shortcut: shortcutLabel(platform, ['Primary', 'N']), icon: <NotebookPen size={14} />, run: onNewSession },
    { id: 'projects', label: t('palette.openProjects'), detail: t('palette.openProjectsDetail'), icon: <Folder size={14} />, run: () => onNavigate('projects') },
    { id: 'activity', label: t('palette.openActivity'), detail: t('palette.openActivityDetail'), icon: <Bell size={14} />, run: () => onNavigate('activity') },
    { id: 'scheduled', label: t('palette.openScheduled'), detail: t('palette.openScheduledDetail'), icon: <CalendarClock size={14} />, run: () => onNavigate('scheduled') },
    { id: 'plugins', label: t('palette.openCapabilities'), detail: t('palette.openCapabilitiesDetail'), icon: <PackageOpen size={14} />, run: () => onNavigate('plugins') },
    {
      id: 'browser',
      label: t('palette.toggleBrowser'),
      detail: t('palette.toggleBrowserDetail'),
      shortcut: shortcutLabel(platform, ['Primary', 'Shift', 'B']),
      icon: <BrowserGlobe size={14} />,
      run: onOpenBrowser,
    },
    {
      id: 'terminal',
      label: t('palette.toggleTerminal'),
      detail: t('palette.toggleTerminalDetail'),
      shortcut: shortcutLabel(platform, ['Primary', 'J']),
      icon: <Terminal size={14} />,
      run: onToggleTerminal,
    },
    {
      id: 'sidebar',
      label: t('palette.toggleSidebar'),
      detail: t('palette.toggleSidebarDetail'),
      shortcut: shortcutLabel(platform, ['Primary', 'B']),
      icon: <LayoutPanelLeft size={14} />,
      run: onToggleSidebar,
    },
    {
      id: 'settings',
      label: t('palette.openSettings'),
      detail: t('palette.openSettingsDetail'),
      shortcut: shortcutLabel(platform, ['Primary', ',']),
      icon: <Settings size={14} />,
      run: () => onNavigate('settings'),
    },
  ]
  const visible = commands.filter((command) => `${command.label} ${command.detail}`.toLowerCase().includes(query.toLowerCase()))
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      // A close mid-composition would otherwise leave the guard latched for
      // the next mount if a call site ever keeps this component mounted.
      composingRef.current = false
      lastCompositionEndAtRef.current = null
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])
  useEffect(() => setActive(0), [query])
  useAppShellOverlay(open)
  const activeCommandId = visible[active]?.id
  // Wrap-around selection can land past the listbox fold; keep the active
  // option in view without scrolling the input out of place.
  useEffect(() => {
    if (activeCommandId) document.getElementById(`command-${activeCommandId}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeCommandId, query])
  if (!open) return null
  const choose = (command?: Command) => {
    if (!command) return
    command.run()
    onClose()
  }
  return createPortal(
    <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={paletteRef} className="command-palette" role="dialog" aria-modal="true" aria-label={t('palette.aria')} tabIndex={-1}>
        <div className="command-search">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={visible[active] ? `command-${visible[active].id}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false
              lastCompositionEndAtRef.current = event.nativeEvent.timeStamp
            }}
            placeholder={t('palette.searchPlaceholder')}
            onKeyDown={(event) => {
              if (isImeComposingOrGuarded(event.nativeEvent, composingRef.current, lastCompositionEndAtRef.current)) return
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                if (visible.length > 0) setActive((value) => (value + 1) % visible.length)
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                if (visible.length > 0) setActive((value) => (value - 1 + visible.length) % visible.length)
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                choose(visible[active])
              }
              if (event.key === 'Escape') onClose()
            }}
          />
          <button type="button" onClick={onClose} aria-label={t('palette.close')}>
            <kbd>esc</kbd>
          </button>
        </div>
        <div id="command-results" className="command-results" role="listbox" aria-label={t('palette.commands')}>
          <div className="command-section-label">{t('palette.commands')}</div>
          {visible.map((command, index) => (
            <button
              id={`command-${command.id}`}
              type="button"
              role="option"
              aria-selected={index === active}
              key={command.id}
              className={index === active ? 'is-active' : ''}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(command)}
            >
              <span>{command.icon}</span>
              <span>
                <strong>{command.label}</strong>
                <small>{command.detail}</small>
              </span>
              {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
            </button>
          ))}
          {visible.length === 0 ? <p>{t('palette.noMatch', { query })}</p> : null}
        </div>
        <footer>
          <span>{t('palette.footerNavigate')}</span>
          <span>{t('palette.footerOpen')}</span>
          <span>{t('palette.footerClose')}</span>
        </footer>{' '}
      </div>
    </div>,
    document.body,
  )
}
