// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useGitStatus } from '../../src/hooks/useGitStatus'
import type { WorkspaceSnapshot } from '../../src/app/workspace'
import type { DesktopApi, GitStatus } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('shares overlapping Git reads and discards a result from the previous workspace', async () => {
  let resolveOld!: (status: GitStatus) => void
  let resolveNew!: (status: GitStatus) => void
  const old = new Promise<GitStatus>((resolve) => { resolveOld = resolve })
  const next = new Promise<GitStatus>((resolve) => { resolveNew = resolve })
  const status = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next)
  const bridge = { git: { status } } as unknown as DesktopApi
  const scope = createRef<WorkspaceSnapshot>()
  scope.current = { generation: 1, cwd: '/first' }
  const reportError = vi.fn()
  let state!: ReturnType<typeof useGitStatus>
  function Harness() {
    state = useGitStatus({ bridge, cwd: scope.current!.cwd, generation: scope.current!.generation,
      workspaceRef: scope as { current: WorkspaceSnapshot }, initial: { cwd: undefined, status: { isRepo: false, files: [] } }, reportError })
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<Harness />))
    const extra = state.refreshGit()
    expect(status).toHaveBeenCalledTimes(1)
    scope.current = { generation: 2, cwd: '/second' }
    await act(async () => root.render(<Harness />))
    expect(status).toHaveBeenCalledTimes(2)
    await act(async () => { resolveNew({ isRepo: true, branch: 'second', files: [] }); await next })
    await act(async () => { resolveOld({ isRepo: true, branch: 'obsolete', files: [] }); await extra })
    expect(state.git.branch).toBe('second')
    expect(reportError).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()) }
})
