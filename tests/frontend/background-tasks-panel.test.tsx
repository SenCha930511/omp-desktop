// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundTasksPanel } from '../../src/components/inspector/BackgroundTasksPanel'
import { formatRelative } from '../../src/lib/data'
import type { AutomationScheduleRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const automation = (overrides: Partial<AutomationScheduleRecord> = {}): AutomationScheduleRecord => ({
  schemaVersion: 1,
  id: 'morning',
  harness: 'omp',
  revision: 1,
  title: 'Morning issue triage',
  prompt: 'Review new high-priority issues and propose owners.',
  target: { kind: 'project', projectId: 'omp-desktop' },
  timing: { kind: 'rrule', dtstartLocal: '2026-08-06T09:00:00', timeZone: 'UTC', rrule: 'FREQ=DAILY' },
  execution: { model: 'auto', thinking: 'auto', speed: 'normal' },
  status: 'active',
  createdBy: 'user',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
  runs: [],
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

const render = async (automations: AutomationScheduleRecord[], onOpenAutomation = vi.fn(), onOpenSchedules = vi.fn()) => {
  await act(async () => root.render(<BackgroundTasksPanel automations={automations} onOpenAutomation={onOpenAutomation} onOpenSchedules={onOpenSchedules} />))
  return { onOpenAutomation, onOpenSchedules }
}

describe('BackgroundTasksPanel', () => {
  it('lists every automation with its status, next run, and blocked reason', async () => {
    const nextRunAt = new Date(Date.now() + 3600e3).toISOString()
    const automations = [
      automation({ id: 'morning', title: 'Morning issue triage', nextRunAt }),
      automation({ id: 'nightly', title: 'Nightly dependency audit', status: 'blocked', blockedReason: 'Missing project' }),
    ]
    await render(automations)

    expect(container.querySelector('.inspector-scroll.background-tasks')).not.toBeNull()
    expect(container.querySelector('.background-tasks__header h2')?.textContent).toBe('Background tasks')
    expect(container.querySelector('.background-tasks__header small')?.textContent).toBe('2 tasks')
    expect(container.querySelectorAll('.summary-automation-list > button')).toHaveLength(2)

    const text = container.textContent ?? ''
    expect(text).toContain('Morning issue triage')
    expect(text).toContain('Nightly dependency audit')
    expect(text).toContain('active')
    expect(text).toContain(`Next run ${formatRelative(nextRunAt)}`)
    expect(text).toContain('Blocked: Missing project')
    expect(container.querySelector('.background-tasks__blocked')?.textContent).toBe('Blocked: Missing project')
  })

  it('opens the selected automation from its row', async () => {
    const { onOpenAutomation } = await render([automation(), automation({ id: 'nightly', title: 'Nightly dependency audit' })])

    const row = [...container.querySelectorAll<HTMLButtonElement>('.summary-automation-list > button')].find((button) => button.textContent?.includes('Nightly dependency audit'))
    expect(row).toBeDefined()
    await act(async () => row?.click())

    expect(onOpenAutomation).toHaveBeenCalledWith('nightly')
  })

  it('shows the empty state and opens schedules from its action', async () => {
    const { onOpenSchedules } = await render([])

    expect(container.querySelector('.summary-automation-list')).toBeNull()
    expect(container.querySelector('.background-tasks__empty p')?.textContent).toBe('Scheduled runs appear here once you create one.')
    const button = container.querySelector<HTMLButtonElement>('.background-tasks__empty button')
    expect(button?.textContent).toBe('Open schedules')
    await act(async () => button?.click())

    expect(onOpenSchedules).toHaveBeenCalledTimes(1)
  })
})
