import { resolve } from 'node:path'
import { isPathWithin, requireExistingDirectory } from './validation'

/** Session facts deleteProjectSessions needs; a structural slice of SessionRecord. */
export interface ProjectSessionCandidate {
  filePath: string
  projectPath?: string
}

/** Collaborators for deleteProjectSessions; injectable for unit tests. */
export interface ProjectSessionCleanupDeps {
  listSessions(): Promise<readonly ProjectSessionCandidate[]>
  deleteSession(filePath: string): Promise<unknown>
  closeBrowserView(filePath: string): unknown
  killTerminal(filePath: string): Promise<unknown>
}

/**
 * Canonicalizes project folders for containment matching. Session project
 * paths are canonicalized by the metadata reader, so a symlinked project
 * folder must resolve the same way; stale lexical folders still match what
 * the catalog can serve.
 */
export async function resolveProjectRoots(folders: readonly string[]): Promise<string[]> {
  const roots: string[] = []
  for (const folder of folders) {
    try { roots.push(await requireExistingDirectory(folder)) } catch { roots.push(resolve(folder)) }
  }
  return roots
}

/**
 * Removing a project is destructive on the harness side: every saved session
 * stored under the project's folders is deleted with it, so the catalog the
 * UI shows and the sessions the harness keeps on disk stay in sync. The
 * workspace folders themselves are never touched here. Roots are matched by
 * containment, not equality, so sessions started in subdirectories of a
 * project folder are included.
 */
export async function deleteProjectSessions(deps: ProjectSessionCleanupDeps, roots: readonly string[]): Promise<string[]> {
  const resolvedRoots = roots.map((root) => resolve(root))
  const sessions = await deps.listSessions()
  const doomed = sessions.filter((record) => {
    const projectPath = record.projectPath
    if (!projectPath) return false
    return resolvedRoots.some((root) => isPathWithin(root, projectPath))
  })
  for (const record of doomed) {
    await deps.deleteSession(record.filePath)
    deps.closeBrowserView(record.filePath)
    await deps.killTerminal(record.filePath)
  }
  return doomed.map((record) => record.filePath)
}
