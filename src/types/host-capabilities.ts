export interface HostOpenUrlPending {
  readonly requestId: string
  readonly kind: 'open-url'
  readonly url: string
}

export interface HostAuthorizationSnapshot {
  readonly runtimeId: string
  readonly registrationGeneration: number
  readonly pending: HostOpenUrlPending | null
}

export interface HostAuthorizationResponseInput {
  readonly runtimeId: string
  readonly registrationGeneration: number
  readonly requestId: string
  readonly decision: 'approve' | 'deny'
}

export interface DesktopOpenUrlToolDefinition {
  readonly name: 'desktop_open_url'
  readonly label: 'Open a web page'
  readonly description: 'Open one HTTP(S) URL after explicit user confirmation.'
  readonly parameters: {
    readonly type: 'object'
    readonly properties: {
      readonly url: { readonly type: 'string'; readonly maxLength: 8192 }
    }
    readonly required: readonly ['url']
    readonly additionalProperties: false
  }
  readonly loadMode: 'discoverable'
}

export interface DesktopOpenUrlToolCallRequest {
  readonly type: 'host_tool_call'
  readonly id: string
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: Record<string, unknown>
}

export interface DesktopHostToolResult {
  readonly type: 'host_tool_result'
  readonly id: string
  readonly result: {
    readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
  }
  readonly isError?: true
}

export interface DesktopOpenUrlHostKey {
  readonly runtimeId: string
  readonly registrationGeneration: number
  readonly requestId: string
}

export interface OpenUrlOperation {
  readonly kind: 'open-url'
  readonly key: DesktopOpenUrlHostKey
  readonly toolCallId: string
  readonly url: string
  readonly phase: 'awaiting-user' | 'opening' | 'terminal'
  readonly terminal?: 'opened' | 'denied' | 'cancelled' | 'error' | 'runtime-ended'
}

export type DesktopOpenUrlRegistrationOutcome =
  | { readonly ok: true; readonly toolNames: readonly string[] }
  | { readonly ok: false }

export interface DesktopOpenUrlRegistrationCompletion {
  readonly runtimeId: string
  readonly registrationGeneration: number
  readonly ownerId: number
  readonly outcome: DesktopOpenUrlRegistrationOutcome
}

export type DesktopOpenUrlRegistrationStatus = 'registered' | 'unavailable' | 'stale'
export type DesktopOpenUrlExecutor = (url: string) => Promise<void>
export type DesktopHostToolResultSink = (runtimeId: string, result: DesktopHostToolResult) => Promise<void>

export interface DesktopOpenUrlServiceDependencies {
  readonly openExternal: DesktopOpenUrlExecutor
  readonly writeResult: DesktopHostToolResultSink
}
