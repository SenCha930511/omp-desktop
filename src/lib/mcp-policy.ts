/**
 * MCP 定義管理政策。
 *
 * OMP Desktop 管理 OMP 原生 mcp.json(~/.omp/agent/mcp.json 與專案
 * .omp/mcp.json)中的定義,對齊上游 mcp-schema.json:stdio 需要 command、
 * http/sse 需要 url,兩者互斥。上游信任 committed config、不做 SSRF 檢查;
 * GUI 比上游嚴格是加值:新增網路定義預設只接受 https,純 http 僅在
 * loopback/私有網段且使用者明示勾選後才寫入。
 *
 * 認證(OAuth / /mcp reauth / credential storage)仍由 OMP 全權擁有,
 * GUI 不經手、不檢查、不轉送認證指令。
 */

/**
 * 由已安裝套件提供、或非 mcp.json 原生的 MCP 定義:GUI 唯讀呈現。
 * 認證永遠不由 OMP Desktop 檢查或變更。
 */
export const EXTERNALLY_MANAGED_MCP_DETAIL = 'This MCP server is provided by an installed OMP plugin package and is managed outside OMP Desktop. Its definition is read-only here except explicit definition removal where supported. Authorization is never inspected or changed by OMP Desktop.'

export const NETWORK_MCP_AUTH_UNAVAILABLE = 'Network MCP authentication is managed outside OMP Desktop. Use the omp CLI directly; OMP Desktop does not inspect or change MCP credentials.'

/**
 * 定義中的 ${VAR} 與 !command 值由上游在載入 mcp.json 時解析(!command 會
 * 以 shell 執行,10 秒逾時)。OMP Desktop 一律原樣寫入與顯示,絕不代為展開。
 */
export const MCP_SECRET_EXPANSION_DETAIL = 'OMP resolves ${VAR} environment references and executes !command values as shell commands (10s timeout) when it loads mcp.json. OMP Desktop stores and shows these values verbatim and never expands them.'

export const LOCAL_MCP_STATE_UNAVAILABLE_DETAIL = 'This local MCP definition uses a key OMP Desktop cannot safely enable or disable. Its state is managed outside OMP Desktop; use the omp CLI directly. Bounded exact-definition removal remains available when supported.'

/** Exact MCP map keys above this limit stay visible but are not app-removable. */
export const MAX_MCP_DEFINITION_KEY_LENGTH = 1_024

/** 重新載入以文字 prompt 轉送上游;無專用 RPC,busy 時依現行規則排隊。 */
export const MCP_RELOAD_PROMPT = '/mcp reload'
export const PLUGINS_RELOAD_PROMPT = '/reload-plugins'

const UNSAFE_MCP_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export interface McpAuthenticationCommand {
  server?: string
}

function parsedAuthenticationCommand(match: RegExpMatchArray | null): McpAuthenticationCommand | undefined {
  if (!match) return undefined
  const server = match[1]?.trim()
  if (!server || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(server) || UNSAFE_MCP_KEYS.has(server)) return {}
  return { server }
}

/** Recognizes the authentication command OMP exposes without executing it. */
export function parseMcpAuthenticationCommand(prompt: string): McpAuthenticationCommand | undefined {
  return parsedAuthenticationCommand(prompt.trim().match(/^\/mcp\s+reauth(?:\s+([\s\S]*))?$/i))
}

/** Authentication is harness-owned, so no app-managed delivery path may forward these commands. */
export function assertNoMcpAuthenticationCommand(prompt: string): void {
  if (parseMcpAuthenticationCommand(prompt)) throw new TypeError(NETWORK_MCP_AUTH_UNAVAILABLE)
}

export function isAppManageableLocalMcpKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 64
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)
    && !UNSAFE_MCP_KEYS.has(value)
}

export function isNetworkMcpDefinition(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.type === 'http' || record.type === 'sse' || Object.hasOwn(record, 'url')
}

// --- 網路 MCP URL 政策(https 預設 / 私網警告) ---

export type McpUrlHostClass = 'loopback' | 'private' | 'link-local' | 'public'

export interface McpUrlAssessment {
  /** false 時定義不可寫入;error 為原因。 */
  ok: boolean
  error?: string
  /** https 為 true。 */
  secure: boolean
  hostClass: McpUrlHostClass
  /** 純 http 落在 loopback/私有網段:可寫入但必須向使用者明示警告。 */
  insecurePrivateHttp: boolean
}

const PRIVATE_HOST_SUFFIXES = ['.local', '.internal', '.lan', '.home', '.corp', '.intranet']

function parseIpv4(host: string): [number, number, number, number] | null {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.every((part) => part <= 255) ? [parts[0], parts[1], parts[2], parts[3]] as [number, number, number, number] : null
}

/**
 * 僅供警告分級的主機分類,不是 SSRF 防線:上游載入 committed config 時
 * 本就信任定義內容。GUI 比上游嚴格(公網必須 https)是加值,不是 parity 需求。
 */
export function classifyMcpUrlHost(hostname: string): McpUrlHostClass {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '[::1]') return 'loopback'
  const ipv4 = parseIpv4(host)
  if (ipv4) {
    const [a, b] = ipv4
    if (a === 127 || a === 0) return 'loopback'
    if (a === 169 && b === 254) return 'link-local'
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private'
    return 'public'
  }
  if (host.includes(':')) {
    const firstGroup = host.split(':')[0]
    const first = Number.parseInt(firstGroup, 16)
    if (Number.isNaN(first)) return 'public'
    if ((first & 0xfe00) === 0xfc00) return 'private' // fc00::/7 ULA
    if ((first & 0xffc0) === 0xfe80) return 'link-local' // fe80::/10
    return 'public'
  }
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'private'
  return 'public'
}

/**
 * 驗證 http/sse MCP endpoint。
 * - 僅接受 http(s) scheme;URL 內嵌帳密一律拒絕(secret 應放 headers,可用 ${VAR})。
 * - https 永遠可寫入。
 * - http 只允許 loopback/私有/link-local 位址,且呼叫端必須帶
 *   allowInsecureHttp(使用者在 UI 明示勾選);公網 http 拒絕。
 */
export function assessMcpUrl(raw: string, options: { allowInsecureHttp?: boolean } = {}): McpUrlAssessment {
  const fail = (error: string): McpUrlAssessment => ({ ok: false, error, secure: false, hostClass: 'public', insecurePrivateHttp: false })
  let url: URL
  try { url = new URL(raw) } catch { return fail('MCP endpoint URL is not a valid URL') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('MCP endpoint URL must use http or https')
  if (url.username || url.password) return fail('MCP endpoint URL must not embed credentials; put secrets in headers with ${VAR} references')
  const hostClass = classifyMcpUrlHost(url.hostname)
  const secure = url.protocol === 'https:'
  if (!secure) {
    const privateHost = hostClass === 'loopback' || hostClass === 'private' || hostClass === 'link-local'
    if (!privateHost) return fail('Public MCP endpoints must use https; plain http is only allowed for loopback or private-network addresses')
    if (!options.allowInsecureHttp) {
      return { ok: false, error: 'Plain http requires the explicit insecure-http acknowledgement', secure, hostClass, insecurePrivateHttp: true }
    }
    return { ok: true, secure, hostClass, insecurePrivateHttp: true }
  }
  return { ok: true, secure, hostClass, insecurePrivateHttp: false }
}

// --- secret 展開偵測(只偵測標示,不展開) ---

export type McpSecretExpansionKind = 'environment' | 'command'

/**
 * 偵測上游會在載入時展開的值:以 ! 開頭(shell 指令)或含 ${VAR}。
 * OMP Desktop 只用結果向使用者標示「secret 由 OMP 解析」,絕不執行展開。
 */
export function detectMcpSecretExpansion(value: string): McpSecretExpansionKind | undefined {
  if (value.startsWith('!')) return 'command'
  if (/\$\{[^}]{1,256}\}/.test(value)) return 'environment'
  return undefined
}

/** 掃描定義中會被上游展開的欄位,回傳最多 8 個欄位名稱(供 UI 標示)。 */
export function collectMcpSecretExpansionFields(definition: {
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
}): string[] {
  const fields: string[] = []
  const note = (field: string, value: string | undefined) => {
    if (typeof value === 'string' && detectMcpSecretExpansion(value) && fields.length < 8) fields.push(field)
  }
  note('url', definition.url)
  note('command', definition.command)
  for (const [index, arg] of (definition.args ?? []).slice(0, 64).entries()) note(`args[${index}]`, arg)
  for (const [key, value] of Object.entries(definition.headers ?? {}).slice(0, 32)) note(`headers.${key}`, value)
  for (const [key, value] of Object.entries(definition.env ?? {}).slice(0, 32)) note(`env.${key}`, value)
  return fields
}

/** reload 轉送:回傳交給上游文字 dispatcher 的 prompt,busy 時依現行規則排隊。 */
export function capabilityReloadPrompt(kind: 'mcp' | 'plugins'): string {
  return kind === 'mcp' ? MCP_RELOAD_PROMPT : PLUGINS_RELOAD_PROMPT
}
