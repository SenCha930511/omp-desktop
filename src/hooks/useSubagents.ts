import { useCallback, useEffect, useRef, useState } from 'react'
import { useDocumentVisible } from './useDocumentVisible'
import type { DesktopApi } from '@/types/api'
import { record, string } from '@/lib/events/parse'
import { terminalSubagentPhase } from '@/lib/subagent-status'

export interface SubagentView {
  id: string
  agent: string
  status: string
  revision?: number
  description?: string
  task?: string
  error?: string
  progress?: Record<string, unknown>
  messages: Record<string, unknown>[]
  /** 上游 roster/progress 帶的轉錄檔(SubagentLifecyclePayload/SubagentProgressPayload.sessionFile)。 */
  sessionFile?: string
  /** 「載入更早」補回、比 messages 視窗更舊的訊息;升冪去重,不受 400 視窗上限限制。 */
  history?: Record<string, unknown>[]
  /** true = history 已補齊到 live 位元組邊界;顯示視窗溢出會重新打開缺口(false)。 */
  historyDone?: boolean
}

export type SubagentSubscriptionLevel = 'off' | 'progress' | 'events'

/** 面板狀態介面:測試可以字面物件提供 state,行動函式全部選配。 */
export interface SubagentPanelState {
  agents: SubagentView[]
  selectedId?: string
  select(id?: string): void
  error?: string
  /** 目前訂閱層級;啟動時 runtime 預設要求 'events',僅在 RPC 確認後更新。 */
  subscriptionLevel?: SubagentSubscriptionLevel
  /** 進行中行動的鍵集合:`cancel:<id>`、`steer:<id>`、`history:<id>`、`subscription`。 */
  pendingActions?: ReadonlySet<string>
  /** true = 上游硬殺成功;false = 已不在執行(上游如實回報,不當作取消)。 */
  cancel?(id: string): Promise<boolean>
  steer?(id: string, message: string): Promise<void>
  loadEarlier?(id: string): Promise<void>
  setSubscriptionLevel?(level: SubagentSubscriptionLevel): Promise<void>
}

/** 以 role:timestamp 去重並按時間升冪;不設視窗上限(歷史併接專用)。 */
export function dedupeSubagentMessages(current: Record<string, unknown>[], incoming: unknown[]): Record<string, unknown>[] {
  if (!incoming.length) return current
  const messages = new Map(current.map((message) => [`${message.role}:${message.timestamp}`, message]))
  for (const raw of incoming) {
    const message = record(raw)
    if (message && typeof message.role === 'string' && typeof message.timestamp === 'number') messages.set(`${message.role}:${message.timestamp}`, message)
  }
  return [...messages.values()].sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
}

export function mergeSubagentMessages(current: Record<string, unknown>[], incoming: unknown[]): Record<string, unknown>[] {
  return dedupeSubagentMessages(current, incoming).slice(-400)
}

/** 歷史頁在上(較舊)、live 視窗在下(較新);重疊訊息以 role:timestamp 去重。 */
export function combineSubagentMessages(history: Record<string, unknown>[] | undefined, messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return history?.length ? dedupeSubagentMessages(history, messages) : messages
}

/** 單次「載入更早」最多連續翻頁數;上游每次回應都是 fromByte → 檔尾的完整剩餘,通常一頁收尾。 */
const HISTORY_PAGE_LIMIT = 4

export function applySubagentFrame(current: SubagentView[], frame: Record<string, unknown>): SubagentView[] {
  const payload = record(frame.payload)
  if (!payload) return current
  const progress = record(payload.progress)
  const id = string(payload.id) ?? string(progress?.id)
  if (!id) return current
  const existing = current.find((item) => item.id === id)
  const restarting = existing && frame.type === 'subagent_lifecycle' && payload.status === 'started' && existing.status !== 'running'
  const item: SubagentView = restarting
    ? { id, agent: string(payload.agent) ?? id, status: 'running', messages: [], revision: (existing.revision ?? 0) + 1 }
    : existing ?? { id, agent: string(payload.agent) ?? id, status: 'running', messages: [] }
  const event = record(payload.event)
  const message = record(event?.message)
  const next: SubagentView = {
    ...item,
    agent: string(payload.agent) ?? item.agent,
    description: string(payload.description) ?? string(progress?.description) ?? item.description,
    task: string(payload.task) ?? item.task,
    error: string(payload.error) ?? string(progress?.error) ?? item.error,
    status: string(progress?.status) ?? (payload.status === 'started' ? 'running' : string(payload.status)) ?? item.status,
    progress: progress ?? item.progress,
    sessionFile: string(payload.sessionFile) ?? item.sessionFile,
    messages: message ? mergeSubagentMessages(item.messages, [message]) : item.messages,
  }
  return existing ? current.map((agent) => agent.id === id ? next : agent) : [...current, next].slice(-256)
}

export function useSubagents(bridge: DesktopApi | null, runtimeId?: string, visible = true): SubagentPanelState {
  const [state, setState] = useState<{ owner?: string; agents: SubagentView[]; error?: string }>({ agents: [] })
  const [selectedId, select] = useState<string>()
  const selected = state.agents.find((agent) => agent.id === selectedId)
  const selectedRevision = selected?.revision
  const selectedStatus = selected?.status
  const documentVisible = useDocumentVisible()
  const cursors = useRef(new Map<string, number>())
  const historyPages = useRef(new Map<string, { nextByte: number; done: boolean }>())
  const pendingRef = useRef(new Set<string>())
  const [pendingActions, setPendingActions] = useState<ReadonlySet<string>>(new Set())
  // 啟動時 runtime 已向 OMP 要求 'events'(electron/main/agent-rpc/runtime.ts);
  // 這裡只是顯示預設,實際值一律以 set_subagent_subscription 回應為準。
  const [subscriptionLevel, setSubscriptionLevelState] = useState<SubagentSubscriptionLevel>('events')
  const stateRef = useRef(state)
  const beginAction = useCallback((key: string) => {
    if (pendingRef.current.has(key)) return false
    pendingRef.current.add(key)
    setPendingActions(new Set(pendingRef.current))
    return true
  }, [])
  const endAction = useCallback((key: string) => {
    pendingRef.current.delete(key)
    setPendingActions(new Set(pendingRef.current))
  }, [])
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => {
    cursors.current.clear()
    historyPages.current.clear()
    setState({ owner: runtimeId, agents: [] })
    select(undefined)
    if (!bridge || !runtimeId) return
    let active = true
    const touched = new Set<string>()
    const unsubscribe = bridge.agent.onEvent((envelope) => {
      if (envelope.runtimeId !== runtimeId || !String(envelope.event.type).startsWith('subagent_')) return
      const payload = record(envelope.event.payload)
      const id = string(payload?.id) ?? string(record(payload?.progress)?.id)
      if (id) touched.add(id)
      setState((current) => ({ owner: runtimeId, agents: applySubagentFrame(current.owner === runtimeId ? current.agents : [], envelope.event) }))
    })
    void bridge.agent.command(runtimeId, { type: 'get_subagents' }).then((response) => {
      if (!active) return
      const snapshots = record(response.data)?.subagents
      if (!Array.isArray(snapshots)) throw new Error('OMP returned an invalid subagent roster')
      setState((current) => {
        let agents = current.agents
        for (const raw of snapshots) {
          const snapshot = record(raw)
          if (snapshot && typeof snapshot.id === 'string' && !touched.has(snapshot.id)) agents = applySubagentFrame(agents, { type: 'subagent_lifecycle', payload: snapshot })
        }
        return { owner: runtimeId, agents }
      })
    }).catch((error: unknown) => { if (active) setState((current) => ({ ...current, error: String(error) })) })
    return () => { active = false; unsubscribe() }
  }, [bridge, runtimeId])

  useEffect(() => {
    if (!bridge || !runtimeId || !selectedId || state.owner !== runtimeId || !visible || !documentVisible) return
    let active = true
    const key = `${runtimeId}:${selectedId}:${selectedRevision ?? 0}`
    let cursor = cursors.current.get(key) ?? 0
    let timer: ReturnType<typeof setTimeout>
    let failures = 0
    const read = async () => {
      let succeeded = false
      try {
        const response = await bridge.agent.command(runtimeId, { type: 'get_subagent_messages', subagentId: selectedId, fromByte: cursor })
        if (!active) return
        const data = record(response.data)
        if (!data || !Array.isArray(data.messages) || typeof data.nextByte !== 'number') throw new Error('Invalid subagent transcript')
        cursor = data.nextByte
        cursors.current.set(key, cursor)
        while (cursors.current.size > 256) cursors.current.delete(cursors.current.keys().next().value!)
        const messages = data.messages
        succeeded = true
        failures = 0
        setState((current) => {
          if (current.owner !== runtimeId) return current
          if (!messages.length && data.reset !== true) return current.error ? { ...current, error: undefined } : current
          return { ...current, error: undefined, agents: current.agents.map((agent) => {
            if (agent.id !== selectedId) return agent
            const merged = dedupeSubagentMessages(data.reset === true ? [] : agent.messages, messages)
            if (merged.length <= 400) return { ...agent, messages: merged }
            // 顯示視窗上限 400:被擠出的更舊訊息不落進歷史,改由「載入更早」
            // 以 fromByte 位元組游標從上游轉錄檔補回。溢出 = 歷史不再是完整前綴,
            // 必須重新打開缺口,否則缺口段會永久性無法查閱。
            const entry = historyPages.current.get(key)
            if (entry) entry.done = false
            return { ...agent, messages: merged.slice(-400), historyDone: false }
          }) }
        })
      } catch (error) {
        failures += 1
        if (active) setState((current) => ({ ...current, error: String(error) }))
      }
      const completed = terminalSubagentPhase(selectedStatus ?? '') !== undefined
      if (active && (!completed || (!succeeded && failures < 3))) timer = setTimeout(() => void read(), 1_500 * Math.max(1, failures))
    }
    void read()
    return () => { active = false; clearTimeout(timer) }
  }, [bridge, runtimeId, selectedId, selectedRevision, selectedStatus, state.owner, visible, documentVisible])

  const cancel = useCallback(async (id: string): Promise<boolean> => {
    if (!bridge || !runtimeId) throw new Error('No active session')
    const pendingKey = `cancel:${id}`
    // 已在送出中時絕不重送;取消成功與否之後仍由 subagent_lifecycle 事件收斂,
    // 這裡只在本次呼叫未送出時回 false,表示「這次沒有取消動作」。
    if (!beginAction(pendingKey)) return false
    try {
      const response = await bridge.agent.command(runtimeId, { type: 'cancel_subagent', subagentId: id })
      const data = record(response.data)
      if (!data || typeof data.cancelled !== 'boolean') throw new Error('Invalid cancel_subagent response')
      return data.cancelled
    } finally {
      endAction(pendingKey)
    }
  }, [bridge, runtimeId, beginAction, endAction])

  const steer = useCallback(async (id: string, message: string): Promise<void> => {
    if (!bridge || !runtimeId) throw new Error('No active session')
    const trimmed = message.trim()
    if (!trimmed) throw new Error('Steer message is empty')
    const pendingKey = `steer:${id}`
    if (!beginAction(pendingKey)) return
    try {
      await bridge.agent.command(runtimeId, { type: 'steer_subagent', subagentId: id, message: trimmed })
    } finally {
      endAction(pendingKey)
    }
  }, [bridge, runtimeId, beginAction, endAction])

  const setSubscriptionLevel = useCallback(async (level: SubagentSubscriptionLevel): Promise<void> => {
    if (!bridge || !runtimeId) throw new Error('No active session')
    if (!beginAction('subscription')) return
    try {
      const response = await bridge.agent.command(runtimeId, { type: 'set_subagent_subscription', level })
      const data = record(response.data)
      if (data?.level !== 'off' && data?.level !== 'progress' && data?.level !== 'events') throw new Error('Invalid subscription level response')
      setSubscriptionLevelState(data.level)
    } finally {
      endAction('subscription')
    }
  }, [bridge, runtimeId, beginAction, endAction])

  const loadEarlier = useCallback(async (id: string): Promise<void> => {
    if (!bridge || !runtimeId) throw new Error('No active session')
    const pendingKey = `history:${id}`
    if (!beginAction(pendingKey)) return
    try {
      const agent = stateRef.current.agents.find((item) => item.id === id)
      if (!agent) return
      const key = `${runtimeId}:${id}:${agent.revision ?? 0}`
      let page = historyPages.current.get(key) ?? { nextByte: 0, done: false }
      if (page.done) return
      // 上游 readRpcSubagentTranscript:從 fromByte 讀到最後一個完整行,回 nextByte。
      // live 游標是輪詢已覆蓋的位元組邊界;歷史從 0 起逐頁補到該邊界即完整,
      // 與顯示視窗的重疊段在併接時以 role:timestamp 去重,不會重複也不會亂序。
      const liveBoundary = cursors.current.get(key) ?? 0
      const incoming: unknown[] = []
      for (let pages = 0; pages < HISTORY_PAGE_LIMIT; pages++) {
        const response = await bridge.agent.command(runtimeId, { type: 'get_subagent_messages', subagentId: id, fromByte: page.nextByte })
        const data = record(response.data)
        if (!data || !Array.isArray(data.messages) || typeof data.nextByte !== 'number') throw new Error('Invalid subagent transcript')
        const fromByte = typeof data.fromByte === 'number' ? data.fromByte : page.nextByte
        incoming.push(...data.messages)
        const progressed = data.nextByte > fromByte
        page = { nextByte: Math.max(data.nextByte, page.nextByte), done: !progressed || data.nextByte >= liveBoundary }
        if (page.done) break
      }
      historyPages.current.set(key, page)
      while (historyPages.current.size > 256) historyPages.current.delete(historyPages.current.keys().next().value!)
      setState((current) => {
        if (current.owner !== runtimeId) return current
        return { ...current, agents: current.agents.map((item) => item.id !== id ? item : {
          ...item,
          history: incoming.length ? dedupeSubagentMessages(item.history ?? [], incoming) : item.history,
          historyDone: page.done,
        }) }
      })
    } finally {
      endAction(pendingKey)
    }
  }, [bridge, runtimeId, beginAction, endAction])

  return {
    agents: state.owner === runtimeId ? state.agents : [],
    error: state.owner === runtimeId ? state.error : undefined,
    selectedId,
    select,
    subscriptionLevel,
    pendingActions,
    cancel,
    steer,
    loadEarlier,
    setSubscriptionLevel,
  }
}
