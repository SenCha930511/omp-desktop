import { describe, expect, it, vi } from 'vitest'
import { ScheduledRunExecutor } from '../../electron/main/schedules/executor'
import { ScheduleBlockedError } from '../../electron/main/schedules/service'
import type { AutomationScheduleRecord, HarnessId } from '../../src/types/api'

function task(harness: HarnessId, prompt: string): AutomationScheduleRecord {
  return {
    schemaVersion: 1,
    id: `task-${harness}`,
    harness,
    revision: 1,
    title: 'MCP policy probe',
    prompt,
    target: { kind: 'project', projectId: `project-${harness}` },
    timing: { kind: 'once', at: '2026-08-15T22:00:00.000Z' },
    execution: { model: 'auto', thinking: 'auto', speed: 'normal' },
    status: 'active',
    createdBy: 'user',
    createdAt: '2026-08-15T21:00:00.000Z',
    updatedAt: '2026-08-15T21:00:00.000Z',
    runs: [],
  }
}

describe('ScheduledRunExecutor MCP auth policy', () => {
  it('rejects a persisted omp auth task before project lookup or runtime start', async () => {
    const harness = 'omp'
    const prompt = '/mcp reauth docs'
    const projects = { list: vi.fn(), authorizeCwd: vi.fn() }
    const sessions = { harness, list: vi.fn(), requireSessionPath: vi.fn() }
    const agents = { startUnattended: vi.fn() }
    const providers = { requireAvailableModel: vi.fn() }
    const executor = new ScheduledRunExecutor(projects as never, sessions as never, agents as never, providers as never)

    const result = executor.run(task(harness, prompt))
    await expect(result).rejects.toBeInstanceOf(ScheduleBlockedError)
    await expect(result).rejects.toThrow('Network MCP authentication is managed outside OMP Desktop')
    expect(projects.list).not.toHaveBeenCalled()
    expect(agents.startUnattended).not.toHaveBeenCalled()
  })
})

function sessionTask(): AutomationScheduleRecord {
  return {
    ...task('omp', 'nightly report'),
    id: 'task-session',
    target: { kind: 'session', projectId: 'project-one', sessionId: 'thread-one' },
  }
}

function sessionServices(agents: Record<string, unknown>): ScheduledRunExecutor {
  const projects = {
    list: vi.fn(async () => [{ id: 'project-one', path: '/project', primaryFolder: '/project', folders: ['/project'], inferred: false }]),
    authorizeCwd: vi.fn(async (cwd: string) => cwd),
  }
  const sessions = {
    harness: 'omp',
    list: vi.fn(async () => [{ id: 'thread-one', archived: false, projectPath: '/project', filePath: '/project/session.jsonl' }]),
    requireSessionPath: vi.fn(async (path: string) => path),
  }
  return new ScheduledRunExecutor(projects as never, sessions as never, agents as never, { requireAvailableModel: vi.fn() } as never)
}

describe('ScheduledRunExecutor idle wait', () => {
  it('surfaces the busy-thread timeout without stopping the live runtime', async () => {
    const agents = {
      getForSession: vi.fn(() => ({ runtimeId: 'runtime-1' })),
      waitUntilIdle: vi.fn(async () => { throw new Error('The scheduled thread remained busy for 15 minutes') }),
      stop: vi.fn(async () => true),
    }
    const executor = sessionServices(agents)

    await expect(executor.run(sessionTask())).rejects.toThrow('The scheduled thread remained busy for 15 minutes')
    expect(agents.waitUntilIdle).toHaveBeenCalledWith('runtime-1')
    expect(agents.stop).not.toHaveBeenCalled()
  })

  it('waits for the existing runtime before stopping it and resuming the thread', async () => {
    const order: string[] = []
    const agents = {
      getForSession: vi.fn(() => ({ runtimeId: 'runtime-1' })),
      waitUntilIdle: vi.fn(async () => { order.push('idle') }),
      stop: vi.fn(async () => { order.push('stop'); return true }),
      startUnattended: vi.fn(async () => { order.push('start'); return { runtimeId: 'runtime-2', isStreaming: false, isCompacting: false } }),
      runPromptToCompletion: vi.fn(async () => { order.push('prompt'); return { sessionId: 'thread-one', sessionFile: '/project/session.jsonl' } }),
    }
    const executor = sessionServices(agents)

    await expect(executor.run(sessionTask())).resolves.toEqual({ sessionId: 'thread-one', sessionFile: '/project/session.jsonl' })
    expect(agents.waitUntilIdle).toHaveBeenCalledWith('runtime-1')
    expect(order).toEqual(['idle', 'stop', 'start', 'prompt', 'stop'])
  })
})
