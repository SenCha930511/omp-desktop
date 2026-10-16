
/**
 * OMP Desktop does not own the network transport or OAuth discovery performed
 * by OMP. Keep network MCP management outside the app instead of implying
 * that selected app-side validation can secure an upstream runtime.
 */
export const NETWORK_MCP_UNAVAILABLE_DETAIL = 'Network MCP servers are managed outside OMP Desktop. OMP Desktop does not create, enable, disable, or authenticate HTTP/SSE servers; use the omp CLI directly. Externally configured definitions are read-only here except explicit definition removal. Authorization is never inspected or changed by OMP Desktop.'

export const NETWORK_MCP_AUTH_UNAVAILABLE = 'Network MCP authentication is managed outside OMP Desktop. Use the omp CLI directly; OMP Desktop does not inspect or change MCP credentials.'

export const LOCAL_MCP_STATE_UNAVAILABLE_DETAIL = 'This local MCP definition uses a key OMP Desktop cannot safely enable or disable. Its state is managed outside OMP Desktop; use the omp CLI directly. Bounded exact-definition removal remains available when supported.'

/** Exact MCP map keys above this limit stay visible but are not app-removable. */
export const MAX_MCP_DEFINITION_KEY_LENGTH = 1_024

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
