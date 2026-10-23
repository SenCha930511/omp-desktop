/**
 * OMP renders its `todo` tool result as a fixed human-readable block:
 *
 *   Remaining items (2):
 *     - task2 [in_progress] (phase A)
 *   Overall: 1/3 done, 2 open.
 *   Active phase 1/2 "phase A" (1/2).
 *     phase A:
 *       - [X] task1
 *       - [ ] task2 (in progress)
 *     phase B:
 *       - [ ] task3
 *
 * The phase blocks at the tail carry the full structured state, so that is
 * what the todo card parses. Anything the parser cannot recognize is ignored
 * rather than guessed: a format change from the harness degrades to the plain
 * tool-result row instead of a mangled card.
 */

export interface TodoTask {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface TodoPhase {
  name: string
  tasks: TodoTask[]
}

const PHASE_LINE = /^ {2}(.+):$/
const TASK_LINE = /^ {4}- \[( |X|x)\] (.*)$/

/** Parses the phase blocks of a `todo` tool result; empty when nothing matches. */
export function parseTodoToolResult(text: string): TodoPhase[] {
  const phases: TodoPhase[] = []
  let current: TodoPhase | null = null
  for (const line of text.split('\n')) {
    const phase = PHASE_LINE.exec(line)
    if (phase) {
      current = { name: phase[1]!.trim(), tasks: [] }
      phases.push(current)
      continue
    }
    const task = TASK_LINE.exec(line)
    if (task && current) {
      const raw = task[2]!.trim()
      const inProgress = raw.endsWith('(in progress)')
      current.tasks.push({
        content: (inProgress ? raw.slice(0, -(('(in progress)').length)) : raw).trim(),
        status: task[1] === ' ' ? (inProgress ? 'in_progress' : 'pending') : 'completed',
      })
    }
  }
  return phases.filter((phase) => phase.tasks.length > 0)
}
