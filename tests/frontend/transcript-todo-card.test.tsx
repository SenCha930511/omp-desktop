// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssistantMessage } from '../../src/components/transcript/messages'
import type { TranscriptMessage } from '../../src/types/api'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  window.localStorage.clear()
})

const TODO_RESULT = `Remaining items (2):
  - task2 [in_progress] (phase A)
  - task3 [pending] (phase B)
Overall: 1/3 done, 2 open.
  phase A:
    - [X] task1
    - [ ] task2 (in progress)
  phase B:
    - [ ] task3
`

const messageWithTodo: TranscriptMessage = {
  id: 'assistant-todo',
  role: 'assistant',
  timestamp: 1_000,
  startedAt: 1_000,
  completedAt: 4_000,
  streaming: false,
  parts: [
    { type: 'thinking', text: 'Planning the work.' },
    { type: 'toolCall', id: 'tool-todo', name: 'todo', args: { i: 'seed the plan' } },
    { type: 'toolResult', name: 'todo', text: TODO_RESULT },
    { type: 'text', text: 'Plan is set; starting on task2.' },
  ],
}

describe('todo result cards', () => {
  it('renders the todo result as a checklist card outside the work fold', () => {
    act(() => root.render(<AssistantMessage message={messageWithTodo} showReasoning showTools />))

    const card = container.querySelector('.todo-card')
    expect(card).not.toBeNull()
    expect(card?.querySelector('.todo-card__progress')?.textContent).toContain('1/3')
    const tasks = [...container.querySelectorAll('.todo-card__task')].map((task) => task.className)
    expect(tasks).toContain('todo-card__task is-completed')
    expect(tasks).toContain('todo-card__task is-in_progress')
    expect(tasks).toContain('todo-card__task is-pending')
    // The plan stays out of the collapsed work rail: the fold carries the
    // tool call, the card lives in the narrative flow below it.
    const fold = container.querySelector('.work-disclosure')
    expect(fold).not.toBeNull()
    expect(fold?.querySelector('.todo-card')).toBeNull()
  })

  it('keeps ordinary tool results in the work rail', () => {
    act(() => root.render(
      <AssistantMessage
        message={{ ...messageWithTodo, parts: [
          { type: 'toolCall', id: 'tool-read', name: 'read', args: {} },
          { type: 'toolResult', name: 'read', text: 'file contents' },
          { type: 'text', text: 'Done reading.' },
        ] }}
        showReasoning
        showTools
      />,
    ))

    expect(container.querySelector('.todo-card')).toBeNull()
    expect(container.querySelector('.work-disclosure')).not.toBeNull()
  })
})
