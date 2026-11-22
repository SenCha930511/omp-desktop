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

it('keeps the previous snapshot when a refresh returns an equal status', async () => {
  const first: GitStatus = {
    isRepo: true,
    branch: 'main',
    ahead: 1,
    files: [{ path: 'a.ts', status: 'M', staged: false, additions: 1, deletions: 0, contentHash: '33188:aa' }],
  }
  const second: GitStatus = { ...first, files: [{ ...first.files[0] }] }
  const status = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  const bridge = { git: { status } } as unknown as DesktopApi
  const scope = createRef<WorkspaceSnapshot>()
  scope.current = { generation: 1, cwd: '/repo' }
  let state!: ReturnType<typeof useGitStatus>
  function Harness() {
    state = useGitStatus({ bridge, cwd: scope.current!.cwd, generation: scope.current!.generation,
      workspaceRef: scope as { current: WorkspaceSnapshot }, initial: { cwd: undefined, status: { isRepo: false, files: [] } }, reportError: vi.fn() })
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<Harness />))
    expect(state.git).toBe(first)
    await act(async () => { await state.refreshGit() })
    expect(status).toHaveBeenCalledTimes(2)
    // The equal refresh must not replace the snapshot, so consumers keep the
    // exact object they memoized against.
    expect(state.git).toBe(first)
    expect(state.git).not.toBe(second)
  } finally { await act(async () => root.unmount()) }
})

it('replaces the snapshot when a refresh changes the status', async () => {
  const before: GitStatus = {
    isRepo: true,
    branch: 'main',
    files: [{ path: 'a.ts', status: 'M', staged: false, additions: 1, deletions: 0, contentHash: '33188:aa' }],
  }
  const after: GitStatus = { ...before, files: [{ ...before.files[0], additions: 2, contentHash: '33188:bb' }] }
  const status = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after)
  const bridge = { git: { status } } as unknown as DesktopApi
  const scope = createRef<WorkspaceSnapshot>()
  scope.current = { generation: 1, cwd: '/repo' }
  let state!: ReturnType<typeof useGitStatus>
  function Harness() {
    state = useGitStatus({ bridge, cwd: scope.current!.cwd, generation: scope.current!.generation,
      workspaceRef: scope as { current: WorkspaceSnapshot }, initial: { cwd: undefined, status: { isRepo: false, files: [] } }, reportError: vi.fn() })
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => { await state.refreshGit() })
    expect(state.git).toBe(after)
    expect(state.git.files[0]?.contentHash).toBe('33188:bb')
  } finally { await act(async () => root.unmount()) }
})
