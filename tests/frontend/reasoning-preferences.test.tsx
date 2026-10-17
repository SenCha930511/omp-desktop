// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ReasoningDisclosure, ReasoningExpandedContext } from '../../src/components/ReasoningDisclosure'
import { useProviderCatalog } from '../../src/hooks/useProviderCatalog'
import type { DesktopApi, RuntimeInfo } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('lets users toggle thinking and updates its default when the setting changes', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  const render = (expanded: boolean) => root.render(<ReasoningExpandedContext.Provider value={expanded}><ReasoningDisclosure>Model thinking</ReasoningDisclosure></ReasoningExpandedContext.Provider>)
  try {
    act(() => render(false))
    expect(host.querySelector('details')?.open).toBe(false)
    act(() => host.querySelector('summary')!.click())
    expect(host.querySelector('details')?.open).toBe(true)
    act(() => host.querySelector('summary')!.click())
    expect(host.querySelector('details')?.open).toBe(false)
    act(() => render(true))
    expect(host.querySelector('details')?.open).toBe(true)
  } finally { act(() => root.unmount()) }
})

it('keeps auto selected while OMP reports a concrete effective level', async () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  const command = vi.fn(async () => ({}))
  const model = { key: 'test/reasoner', id: 'reasoner', name: 'Reasoner', provider: 'test', reasoning: true, available: true, enabled: true, input: ['text'], availableThinkingLevels: ['off', 'high'], fastModeSupported: false, contextWindow: 1000, maxTokens: 100 }
  const bridge = { agent: { command }, providers: { catalog: async () => ({ models: [model], providers: [] }) } } as unknown as DesktopApi
  let value: ReturnType<typeof useProviderCatalog>
  const syncRuntime = vi.fn(async () => undefined)
  const reportError = vi.fn()
  const runtime: RuntimeInfo = { runtimeId: 'r', harness: 'omp', cwd: '/test', isStreaming: false, model: { provider: 'test', id: 'reasoner' }, thinkingLevel: 'high', configuredThinkingLevel: 'auto' }
  function Harness({ active }: { active: RuntimeInfo }) {
    value = useProviderCatalog({ bridge, runtime: active, syncRuntime, reportError })
    return <span>{value.effort}</span>
  }
  try {
    await act(async () => root.render(<Harness active={runtime} />))
    expect(value!.reasoningLevels).toEqual(['auto', 'off', 'high'])
    expect(value!.effort).toBe('auto')
    await act(async () => root.render(<Harness active={{ ...runtime, thinkingLevel: 'off' }} />))
    expect(value!.effort).toBe('auto')
    await act(async () => { value!.changeEffort('auto') })
    expect(command).toHaveBeenCalledWith('r', { type: 'set_thinking_level', level: 'auto' })
  } finally { await act(async () => root.unmount()) }
})
