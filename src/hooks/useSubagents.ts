import { useEffect, useRef, useState } from 'react'
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
}

export function mergeSubagentMessages(current: Record<string, unknown>[], incoming: unknown[]): Record<string, unknown>[] {
  if (!incoming.length) return current
  const messages = new Map(current.map((message) => [`${message.role}:${message.timestamp}`, message]))
  for (const raw of incoming) {
    const message = record(raw)
    if (message && typeof message.role === 'string' && typeof message.timestamp === 'number') messages.set(`${message.role}:${message.timestamp}`, message)
  }
  return [...messages.values()].sort((a, b) => Number(a.timestamp) - Number(b.timestamp)).slice(-400)
}

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
    messages: message ? mergeSubagentMessages(item.messages, [message]) : item.messages,
  }
  return existing ? current.map((agent) => agent.id === id ? next : agent) : [...current, next].slice(-256)
}

export function useSubagents(bridge: DesktopApi | null, runtimeId?: string, visible = true) {
  const [state, setState] = useState<{ owner?: string; agents: SubagentView[]; error?: string }>({ agents: [] })
  const [selectedId, select] = useState<string>()
  const selected = state.agents.find((agent) => agent.id === selectedId)
  const selectedRevision = selected?.revision
  const selectedStatus = selected?.status
  const documentVisible = useDocumentVisible()
  const cursors = useRef(new Map<string, number>())
  useEffect(() => {
    cursors.current.clear()
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
          return { ...current, error: undefined, agents: current.agents.map((agent) => agent.id !== selectedId ? agent : {
            ...agent, messages: mergeSubagentMessages(data.reset === true ? [] : agent.messages, messages),
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
  return { agents: state.owner === runtimeId ? state.agents : [], error: state.owner === runtimeId ? state.error : undefined, selectedId, select }
}
