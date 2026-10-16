// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoHarnessPrompt } from '../../src/components/NoHarnessPrompt'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('NoHarnessPrompt', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    container.className = 'app-shell'
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('explains recovery options and opens Harness settings from the primary action', async () => {
    const onOpenHarnessSettings = vi.fn()
    await act(async () => root.render(<NoHarnessPrompt onClose={vi.fn()} onOpenHarnessSettings={onOpenHarnessSettings} />))

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('OMP is not installed')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('OMP Desktop couldn’t find OMP. Install it to get started.')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('configure its executable path in Harness settings')

    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === 'Take me there')!
    await act(async () => button.click())
    expect(onOpenHarnessSettings).toHaveBeenCalledTimes(1)
  })
})
