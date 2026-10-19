import { Folder } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import type { ProjectRecord } from '@/types/api'

interface ProjectPickerProps {
  /** Only used to label the chip with the active project name. */
  projects: readonly ProjectRecord[]
  activeProjectId?: string
  /** Opens the native folder picker and activates the granted folder as a project. */
  onAddFolder(): void
}

/**
 * Composer chip for the session's working folder. Clicking it goes straight
 * to the system folder dialog — switching between already-added projects is
 * what the sidebar is for, so the composer stays a single step.
 */
export function ProjectPicker({ projects, activeProjectId, onAddFolder }: ProjectPickerProps) {
  const { t } = useI18n()
  const active = projects.find((project) => project.id === activeProjectId)
  const label = active?.name ?? t('composer.projectMenu.none')

  return (
    <button
      type="button"
      className="permissions-chip project-picker__trigger"
      aria-label={t('composer.projectMenu.aria', { label })}
      title={active ? `${active.name}\n${active.primaryFolder}` : undefined}
      onClick={onAddFolder}
    >
      <Folder size={12} />
      <span className="worktree-picker__label">{label}</span>
    </button>
  )
}
