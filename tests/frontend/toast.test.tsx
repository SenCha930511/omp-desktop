// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '../../src/components/CommandPalette'
import { TOAST_DURATION_MS, TOAST_ERROR_DURATION_MS, type ToastTone, useToast } from '../../src/hooks/useToast'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useToast', () => {
  it('clears each notification after 2.5 seconds and restarts for a replacement', async () => {
    let setToast!: (toast: string | null) => void
    function ToastProbe() {
      const state = useToast()
      setToast = state.setToast
      return <>{state.toast}</>
    }

    await act(async () => { root.render(<ToastProbe />) })
    await act(async () => { setToast('Session archived.') })
    expect(container.textContent).toBe('Session archived.')

    await act(async () => { vi.advanceTimersByTime(TOAST_DURATION_MS - 1) })
    expect(container.textContent).toBe('Session archived.')

    await act(async () => { setToast('Session restored.') })
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(container.textContent).toBe('Session restored.')

    await act(async () => { vi.advanceTimersByTime(TOAST_DURATION_MS) })
    expect(container.textContent).toBe('')
  })

  it('keeps error toasts visible for 5 seconds and infers error tone from failure messages', async () => {
    let setToast!: (toast: string | null, tone?: ToastTone) => void
    let currentTone!: ToastTone
    function ToastProbe() {
      const state = useToast()
      setToast = state.setToast
      currentTone = state.toastTone
      return <>{state.toast}</>
    }

    await act(async () => { root.render(<ToastProbe />) })
    await act(async () => { setToast('Failed to connect to runtime.') })
    expect(container.textContent).toBe('Failed to connect to runtime.')
    expect(currentTone).toBe('error')

    await act(async () => { vi.advanceTimersByTime(TOAST_DURATION_MS) })
    expect(container.textContent).toBe('Failed to connect to runtime.')

    await act(async () => { vi.advanceTimersByTime(TOAST_ERROR_DURATION_MS - TOAST_DURATION_MS - 1) })
    expect(container.textContent).toBe('Failed to connect to runtime.')

    await act(async () => { vi.advanceTimersByTime(1) })
    expect(container.textContent).toBe('')
    expect(currentTone).toBe('info')
  })

  it('pauses the dismissal timer while hovered and resumes when hover ends', async () => {
    let setToast!: (toast: string | null, tone?: ToastTone) => void
    let setToastHovered!: (hovered: boolean) => void
    function ToastProbe() {
      const state = useToast()
      setToast = state.setToast
      setToastHovered = state.setToastHovered
      return <>{state.toast}</>
    }

    await act(async () => { root.render(<ToastProbe />) })
    await act(async () => { setToast('Saved settings.') })
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(container.textContent).toBe('Saved settings.')

    await act(async () => { setToastHovered(true) })
    await act(async () => { vi.advanceTimersByTime(TOAST_DURATION_MS * 3) })
    expect(container.textContent).toBe('Saved settings.')

    await act(async () => { setToastHovered(false) })
    await act(async () => { vi.advanceTimersByTime(TOAST_DURATION_MS - 1) })
    expect(container.textContent).toBe('Saved settings.')

    await act(async () => { vi.advanceTimersByTime(1) })
    expect(container.textContent).toBe('')
  })
})

describe('CommandPalette keyboard looping', () => {
  it('wraps active selection between the first and last command on ArrowUp and ArrowDown', async () => {
    const noop = () => {}
    await act(async () => {
      root.render(
        <CommandPalette
          open={true}
          platform="darwin"
          onClose={noop}
          onNavigate={noop}
          onNewSession={noop}
          onToggleSidebar={noop}
          onToggleTerminal={noop}
          onOpenBrowser={noop}
        />,
      )
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const options = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button[role="option"]'))
    expect(input).not.toBeNull()
    expect(options.length).toBeGreaterThan(1)
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    })
    expect(options[options.length - 1]?.getAttribute('aria-selected')).toBe('true')
    expect(input?.getAttribute('aria-activedescendant')).toBe(options[options.length - 1]?.id)

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    expect(input?.getAttribute('aria-activedescendant')).toBe(options[0]?.id)
  })
})
