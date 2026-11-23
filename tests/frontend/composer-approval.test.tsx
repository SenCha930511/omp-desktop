// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'
import { I18nProvider } from '../../src/lib/i18n'
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
    ['always-ask-cached', 'Ask (cached)'],
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
    expect(options.map((option) => option.textContent)).toEqual(['Inherit', 'Ask', 'Ask (cached)', 'Write', 'YOLO'])
    expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false', 'true', 'false'])

    act(() => options[4].click())

    expect(onApprovalModeChange).toHaveBeenCalledTimes(1)
    expect(onApprovalModeChange).toHaveBeenCalledWith('yolo')
    expect(container.querySelector('.approval-mode__menu')).toBeNull()
  })

  it.each([
    ['en', 'Ask (cached)', 'Approval mode: Always ask (cached)', "Use OMP's native cached-approval prompts when a new runtime starts. Running sessions are unchanged."],
    ['zh-TW', '詢問（快取）', '核准模式：一律詢問（快取）', '在新執行環境啟動時使用 OMP 原生的快取核准提示。現有工作階段不受影響。'],
    ['zh-CN', '询问（缓存）', '核准模式：总是询问（缓存）', '在新运行环境启动时使用 OMP 原生的缓存批准提示。现有会话不受影响。'],
  ] as const)('renders the cached label, title, and tooltip in %s', (locale, label, title, description) => {
    act(() => root.render(
      <I18nProvider preference={locale}>
        <Composer {...props({ approvalMode: 'always-ask-cached' })} />
      </I18nProvider>,
    ))

    expect(pill()?.textContent).toContain(label)
    expect(pill()?.getAttribute('title')).toBe(title)
    act(() => pill()?.click())
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('button.approval-mode__option'))
    expect(options).toHaveLength(5)
    expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false', 'false'])
    const cachedOption = options.find((option) => option.textContent === label)
    expect(cachedOption?.getAttribute('title')).toBe(description)
  })

  it('changes only to the exact cached setting without invoking prompt or runtime callbacks', () => {
    const onApprovalModeChange = vi.fn()
    const onSend = vi.fn()
    const onContinue = vi.fn()
    const onStop = vi.fn()
    act(() => root.render(<Composer {...props({ approvalMode: 'write', onApprovalModeChange, onSend, onContinue, onStop })} />))

    act(() => pill()?.click())
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('button.approval-mode__option'))
    options[2].focus()
    expect(document.activeElement).toBe(options[2])
    act(() => options[2].click())

    expect(onApprovalModeChange).toHaveBeenCalledExactlyOnceWith('always-ask-cached')
    expect(pill()?.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(pill())
    expect(onSend).not.toHaveBeenCalled()
    expect(onContinue).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
    expect(container.querySelector('.approval-mode__menu')).toBeNull()
  })
})
