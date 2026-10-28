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
      for (const [preference, back, running] of [['zh-TW', '子代理', '思考中'], ['zh-CN', '子代理', '思考中'], ['en', 'Subagents', 'Thinking']] as const) {
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

describe('subagent control and history UI', () => {
  function renderPanel(state: Parameters<typeof SubagentsPanel>[0]['state'], host = document.createElement('div')) {
    const root = createRoot(host)
    act(() => root.render(<SubagentsPanel connected pinned state={state} />))
    return { host, root }
  }

  it('shows a cancel button only for running roster entries and reports a not-running reply', async () => {
    const cancel = vi.fn(async () => false)
    const agents: SubagentView[] = [
      { id: 'a', agent: 'Runner', status: 'running', messages: [] },
      { id: 'b', agent: 'Done', status: 'completed', messages: [] },
    ]
    const { host, root } = renderPanel({ agents, selectedId: undefined, select: vi.fn(), error: undefined, cancel, pendingActions: new Set() })
    try {
      const cancelButtons = host.querySelectorAll('button.subagents__cancel')
      expect(cancelButtons).toHaveLength(1)
      expect(cancelButtons[0].getAttribute('aria-label')).toBe('Stop Runner')
      await act(async () => { (cancelButtons[0] as HTMLButtonElement).click() })
      expect(cancel).toHaveBeenCalledWith('a')
      expect(host.textContent).toContain('no longer running')
    } finally { act(() => root.unmount()) }
  })

  it('disables the cancel button while a cancel for that agent is in flight', () => {
    const agents: SubagentView[] = [{ id: 'a', agent: 'Runner', status: 'running', messages: [] }]
    const { host, root } = renderPanel({ agents, selectedId: undefined, select: vi.fn(), error: undefined, cancel: vi.fn(), pendingActions: new Set(['cancel:a']) })
    try {
      const button = host.querySelector<HTMLButtonElement>('button.subagents__cancel')!
      expect(button.disabled).toBe(true)
      expect(button.getAttribute('aria-label')).toBe('Stopping Runner…')
    } finally { act(() => root.unmount()) }
  })

  it('blocks the cancel path from opening a selector for finished agents', () => {
    const agents: SubagentView[] = [{ id: 'a', agent: 'Done', status: 'failed', messages: [] }]
    const { host, root } = renderPanel({ agents, selectedId: undefined, select: vi.fn(), error: undefined, cancel: vi.fn(), pendingActions: new Set() })
    try {
      expect(host.querySelectorAll('button.subagents__cancel')).toHaveLength(0)
    } finally { act(() => root.unmount()) }
  })

  it('sends a steering message for a running agent and shows the upstream failure unchanged', async () => {
    const steer = vi.fn(async () => { throw new Error('subagent is not running') })
    const agents: SubagentView[] = [{ id: 'a', agent: 'Runner', status: 'running', messages: [] }]
    const { host, root } = renderPanel({ agents, selectedId: 'a', select: vi.fn(), error: undefined, steer, pendingActions: new Set() })
    try {
      const form = host.querySelector<HTMLFormElement>('.subagents__steer')!
      const input = form.querySelector('input')!
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '  steer here  ')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
      expect(steer).toHaveBeenCalledWith('a', 'steer here')
      expect(form.querySelector('.subagents__steer-error')?.textContent).toBe('subagent is not running')
      // 失敗不清空草稿,讓使用者可以修正後重送(草稿保留原始空白)
      expect(input.value).toBe('  steer here  ')
      // 收斂後不再提供導引輸入
      act(() => root.render(<SubagentsPanel connected pinned state={{ agents: [{ id: 'a', agent: 'Runner', status: 'completed', messages: [] }], selectedId: 'a', select: vi.fn(), error: undefined, steer, pendingActions: new Set() }} />))
      expect(host.querySelector('.subagents__steer')).toBeNull()
    } finally { act(() => root.unmount()) }
  })

  it('clears the steer draft after the message was accepted', async () => {
    const steer = vi.fn(async () => undefined)
    const agents: SubagentView[] = [{ id: 'a', agent: 'Runner', status: 'running', messages: [] }]
    const { host, root } = renderPanel({ agents, selectedId: 'a', select: vi.fn(), error: undefined, steer, pendingActions: new Set() })
    try {
      const form = host.querySelector<HTMLFormElement>('.subagents__steer')!
      const input = form.querySelector('input')!
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'focus the parser')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
      expect(steer).toHaveBeenCalledWith('a', 'focus the parser')
      expect(input.value).toBe('')
    } finally { act(() => root.unmount()) }
  })

  it('offers loading earlier history until the cursor is complete and shows the failure unchanged', async () => {
    const loadEarlier = vi.fn(async () => { throw new Error('transcript unavailable') })
    const messages = [{ role: 'assistant', timestamp: 7, content: [{ type: 'text', text: 'done' }] }]
    const agents: SubagentView[] = [{ id: 'a', agent: 'Worker', status: 'completed', messages, history: [{ role: 'user', timestamp: 1, content: [{ type: 'text', text: 'start' }] }] }]
    const { host, root } = renderPanel({ agents, selectedId: 'a', select: vi.fn(), error: undefined, loadEarlier, pendingActions: new Set() })
    try {
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === 'Load earlier messages')!
      await act(async () => { button.click() })
      expect(loadEarlier).toHaveBeenCalledWith('a')
      expect(host.textContent).toContain('transcript unavailable')
      // 歷史補齊後按鈕消失
      act(() => root.render(<SubagentsPanel connected pinned state={{ agents: [{ ...agents[0], historyDone: true }], selectedId: 'a', select: vi.fn(), error: undefined, loadEarlier, pendingActions: new Set() }} />))
      expect([...host.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === 'Load earlier messages')).toBeUndefined()
    } finally { act(() => root.unmount()) }
  })

  it('switches the live subscription level through the roster control', async () => {
    const setSubscriptionLevel = vi.fn(async () => undefined)
    const agents: SubagentView[] = [{ id: 'a', agent: 'Worker', status: 'running', messages: [] }]
    const { host, root } = renderPanel({ agents, selectedId: undefined, select: vi.fn(), error: undefined, setSubscriptionLevel, pendingActions: new Set(), subscriptionLevel: 'events' })
    try {
      const select = [...host.querySelectorAll('select')].find((candidate) => candidate.getAttribute('aria-label') === 'Agent update level')!
      expect((select as HTMLSelectElement).value).toBe('events')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'progress')
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(setSubscriptionLevel).toHaveBeenCalledWith('progress')
    } finally { act(() => root.unmount()) }
  })
})

  it('closes the split-view pane through its header control', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const select = vi.fn()
    const agent: SubagentView = { id: 'a', agent: 'Explore', status: 'running', messages: [] }
    try {
      act(() => root.render(<I18nProvider preference="en"><SubagentsPanel connected state={{ agents: [agent], selectedId: 'a', select, error: undefined }} /></I18nProvider>))
      const close = host.querySelector<HTMLButtonElement>('.subagents__pane-close')
      expect(close).not.toBeNull()
      expect(close?.getAttribute('aria-label')).toBe('Close agent transcript')
      await act(async () => close!.click())
      expect(select).toHaveBeenCalledWith(undefined)
    } finally { act(() => root.unmount()) }
  })
