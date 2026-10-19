import { ArrowUpRight, Folder, FolderGit2, FolderInput, FolderPlus, GitBranch, Pin, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState, IconButton, Modal } from '@/components/ui'
import { formatRelative } from '@/lib/data'
import { useI18n } from '@/lib/i18n'
import { sortProjects } from '@/lib/project-order'
import type { ProjectRecord, ProjectSortMode } from '@/types/api'

export function ProjectsPage({
  projects,
  sortMode,
  onAdd,
  onOpen,
  onRelocate,
  onRemove,
  onTogglePin,
}: {
  projects: ProjectRecord[]
  sortMode: ProjectSortMode
  onAdd(): void
  onOpen(project: ProjectRecord): void
  onRelocate(project: ProjectRecord): void
  onRemove(project: ProjectRecord): void
  onTogglePin(project: ProjectRecord): void
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [removeTarget, setRemoveTarget] = useState<ProjectRecord | null>(null)
  const visible = useMemo(
    () =>
      sortProjects(
        projects.filter((project) => `${project.name} ${project.path} ${project.gitBranch ?? ''}`.toLowerCase().includes(query.toLowerCase())),
        sortMode,
      ),
    [projects, query, sortMode],
  )
  return (
    <div className="page scroll-area">
      <div className="page-container">
        <header className="page-header">
          <div>
            <h1>{t('projects.title')}</h1>
            <p>{t('projects.subtitle')}</p>
          </div>
          <button type="button" title={t('projects.addProject')} className="button button--primary" onClick={onAdd}>
            <FolderPlus size={14} /> {t('projects.addProject')}
          </button>
        </header>
        <div className="page-tools">
          <label className="page-search">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('projects.searchPlaceholder')} />
          </label>
          <span>{t('projects.count', { count: visible.length })}</span>
        </div>
        {visible.length ? (
          <div className="project-library">
            {visible.map((project) => (
              <article key={project.id} className="project-item">
                <button type="button" className="project-item__open" onClick={() => onOpen(project)}>
                  <span className="project-item__icon">
                    <FolderGit2 size={19} />
                  </span>
                  <span className="project-item__body">
                    <span>
                      <h2>{project.name}</h2>
                      {project.pinned ? <Pin size={11} fill="currentColor" /> : null}
                    </span>
                    <span className="project-item__path">{project.path}</span>
                    <span className="project-item__meta">
                      <span>
                        <GitBranch size={12} />
                        {project.gitBranch ?? t('projects.noRepository')}
                      </span>
                      <span>{t('projects.sessionCount', { count: project.sessionCount })}</span>
                      <span>{t('projects.opened', { time: formatRelative(project.lastOpenedAt) })}</span>
                    </span>
                  </span>
                </button>
                <div className="project-item__actions">
                  <IconButton label={t('projects.openProject', { name: project.name })} onClick={() => onOpen(project)}>
                    <ArrowUpRight size={14} />
                  </IconButton>
                  {!project.inferred ? (
                    <IconButton label={t('projects.relocateProject', { name: project.name })} onClick={() => onRelocate(project)}>
                      <FolderInput size={14} />
                    </IconButton>
                  ) : null}
                  {!project.inferred ? (
                    <IconButton label={t(project.pinned ? 'projects.unpinProject' : 'projects.pinProject', { name: project.name })} onClick={() => onTogglePin(project)}>
                      <Pin size={14} fill={project.pinned ? 'currentColor' : 'none'} />
                    </IconButton>
                  ) : null}
                  <IconButton label={t('projects.removeProject', { name: project.name })} onClick={() => setRemoveTarget(project)}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState icon={<Folder size={25} />} title={query ? t('projects.emptySearchTitle') : t('projects.emptyTitle')}>
            {query ? t('projects.emptySearchBody') : t('projects.emptyBody')}
          </EmptyState>
        )}
        {removeTarget ? (
          <Modal
            title={t('projects.removeTitle')}
            onClose={() => setRemoveTarget(null)}
            footer={
              <>
                <button type="button" className="button" onClick={() => setRemoveTarget(null)}>
                  {t('projects.cancel')}
                </button>
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => {
                    const project = removeTarget
                    setRemoveTarget(null)
                    onRemove(project)
                  }}
                >
                  {t('projects.remove')}
                </button>
              </>
            }
          >
            <p>{t('projects.removeBody', { name: removeTarget.name })}</p>
          </Modal>
        ) : null}
      </div>
    </div>
  )
}
