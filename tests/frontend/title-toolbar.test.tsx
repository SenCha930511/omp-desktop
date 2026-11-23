// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptStore } from '../../src/app/transcript-store'
import { TitleToolbar } from '../../src/components/TitleToolbar'
import { I18nProvider } from '../../src/lib/i18n'
import type { ProjectRecord, RuntimeInfo } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project', harness: 'omp', name: 'My Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1, gitBranch: 'main',
}

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
  vi.restoreAllMocks()
})

const noop = () => undefined

describe('title toolbar identity', () => {
  it('shows the session name instead of the project while a session is open', async () => {
    await act(async () => {
      root.render(
        <TitleToolbar
          project={project} sessionTitle="Outline WSL architecture" view="session" sidebarOpen inspectorOpen
          onToggleSidebar={noop} onToggleInspector={noop}
        />,
      )
    })
    const identity = container.querySelector('.title-toolbar__identity strong')
    expect(identity?.textContent).toBe('Outline WSL architecture')
    expect(container.querySelector('.branch-pill')?.textContent).toBe('main')
  })

  it('falls back to the project name for a brand-new session', async () => {
    await act(async () => {
      root.render(
        <TitleToolbar
          project={project} view="session" sidebarOpen inspectorOpen
          onToggleSidebar={noop} onToggleInspector={noop}
        />,
      )
    })
    expect(container.querySelector('.title-toolbar__identity strong')?.textContent).toBe('My Project')
  })
})

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy()
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const renderToolbar = async (props: Partial<ComponentProps<typeof TitleToolbar>> = {}) => {
  await act(async () => {
    root.render(
      <TitleToolbar
        project={project}
        view="session"
        sidebarOpen
        inspectorOpen
        onToggleSidebar={noop}
        onToggleInspector={noop}
        {...props}
      />,
    )
  })
}

describe('title toolbar session actions', () => {
  it('renders only Overview and Toggle inspector buttons in session view', async () => {
    const onToggleInspector = vi.fn()
    await renderToolbar({ inspectorOpen: true, onToggleInspector })

    expect([...container.querySelectorAll('.title-toolbar__actions button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Overview', 'Toggle inspector'])
    expect(container.querySelector('button[aria-label="More"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Session tree"]')).toBeNull()
    expect(container.querySelector('button[aria-label^="Open browser"]')).toBeNull()

    const toggle = container.querySelector('button[aria-label="Toggle inspector"]')
    expect(toggle?.className).toContain('is-active')
    await click(toggle)
    expect(onToggleInspector).toHaveBeenCalledTimes(1)

    await renderToolbar({ inspectorOpen: false })
    expect(container.querySelector('button[aria-label="Toggle inspector"]')?.className).not.toContain('is-active')
  })

  it('opens the Session Summary Overview card with status, workspace, activity, clickable subagents, and context', async () => {
    const onSelectInspectorTab = vi.fn()
    const onSelectSubagent = vi.fn()
    const transcript = createTranscriptStore([
      {
        id: 'm-1',
        role: 'assistant',
        timestamp: '2026-01-01T00:00:00.000Z',
        parts: [
          { type: 'toolCall', id: 'tc-1', name: 'read', args: { path: 'src/App.tsx' } },
          { type: 'text', text: 'Updated the toolbar overview to show live session metrics.' },
        ],
      },
    ])
    const runtime = {
      sessionUsage: {
        cost: 0.42,
        tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0, total: 1700 },
      },
    } as unknown as RuntimeInfo

    await renderToolbar({
      transcript,
      runtime,
      git: {
        isRepo: true,
        branch: 'feat/test',
        files: [{ path: 'src/App.tsx', status: 'M', staged: false, additions: 12, deletions: 4 }],
      },
      subagents: [{ id: 'sub-1', agent: 'Explore', status: 'running', messages: [] }],
      onSelectInspectorTab,
      onSelectSubagent,
    })

    const overview = container.querySelector<HTMLButtonElement>('button[aria-label="Overview"]')
    expect(overview?.getAttribute('aria-expanded')).toBe('false')
    await click(overview)
    expect(overview?.getAttribute('aria-expanded')).toBe('true')

    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-label')).toBe('Workspace overview')
    expect(dialog?.querySelector('.summary-hero .run-state')?.textContent).toBe('Ready')
    expect(dialog?.textContent).toContain('Session overview')
    expect(dialog?.textContent).toContain('Updated the toolbar overview to show live session metrics.')
    expect(dialog?.textContent).toContain('My Project')
    expect(dialog?.textContent).toContain('/project')
    expect(dialog?.textContent).toContain('1 tool call recorded')
    expect(dialog?.textContent).toContain('1 files ready to review')
    expect(dialog?.textContent).toContain('$0.42')
    expect(dialog?.textContent).toContain('1,000 in / 500 out / 200 cached')
    expect(dialog?.textContent).toContain('Explore')

    const agentBtn = [...(dialog?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.includes('Explore'))
    await click(agentBtn)
    expect(onSelectSubagent).toHaveBeenCalledWith('sub-1')
    expect(onSelectInspectorTab).toHaveBeenCalledWith('agents')
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    await click(overview)
    const seeAllBtn = container.querySelector<HTMLButtonElement>('.toolbar-overview__see-all')
    await click(seeAllBtn)
    expect(onSelectInspectorTab).toHaveBeenCalledWith('agents')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('localizes known subagent statuses and marks unknown upstream states unavailable in every locale', async () => {
    const subagents = [
      { id: 'running', agent: 'Explore', status: 'running', messages: [] },
      { id: 'completed', agent: 'Reviewer', status: 'completed', messages: [] },
      { id: 'unknown', agent: 'Custom', status: 'queued_upstream', messages: [] },
    ]
    const cases = [
      ['en', 'Workspace overview', ['Running', 'Completed', 'Status unavailable']],
      ['zh-TW', '工作區總覽', ['執行中', '已完成', '狀態不明']],
      ['zh-CN', '工作区概览', ['运行中', '已完成', '状态不明']],
    ] as const

    for (const [preference, dialogLabel, statuses] of cases) {
      await act(async () => {
        root.render(
          <I18nProvider preference={preference}>
            <TitleToolbar
              project={project} view="session" sidebarOpen inspectorOpen
              onToggleSidebar={noop} onToggleInspector={noop} subagents={subagents}
            />
          </I18nProvider>,
        )
      })
      if (!container.querySelector('[role="dialog"]')) await click(container.querySelector('.title-toolbar__overview button'))

      expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(dialogLabel)
      expect([...container.querySelectorAll('.toolbar-overview__subitem .toolbar-overview__status')].map((status) => status.textContent)).toEqual([...statuses])
      expect(container.querySelector('.toolbar-overview')?.textContent).not.toContain('queued_upstream')
      expect([...container.querySelectorAll('.toolbar-overview__subitem')].map((item) => item.textContent)).toEqual([
        `Explore${statuses[0]}`, `Reviewer${statuses[1]}`, `Custom${statuses[2]}`,
      ])
    }
  })

  it('closes the Overview popover on Escape and on an outside pointer down', async () => {
    await renderToolbar()
    const overview = container.querySelector('button[aria-label="Overview"]')

    await click(overview)
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    await click(overview)
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    await click(overview)
    await act(async () => {
      container.querySelector('[role="dialog"]')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  })
})
