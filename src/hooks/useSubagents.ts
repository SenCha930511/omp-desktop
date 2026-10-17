import { useEffect, useState } from 'react'
import type { DesktopApi } from '@/types/api'
import { record, string } from '@/lib/events/parse'

export interface SubagentView {
  id: string
  agent: string
  status: string
  revision?: number
  description?: string
  task?: string
  progress?: Record<string, unknown>
  messages: Record<string, unknown>[]
}

export function mergeSubagentMessages(current: Record<string, unknown>[], incoming: unknown[]): Record<string, unknown>[] {
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
    status: string(progress?.status) ?? (payload.status === 'started' ? 'running' : string(payload.status)) ?? item.status,
    progress: progress ?? item.progress,
    messages: message ? mergeSubagentMessages(item.messages, [message]) : item.messages,
  }
  return existing ? current.map((agent) => agent.id === id ? next : agent) : [...current, next].slice(-256)
}

export function useSubagents(bridge: DesktopApi | null, runtimeId?: string) {
  const [state, setState] = useState<{ owner?: string; agents: SubagentView[]; error?: string }>({ agents: [] })
  const [selectedId, select] = useState<string>()
  const selectedRevision = state.agents.find((agent) => agent.id === selectedId)?.revision
  useEffect(() => {
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
    if (!bridge || !runtimeId || !selectedId || state.owner !== runtimeId) return
    let active = true
    let cursor = 0
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const response = await bridge.agent.command(runtimeId, { type: 'get_subagent_messages', subagentId: selectedId, fromByte: cursor })
        if (!active) return
        const data = record(response.data)
        if (!data || !Array.isArray(data.messages) || typeof data.nextByte !== 'number') throw new Error('Invalid subagent transcript')
        cursor = data.nextByte
        const messages = data.messages
        setState((current) => current.owner !== runtimeId ? current : ({ ...current, error: undefined, agents: current.agents.map((agent) => agent.id !== selectedId ? agent : {
          ...agent, messages: mergeSubagentMessages(data.reset === true ? [] : agent.messages, messages),
        }) }))
      } catch (error) {
        if (active) setState((current) => ({ ...current, error: String(error) }))
      }
      if (active) timer = setTimeout(() => void read(), 1_500)
    }
    void read()
    return () => { active = false; clearTimeout(timer) }
  }, [bridge, runtimeId, selectedId, selectedRevision, state.owner])
  return { agents: state.owner === runtimeId ? state.agents : [], error: state.owner === runtimeId ? state.error : undefined, selectedId, select }
}
