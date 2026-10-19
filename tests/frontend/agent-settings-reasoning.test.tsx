// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSettings } from '../../src/pages/settings/AgentSettings'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import type { AppSettings } from '../../src/types/api'

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
})

function toggleRow(label: string): HTMLElement {
  const match = Array.from(container.querySelectorAll<HTMLElement>('.settings-toggle'))
    .find((element) => element.textContent?.includes(label))
  if (!match) throw new Error(`toggle row not found: ${label}`)
  return match
}

describe('agent settings reasoning expansion', () => {
  it('renders the expand-thinking toggle with its localized label', () => {
    act(() => {
      root.render(
        <AgentSettings
          settings={{ ...DEFAULT_SETTINGS, reasoningExpandedByDefault: false }}
          meta={null}
          onUpdate={() => undefined}
          onRefreshHarnesses={async () => undefined}
        />,
      )
    })

    expect(container.textContent).toContain('Expand thinking by default')
    expect(container.textContent).toContain('Open thinking sections automatically in conversations and subagent views. Each section can still be toggled manually.')
  })

  it('commits the reasoning expansion preference when the toggle flips', () => {
    const onUpdate = vi.fn()
    act(() => {
      root.render(
        <AgentSettings
          settings={{ ...DEFAULT_SETTINGS, reasoningExpandedByDefault: false }}
          meta={null}
          onUpdate={onUpdate}
          onRefreshHarnesses={async () => undefined}
        />,
      )
    })

    const row = toggleRow('Expand thinking by default')
    const control = row.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(control).not.toBeNull()
    act(() => {
      control.click()
    })

    expect(onUpdate).toHaveBeenCalledWith({ reasoningExpandedByDefault: true } satisfies Partial<AppSettings>)
  })

  it('renders the default reasoning effort select with the current level', () => {
    act(() => {
      root.render(
        <AgentSettings
          settings={{ ...DEFAULT_SETTINGS, defaultEffort: 'high' }}
          meta={null}
          onUpdate={() => undefined}
          onRefreshHarnesses={async () => undefined}
        />,
      )
    })

    expect(container.textContent).toContain('Default reasoning effort')
    const row = Array.from(container.querySelectorAll<HTMLElement>('.settings-row'))
      .find((element) => element.textContent?.includes('Default reasoning effort'))
    expect(row).toBeDefined()
    const select = row?.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('high')
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('commits the chosen default reasoning effort', () => {
    const onUpdate = vi.fn()
    act(() => {
      root.render(
        <AgentSettings
          settings={{ ...DEFAULT_SETTINGS, defaultEffort: 'medium' }}
          meta={null}
          onUpdate={onUpdate}
          onRefreshHarnesses={async () => undefined}
        />,
      )
    })

    const row = Array.from(container.querySelectorAll<HTMLElement>('.settings-row'))
      .find((element) => element.textContent?.includes('Default reasoning effort'))
    const select = row?.querySelector('select') as HTMLSelectElement
    act(() => {
      select.value = 'high'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(onUpdate).toHaveBeenCalledWith({ defaultEffort: 'high' } satisfies Partial<AppSettings>)
  })
})
