// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ScheduledPage } from '../../src/pages/ScheduledPage'
import { SAMPLE_PROJECTS, SAMPLE_SESSIONS } from '../../src/lib/data'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('offers authorized secondary-folder threads and selects their project on entry', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const secondary = `${SAMPLE_PROJECTS[0].path}/packages/client`
  const project = { ...SAMPLE_PROJECTS[0], folders: [...SAMPLE_PROJECTS[0].folders, secondary] }
  const session = { ...SAMPLE_SESSIONS[0], id: 'nested-session', title: 'Secondary folder thread', projectPath: secondary }
  const unrelated = { ...session, id: 'unrelated', projectPath: `${secondary}/ungranted` }
  const archived = { ...session, id: 'archived', archived: true }
  try {
    await act(async () => root.render(<ScheduledPage
      harness="omp" schedules={[]} projects={[project]} sessions={[session, unrelated, archived]}
      models={[]} lastSelectedModel="" initialSessionId={session.id}
      onCreate={vi.fn()} onUpdate={vi.fn()} onPause={vi.fn()} onResume={vi.fn()}
      onDelete={vi.fn()} onRunNow={vi.fn()} onOpenSession={vi.fn()}
      onPreview={async (timing) => ({ timing, occurrences: [] })}
    />))
    const create = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('New schedule'))
    expect(create).toBeDefined()
    await act(async () => create?.click())
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelectorAll<HTMLInputElement>('input[name="target"]')[1]?.checked).toBe(true)
    const options = [...(dialog?.querySelectorAll('option') ?? [])].map((option) => option.value)
    expect(options).toContain(session.id)
    expect(options).not.toContain(unrelated.id)
    expect(options).not.toContain(archived.id)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
