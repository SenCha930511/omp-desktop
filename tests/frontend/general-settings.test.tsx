// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { GeneralSettings } from '../../src/pages/settings/GeneralSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('GeneralSettings macOS background controls', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('describes and persists the opt-in macOS behavior', () => {
    const update = vi.fn()
    act(() => root.render(<GeneralSettings settings={DEFAULT_SETTINGS} onUpdate={update} platform="darwin" />))

    expect(container.textContent).toContain('Startup & background')
    expect(container.textContent).toContain('Keep running after closing the app window')
    expect(container.textContent).toContain('Keep scheduled work running from the menu bar until you quit the app.')
    expect(container.textContent).toContain('Launch at login')
    expect(container.textContent).toContain('Start the app in the background when you log in to this Mac.')

    const toggles = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(toggles.slice(-2).map((toggle) => toggle.checked)).toEqual([false, false])
    act(() => toggles.at(-2)?.click())
    act(() => toggles.at(-1)?.click())
    expect(update).toHaveBeenNthCalledWith(1, { keepRunningInBackground: true })
    expect(update).toHaveBeenNthCalledWith(2, { launchAtLogin: true })
  })

  it('keeps the unfinished cross-platform behavior out of other builds', () => {
    act(() => root.render(<GeneralSettings settings={DEFAULT_SETTINGS} onUpdate={vi.fn()} platform="win32" />))
    expect(container.textContent).not.toContain('Startup & background')
    expect(container.textContent).not.toContain('Launch at login')
  })

  it('closes idle sessions on the chosen schedule', () => {
    const update = vi.fn()
    act(() => root.render(<GeneralSettings settings={DEFAULT_SETTINGS} onUpdate={update} platform="darwin" />))

    expect(container.textContent).toContain('Close idle sessions')
    expect(container.textContent).toContain("A session's agent stops after this much idle time; reopening it resumes the same conversation.")
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Close idle sessions"]')
    expect(select?.value).toBe('5')
    expect([...select!.options].map((option) => option.textContent)).toEqual(['5 minutes', '15 minutes', '30 minutes', 'Never'])

    act(() => {
      select!.value = '0'
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(update).toHaveBeenCalledWith({ idleSessionMinutes: 0 })

    act(() => {
      select!.value = '15'
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(update).toHaveBeenCalledWith({ idleSessionMinutes: 15 })
  })

  it('offers worktree isolation or in-place branch switching', () => {
    const update = vi.fn()
    act(() => root.render(<GeneralSettings settings={DEFAULT_SETTINGS} onUpdate={update} platform="linux" />))

    const select = [...container.querySelectorAll('select')].find((candidate) => candidate.value === 'worktree')
    expect(select?.textContent).toContain('Worktrees')
    expect(select?.textContent).toContain('Branches')
    expect(container.textContent).toContain('separate folders')
    expect(container.textContent).toContain('same folder')

    act(() => {
      if (!select) return
      select.value = 'branch'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(update).toHaveBeenCalledWith({ checkoutStrategy: 'branch' })
  })
})
