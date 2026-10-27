import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageKey } from '@/lib/i18n'
import type { DesktopApi } from '@/types/api'
import {
  LOGIN_FLOW_TIMEOUT_MS,
  parseLoginProviders,
  parseLoginResult,
  parseLogoutAccounts,
  parseLogoutResult,
  type LoginProvider,
  type LogoutAccount,
} from '@/lib/provider-accounts'

interface UseProviderAccountsOptions {
  bridge: DesktopApi | null
  /** 登入/登出 RPC 與 extension_ui 流程都掛在目前工作階段的 runtime 上。 */
  activeRuntimeId: string | undefined
  /** 取消登入流程:App 注入,對上游等待中的 input dialog 回
   * extension_ui_response cancelled(上游中止 OAuth flow)。 */
  cancelActiveDialog?: () => void
  reportError?(error: unknown): void
}

export type ProviderAccountError = { kind: 'invalid-data' } | { kind: 'timeout' } | { kind: 'upstream'; message: string }

export interface LoginProgress {
  providerId: string
  startedAt: number
  deadlineAt: number
}

export interface ProviderAccountsApi {
  /** 已依白名單欄位解析的 provider 清單(GUI 只持有非機敏欄位)。 */
  providers: LoginProvider[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 上一個操作失敗訊息;i18n 化的結構或上游原文(上游錯誤不含祕密)。 */
  error: ProviderAccountError | null
  /** 登入流程進行中的狀態;RPC 結束或逾時後清空。 */
  loginInFlight: LoginProgress | null
  /** 最近一次成功操作的提示(logout 後仍生效的 auth 來源等)。 */
  noticeKey: MessageKey | null
  noticeValues: Record<string, string | number> | undefined
  accountsByProvider: Record<string, LogoutAccount[]>
  accountsLoadingProvider: string | null
  refresh(): Promise<void>
  beginLogin(providerId: string): Promise<void>
  cancelLogin(): void
  loadAccounts(providerId: string): Promise<void>
  logout(providerId: string, credentialId: number): Promise<void>
}

function upstreamErrorMessage(response: Record<string, unknown>, fallback: string): string {
  return typeof response.error === 'string' && response.error.length > 0 && response.error.length <= 1024 ? response.error : fallback
}

function classifyRejection(reason: unknown): ProviderAccountError {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/timed out/i.test(message)) return { kind: 'timeout' }
  return { kind: 'upstream', message: message.slice(0, 1024) }
}

/**
 * Provider 帳號(對應 TUI /login /logout)的 GUI 驅動殼。
 *
 * 職責邊界(憑證 OMP custody,見 src/lib/provider-accounts.ts 匯頭註解):
 * - 送出 login / get_login_providers / get_logout_accounts / logout RPC,
 *   回覆一律經白名單解析器,GUI 狀態不含任何 token/祕密欄位。
 * - 登入流程本體由既有 extension_ui 接管:open_url(瀏覽器授權頁,僅
 *   http/https 可達外部連結面)與 input dialog(授權碼回填);本 hook 只
 *   追蹤進行中狀態與逾時,不經手流程內容。
 * - 取消由使用者透過 dialog 的 Cancel(或 cancelLogin,cancel 拆掉
 *   dialog 後由 App 注入的 cancelActiveDialog 送出 cancelled 回應),
 *   上游中止 flow 並以失敗回應 login。
 */
export function useProviderAccounts({ bridge, activeRuntimeId, cancelActiveDialog, reportError }: UseProviderAccountsOptions): ProviderAccountsApi {
  const usable = Boolean(bridge && activeRuntimeId)
  const [providers, setProviders] = useState<LoginProvider[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<ProviderAccountError | null>(null)
  const [loginInFlight, setLoginInFlight] = useState<LoginProgress | null>(null)
  const [noticeKey, setNoticeKey] = useState<MessageKey | null>(null)
  const [noticeValues, setNoticeValues] = useState<Record<string, string | number> | undefined>(undefined)
  const [accountsByProvider, setAccountsByProvider] = useState<Record<string, LogoutAccount[]>>({})
  const [accountsLoadingProvider, setAccountsLoadingProvider] = useState<string | null>(null)
  const runtimeIdRef = useRef(activeRuntimeId)
  // latest-value ref:callback 一律對「目前的」active runtime 送 RPC。
  runtimeIdRef.current = activeRuntimeId
  // 進行中的 login attempt 代號;runtime 切換或後續 attempt 使舊結果失效。
  const loginAttemptRef = useRef(0)
  const cancelActiveDialogRef = useRef(cancelActiveDialog)
  cancelActiveDialogRef.current = cancelActiveDialog
  const loginInFlightRef = useRef<LoginProgress | null>(null)
  loginInFlightRef.current = loginInFlight

  const resetForRuntime = useCallback(() => {
    loginAttemptRef.current += 1
    setProviders([])
    setStatus('idle')
    setError(null)
    setLoginInFlight(null)
    setNoticeKey(null)
    setNoticeValues(undefined)
    setAccountsByProvider({})
    setAccountsLoadingProvider(null)
  }, [])

  const refresh = useCallback(async () => {
    const runtimeId = runtimeIdRef.current
    if (!bridge || !runtimeId) { resetForRuntime(); return }
    setStatus('loading')
    try {
      const response = await bridge.agent.command(runtimeId, { type: 'get_login_providers' })
      if (runtimeIdRef.current !== runtimeId) return
      if (response.success !== true) throw new Error(upstreamErrorMessage(response, 'OMP could not list login providers'))
      const parsed = parseLoginProviders(response.data)
      if (!parsed) { setStatus('error'); setError({ kind: 'invalid-data' }); return }
      setError(null)
      setProviders(parsed)
      setStatus('ready')
    } catch (reason) {
      if (runtimeIdRef.current !== runtimeId) return
      setStatus('error')
      setError(classifyRejection(reason))
    }
  }, [bridge, resetForRuntime])

  const loadAccounts = useCallback(async (providerId: string) => {
    const runtimeId = runtimeIdRef.current
    if (!bridge || !runtimeId) return
    setAccountsLoadingProvider(providerId)
    try {
      const response = await bridge.agent.command(runtimeId, { type: 'get_logout_accounts', providerId })
      if (runtimeIdRef.current !== runtimeId) return
      if (response.success !== true) throw new Error(upstreamErrorMessage(response, 'OMP could not list stored credentials'))
      const parsed = parseLogoutAccounts(response.data)
      if (!parsed) { setError({ kind: 'invalid-data' }); return }
      setError(null)
      setAccountsByProvider((current) => ({ ...current, [providerId]: parsed }))
    } catch (reason) {
      if (runtimeIdRef.current !== runtimeId) return
      setError(classifyRejection(reason))
    } finally {
      if (runtimeIdRef.current === runtimeId) setAccountsLoadingProvider(null)
    }
  }, [bridge])

  const beginLogin = useCallback(async (providerId: string) => {
    const runtimeId = runtimeIdRef.current
    if (!bridge || !runtimeId) return
    loginAttemptRef.current += 1
    const attempt = loginAttemptRef.current
    const startedAt = Date.now()
    setLoginInFlight({ providerId, startedAt, deadlineAt: startedAt + LOGIN_FLOW_TIMEOUT_MS })
    setError(null)
    setNoticeKey(null)
    setNoticeValues(undefined)
    try {
      // 600s:runtime 端逾時與上游 OAuth flow 同長;open_url/input 事件由
      // 既有 extension_ui 管線呈現,本 hook 不經手內容。
      const response = await bridge.agent.command(runtimeId, { type: 'login', providerId })
      if (loginAttemptRef.current !== attempt) return
      if (response.success !== true) throw new Error(upstreamErrorMessage(response, 'Login failed'))
      // 回覆只應含 providerId;經白名單解析器確認,多餘欄位在此丟棄。
      const result = parseLoginResult(response.data)
      setLoginInFlight(null)
      setNoticeKey(result ? 'plugins.providerLoggedIn' : 'plugins.providerAccountsRefreshed')
      setNoticeValues(undefined)
      await refresh()
    } catch (reason) {
      if (loginAttemptRef.current !== attempt) return
      setLoginInFlight(null)
      // 失敗/取消後 provider 狀態可能已變(部分完成或上游中止),回讀一次;
      // 先回讀再上錯誤——refresh 成功路徑會清 error,順序反了會把剛記下的
      // 失敗原因抹掉。
      const classified = classifyRejection(reason)
      await refresh()
      if (loginAttemptRef.current !== attempt) return
      setError(classified)
    }
  }, [bridge, refresh])

  const cancelLogin = useCallback(() => {
    // 取消 = 拆 dialog(cancelled 回應)→ 上游中止 flow。local 狀態仍然
    // 等 login RPC 的失敗回應收尾,以免與上游 flow 狀態漂移。
    if (!loginInFlightRef.current) return
    cancelActiveDialogRef.current?.()
  }, [])

  const logout = useCallback(async (providerId: string, credentialId: number) => {
    const runtimeId = runtimeIdRef.current
    if (!bridge || !runtimeId) return
    setError(null)
    setNoticeKey(null)
    setNoticeValues(undefined)
    try {
      const response = await bridge.agent.command(runtimeId, { type: 'logout', providerId, credentialId })
      if (runtimeIdRef.current !== runtimeId) return
      if (response.success !== true) throw new Error(upstreamErrorMessage(response, 'Logout failed'))
      // 只回存 remainingSource(上游指明 logout 後仍生效的 auth 來源)。
      const result = parseLogoutResult(response.data)
      setNoticeKey(result.remainingSource !== undefined ? 'plugins.providerRemainingSource' : 'plugins.providerLoggedOut')
      setNoticeValues(result.remainingSource !== undefined ? { source: result.remainingSource } : undefined)
      await loadAccounts(providerId)
      await refresh()
    } catch (reason) {
      if (runtimeIdRef.current !== runtimeId) return
      setError(classifyRejection(reason))
      reportError?.(reason)
    }
  }, [bridge, loadAccounts, refresh, reportError])

  // runtime 切換時捨棄前一個 runtime 的 provider/帳號快照與登入進度;
  // 可用時立即回讀 provider 清單。
  const previousRuntimeIdRef = useRef(activeRuntimeId)
  useEffect(() => {
    if (previousRuntimeIdRef.current !== activeRuntimeId) {
      previousRuntimeIdRef.current = activeRuntimeId
      resetForRuntime()
    }
    if (usable) void refresh()
    else resetForRuntime()
  }, [activeRuntimeId, usable, refresh, resetForRuntime])

  return {
    providers,
    status,
    error,
    loginInFlight,
    noticeKey,
    noticeValues,
    accountsByProvider,
    accountsLoadingProvider,
    refresh,
    beginLogin,
    cancelLogin,
    loadAccounts,
    logout,
  }
}
