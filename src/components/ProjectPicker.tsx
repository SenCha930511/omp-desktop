import { Check, ChevronDown, Folder, FolderPlus } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import type { ProjectRecord } from '@/types/api'

interface ProjectPickerProps {
  /** Every addable project; inferred ones are included and behave like sidebar clicks. */
  projects: readonly ProjectRecord[]
  activeProjectId?: string
  /** Activates another project, exactly like clicking it in the sidebar. */
  onSelect(project: ProjectRecord): void
  /** Opens the native folder picker and activates the granted folder as a project. */
  onAddFolder(): void
}

/**
 * Composer control for the session's working folder. The checkout picker only
 * covers git-bound projects, so this menu is what makes an arbitrary local
 * folder selectable while composing — including brand-new empty sessions,
 * where the old fallback pill rendered as a permanently disabled button.
 */
export function ProjectPicker({ projects, activeProjectId, onSelect, onAddFolder }: ProjectPickerProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const active = projects.find((project) => project.id === activeProjectId)
  const label = active?.name ?? t('composer.projectMenu.none')

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) setOpen(false)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onEscape)
    }
  }, [open])

  return (
    <div className="worktree-picker project-picker" ref={rootRef}>
      <button
        type="button"
        className="permissions-chip worktree-picker__trigger"
        aria-label={t('composer.projectMenu.aria', { label })}
        title={active ? `${active.name}\n${active.primaryFolder}` : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Folder size={12} />
        <span className="worktree-picker__label">{label}</span>
        <ChevronDown className="worktree-picker__chevron" size={11} />
      </button>
      {open ? (
        <div className="worktree-picker__menu" id={menuId} role="menu" aria-label={t('composer.projectMenu.heading')}>
          <div className="worktree-picker__heading">{t('composer.projectMenu.heading')}</div>
          <div className="worktree-picker__options">
            {projects.length === 0 ? <span className="worktree-picker__empty">{t('composer.projectMenu.empty')}</span> : null}
            {projects.map((project) => {
              const selected = project.id === activeProjectId
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`worktree-picker__option ${selected ? 'is-active' : ''}`}
                  key={project.id}
                  onClick={() => {
                    setOpen(false)
                    if (!selected) onSelect(project)
                  }}
                >
                  <span className="worktree-picker__check">{selected ? <Check size={13} /> : null}</span>
                  <span className="worktree-picker__option-copy">
                    <strong>{project.name}</strong>
                    <span title={project.primaryFolder}>{project.primaryFolder}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <div className="project-picker__add">
            <button
              type="button"
              role="menuitem"
              className="worktree-picker__option"
              onClick={() => {
                setOpen(false)
                onAddFolder()
              }}
            >
              <span className="worktree-picker__check">
                <FolderPlus size={13} />
              </span>
              <span className="worktree-picker__option-copy">
                <strong>{t('composer.projectMenu.chooseFolder')}</strong>
              </span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
