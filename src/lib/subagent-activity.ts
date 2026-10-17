import type { SubagentView } from '@/hooks/useSubagents'
import { activityState, isInteractiveTool, type ExecutionState } from './execution-state'
import { subagentTranscript } from './subagent-transcript'
import { string } from './events/parse'

export function subagentExecution(agent: SubagentView): ExecutionState {
  if (agent.status === 'pending' || agent.status === 'starting') return { phase: 'starting' }
  if (agent.status === 'failed' || agent.status === 'error') return { phase: 'failed', detail: agent.error }
  if (agent.status === 'aborted' || agent.status === 'cancelled') return { phase: 'cancelled' }
  if (agent.status === 'completed') return { phase: 'completed' }
  if (agent.status === 'waiting' || agent.status === 'waiting_for_input') return { phase: 'waiting' }
  if (agent.status !== 'running') return { phase: 'unknown' }
  const tool = string(agent.progress?.currentTool)
  if (tool) return { phase: isInteractiveTool(tool) ? 'waiting' : 'running', detail: string(agent.progress?.currentToolIntent) ?? tool }
  const messages = subagentTranscript(agent.messages, true)
  return activityState(messages.at(-1)?.parts ?? [])
}

const PRIORITY: Record<ExecutionState['phase'], number> = { waiting: 0, failed: 1, starting: 2, running: 2, thinking: 2, compacting: 2, idle: 3, unknown: 3, completed: 4, cancelled: 4 }

export function prioritizeSubagents(agents: SubagentView[]): SubagentView[] {
  return agents.map((agent, index) => ({ agent, index, priority: PRIORITY[subagentExecution(agent).phase] }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index).map(({ agent }) => agent)
}
