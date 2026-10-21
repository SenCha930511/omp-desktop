import { useEffect, useRef, useState, type RefObject } from 'react'
import { createScopedRequestGuard } from '@/app/scoped-request'
import type { WorkspaceSnapshot } from '@/app/workspace'
import { gitStatusForWorkspace } from '@/lib/workspace'
import type { DesktopApi, GitStatus } from '@/types/api'
import { useStableCallback } from './useStableCallback'

interface UseGitStatusOptions {
  bridge: DesktopApi | null
  cwd?: string
  generation: number
  workspaceRef: RefObject<WorkspaceSnapshot>
  initial: { cwd: string | undefined; status: GitStatus }
  reportError(error: unknown): void
}

/** Owns Git reads and their workspace admission; overlapping callers share one process request. */
export function useGitStatus({ bridge, cwd, generation, workspaceRef, initial, reportError }: UseGitStatusOptions) {
  const [snapshot, setSnapshot] = useState(initial)
  const guard = useRef(createScopedRequestGuard())
  const pending = useRef(new Map<string, Promise<GitStatus>>())
  const refreshGit = useStableCallback(async (selected: Pick<WorkspaceSnapshot, 'generation' | 'cwd'> = workspaceRef.current): Promise<void> => {
    const request = guard.current.begin(selected.generation, selected.cwd)
    if (!bridge) return
    if (!selected.cwd) { setSnapshot({ cwd: undefined, status: { isRepo: false, files: [] } }); return }
    const key = `${selected.generation}:${selected.cwd}`
    let operation = pending.current.get(key)
    if (!operation) {
      operation = bridge.git.status(selected.cwd)
      pending.current.set(key, operation)
    }
    const isCurrent = () => guard.current.isCurrent(request, workspaceRef.current.generation, workspaceRef.current.cwd)
    try {
      const status = await operation
      if (isCurrent()) setSnapshot({ cwd: selected.cwd, status })
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
