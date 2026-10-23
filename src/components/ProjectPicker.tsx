import { Check, Folder } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import type { ProjectRecord } from '@/types/api'

interface ProjectPickerProps {
  projects: readonly ProjectRecord[]
  activeProjectId?: string
  onSelectProject?(project: ProjectRecord): void
  /** Opens the native folder picker and activates the granted folder as a project. */
  onAddFolder(): void
}

export function ProjectPicker({ projects, activeProjectId, onAddFolder, onSelectProject }: ProjectPickerProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const active = projects.find((project) => project.id === activeProjectId)
  const label = active?.name ?? t('composer.projectMenu.none')
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }
  useEffect(() => {
    if (!open) return
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menu"] button')?.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  return (
    <div className="worktree-picker" ref={rootRef} onBlur={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close()
    }}>
    <button
      ref={triggerRef}
      type="button"
      className="permissions-chip project-picker__trigger"
      aria-label={t('composer.projectMenu.aria', { label })}
      title={active ? `${active.name}\n${active.primaryFolder}` : undefined}
      aria-haspopup={onSelectProject ? 'menu' : undefined}
      aria-expanded={onSelectProject ? open : undefined}
      aria-controls={open ? menuId : undefined}
      onClick={() => onSelectProject ? setOpen((value) => !value) : onAddFolder()}
      onKeyDown={(event) => {
        if (onSelectProject && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault()
          setOpen(true)
        }
      }}
    >
      <Folder size={12} />
      <span className="worktree-picker__label">{label}</span>
    </button>
    {open ? <div className="worktree-picker__menu" id={menuId} role="menu" aria-label={t('composer.projectMenu.heading')} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
      const index = document.activeElement instanceof HTMLButtonElement ? items.indexOf(document.activeElement) : -1
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }}>
      <div className="worktree-picker__options">{projects.map((project) => <button key={project.id} type="button" className="worktree-picker__option" role="menuitemradio" aria-checked={project.id === activeProjectId} title={project.primaryFolder} onClick={() => { onSelectProject?.(project); close(true) }}>
        {project.id === activeProjectId ? <Check size={12} /> : <Folder size={12} />}
        <span className="worktree-picker__option-copy"><strong>{project.name}</strong><span>{project.primaryFolder}</span></span>
      </button>)}</div>
      <div className="project-picker__add"><button type="button" role="menuitem" className="worktree-picker__option" onClick={() => { close(true); onAddFolder() }}>{t('composer.projectMenu.chooseFolder')}</button></div>
    </div> : null}
    </div>
  )
}
