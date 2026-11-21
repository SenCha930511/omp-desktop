// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundTasksPanel } from '../../src/components/inspector/BackgroundTasksPanel'
import { deriveOmpBackgroundTasks, type OmpBackgroundTask } from '../../src/lib/omp-background-tasks'
import type { TranscriptMessage } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const task = (overrides: Partial<OmpBackgroundTask> = {}): OmpBackgroundTask => ({
  id: 'job-1',
  kind: 'job',
  title: 'npm run build:watch',
  type: 'bash',
  status: 'running',
  detail: '2s',
  cancellable: true,
  ...overrides,
})

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
})

const render = async (
  tasks: OmpBackgroundTask[],
  options: { hasRuntime?: boolean; onCancelTask?: (task: OmpBackgroundTask) => void; onRefreshTasks?: () => void } = {},
) => {
  const onCancelTask = options.onCancelTask ?? vi.fn()
  const onRefreshTasks = options.onRefreshTasks ?? vi.fn()
  await act(async () =>
    root.render(<BackgroundTasksPanel tasks={tasks} hasRuntime={options.hasRuntime ?? true} onCancelTask={onCancelTask} onRefreshTasks={onRefreshTasks} />),
  )
  return { onCancelTask, onRefreshTasks }
}

describe('BackgroundTasksPanel', () => {
  it('lists OMP background tasks with status, metadata, and cancel actions', async () => {
    const running = task({ id: 'job-1', title: 'Watch CI run', type: 'bash', status: 'running', detail: '12s', cancellable: true })
    const failed = task({ id: 'job-2', title: 'Run integration tests', type: 'task', status: 'failed', detail: 'exit 1', cancellable: false })
    const { onCancelTask, onRefreshTasks } = await render([running, failed])

    expect(container.querySelector('.inspector-scroll.background-tasks')).not.toBeNull()
    expect(container.querySelector('.background-tasks__header h2')?.textContent).toBe('Background tasks')
    expect(container.querySelector('.background-tasks__header small')?.textContent).toBe('2 tasks')
    expect(container.querySelectorAll('.background-task-row')).toHaveLength(2)

    const text = container.textContent ?? ''
    expect(text).toContain('Watch CI run')
    expect(text).toContain('bash · Running · 12s')
    expect(text).toContain('Run integration tests')
    expect(text).toContain('task · Failed · exit 1')

    const cancelButtons = container.querySelectorAll<HTMLButtonElement>('button[aria-label="Cancel task"]')
    expect(cancelButtons).toHaveLength(1)
    await act(async () => cancelButtons[0]?.click())
    expect(onCancelTask).toHaveBeenCalledWith(running)

    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')
    await act(async () => refresh?.click())
    expect(onRefreshTasks).toHaveBeenCalledTimes(1)
  })

  it('shows the empty state and triggers refresh when clicked', async () => {
    const { onRefreshTasks } = await render([], { hasRuntime: true })

    expect(container.querySelector('.background-tasks__list')).toBeNull()
    expect(container.querySelector('.background-tasks__empty p')?.textContent).toBe('No background tasks are currently running in this session.')
    const button = container.querySelector<HTMLButtonElement>('.background-tasks__empty button')
    expect(button?.textContent).toBe('Refresh')
    await act(async () => button?.click())

    expect(onRefreshTasks).toHaveBeenCalledTimes(1)
  })
})

describe('deriveOmpBackgroundTasks', () => {
  it('extracts active scripts, running bash commands, streaming tools, and async jobs from OMP transcript', () => {
    const messages: TranscriptMessage[] = [
      {
        id: 'm-1',
        role: 'assistant',
        timestamp: '2026-01-01T00:00:00.000Z',
        streaming: true,
        parts: [
          {
            type: 'toolCall',
            id: 'tc-1',
            name: 'bash',
            args: { command: 'npm run dev', async: true },
          },
          {
            type: 'toolResult',
            name: 'bash',
            text: 'Backgrounded as job job-42\nWait or use /jobs',
          },
          {
            type: 'toolCall',
            id: 'tc-2',
            name: 'read',
            args: { path: 'src/App.tsx' },
          },
        ],
      },
    ]

    const tasks = deriveOmpBackgroundTasks({
      messages,
      isStreaming: true,
      commandOutputHistory: [{ id: 7, command: 'vitest run', text: '', status: 'running', onAbort: () => undefined }],
      activeProjectScript: { runId: 'run-1', kind: 'run', command: 'npm run dev' },
    })

    expect(tasks.map((item) => ({ id: item.id, kind: item.kind, status: item.status, title: item.title }))).toEqual([
      { id: 'script:run-1', kind: 'script', status: 'running', title: 'npm run dev' },
      { id: 'bash:7', kind: 'bash', status: 'running', title: 'vitest run' },
      { id: 'tc-2', kind: 'tool', status: 'running', title: 'src/App.tsx' },
      { id: 'job-42', kind: 'job', status: 'running', title: 'npm run dev' },
    ])
  })

  it('reconciles /jobs output and cancellation updates to terminal status', () => {
    const messages: TranscriptMessage[] = [
      {
        id: 'm-1',
        role: 'assistant',
        timestamp: '2026-01-01T00:00:00.000Z',
        parts: [
          { type: 'toolCall', id: 'tc-1', name: 'bash', args: { command: 'npm test', async: true } },
          { type: 'toolResult', name: 'bash', text: 'Backgrounded as job job-9' },
          { type: 'text', text: '[job-9] bash (running) — 4s\n  npm test\nCancelled background job job-9' },
        ],
      },
    ]

    const tasks = deriveOmpBackgroundTasks({ messages })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: 'job-9', status: 'cancelled', cancellable: false, title: 'npm test' })
  })
})
