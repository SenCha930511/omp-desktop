// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ReasoningDisclosure, ReasoningExpandedContext } from '../../src/components/ReasoningDisclosure'
import { SearchRevealContext } from '../../src/components/TranscriptSearch'
import { type ProviderCatalog, useProviderCatalog } from '../../src/hooks/useProviderCatalog'
import type { DesktopApi, RuntimeInfo } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('mounts expensive reasoning only when expanded or revealed by search', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  const body = vi.fn(() => <p>Expensive reasoning</p>)
  const render = (reveal: boolean) => root.render(<SearchRevealContext.Provider value={reveal}><ReasoningDisclosure>{bodyElement()}</ReasoningDisclosure></SearchRevealContext.Provider>)
  function bodyElement() { const Body = body; return <Body /> }
  try {
    act(() => render(false))
    expect(body).not.toHaveBeenCalled()
    act(() => host.querySelector('summary')!.click())
    expect(host.textContent).toContain('Expensive reasoning')
    act(() => host.querySelector('summary')!.click())
    expect(host.querySelector('p')).toBeNull()
    act(() => render(true))
    expect(host.querySelector('details')?.open).toBe(true)
    expect(host.textContent).toContain('Expensive reasoning')
    act(() => render(false))
    expect(host.querySelector('p')).toBeNull()
  } finally { act(() => root.unmount()) }
})

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
  let value: ProviderCatalog
  const syncRuntime = vi.fn(async () => undefined)
  const reportError = vi.fn()
  const runtime: RuntimeInfo = { runtimeId: 'r', harness: 'omp', cwd: '/test', isStreaming: false, model: { provider: 'test', id: 'reasoner' }, thinkingLevel: 'high', configuredThinkingLevel: 'auto', autoThinkingResolved: true }
  function Harness({ active }: { active: RuntimeInfo }) {
    value = useProviderCatalog({ bridge, runtime: active, syncRuntime, reportError })
    return <span>{value.effort}</span>
  }
  try {
    await act(async () => root.render(<Harness active={runtime} />))
    expect(value!.reasoningLevels).toEqual(['auto', 'off', 'high'])
    expect(value!.effort).toBe('auto')
    // The chip display flips to the concrete level while selection stays auto.
    expect(value!.resolvedAutoEffort).toBe('high')
    await act(async () => root.render(<Harness active={{ ...runtime, thinkingLevel: 'off' }} />))
    expect(value!.effort).toBe('auto')
    expect(value!.resolvedAutoEffort).toBe('off')
    await act(async () => root.render(<Harness active={{ ...runtime, thinkingLevel: 'auto' }} />))
    expect(value!.resolvedAutoEffort).toBeUndefined()
    await act(async () => { value!.changeEffort('auto') })
    expect(command).toHaveBeenCalledWith('r', { type: 'set_thinking_level', level: 'auto' })
  } finally { await act(async () => root.unmount()) }
})

it('shows plain auto while the runtime has not resolved the auto level yet', async () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  const model = { key: 'test/reasoner', id: 'reasoner', name: 'Reasoner', provider: 'test', reasoning: true, available: true, enabled: true, input: ['text'], availableThinkingLevels: ['off', 'high'], fastModeSupported: false, contextWindow: 1000, maxTokens: 100 }
  const bridge = { agent: { command: vi.fn(async () => ({})) }, providers: { catalog: async () => ({ models: [model], providers: [] }) } } as unknown as DesktopApi
  let value: ProviderCatalog
  const syncRuntime = vi.fn(async () => undefined)
  const reportError = vi.fn()
  // A concrete persisted level without resolution evidence must not leak into the chip.
  const runtime: RuntimeInfo = { runtimeId: 'r', harness: 'omp', cwd: '/test', isStreaming: false, model: { provider: 'test', id: 'reasoner' }, thinkingLevel: 'high', configuredThinkingLevel: 'auto' }
  function Harness({ active }: { active: RuntimeInfo }) {
    value = useProviderCatalog({ bridge, runtime: active, syncRuntime, reportError })
    return <span>{value.effort}</span>
  }
  try {
    await act(async () => root.render(<Harness active={runtime} />))
    expect(value!.effort).toBe('auto')
    expect(value!.resolvedAutoEffort).toBeUndefined()
  } finally { await act(async () => root.unmount()) }
})

it('opens sessions without a saved level at the configured default effort', async () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  const model = { key: 'test/reasoner', id: 'reasoner', name: 'Reasoner', provider: 'test', reasoning: true, available: true, enabled: true, input: ['text'], availableThinkingLevels: ['off', 'low', 'high'], fastModeSupported: false, contextWindow: 1000, maxTokens: 100 }
  const bridge = { providers: { catalog: async () => ({ models: [model], providers: [] }) } } as unknown as DesktopApi
  const syncRuntime = vi.fn(async () => undefined)
  const reportError = vi.fn()
  const sessions: Record<string, { id: string }> = {}
  let value: ProviderCatalog
  function Harness({ sessionId }: { sessionId: string }) {
    sessions[sessionId] ??= { id: sessionId }
    value = useProviderCatalog({ bridge, runtime: null, defaultEffort: 'high', activeSession: sessions[sessionId] as never, syncRuntime, reportError })
    return <span>{value.effort}</span>
  }
  try {
    await act(async () => root.render(<Harness sessionId="first" />))
    expect(value!.effort).toBe('high')
    // Switching tabs again without a saved level re-applies the default even
    // after the user overrode it mid-stream on the previous tab.
    await act(async () => { value!.changeEffort('off') })
    expect(value!.effort).toBe('off')
    await act(async () => root.render(<Harness sessionId="second" />))
    expect(value!.effort).toBe('high')
  } finally { await act(async () => root.unmount()) }
})
