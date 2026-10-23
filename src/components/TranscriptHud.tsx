import { Check, ChevronDown, ListTodo } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { parseTodoToolResult, type TodoPhase } from '@/lib/todo'
import type { TranscriptMessage } from '@/types/api'


/** Latest todo state across the whole transcript: the plan shown in the HUD. */
function latestTodoPhases(messages: readonly TranscriptMessage[]): TodoPhase[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    // Malformed rows (the per-message error boundary swaps in broken payloads)
    // must not take the whole HUD down with them.
    const parts = messages[index]!.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (part.type === 'toolResult' && part.name === 'todo') {
        const phases = parseTodoToolResult(part.text)
        if (phases.length > 0) return phases
      }
    }
  }
  return []
}

function TodoHud({ phases }: { phases: TodoPhase[] }) {
  const { t } = useI18n()
  const tasks = useMemo(() => phases.flatMap((phase) => phase.tasks), [phases])
  const done = tasks.filter((task) => task.status === 'completed').length
  const current = tasks.find((task) => task.status === 'in_progress')
  // Claude Code logic: the list auto-expands while work remains (any task
  // pending or in progress) and collapses to the quiet bar once everything
  // completes. A user toggle overrides the automatic state until the agent
  // publishes a fresh list, which re-arms the automatic behavior.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const fingerprint = useMemo(() => JSON.stringify(phases), [phases])
  const [seenFingerprint, setSeenFingerprint] = useState(fingerprint)
  if (seenFingerprint !== fingerprint) {
    setSeenFingerprint(fingerprint)
    setManualOpen(null)
  }
  const allDone = tasks.length > 0 && done === tasks.length
  const open = manualOpen ?? false
  return (
    <div className={`todo-hud${open ? ' is-open' : ''}`}>
      <button type="button" className="todo-hud__bar" aria-expanded={open} onClick={() => setManualOpen(!open)}>
        <ListTodo size={13} aria-hidden="true" />
        <span className="todo-hud__title">{t('transcript.todo.title')}</span>
        <span className="todo-hud__progress">{t('transcript.todo.progress', { done, total: tasks.length })}</span>
        {current ? <span className="todo-hud__current">{current.content}</span> : null}
        <ChevronDown size={12} className={open ? 'is-expanded' : undefined} aria-hidden="true" />
      </button>
      {open ? (
        <div className="todo-hud__panel">
          {phases.map((phase) => (
            <div className="todo-hud__phase" key={phase.name}>
              <div className="todo-hud__phase-name">{phase.name}</div>
              {phase.tasks.map((task) => (
                <div className={`todo-hud__task is-${task.status}`} key={task.content}>
                  <span className="todo-hud__marker" aria-hidden="true">
                    {task.status === 'completed' ? <Check size={11} /> : task.status === 'in_progress' ? <span className="todo-hud__pulse" /> : <span className="todo-hud__ring" />}
                  </span>
                  <span className="todo-hud__content">{task.content}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Bottom-docked status area for the live plan (Claude-desktop style): a
 * quiet bar under the transcript instead of a card interrupting the
 * conversation flow. Compaction renders inline, Claude-Code style.
 */
export const TranscriptHud = memo(function TranscriptHud({ messages }: { messages: readonly TranscriptMessage[] }) {
  const phases = useMemo(() => latestTodoPhases(messages), [messages])
  if (phases.length === 0) return null
  return (
    <div className="transcript-hud" aria-live="polite">
      <TodoHud phases={phases} />
    </div>
  )
})
