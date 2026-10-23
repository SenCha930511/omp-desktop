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

  it('shows the active project name and opens the native picker directly on click', async () => {
    const onAddFolder = vi.fn()
    act(() => root.render(<ProjectPicker projects={projects} activeProjectId="p-tmp" onAddFolder={onAddFolder} />))

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Project: tmp"]')
    expect(trigger?.textContent).toContain('tmp')
    expect(container.querySelector('[role="menu"]')).toBeNull()

    act(() => trigger?.click())
    expect(onAddFolder).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(container.querySelector('[role="menuitemradio"]')).toBeNull()
  })

  it('falls back to "No project" and still opens the native picker when nothing exists', () => {
    const onAddFolder = vi.fn()
    act(() => root.render(<ProjectPicker projects={[]} activeProjectId={undefined} onAddFolder={onAddFolder} />))

    const trigger = container.querySelector<HTMLButtonElement>('button[type="button"]')
    expect(trigger?.textContent).toContain('No project')

    act(() => trigger?.click())
    expect(onAddFolder).toHaveBeenCalledOnce()
  })

  it('offers existing projects before adding folders and supports keyboard navigation', () => {
    const onAddFolder = vi.fn()
    const onSelectProject = vi.fn()
    act(() => root.render(<ProjectPicker projects={projects} activeProjectId="p-tmp" onAddFolder={onAddFolder} onSelectProject={onSelectProject} />))
    const trigger = container.querySelector<HTMLButtonElement>('.project-picker__trigger')!
    act(() => trigger.click())
    expect(onAddFolder).not.toHaveBeenCalled()
    const options = container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    expect(options).toHaveLength(2)
    expect(options[0]?.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(options[0])
    act(() => options[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe(options[1])
    act(() => options[1]?.click())
    expect(onSelectProject).toHaveBeenCalledWith(projects[1])
    expect(document.activeElement).toBe(trigger)
    act(() => trigger.click())
    act(() => container.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click())
    expect(onAddFolder).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="menu"]')).toBeNull()
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

  it('renders the folder chip without a git catalog and opens the native picker on click', () => {
    const onAddProjectFolder = vi.fn()
    act(() =>
      root.render(
        <Composer
          {...props({
            checkoutCatalog: undefined,
            projects,
            activeProjectId: 'p-tmp',
            onAddProjectFolder,
          })}
        />,
      ),
    )

    expect(container.querySelector('[aria-label^="Checkout:"]')).toBeNull()
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Project: tmp"]')
    expect(trigger?.textContent).toContain('tmp')

    act(() => trigger?.click())
    expect(onAddProjectFolder).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })
})
