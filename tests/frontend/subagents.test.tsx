// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { applySubagentFrame, mergeSubagentMessages } from '../../src/hooks/useSubagents'
import { SubagentsPanel } from '../../src/components/SubagentsPanel'
import { I18nProvider } from '../../src/lib/i18n'
import { useSubagentAttention } from '../../src/hooks/useSubagentAttention'
import type { SubagentView } from '../../src/hooks/useSubagents'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('subagent observability', () => {
  it('bounds retained transcript trees to three recently opened agents', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const agents = Array.from({ length: 6 }, (_, index) => ({ id: String(index), agent: `Agent ${index}`, status: 'completed', messages: [] }))
    try {
      for (const agent of agents) {
        act(() => root.render(<SubagentsPanel connected state={{ agents, selectedId: agent.id, select: vi.fn(), error: undefined }} />))
        expect(host.querySelectorAll('.subagents__page').length).toBeLessThanOrEqual(3)
        expect(host.querySelector('.subagents__page:not([hidden]) h2')?.textContent).toBe(agent.agent)
      }
    } finally { act(() => root.unmount()) }
  })
  it('acknowledges viewed updates, ignores elapsed ticks and marks later completion unread', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const agent: SubagentView = { id: 'a', agent: 'Task', status: 'running', messages: [], progress: { durationMs: 1000 } }
    let unread: Set<string>
    function Harness({ agents, selectedId }: { agents: SubagentView[]; selectedId?: string }) { unread = useSubagentAttention(agents, selectedId); return null }
    try {
      act(() => root.render(<Harness agents={[agent]} />))
      expect([...unread!]).toEqual(['a'])
      act(() => root.render(<Harness agents={[agent]} selectedId="a" />))
      expect(unread!.size).toBe(0)
      act(() => root.render(<Harness agents={[{ ...agent, progress: { durationMs: 2000 } }]} />))
      expect(unread!.size).toBe(0)
      act(() => root.render(<Harness agents={[{ ...agent, status: 'completed' }]} />))
      expect([...unread!]).toEqual(['a'])
    } finally { act(() => root.unmount()) }
  })
  it('retains disclosure state and the mounted transcript when switching agents', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const agents = ['a', 'b'].map((id) => ({ id, agent: id, status: 'completed', messages: [{ role: 'assistant', timestamp: 1, content: [{ type: 'thinking', thinking: `Reasoning ${id}` }] }] }))
    const render = (selectedId: string | undefined) => act(() => root.render(<SubagentsPanel connected state={{ agents, selectedId, select: vi.fn(), error: undefined }} />))
    try {
      render('a')
      const transcript = host.querySelector('.subagents__messages')
      act(() => host.querySelector<HTMLButtonElement>('.work-disclosure__button')!.click())
      render('b')
      render(undefined)
      render('a')
      expect(host.querySelector('.subagents__page:not([hidden]) .subagents__messages')).toBe(transcript)
      expect(host.querySelector('.subagents__page:not([hidden]) .work-disclosure__button')?.getAttribute('aria-expanded')).toBe('true')
    } finally { act(() => root.unmount()) }
  })
  it('switches all new chrome and statuses with the UI language while preserving agent output', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const agent = { id: 'a', agent: 'Explore', status: 'running', messages: [{ role: 'assistant', timestamp: 1, content: [{ type: 'thinking', thinking: 'Original model output' }] }] }
    try {
      for (const [preference, back, running] of [['zh-TW', '主對話', '思考中'], ['zh-CN', '主对话', '思考中'], ['en', 'Conversation', 'Thinking']] as const) {
        act(() => root.render(<I18nProvider preference={preference}><SubagentsPanel connected state={{ agents: [agent], selectedId: 'a', select: vi.fn(), error: undefined }} /></I18nProvider>))
        expect(host.textContent).toContain(back)
        expect(host.textContent).toContain(running)
        if (host.querySelector('.work-disclosure__button')?.getAttribute('aria-expanded') === 'false') act(() => host.querySelector<HTMLButtonElement>('.work-disclosure__button')!.click())
        expect(host.textContent).toContain('Original model output')
      }
    } finally { act(() => root.unmount()) }
  })
  it('keeps parallel agents, progress, thinking and terminal states separate', () => {
    let agents = applySubagentFrame([], { type: 'subagent_lifecycle', payload: { id: 'a', agent: 'Explore', status: 'started' } })
    agents = applySubagentFrame(agents, { type: 'subagent_lifecycle', payload: { id: 'b', agent: 'Reviewer', status: 'started' } })
    agents = applySubagentFrame(agents, { type: 'subagent_progress', payload: { progress: { id: 'a', status: 'running', toolCount: 3 }, task: 'Find code' } })
    agents = applySubagentFrame(agents, { type: 'subagent_event', payload: { id: 'a', event: { type: 'message_update', message: { role: 'assistant', timestamp: 1, content: [{ type: 'thinking', thinking: 'Inspecting files' }] } } } })
    agents = applySubagentFrame(agents, { type: 'subagent_lifecycle', payload: { id: 'a', status: 'completed' } })
    const a = agents.find((agent) => agent.id === 'a')!
    expect(a.status).toBe('completed')
    expect(a.progress?.toolCount).toBe(3)
    expect(a.messages).toHaveLength(1)
    expect(agents.find((agent) => agent.id === 'b')?.status).toBe('running')
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      act(() => root.render(<SubagentsPanel connected state={{ agents, selectedId: 'a', select: vi.fn(), error: undefined }} />))
      act(() => host.querySelector<HTMLButtonElement>('.work-disclosure__button')!.click())
      expect(host.textContent).toContain('Inspecting files')
      expect(host.querySelector('h2')?.textContent).toBe('Explore')
      expect(host.textContent).toContain('Completed')
    } finally { act(() => root.unmount()) }
  })
  it('reconciles durable messages by identity and bounds history', () => {
    const old = { role: 'assistant', timestamp: 1, content: 'partial' }
    const full = { ...old, content: 'complete' }
    expect(mergeSubagentMessages([old], [full, null])).toEqual([full])
    expect(mergeSubagentMessages([], Array.from({ length: 500 }, (_, timestamp) => ({ role: 'assistant', timestamp })))).toHaveLength(400)
    const restarted = applySubagentFrame([{ id: 'a', agent: 'Task', status: 'completed', messages: [old] }], { type: 'subagent_lifecycle', payload: { id: 'a', status: 'started' } })
    expect(restarted[0].messages).toEqual([])
    expect(restarted[0].revision).toBe(1)
  })
})
