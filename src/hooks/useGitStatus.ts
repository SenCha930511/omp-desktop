import { useEffect, useRef, useState, type RefObject } from 'react'
import { createScopedRequestGuard } from '@/app/scoped-request'
import type { WorkspaceSnapshot } from '@/app/workspace'
import { EMPTY_GIT_STATUS, gitStatusForWorkspace } from '@/lib/workspace'
import type { DesktopApi, GitFileChange, GitStatus } from '@/types/api'
import { useStableCallback } from './useStableCallback'

interface UseGitStatusOptions {
  bridge: DesktopApi | null
  cwd?: string
  generation: number
  workspaceRef: RefObject<WorkspaceSnapshot>
  initial: { cwd: string | undefined; status: GitStatus }
  reportError(error: unknown): void
}

function sameFiles(left: readonly GitFileChange[], right: readonly GitFileChange[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a.path !== b.path || a.status !== b.status || a.staged !== b.staged
      || a.additions !== b.additions || a.deletions !== b.deletions || a.contentHash !== b.contentHash) return false
  }
  return true
}

/** A poll that observed nothing new must not re-render the inspector. */
function sameStatus(left: GitStatus, right: GitStatus): boolean {
  return left.isRepo === right.isRepo
    && left.branch === right.branch
    && left.upstream === right.upstream
    && left.ahead === right.ahead
    && left.behind === right.behind
    && left.truncated === right.truncated
    && left.error === right.error
    && sameFiles(left.files, right.files)
}

function sameSnapshot(left: { cwd: string | undefined; status: GitStatus }, cwd: string | undefined, status: GitStatus): boolean {
  return left.cwd === cwd && sameStatus(left.status, status)
}

/** Owns Git reads and their workspace admission; overlapping callers share one process request. */
export function useGitStatus({ bridge, cwd, generation, workspaceRef, initial, reportError }: UseGitStatusOptions) {
  const [snapshot, setSnapshot] = useState(initial)
  const guard = useRef(createScopedRequestGuard())
  const pending = useRef(new Map<string, Promise<GitStatus>>())
  const refreshGit = useStableCallback(async (selected: Pick<WorkspaceSnapshot, 'generation' | 'cwd'> = workspaceRef.current): Promise<void> => {
    const request = guard.current.begin(selected.generation, selected.cwd)
    if (!bridge) return
    if (!selected.cwd) {
      setSnapshot((previous) => sameSnapshot(previous, undefined, EMPTY_GIT_STATUS) ? previous : { cwd: undefined, status: EMPTY_GIT_STATUS })
      return
    }
    const key = `${selected.generation}:${selected.cwd}`
    let operation = pending.current.get(key)
    if (!operation) {
      operation = bridge.git.status(selected.cwd)
      pending.current.set(key, operation)
    }
    const isCurrent = () => guard.current.isCurrent(request, workspaceRef.current.generation, workspaceRef.current.cwd)
    try {
      const status = await operation
      if (isCurrent()) setSnapshot((previous) => sameSnapshot(previous, selected.cwd, status) ? previous : { cwd: selected.cwd, status })
    } catch (error) {
      if (isCurrent()) reportError(error)
    } finally {
      if (pending.current.get(key) === operation) pending.current.delete(key)
    }
  })
  useEffect(() => {
    void refreshGit()
    return () => guard.current.invalidate()
  }, [cwd, generation, refreshGit])
  return { git: gitStatusForWorkspace(snapshot, cwd), refreshGit }
}
