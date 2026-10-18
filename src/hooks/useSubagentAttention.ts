import { useEffect, useState } from 'react'
import type { SubagentView } from './useSubagents'

function snapshot(agent: SubagentView) {
  return { revision: agent.revision, status: agent.status, message: agent.messages.at(-1), count: agent.messages.length, tool: agent.progress?.currentTool, tools: agent.progress?.toolCount, requests: agent.progress?.requests }
}
type AttentionSnapshot = ReturnType<typeof snapshot>
function same(a: AttentionSnapshot | undefined, b: AttentionSnapshot): boolean {
  return Boolean(a && a.revision === b.revision && a.status === b.status && a.message === b.message && a.count === b.count && a.tool === b.tool && a.tools === b.tools && a.requests === b.requests)
}

export function useSubagentAttention(agents: SubagentView[], selectedId?: string) {
  const [seen, setSeen] = useState<Map<string, AttentionSnapshot>>(new Map())
  const selected = agents.find((agent) => agent.id === selectedId)
  useEffect(() => {
    if (!selected) return
    const next = snapshot(selected)
    setSeen((current) => same(current.get(selected.id), next) ? current : new Map(current).set(selected.id, next))
  }, [selected])
  useEffect(() => {
    if (seen.size <= 256) return
    const ids = new Set(agents.map((agent) => agent.id))
    setSeen((current) => new Map([...current].filter(([id]) => ids.has(id))))
  }, [agents, seen.size])
  return new Set(agents.filter((agent) => agent.id !== selectedId && !same(seen.get(agent.id), snapshot(agent))).map((agent) => agent.id))
}
