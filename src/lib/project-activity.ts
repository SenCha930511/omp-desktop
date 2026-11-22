import type { ProjectRecord, SessionRecord } from '../types/api'

type ActivitySession = Pick<SessionRecord, 'createdAt' | 'lastUserMessageAt'>
type ProjectActivitySource = Pick<ProjectRecord, 'createdAt' | 'lastUserActivityAt'>

function validActivityAt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return Number.isFinite(Date.parse(value)) ? value : undefined
}

export function newerActivityAt(left: string | undefined, right: string | undefined): string | undefined {
  const leftTime = left === undefined ? Number.NaN : Date.parse(left)
  const rightTime = right === undefined ? Number.NaN : Date.parse(right)
  if (Number.isFinite(leftTime) && (!Number.isFinite(rightTime) || leftTime >= rightTime)) return left
  if (Number.isFinite(rightTime)) return right
  return undefined
}

/** A session without a recorded user turn still contributes its creation time. */
export function sessionActivityAt(session: ActivitySession): string | undefined {
  return validActivityAt(session.lastUserMessageAt) ?? validActivityAt(session.createdAt)
}

export function projectActivityAt(project: ProjectActivitySource): string | undefined {
  return validActivityAt(project.lastUserActivityAt) ?? validActivityAt(project.createdAt)
}

export function projectActivityTime(project: ProjectActivitySource): number | undefined {
  const activity = projectActivityAt(project)
  if (activity === undefined) return undefined
  return Date.parse(activity)
}

const PATH_SEPARATORS = new Set(['/', '\\'])

function pathIsWithin(path: string, folder: string): boolean {
  let end = folder.length
  while (end > 1 && PATH_SEPARATORS.has(folder[end - 1]!)) end -= 1
  const base = folder.slice(0, end)
  if (path === base) return true
  if (base.length === 0) return false
  if (base.length === 1 && PATH_SEPARATORS.has(base)) return true
  return path.startsWith(base) && PATH_SEPARATORS.has(path.charAt(base.length))
}

/**
 * Reprojects activity whenever project or session state changes. A matching
 * session belongs only to the most specific project folders. Tied folders
 * retain the same multi-project membership as the sidebar.
 */
export function projectsWithActivity(
  projects: readonly ProjectRecord[],
  sessions: readonly SessionRecord[],
): ProjectRecord[] {
  const activityByProject = new Map<string, string>()
  for (const session of sessions) {
    const activity = sessionActivityAt(session)
    if (activity === undefined) continue
    let bestLength = -1
    let owners: string[] = []
    for (const project of projects) {
      let projectBestLength = -1
      for (const folder of new Set([project.path, ...project.folders])) {
        if (pathIsWithin(session.projectPath, folder)) projectBestLength = Math.max(projectBestLength, folder.length)
      }
      if (projectBestLength < 0) continue
      if (projectBestLength > bestLength) {
        bestLength = projectBestLength
        owners = []
      }
      if (projectBestLength === bestLength) owners.push(project.id)
    }
    for (const projectId of owners) {
      activityByProject.set(projectId, newerActivityAt(activityByProject.get(projectId), activity) ?? activity)
    }
  }
  return projects.map((project) => {
    const lastUserActivityAt = newerActivityAt(project.lastUserActivityAt, activityByProject.get(project.id))
    return lastUserActivityAt === project.lastUserActivityAt ? project : { ...project, lastUserActivityAt }
  })
}
