// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'
import type { OmpApprovalMode } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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

describe('composer approval mode pill', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    window.sessionStorage.clear()
  })

  const pill = () => container.querySelector<HTMLButtonElement>('button.approval-mode-toggle')

  it.each<[OmpApprovalMode, string]>([
    ['inherit', 'Inherit'],
    ['always-ask', 'Ask'],
    ['write', 'Write'],
    ['yolo', 'YOLO'],
  ])('renders the %s label', (mode, label) => {
    act(() => root.render(<Composer {...props({ approvalMode: mode })} />))

    expect(pill()?.textContent).toContain(label)
  })

  it('defaults to inherit when approvalMode is omitted', () => {
    act(() => root.render(<Composer {...props()} />))

    expect(pill()?.textContent).toContain('Inherit')
    expect(pill()?.classList.contains('is-yolo')).toBe(false)
  })

  it('flags yolo with the least-safe styling and full settings tooltip', () => {
    act(() => root.render(<Composer {...props({ approvalMode: 'yolo' })} />))

    expect(pill()?.classList.contains('is-yolo')).toBe(true)
    expect(pill()?.getAttribute('title')).toBe('Approval mode: YOLO (never prompt)')
  })

  it('opens a mode menu and reports the chosen mode', () => {
    const onApprovalModeChange = vi.fn()
    act(() => root.render(<Composer {...props({ approvalMode: 'write', onApprovalModeChange })} />))

    act(() => pill()?.click())
    const menu = container.querySelector('.approval-mode__menu')
    expect(menu).not.toBeNull()
    const options = Array.from(menu?.querySelectorAll<HTMLButtonElement>('button.approval-mode__option') ?? [])
    expect(options.map((option) => option.textContent)).toEqual(['Inherit', 'Ask', 'Write', 'YOLO'])
    expect(options[2].getAttribute('aria-checked')).toBe('true')

    act(() => options[3].click())

    expect(onApprovalModeChange).toHaveBeenCalledTimes(1)
    expect(onApprovalModeChange).toHaveBeenCalledWith('yolo')
    expect(container.querySelector('.approval-mode__menu')).toBeNull()
  })

  it('offers plan and goal in the add menu and reports the chosen mode', () => {
    const onSessionModeChange = vi.fn()
    act(() => root.render(<Composer {...props({ onSessionModeChange })} />))

    act(() => (container.querySelector('button.composer-add') as HTMLButtonElement).click())
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>('.composer-menu button[role="option"]'))
    const labels = items.map((item) => item.textContent ?? '')
    expect(labels.some((item) => item.includes('Plan mode'))).toBe(true)
    expect(labels.some((item) => item.includes('Goal mode'))).toBe(true)

    const plan = items.find((item) => (item.textContent ?? '').includes('Plan mode'))
    act(() => plan?.click())
    expect(onSessionModeChange).toHaveBeenCalledWith('plan')
  })

  it('shows the active mode chip and cancels it on click', () => {
    const onSessionModeChange = vi.fn()
    act(() => root.render(<Composer {...props({ sessionMode: 'goal', onSessionModeChange })} />))

    const chip = container.querySelector<HTMLButtonElement>('button.session-mode-chip')
    expect(chip?.textContent).toContain('Goal mode')
    expect(chip?.getAttribute('title')).toBe('Turn off Goal mode')
    act(() => chip?.click())
    expect(onSessionModeChange).toHaveBeenCalledWith(null)

    act(() => root.render(<Composer {...props({ sessionMode: null })} />))
    expect(container.querySelector('button.session-mode-chip')).toBeNull()
  })
})
