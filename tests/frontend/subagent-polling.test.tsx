// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useSubagents } from '../../src/hooks/useSubagents'
import type { DesktopApi } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('pauses hidden reads, resumes from its cursor and drains completion once', async () => {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let event: Parameters<DesktopApi['agent']['onEvent']>[0] = () => undefined
  const command = vi.fn(async (_runtime: string, value: Record<string, unknown>) => value.type === 'get_subagents'
    ? { data: { subagents: [{ id: 'a', agent: 'Task', status: 'running' }] } }
    : { data: { messages: [], nextByte: Number(value.fromByte) + 10 } })
  const bridge = { agent: { command, onEvent: (callback: typeof event) => { event = callback; return () => undefined } } } as unknown as DesktopApi
  let state: ReturnType<typeof useSubagents>
  function Harness() { state = useSubagents(bridge, 'r'); return null }
  const root = createRoot(document.createElement('div'))
  const reads = () => command.mock.calls.filter(([, value]) => value.type === 'get_subagent_messages')
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => state.select('a'))
    expect(reads()).toHaveLength(1)
    await act(async () => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => vi.advanceTimersByTime(6_000))
    expect(reads()).toHaveLength(1)
    await act(async () => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) })
    expect(reads().at(-1)?.[1].fromByte).toBe(10)
    command.mockRejectedValueOnce(new Error('Temporary read failure'))
    await act(async () => event({ runtimeId: 'r', event: { type: 'subagent_lifecycle', payload: { id: 'a', status: 'completed' } } }))
    expect(reads().at(-1)?.[1].fromByte).toBe(20)
    await act(async () => vi.advanceTimersByTime(1_500))
    expect(reads().at(-1)?.[1].fromByte).toBe(20)
    const finalReads = reads().length
    await act(async () => vi.advanceTimersByTime(6_000))
    expect(reads()).toHaveLength(finalReads)
  } finally { await act(async () => root.unmount()) }
})
