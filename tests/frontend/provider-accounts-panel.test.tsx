// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ProviderAccountsPanel, type ProviderAccountsPanelProps } from '../../src/components/ProviderAccountsPanel'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const providers = [
  { id: 'anthropic', name: 'Anthropic', available: true, authenticated: true },
  { id: 'openai-codex', name: 'OpenAI Codex', available: true, authenticated: false },
  { id: 'device-flow', name: 'Device Flow Provider', available: false, authenticated: false },
]

const accounts = {
  anthropic: [
    { credentialId: 7, provider: 'anthropic', label: 'me@example.com', detail: 'Team plan', type: 'oauth' as const, active: true },
    { credentialId: 3, provider: 'anthropic', label: 'CI key', detail: '', type: 'api_key' as const, active: false },
  ],
}

let onLogin: Mock<(providerId: string) => void>
let onCancelLogin: Mock<() => void>
let onLoadAccounts: Mock<(providerId: string) => void>
let onLogout: Mock<(providerId: string, credentialId: number) => void>
let onRefresh: Mock<() => void>

function baseProps(overrides: Partial<ProviderAccountsPanelProps> = {}): ProviderAccountsPanelProps {
  return {
    usable: true,
    providers,
    status: 'ready',
    error: null,
    loginInFlight: null,
    noticeKey: null,
    noticeValues: undefined,
    accountsByProvider: {},
    accountsLoadingProvider: null,
    onRefresh,
    onLogin,
    onCancelLogin,
    onLoadAccounts,
    onLogout,
    ...overrides,
  }
}

function renderPanel(props: ProviderAccountsPanelProps): void {
  act(() => { root.render(createElement(ProviderAccountsPanel, props)) })
}

function buttonByText(text: string): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button'))
  const hit = buttons.find((button) => button.textContent?.trim() === text || button.getAttribute('aria-label')?.trim() === text)
  if (!(hit instanceof HTMLButtonElement)) throw new Error(`button ${text} not found`)
  return hit
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  onLogin = vi.fn()
  onCancelLogin = vi.fn()
  onLoadAccounts = vi.fn()
  onLogout = vi.fn()
  onRefresh = vi.fn()
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

describe('ProviderAccountsPanel', () => {
  it('shows the custody note and requires a session without a runtime', () => {
    renderPanel(baseProps({ usable: false, providers: [] }))
    expect(container.textContent).toContain('never pass through the app')
    expect(container.textContent).toContain('Start or select a session')
    expect(container.querySelectorAll('button').length).toBe(0)
  })

  it('lists providers with availability/authentication badges and login actions', () => {
    renderPanel(baseProps())
    expect(container.textContent).toContain('Anthropic')
    expect(container.textContent).toContain('Signed in')
    expect(container.textContent).toContain('Not signed in')
    expect(container.textContent).toContain('Unavailable')
    const signInButtons = Array.from(container.querySelectorAll('button')).filter((button) => button.textContent?.trim().startsWith('Sign in'))
    // 三個 provider 都有登入按鈕;unavailable 的不可點。
    expect(signInButtons.length).toBe(3)
    expect(signInButtons[2]?.disabled).toBe(true)
    act(() => { buttonByText('Sign in').click() })
    expect(onLogin).toHaveBeenCalledWith('anthropic')
  })

  it('shows in-flight state and routes cancel through the dialog channel', () => {
    renderPanel(baseProps({ loginInFlight: { providerId: 'anthropic', startedAt: 1_000, deadlineAt: 601_000 } }))
    expect(container.textContent).toContain('Waiting for authorization')
    // 進行中時不顯示其他 provider 的登入按鈕(一次一個流程)。
    expect(buttonByText('Cancel')).toBeTruthy()
    act(() => { buttonByText('Cancel').click() })
    expect(onCancelLogin).toHaveBeenCalledTimes(1)
  })

  it('expands stored accounts per provider and confirms before logout', () => {
    renderPanel(baseProps())
    act(() => { buttonByText('Manage credentials').click() })
    expect(onLoadAccounts).toHaveBeenCalledWith('anthropic')
    renderPanel(baseProps({ accountsByProvider: accounts }))
    // 已展開狀態跨 render 保留(內部 state),account 資料由 props 補上。
    expect(container.textContent).toContain('me@example.com')
    expect(container.textContent).toContain('OAuth · active')
    act(() => { buttonByText('Sign out me@example.com').click() })
    // 點一次只進入確認狀態,不直接登出。
    expect(onLogout).not.toHaveBeenCalled()
    act(() => { buttonByText('Confirm sign out').click() })
    expect(onLogout).toHaveBeenCalledWith('anthropic', 7)
  })

  it('dismisses the logout confirmation without calling onLogout', () => {
    renderPanel(baseProps())
    act(() => { buttonByText('Manage credentials').click() })
    renderPanel(baseProps({ accountsByProvider: accounts }))
    act(() => { buttonByText('Sign out me@example.com').click() })
    act(() => { buttonByText('Keep credential').click() })
    expect(onLogout).not.toHaveBeenCalled()
    // 取消確認後登出按鈕須回來(aria-label 帶帳號名稱;textContent 不含 aria-label,
    // 不能用 textContent 斷言)。
    buttonByText('Sign out me@example.com')
  })

  it('shows notices such as a post-logout remaining source', () => {
    renderPanel(baseProps({ noticeKey: 'plugins.providerRemainingSource', noticeValues: { source: 'env:ANTHROPIC_API_KEY' } }))
    expect(container.textContent).toContain('Provider stays signed in via env:ANTHROPIC_API_KEY')
  })

  it('shows structured errors localized; upstream text passes through verbatim', () => {
    renderPanel(baseProps({ error: { kind: 'invalid-data' } }))
    expect(container.textContent).toContain('unexpected provider data')
    renderPanel(baseProps({ error: { kind: 'timeout' } }))
    expect(container.textContent).toContain('timed out')
    renderPanel(baseProps({ error: { kind: 'upstream', message: 'provider requires the terminal UI' } }))
    expect(container.textContent).toContain('provider requires the terminal UI')
  })
})
