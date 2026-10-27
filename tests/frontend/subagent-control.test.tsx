// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { combineSubagentMessages, useSubagents } from '../../src/hooks/useSubagents'
import type { DesktopApi } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function makeBridge(command: (runtimeId: string, value: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  let event: Parameters<DesktopApi['agent']['onEvent']>[0] = () => undefined
  const bridge = {
    agent: {
      command: vi.fn(command),
      onEvent: (callback: typeof event) => { event = callback; return () => undefined },
    },
  } as unknown as DesktopApi & { agent: { command: ReturnType<typeof vi.fn> } }
  return { bridge, emit: (envelope: Parameters<typeof event>[0]) => event(envelope) }
}

function renderHook(bridge: DesktopApi) {
  let state: ReturnType<typeof useSubagents>
  function Harness() { state = useSubagents(bridge, 'r'); return null }
  const root = createRoot(document.createElement('div'))
  return {
    root,
    state: () => state!,
    async mount() { await act(async () => root.render(<Harness />)) },
    async unmount() { await act(async () => root.unmount()) },
  }
}

const callsOf = (bridge: { agent: { command: ReturnType<typeof vi.fn> } }, type: string) =>
  bridge.agent.command.mock.calls.filter(([, value]) => value.type === type)

describe('subagent cancel/steer actions', () => {
  it('sends cancel_subagent once with the right payload, guards double-clicks and reports not-running', async () => {
    let resolveCancel!: (response: Record<string, unknown>) => void
    let cancelCalls = 0
    const { bridge } = makeBridge(async (_runtime, value) => {
      if (value.type === 'cancel_subagent') {
        cancelCalls += 1
        if (cancelCalls === 1) return new Promise((resolve) => { resolveCancel = resolve })
        return { data: { cancelled: false } }
      }
      if (value.type === 'get_subagents') return { data: { subagents: [] } }
      return { data: {} }
    })
    const { state, mount, unmount } = renderHook(bridge)
    try {
      await mount()
      let cancelled!: Promise<boolean>
      act(() => { cancelled = state().cancel!('worker-a') })
      await act(async () => undefined)
      expect(callsOf(bridge, 'cancel_subagent')).toEqual([['r', { type: 'cancel_subagent', subagentId: 'worker-a' }]])
      expect([...state().pendingActions!]).toContain('cancel:worker-a')
      // 重複點擊:不重送,本次呼叫不算取消
      let duplicate!: Promise<boolean>
      await act(async () => { duplicate = state().cancel!('worker-a') })
      await expect(duplicate).resolves.toBe(false)
      expect(callsOf(bridge, 'cancel_subagent')).toHaveLength(1)
      await act(async () => { resolveCancel({ data: { cancelled: true } }) })
      await expect(cancelled).resolves.toBe(true)
      expect([...state().pendingActions!]).toHaveLength(0)
      // 已收斂的子代理:上游如實回報 false,不能當作取消成功
      let notRunning!: Promise<boolean>
      await act(async () => { notRunning = state().cancel!('worker-a') })
      await expect(notRunning).resolves.toBe(false)
      expect(callsOf(bridge, 'cancel_subagent')).toHaveLength(2)
      // RPC 失敗要往上層傳(由呼叫端顯示錯誤)
      bridge.agent.command.mockRejectedValueOnce(new Error('Subagent event bus is unavailable'))
      await expect(state().cancel!('worker-a')).rejects.toThrow('Subagent event bus is unavailable')
    } finally {
      await unmount()
    }
  })

  it('sends steer_subagent with a trimmed message, guards double-clicks and rejects empty input', async () => {
    let resolveSteer!: (response: Record<string, unknown>) => void
    const { bridge } = makeBridge(async (_runtime, value) => {
      if (value.type === 'steer_subagent') return new Promise((resolve) => { resolveSteer = resolve })
      if (value.type === 'get_subagents') return { data: { subagents: [] } }
      return { data: {} }
    })
    const { state, mount, unmount } = renderHook(bridge)
    try {
      await mount()
      await expect(state().steer!('worker-a', '   ')).rejects.toThrow('Steer message is empty')
      expect(callsOf(bridge, 'steer_subagent')).toHaveLength(0)
      let steered!: Promise<void>
      act(() => { steered = state().steer!('worker-a', '  focus on the parser  ') })
      await act(async () => undefined)
      expect(callsOf(bridge, 'steer_subagent')).toEqual([['r', { type: 'steer_subagent', subagentId: 'worker-a', message: 'focus on the parser' }]])
      expect([...state().pendingActions!]).toContain('steer:worker-a')
      let duplicate!: Promise<void>
      await act(async () => { duplicate = state().steer!('worker-a', 'again') })
      await duplicate
      expect(callsOf(bridge, 'steer_subagent')).toHaveLength(1)
      await act(async () => { resolveSteer({ data: {} }) })
      await steered
      expect([...state().pendingActions!]).toHaveLength(0)
      bridge.agent.command.mockRejectedValueOnce(new Error('subagent is not running'))
      await expect(state().steer!('worker-a', 'hello')).rejects.toThrow('subagent is not running')
    } finally {
      await unmount()
    }
  })

  it('confirms subscription levels through the RPC response before updating', async () => {
    const { bridge } = makeBridge(async (_runtime, value) => {
      if (value.type === 'set_subagent_subscription') return { data: { level: value.level } }
      if (value.type === 'get_subagents') return { data: { subagents: [] } }
      return { data: {} }
    })
    const { state, mount, unmount } = renderHook(bridge)
    try {
      await mount()
      expect(state().subscriptionLevel).toBe('events')
      await act(async () => { await state().setSubscriptionLevel!('progress') })
      expect(callsOf(bridge, 'set_subagent_subscription')).toEqual([['r', { type: 'set_subagent_subscription', level: 'progress' }]])
      expect(state().subscriptionLevel).toBe('progress')
      bridge.agent.command.mockRejectedValueOnce(new Error('boom'))
      await act(async () => { await expect(state().setSubscriptionLevel!('off')).rejects.toThrow('boom') })
      expect(state().subscriptionLevel).toBe('progress')
    } finally {
      await unmount()
    }
  })
})

describe('subagent transcript history cursor', () => {
  it('pages earlier history with fromByte cursors and splices it before the live tail without duplicates', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const live = Array.from({ length: 500 }, (_, index) => ({ role: 'assistant', timestamp: index, content: `m${index}` }))
    let zeroByteReads = 0
    const { bridge } = makeBridge(async (_runtime, value) => {
      if (value.type === 'get_subagents') return { data: { subagents: [{ id: 'a', agent: 'Task', status: 'running' }] } }
      if (value.type === 'get_subagent_messages') {
        const fromByte = Number(value.fromByte)
        if (fromByte === 0) {
          zeroByteReads += 1
          // 第一次是 live 輪詢(從 0 讀全量);之後的 0-起始讀是「載入更早」的第一頁
          if (zeroByteReads === 1) return { data: { messages: live, nextByte: 1000, fromByte: 0 } }
          return { data: { messages: live.slice(0, 300), nextByte: 300, fromByte: 0 } }
        }
        if (fromByte === 300) return { data: { messages: live.slice(300), nextByte: 1000, fromByte: 300 } }
        return { data: { messages: [], nextByte: 1000, fromByte } }
      }
      return { data: {} }
    })
    const { state, mount, unmount } = renderHook(bridge)
    try {
      await mount()
      await act(async () => { state().select('a') })
      const windowed = state().agents.find((agent) => agent.id === 'a')!
      // 顯示視窗保留最後 400 則;較舊的 100 則被擠出但可回溯
      expect(windowed.messages).toHaveLength(400)
      expect(windowed.messages[0].timestamp).toBe(100)
      expect(windowed.history ?? []).toHaveLength(0)
      await act(async () => { await state().loadEarlier!('a') })
      const agent = state().agents.find((item) => item.id === 'a')!
      expect(agent.historyDone).toBe(true)
      // 歷史從 0 起逐頁補到 live 位元組邊界(300 → 1000),訊息不受 400 上限限制
      expect(agent.history).toHaveLength(500)
      expect(agent.history![0].timestamp).toBe(0)
      const reads = callsOf(bridge, 'get_subagent_messages').map(([, value]) => Number(value.fromByte))
      expect(reads).toEqual([0, 0, 300])
      // 歷史頁(較舊)在上、live 視窗(較新)在下,重疊段去重且維持時間升冪
      const combined = combineSubagentMessages(agent.history, agent.messages)
      expect(combined).toHaveLength(500)
      for (let index = 0; index < 500; index += 1) expect(combined[index].timestamp).toBe(index)
      // 完成後再次點擊不重送
      await act(async () => { await state().loadEarlier!('a') })
      expect(callsOf(bridge, 'get_subagent_messages')).toHaveLength(3)
    } finally {
      await unmount()
    }
  })

  it('keeps history loadable for finished subagents via the remembered transcript file', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const initial = Array.from({ length: 420 }, (_, index) => ({ role: 'assistant', timestamp: index, content: `m${index}` }))
    const { bridge, emit } = makeBridge(async (_runtime, value) => {
      if (value.type === 'get_subagents') return { data: { subagents: [{ id: 'a', agent: 'Task', status: 'running' }] } }
      if (value.type === 'get_subagent_messages') {
        const fromByte = Number(value.fromByte)
        if (fromByte === 0) return { data: { messages: initial, nextByte: 500, fromByte: 0 } }
        return { data: { messages: [], nextByte: 500, fromByte } }
      }
      return { data: {} }
    })
    const { state, mount, unmount } = renderHook(bridge)
    try {
      await mount()
      await act(async () => { state().select('a') })
      let agent = state().agents.find((item) => item.id === 'a')!
      expect(agent.messages).toHaveLength(400)
      // 子代理完成後仍可回溯歷史(上游以記住的 session file 解析 id)
      await act(async () => emit({ runtimeId: 'r', event: { type: 'subagent_lifecycle', payload: { id: 'a', status: 'completed', sessionFile: '/tmp/a.jsonl' } } }))
      agent = state().agents.find((item) => item.id === 'a')!
      expect(agent.status).toBe('completed')
      expect(agent.sessionFile).toBe('/tmp/a.jsonl')
      await act(async () => { await state().loadEarlier!('a') })
      agent = state().agents.find((item) => item.id === 'a')!
      expect(agent.historyDone).toBe(true)
      expect(agent.history![0].timestamp).toBe(0)
      expect(combineSubagentMessages(agent.history, agent.messages)).toHaveLength(420)
    } finally {
      await unmount()
    }
  })
})
