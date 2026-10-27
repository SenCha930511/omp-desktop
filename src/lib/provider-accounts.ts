/**
 * Provider OAuth 帳號面板的線框解析與安全邊界。
 *
 * 憑證歸屬屬於 **OMP custody**:access/refresh token 存 OMP 自己的 auth
 * storage(~/.omp 的 auth broker),與 TUI/CLI 共用。GUI 只是驅動殼——
 * 這個模組刻意只白名單保留下列欄位,**任何回覆/事件裡的多餘欄位(包括
 * 上游未來誤增的祕密欄位)一律在解析時丟棄**,不會存進 GUI 狀態、
 * React state、localStorage 或日誌:
 * - LoginProvider:id / name / available / authenticated(上游
 *   rpc-types.ts get_login_providers 回覆;全都非機敏)。
 * - LogoutAccount:credentialId / provider / label / detail / type /
 *   active(上游 get_logout_accounts 回覆;label/detail 是上游產生的
 *   人讀摘要,不含 token)。
 * - login 回覆只有 providerId;logout 回覆只有 remainingSource。
 * GUI 也絕不發送任何祕密欄位:登入流程的授權碼經既有 extension_ui
 * input dialog 回傳上游(上游對 secret: true 提示一律拒絕 RPC 客戶端,
 * 因此祕密永遠不會到達 renderer)。
 */

/** 上游 OAuth 流程的逾時(rpc.md:login timeoutMs 600_000)。 */
export const LOGIN_FLOW_TIMEOUT_MS = 600_000

export interface LoginProvider {
  id: string
  name: string
  available: boolean
  authenticated: boolean
}

export interface LogoutAccount {
  credentialId: number
  provider: string
  label: string
  detail: string
  type: 'api_key' | 'oauth'
  active: boolean
}

export interface LogoutResult {
  remainingSource?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const stringField = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.length <= max ? value : undefined)

function parseLoginProvider(raw: unknown): LoginProvider | undefined {
  if (!isRecord(raw)) return undefined
  const id = stringField(raw.id, 128)
  const name = stringField(raw.name, 128)
  if (!id || !name) return undefined
  return { id, name, available: raw.available === true, authenticated: raw.authenticated === true }
}

/** 解析 get_login_providers 回覆 data({ providers: [...] });形狀不符回 undefined。 */
export function parseLoginProviders(data: unknown): LoginProvider[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.providers)) return undefined
  const providers = data.providers.slice(0, 256).flatMap((raw: unknown) => {
    const provider = parseLoginProvider(raw)
    return provider ? [provider] : []
  })
  return providers
}

/** 解析 login 回覆 data({ providerId });僅回傳 providerId,不保留任何其他欄位。 */
export function parseLoginResult(data: unknown): { providerId: string } | undefined {
  if (!isRecord(data)) return undefined
  const providerId = stringField(data.providerId, 128)
  return providerId ? { providerId } : undefined
}

function parseLogoutAccount(raw: unknown): LogoutAccount | undefined {
  if (!isRecord(raw)) return undefined
  const credentialId = raw.credentialId
  const provider = stringField(raw.provider, 128)
  const label = stringField(raw.label, 256)
  const detail = stringField(raw.detail, 512)
  if (!Number.isSafeInteger(credentialId) || (credentialId as number) <= 0 || !provider || label === undefined || detail === undefined) return undefined
  if (raw.type !== 'api_key' && raw.type !== 'oauth') return undefined
  return { credentialId: credentialId as number, provider, label, detail, type: raw.type, active: raw.active === true }
}

/** 解析 get_logout_accounts 回覆 data({ accounts: [...] });形狀不符回 undefined。 */
export function parseLogoutAccounts(data: unknown): LogoutAccount[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.accounts)) return undefined
  return data.accounts.slice(0, 256).flatMap((raw: unknown) => {
    const account = parseLogoutAccount(raw)
    return account ? [account] : []
  })
}

/** 解析 logout 回覆 data({ remainingSource? });僅保留 remainingSource。 */
export function parseLogoutResult(data: unknown): LogoutResult {
  if (!isRecord(data)) return {}
  const remainingSource = stringField(data.remainingSource, 256)
  return remainingSource !== undefined ? { remainingSource } : {}
}
