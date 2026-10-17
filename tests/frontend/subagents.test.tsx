// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { applySubagentFrame, mergeSubagentMessages } from '../../src/hooks/useSubagents'
import { SubagentsPanel } from '../../src/components/SubagentsPanel'
import { I18nProvider } from '../../src/lib/i18n'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('subagent observability', () => {
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
