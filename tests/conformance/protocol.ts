export const CONFORMANCE_PROTOCOL_VERSION = 1

export const CONFORMANCE_CAPABILITIES = ['state', 'projects', 'sessions', 'models', 'agent', 'git', 'checkouts', 'plugins', 'schedules', 'collaboration', 'terminal'] as const

export type ConformanceCapability = (typeof CONFORMANCE_CAPABILITIES)[number]

export interface ConformanceRequest {
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface ConformanceErrorPayload {
  code: string
  message: string
}

export type ConformanceResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: ConformanceErrorPayload }

export interface AdapterInfo {
  protocolVersion: number
  implementation: string
  platform: string
  capabilities: string[]
}

export interface WorkspaceResetParams {
  rootDir: string
  homeDir: string
  userDataDir: string
  appDataDir: string
  ompExecutable: string
  platformOverride?: 'darwin' | 'linux' | 'win32'
  autoOpen?: boolean
  extraEnv?: Record<string, string>
}
