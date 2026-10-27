// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useProviderAccounts, type ProviderAccountsApi } from '../../src/hooks/useProviderAccounts'
import type { DesktopApi } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PROVIDERS = {
  providers: [
    { id: 'anthropic', name: 'Anthropic', available: true, authenticated: true },
    { id: 'openai-codex', name: 'OpenAI Codex', available: true, authenticated: false },
    { id: 'device-flow', name: 'Device Flow Provider', available: false, authenticated: false },
  ],
}

const ACCOUNTS = {
  accounts: [
    { credentialId: 7, provider: 'anthropic', label: 'me@example.com', detail: 'Team plan', type: 'oauth', active: true },
    { credentialId: 3, provider: 'anthropic', label: 'CI key', detail: '', type: 'api_key', active: false },
  ],
}

let container: HTMLDivElement
let root: Root
let commandMock: Mock<(runtimeId: string, command: Record<string, unknown>) => Promise<Record<string, unknown>>>
let cancelMock: Mock<() => void>
let api: ProviderAccountsApi
let activeRuntimeId: string | undefined

function Harness(): null {
  api = useProviderAccounts({ bridge: stableBridge, activeRuntimeId, cancelActiveDialog: cancelMock })
  return null
}

let stableBridge: DesktopApi

// 無預設值:顯式傳 undefined 用來覆蓋「無 active runtime」情境。
function renderHarness(runtimeId: string | undefined): void {
  activeRuntimeId = runtimeId
  act(() => { root.render(createElement(Harness)) })
}

function commandsOf(type: string): Array<Record<string, unknown>> {
  return commandMock.mock.calls.filter((call) => (call[1] as Record<string, unknown>).type === type).map((call) => call[1] as Record<string, unknown>)
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  cancelMock = vi.fn<() => void>()
  commandMock = vi.fn(async (_runtimeId: string, command: Record<string, unknown>) => {
    if (command.type === 'get_login_providers') return { success: true, data: PROVIDERS }
    if (command.type === 'get_logout_accounts') return { success: true, data: ACCOUNTS }
    if (command.type === 'login') return { success: true, data: { providerId: String(command.providerId) } }
    if (command.type === 'logout') return { success: true, data: { remainingSource: 'env:ANTHROPIC_API_KEY' } }
    throw new Error(`unexpected command ${String(command.type)}`)
  })
  stableBridge = { agent: { command: commandMock } } as unknown as DesktopApi
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

// 無預設值:呼叫端一律顯式指定 runtime(含 undefined 案例)。
async function mountAndSettle(runtimeId: string | undefined): Promise<void> {
  renderHarness(runtimeId)
  await act(async () => { await Promise.resolve() })
}

describe('useProviderAccounts provider listing', () => {
  it('loads providers for the active runtime on mount', async () => {
    await mountAndSettle('runtime-a')
    expect(api.status).toBe('ready')
    expect(api.providers).toEqual(PROVIDERS.providers)
    expect(commandsOf('get_login_providers')).toEqual([{ type: 'get_login_providers' }])
  })

  it('stays idle without an active runtime and sends no RPC', async () => {
    await mountAndSettle(undefined)
    expect(api.status).toBe('idle')
    expect(api.providers).toEqual([])
    expect(commandMock).not.toHaveBeenCalled()
  })

  it('reports malformed replies as invalid-data instead of caching them', async () => {
    commandMock.mockResolvedValueOnce({ success: true, data: { providers: 'upstream-bug' } })
    await mountAndSettle('runtime-a')
    expect(api.status).toBe('error')
    expect(api.error).toEqual({ kind: 'invalid-data' })
  })
})

describe('useProviderAccounts login flow shell', () => {
  it('sends a bare login command, clears in-flight state, and refreshes on success', async () => {
    await mountAndSettle('runtime-a')
    let pending: Promise<void> | undefined
    act(() => { pending = api.beginLogin('openai-codex') })
    expect(api.loginInFlight?.providerId).toBe('openai-codex')
    // 憑證 OMP custody 斷言:login RPC 只攜帶 type+providerId,絕無祕密欄位。
    expect(commandsOf('login')).toEqual([{ type: 'login', providerId: 'openai-codex' }])
    await act(async () => { await pending })
    expect(api.loginInFlight).toBeNull()
    expect(api.noticeKey).toBe('plugins.providerLoggedIn')
    expect(api.error).toBeNull()
    // mount 一次 + 成功後回讀一次
    expect(commandsOf('get_login_providers').length).toBe(2)
  })

  it('surfaces upstream failure text without retaining anything else', async () => {
    commandMock.mockImplementation(async (_runtimeId: string, command: Record<string, unknown>) => {
      if (command.type === 'login') return { success: false, error: 'This provider requires the terminal UI' }
      if (command.type === 'get_login_providers') return { success: true, data: PROVIDERS }
      throw new Error('unexpected')
    })
    await mountAndSettle('runtime-a')
    let pending: Promise<void> | undefined
    act(() => { pending = api.beginLogin('anthropic') })
    await act(async () => { await pending })
    expect(api.loginInFlight).toBeNull()
    expect(api.error).toEqual({ kind: 'upstream', message: 'This provider requires the terminal UI' })
    expect(api.noticeKey).toBeNull()
  })

  it('classifies RPC delivery timeouts as timeout errors', async () => {
    commandMock.mockImplementation(async (_runtimeId: string, command: Record<string, unknown>) => {
      if (command.type === 'login') throw new Error('RPC command login timed out after delivery; the agent may still run it — do not retry automatically')
      if (command.type === 'get_login_providers') return { success: true, data: PROVIDERS }
      throw new Error('unexpected')
    })
    await mountAndSettle('runtime-a')
    let pending: Promise<void> | undefined
    act(() => { pending = api.beginLogin('anthropic') })
    await act(async () => { await pending })
    expect(api.error?.kind).toBe('timeout')
    expect(api.loginInFlight).toBeNull()
  })

  it('cancelLogin rides the dialog-cancel channel only while a flow is in flight', async () => {
    await mountAndSettle('runtime-a')
    act(() => { api.cancelLogin() })
    expect(cancelMock).not.toHaveBeenCalled()
    // login 不回應:進行中狀態維持,取消由 dialog cancel 讓上游中止 flow。
    commandMock.mockImplementation(async (_runtimeId: string, command: Record<string, unknown>) => {
      if (command.type === 'login') return new Promise(() => undefined)
      if (command.type === 'get_login_providers') return { success: true, data: PROVIDERS }
      throw new Error('unexpected')
    })
    let pending: Promise<void> | undefined
    act(() => { pending = api.beginLogin('anthropic') })
    expect(api.loginInFlight?.providerId).toBe('anthropic')
    act(() => { api.cancelLogin() })
    expect(cancelMock).toHaveBeenCalledTimes(1)
    // 上游中止後 login RPC 以失敗收尾,本地狀態由該回應清乾淨;這裡 promise
    // 仍 pending,本地狀態不能自行偽造完成。
    expect(api.loginInFlight?.providerId).toBe('anthropic')
    void pending
  })
})

describe('useProviderAccounts logout management', () => {
  it('loads stored credentials and drops nothing into unexpected keys', async () => {
    await mountAndSettle('runtime-a')
    await act(async () => { await api.loadAccounts('anthropic') })
    expect(commandsOf('get_logout_accounts')).toEqual([{ type: 'get_logout_accounts', providerId: 'anthropic' }])
    expect(api.accountsByProvider.anthropic).toEqual(ACCOUNTS.accounts)
    expect(JSON.stringify(api.accountsByProvider)).not.toContain('token')
  })

  it('sends logout with credentialId, shows the remaining source, and refreshes', async () => {
    await mountAndSettle('runtime-a')
    await act(async () => { await api.loadAccounts('anthropic') })
    await act(async () => { await api.logout('anthropic', 7) })
    expect(commandsOf('logout')).toEqual([{ type: 'logout', providerId: 'anthropic', credentialId: 7 }])
    expect(api.noticeKey).toBe('plugins.providerRemainingSource')
    expect(api.noticeValues).toEqual({ source: 'env:ANTHROPIC_API_KEY' })
    // logout 後回讀帳號清單與 provider 清單。
    expect(commandsOf('get_logout_accounts').length).toBe(2)
    expect(commandsOf('get_login_providers').length).toBe(2)
  })

  it('reports logout failure without clearing stored accounts', async () => {
    commandMock.mockImplementation(async (_runtimeId: string, command: Record<string, unknown>) => {
      if (command.type === 'logout') return { success: false, error: 'The credential is no longer stored' }
      if (command.type === 'get_logout_accounts') return { success: true, data: ACCOUNTS }
      if (command.type === 'get_login_providers') return { success: true, data: PROVIDERS }
      throw new Error('unexpected')
    })
    await mountAndSettle('runtime-a')
    await act(async () => { await api.loadAccounts('anthropic') })
    await act(async () => { await api.logout('anthropic', 3) })
    expect(api.error).toEqual({ kind: 'upstream', message: 'The credential is no longer stored' })
    expect(api.accountsByProvider.anthropic).toEqual(ACCOUNTS.accounts)
    expect(api.noticeKey).toBeNull()
  })
})

describe('useProviderAccounts runtime switching', () => {
  it('drops the previous runtime snapshot when the active runtime changes', async () => {
    await mountAndSettle('runtime-a')
    expect(api.providers.length).toBe(3)
    await act(async () => { await api.loadAccounts('anthropic') })
    renderHarness('runtime-b')
    await act(async () => { await Promise.resolve() })
    expect(api.providers).toEqual(PROVIDERS.providers)
    expect(api.accountsByProvider).toEqual({})
    // runtime-b 重新查詢,而非沿用 runtime-a 的快照。
    expect(commandsOf('get_login_providers').length).toBe(2)
  })
})
