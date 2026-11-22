import type { ProjectRecord, ProjectSortMode } from '../types/api'
import { projectActivityTime } from './project-activity'

function compareRecent(a: ProjectRecord, b: ProjectRecord): number {
  const aTime = projectActivityTime(a)
  const bTime = projectActivityTime(b)
  if ((aTime === undefined) !== (bTime === undefined)) return aTime === undefined ? 1 : -1
  if (aTime !== undefined && bTime !== undefined && aTime !== bTime) return bTime - aTime
  return 0
}

export function sortProjects(projects: readonly ProjectRecord[], mode: ProjectSortMode): ProjectRecord[] {
  return [...projects].sort((a, b) => {
    const pinnedOrder = Number(b.pinned) - Number(a.pinned)
    if (pinnedOrder) return pinnedOrder
    if (mode === 'alphabetical') {
      const nameOrder = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      if (nameOrder) return nameOrder
    } else {
      const recentOrder = compareRecent(a, b)
      if (recentOrder) return recentOrder
    }
    return a.id.localeCompare(b.id)
  })
}
