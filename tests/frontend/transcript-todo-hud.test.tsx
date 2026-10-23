// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TranscriptHud } from '../../src/components/TranscriptHud'
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

const todoMessage: TranscriptMessage = {
  id: 'assistant-todo',
  role: 'assistant',
  timestamp: 1_000,
  parts: [
    { type: 'toolCall', id: 'tool-todo', name: 'todo', args: { i: 'seed the plan' } },
    { type: 'toolResult', name: 'todo', text: TODO_RESULT },
    { type: 'text', text: 'Plan is set.' },
  ],
}

function renderWithTodoText(text: string): void {
  act(() => root.render(<TranscriptHud messages={[{ ...todoMessage, parts: [{ type: 'toolResult', name: 'todo', text }] }]} />))
}

describe('todo HUD', () => {
  it('docks the plan at the bottom and auto-expands while work remains', () => {
    act(() => root.render(<TranscriptHud messages={[todoMessage]} />))

    const hud = container.querySelector('.transcript-hud')
    expect(hud).not.toBeNull()
    const bar = container.querySelector<HTMLButtonElement>('.todo-hud__bar')
    expect(bar).not.toBeNull()
    expect(bar?.getAttribute('aria-expanded')).toBe('true')
    expect(bar?.querySelector('.todo-hud__progress')?.textContent).toContain('1/3')
    expect(bar?.querySelector('.todo-hud__current')?.textContent).toContain('task2')
    const tasks = [...container.querySelectorAll('.todo-hud__task')].map((task) => task.className)
    expect(tasks).toContain('todo-hud__task is-completed')
    expect(tasks).toContain('todo-hud__task is-in_progress')
    expect(tasks).toContain('todo-hud__task is-pending')
  })

  it('auto-collapses once every task completes, like Claude Code', () => {
    const allDone = TODO_RESULT
      .replace('- [ ] task2 (in progress)', '- [X] task2')
      .replace('- [ ] task3', '- [X] task3')
    renderWithTodoText(allDone)

    expect(container.querySelector('.todo-hud__bar')?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.todo-hud__progress')?.textContent).toContain('3/3')
    expect(container.querySelector('.todo-hud__task')).toBeNull()
  })

  it('keeps a manual toggle until the agent publishes a fresh list', () => {
    renderWithTodoText(TODO_RESULT)
    act(() => container.querySelector<HTMLButtonElement>('.todo-hud__bar')?.click())
    expect(container.querySelector('.todo-hud__bar')?.getAttribute('aria-expanded')).toBe('false')
    // A re-render with the same list keeps the user's collapsed choice…
    renderWithTodoText(TODO_RESULT)
    expect(container.querySelector('.todo-hud__bar')?.getAttribute('aria-expanded')).toBe('false')
    // …but a fresh list from the agent re-arms the automatic expansion.
    renderWithTodoText(TODO_RESULT.replace('- [ ] task3', '- [ ] task3 revised'))
    expect(container.querySelector('.todo-hud__bar')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('uses only the latest todo state and ignores ordinary tool results', () => {
    const newer: TranscriptMessage = {
      id: 'assistant-2',
      role: 'assistant',
      timestamp: 2_000,
      parts: [{ type: 'toolResult', name: 'read', text: 'unrelated output' }],
    }
    act(() => root.render(<TranscriptHud messages={[newer, todoMessage]} />))
    expect(container.querySelector('.todo-hud__progress')?.textContent).toContain('1/3')
  })
})
