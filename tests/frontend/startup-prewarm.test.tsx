// @vitest-environment jsdom

import { StrictMode, type ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useStartupPrewarm } from '../../src/hooks/useStartupPrewarm'
import type { DesktopApi, RuntimeInfo, SessionRecord } from '../../src/types/api'

const session = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 'session-1',
  harness: 'omp',
  filePath: '/repo/session-1.jsonl',
  projectPath: '/repo',
  title: 'Session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
  ...overrides,
})

const runtime = (overrides: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  runtimeId: 'runtime-1',
  harness: 'omp',
  cwd: '/repo',
  sessionFile: '/repo/session-1.jsonl',
  isStreaming: false,
  ...overrides,
})

function makeBridge(start: Mock<DesktopApi['agent']['start']> = vi.fn<DesktopApi['agent']['start']>(async () => runtime())) {
  const bridge = { agent: { start } } as unknown as DesktopApi
  return { bridge, start }
}

interface ProbeProps {
  bridge: DesktopApi | null
  initialized: boolean
  harness?: 'omp'
  session?: SessionRecord
  cwd?: string
  projectInferred?: boolean
  attachedRuntime?: RuntimeInfo
}

function Probe({ bridge, initialized, harness = 'omp', session: activeSession, cwd, projectInferred, attachedRuntime }: ProbeProps) {
  useStartupPrewarm({ bridge, initialized, harness, session: activeSession, cwd, projectInferred, attachedRuntime })
  return null
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function render(node: ReactNode) {
  await act(async () => { root.render(node) })
}

describe('startup prewarm', () => {
  it('starts exactly one launch for the bootstrap session and sends no selection', async () => {
    const { bridge, start } = makeBridge()
    await render(<Probe bridge={bridge} initialized session={session()} cwd="/repo" />)

    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith({ cwd: '/repo', sessionPath: '/repo/session-1.jsonl', harness: 'omp' })
    expect(Object.keys(start.mock.calls[0]![0])).toEqual(['cwd', 'sessionPath', 'harness'])
  })

  it('does not start before bootstrap reports initialized', async () => {
    const { bridge, start } = makeBridge()
    await render(<Probe bridge={bridge} initialized={false} session={session()} cwd="/repo" />)
    expect(start).not.toHaveBeenCalled()

    await render(<Probe bridge={bridge} initialized session={session()} cwd="/repo" />)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('never prewarms a second session once latched', async () => {
    const { bridge, start } = makeBridge()
    await render(<Probe bridge={bridge} initialized session={session()} cwd="/repo" />)
    await render(<Probe bridge={bridge} initialized session={session({ id: 'session-2', filePath: '/repo/session-2.jsonl' })} cwd="/repo" />)

    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]![0]).toMatchObject({ sessionPath: '/repo/session-1.jsonl' })
  })

  it('latches a draft session and never warms a session that appears later', async () => {
    const { bridge, start } = makeBridge()
    await render(<Probe bridge={bridge} initialized session={session({ filePath: undefined })} cwd="/repo" />)
    expect(start).not.toHaveBeenCalled()

    await render(<Probe bridge={bridge} initialized session={session()} cwd="/repo" />)
    expect(start).not.toHaveBeenCalled()
  })

  it.each([['running'], ['waiting']] as const)('skips a session whose status is %s', async (status) => {
    const { bridge, start } = makeBridge()
    await render(<Probe bridge={bridge} initialized session={session({ status })} cwd="/repo" />)
    expect(start).not.toHaveBeenCalled()
  })

  it('skips an inferred project, a missing cwd, and a missing bridge', async () => {
    const inferred = makeBridge()
    await render(<Probe bridge={inferred.bridge} initialized projectInferred session={session()} cwd="/repo" />)
    expect(inferred.start).not.toHaveBeenCalled()

    const noCwd = makeBridge()
    await render(<Probe bridge={noCwd.bridge} initialized session={session()} cwd={undefined} />)
    expect(noCwd.start).not.toHaveBeenCalled()

    const noBridge = makeBridge()
    await render(<Probe bridge={null} initialized session={session()} cwd="/repo" />)
    expect(noBridge.start).not.toHaveBeenCalled()
  })

  it('skips when a runtime is already attached for the same session', async () => {
    const { bridge, start } = makeBridge()
    await render(<Probe bridge={bridge} initialized session={session()} cwd="/repo" attachedRuntime={runtime()} />)
    expect(start).not.toHaveBeenCalled()
  })

  it('prewarms when the attached runtime belongs to a different session', async () => {
    const { bridge, start } = makeBridge()
    await render(<Probe bridge={bridge} initialized session={session()} cwd="/repo" attachedRuntime={runtime({ sessionFile: '/repo/other.jsonl' })} />)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('swallows a rejected launch so startup continues on the on-demand path', async () => {
    const start = vi.fn<DesktopApi['agent']['start']>(async () => { throw new Error('omp is not installed') })
    const { bridge } = makeBridge(start)
    const errors: unknown[] = []
    const onUnhandled = (reason: unknown) => errors.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      await render(<Probe bridge={bridge} initialized session={session()} cwd="/repo" />)
      await act(async () => { await Promise.resolve() })
      await act(async () => { await Promise.resolve() })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(start).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
  })

  it('issues at most one launch under StrictMode double effects', async () => {
    const { bridge, start } = makeBridge()
    await render(
      <StrictMode>
        <Probe bridge={bridge} initialized session={session()} cwd="/repo" />
      </StrictMode>,
    )

    expect(start).toHaveBeenCalledTimes(1)
  })
})
