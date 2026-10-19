// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'
import { ProjectPicker } from '../../src/components/ProjectPicker'
import type { ProjectRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const projects: ProjectRecord[] = [
  {
    id: 'p-tmp',
    harness: 'omp',
    name: 'tmp',
    path: '/Users/demo/tmp',
    folders: ['/Users/demo/tmp'],
    primaryFolder: '/Users/demo/tmp',
    pinned: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastOpenedAt: '2026-10-18T00:00:00.000Z',
    sessionCount: 3,
  },
  {
    id: 'p-repo',
    harness: 'omp',
    name: 'repo',
    path: '/Users/demo/code/repo',
    folders: ['/Users/demo/code/repo'],
    primaryFolder: '/Users/demo/code/repo',
    pinned: true,
    createdAt: '2026-10-02T00:00:00.000Z',
    lastOpenedAt: '2026-10-19T00:00:00.000Z',
    sessionCount: 12,
  },
]

describe('project picker', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows the active project name on the trigger', () => {
    act(() => root.render(<ProjectPicker projects={projects} activeProjectId="p-tmp" onSelect={vi.fn()} onAddFolder={vi.fn()} />))

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Project: tmp"]')
    expect(trigger?.textContent).toContain('tmp')
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('lists projects with their folders and switches on select', async () => {
    const onSelect = vi.fn()
    act(() => root.render(<ProjectPicker projects={projects} activeProjectId="p-tmp" onSelect={onSelect} onAddFolder={vi.fn()} />))

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Project: tmp"]')?.click())
    const options = container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    expect(options).toHaveLength(2)
    expect(options[0].getAttribute('aria-checked')).toBe('true')
    expect(options[1].textContent).toContain('repo')
    expect(options[1].textContent).toContain('/Users/demo/code/repo')

    await act(async () => options[1].click())
    expect(onSelect).toHaveBeenCalledWith(projects[1])
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('keeps the current project on reselect and opens the native folder picker on demand', async () => {
    const onSelect = vi.fn()
    const onAddFolder = vi.fn()
    act(() => root.render(<ProjectPicker projects={projects} activeProjectId="p-tmp" onSelect={onSelect} onAddFolder={onAddFolder} />))

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Project: tmp"]')?.click())
    const options = container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    await act(async () => options[0].click())
    expect(onSelect).not.toHaveBeenCalled()

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Project: tmp"]')?.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click())
    expect(onAddFolder).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('shows an empty state when no projects exist yet', () => {
    act(() => root.render(<ProjectPicker projects={[]} activeProjectId={undefined} onSelect={vi.fn()} onAddFolder={vi.fn()} />))

    act(() => container.querySelector<HTMLButtonElement>('button[type="button"]')?.click())
    expect(container.textContent).toContain('No projects yet')
    expect(container.querySelector('[role="menuitem"]')).not.toBeNull()
  })
})

describe('composer project picker integration', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function props(overrides: Record<string, unknown> = {}) {
    return {
      busy: false,
      model: '',
      effort: 'medium' as const,
      modelsByProvider: new Map(),
      providers: [],
      reasoningLevels: ['medium' as const],
      fast: false,
      fastSupported: false,
      fastAvailable: false,
      imageInputSupported: true,
      skills: [],
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      onFastChange: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
      ...overrides,
    }
  }

  it('renders the folder picker without a git catalog instead of a dead checkout pill', async () => {
    const onSelectProject = vi.fn()
    act(() =>
      root.render(
        <Composer
          {...props({
            checkoutCatalog: undefined,
            projects,
            activeProjectId: 'p-tmp',
            onSelectProject,
            onAddProjectFolder: vi.fn(),
          })}
        />,
      ),
    )

    expect(container.querySelector('[aria-label^="Checkout:"]')).toBeNull()
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Project: tmp"]')
    expect(trigger?.textContent).toContain('tmp')

    act(() => trigger?.click())
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[1].click())
    expect(onSelectProject).toHaveBeenCalledWith(projects[1])
  })
})
