import { describe, expect, it } from 'vitest'
import { parseTodoToolResult } from '../../src/lib/todo'

const RESULT = `Remaining items (2):
  - task2 [in_progress] (phase A)
  - task3 [pending] (phase B)
Overall: 1/3 done, 2 open.
Active phase 1/2 "phase A" (1/2).
  phase A:
    - [X] task1
    - [ ] task2 (in progress)
  phase B:
    - [ ] task3
`

const ALL_DONE = `Remaining items: none.
Overall: 3/3 done, 0 open.
  phase A:
    - [X] task1
    - [X] task2
`

describe('parseTodoToolResult', () => {
  it('parses phases with statuses from the rendered todo block', () => {
    expect(parseTodoToolResult(RESULT)).toEqual([
      { name: 'phase A', tasks: [
        { content: 'task1', status: 'completed' },
        { content: 'task2', status: 'in_progress' },
      ] },
      { name: 'phase B', tasks: [{ content: 'task3', status: 'pending' }] },
    ])
  })

  it('parses an all-done list', () => {
    const phases = parseTodoToolResult(ALL_DONE)
    expect(phases).toEqual([{ name: 'phase A', tasks: [
      { content: 'task1', status: 'completed' },
      { content: 'task2', status: 'completed' },
    ] }])
  })

  it('returns empty for unrelated tool output', () => {
    expect(parseTodoToolResult('Read 3 files from the workspace.')).toEqual([])
    expect(parseTodoToolResult('')).toEqual([])
  })
})
