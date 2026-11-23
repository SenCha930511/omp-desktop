import { isRecord, requireId, requireWebUrl } from './validation'
import type {
  DesktopHostToolResult,
  DesktopOpenUrlHostKey,
  DesktopOpenUrlRegistrationCompletion,
  DesktopOpenUrlRegistrationStatus,
  DesktopOpenUrlServiceDependencies,
  DesktopOpenUrlToolDefinition,
  HostAuthorizationResponseInput,
  HostAuthorizationSnapshot,
  OpenUrlOperation,
} from '../../src/types/host-capabilities'

export const MAX_OPEN_URL_OPERATIONS = 8
const MAX_PROTOCOL_ID_BYTES = 256
const MAX_OPEN_URL_BYTES = 8192
const MAX_REMEMBERED_REQUESTS = 256
const MAX_REMEMBERED_CANCELLATIONS = 64

const parameters: DesktopOpenUrlToolDefinition['parameters'] = Object.freeze({
  type: 'object',
  properties: Object.freeze({ url: Object.freeze({ type: 'string', maxLength: 8192 }) }),
  required: Object.freeze(['url'] as const),
  additionalProperties: false,
})

export const DESKTOP_OPEN_URL_TOOL: DesktopOpenUrlToolDefinition = Object.freeze({
  name: 'desktop_open_url',
  label: 'Open a web page',
  description: 'Open one HTTP(S) URL after explicit user confirmation.',
  parameters,
  loadMode: 'discoverable',
})

type RegistrationPhase = 'registering' | 'registered' | 'unavailable' | 'ended'

type ActiveOperation = Omit<OpenUrlOperation, 'phase' | 'terminal'> & {
  phase: OpenUrlOperation['phase']
  terminal?: OpenUrlOperation['terminal']
}

interface AuthorizationListener {
  readonly ownerId: number
  readonly callback: (snapshot: HostAuthorizationSnapshot) => void
}

interface RuntimeRegistration {
  readonly runtimeId: string
  generation: number
  ownerId: number | null
  phase: RegistrationPhase
  readonly operations: Map<string, ActiveOperation>
  readonly openingOperations: Set<ActiveOperation>
  readonly requestIds: Set<string>
  readonly cancelledRequestIds: Set<string>
  readonly cancellationIds: Set<string>
  readonly listeners: Set<AuthorizationListener>
}

interface ParsedCall {
  readonly id: string
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: unknown
}

function wellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\0')
    && wellFormedText(value)
    && Buffer.byteLength(value, 'utf8') <= MAX_PROTOCOL_ID_BYTES
}

function validOwnerId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function requireOwnerId(value: number): number {
  if (!validOwnerId(value)) throw new TypeError('ownerId must be a positive safe integer')
  return value
}

function normalizedOpenUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !wellFormedText(value) || Buffer.byteLength(value, 'utf8') > MAX_OPEN_URL_BYTES) return null
  try {
    const normalized = requireWebUrl(value, { mailto: false })
    if (!wellFormedText(normalized) || Buffer.byteLength(normalized, 'utf8') > MAX_OPEN_URL_BYTES) return null
    return normalized
  } catch {
    return null
  }
}

function parsedCall(value: unknown): ParsedCall | null {
  if (!isRecord(value)
    || value.type !== 'host_tool_call'
    || !boundedIdentifier(value.id)
    || !boundedIdentifier(value.toolCallId)
    || !boundedIdentifier(value.toolName)) return null
  return { id: value.id, toolCallId: value.toolCallId, toolName: value.toolName, arguments: value.arguments }
}

function rememberBounded(values: Set<string>, value: string, maximum: number): void {
  values.delete(value)
  values.add(value)
  const oldest = values.values().next()
  if (values.size > maximum && !oldest.done) values.delete(oldest.value)
}

function validRuntimeId(value: string): boolean {
  try {
    return Buffer.byteLength(requireId(value, 'runtimeId'), 'utf8') <= MAX_PROTOCOL_ID_BYTES
  } catch {
    return false
  }
}

function emptySnapshot(runtimeId: string): HostAuthorizationSnapshot {
  return { runtimeId, registrationGeneration: 0, pending: null }
}

function emptyRegistration(runtimeId: string): RuntimeRegistration {
  return {
    runtimeId,
    generation: 0,
    ownerId: null,
    phase: 'ended',
    operations: new Map(),
    openingOperations: new Set(),
    requestIds: new Set(),
    cancelledRequestIds: new Set(),
    cancellationIds: new Set(),
    listeners: new Set(),
  }
}

export class DesktopOpenUrlService {
  private readonly registrations = new Map<string, RuntimeRegistration>()
  private readonly anyListeners = new Set<(ownerId: number, snapshot: HostAuthorizationSnapshot) => void>()

  constructor(private readonly dependencies: DesktopOpenUrlServiceDependencies) {}

  async beginInteractiveRegistration(runtimeId: string, ownerId: number): Promise<number> {
    const id = requireId(runtimeId, 'runtimeId')
    const owner = requireOwnerId(ownerId)
    const registration = this.registration(id)
    const generation = this.nextGeneration(registration)
    if (registration.ownerId !== owner) registration.listeners.clear()
    registration.cancelledRequestIds.clear()
    registration.cancellationIds.clear()
    await this.invalidate(registration, generation, owner, 'registering', 'Host tool registration changed.', 'error')
    return generation
  }

  finishRegistration(input: DesktopOpenUrlRegistrationCompletion): DesktopOpenUrlRegistrationStatus {
    if (!validRuntimeId(input.runtimeId) || !validOwnerId(input.ownerId)) return 'stale'
    const registration = this.registrations.get(input.runtimeId)
    if (!registration
      || registration.generation !== input.registrationGeneration
      || registration.ownerId !== input.ownerId
      || registration.phase !== 'registering') return 'stale'
    const acknowledged = input.outcome.ok
      && input.outcome.toolNames.length === 1
      && input.outcome.toolNames[0] === DESKTOP_OPEN_URL_TOOL.name
    registration.phase = acknowledged ? 'registered' : 'unavailable'
    this.notify(registration)
    return acknowledged ? 'registered' : 'unavailable'
  }

  async endRegistration(runtimeId: string, registrationGeneration: number, ownerId: number): Promise<boolean> {
    if (!validRuntimeId(runtimeId) || !validOwnerId(ownerId)) return false
    const registration = this.registrations.get(runtimeId)
    if (!registration
      || registration.generation !== registrationGeneration
      || registration.ownerId !== ownerId
      || registration.phase === 'ended') return false
    await this.invalidate(registration, this.nextGeneration(registration), null, 'ended', 'Host tool registration changed.', 'error')
    registration.listeners.clear()
    return true
  }

  async retireRuntime(runtimeId: string): Promise<void> {
    const id = requireId(runtimeId, 'runtimeId')
    const registration = this.registrations.get(id)
    if (!registration) return
    await this.invalidate(registration, this.nextGeneration(registration), null, 'ended', 'Host tool runtime ended.', 'runtime-ended')
    registration.listeners.clear()
  }

  async revokeOwner(ownerId: number): Promise<void> {
    const owner = requireOwnerId(ownerId)
    const invalidations: Promise<void>[] = []
    for (const registration of this.registrations.values()) {
      if (registration.ownerId !== owner) continue
      invalidations.push(this.invalidate(
        registration,
        this.nextGeneration(registration),
        null,
        'ended',
        'Host tool owner revoked.',
        'runtime-ended',
      ))
      registration.listeners.clear()
    }
    await Promise.all(invalidations)
  }

  async handleHostToolCall(runtimeId: string, value: unknown): Promise<void> {
    if (!validRuntimeId(runtimeId)) return
    const call = parsedCall(value)
    if (!call) return
    const registration = this.registration(runtimeId)
    let liveOpeningDuplicate = false
    for (const operation of registration.openingOperations) {
      if (operation.key.requestId === call.id) {
        liveOpeningDuplicate = true
        break
      }
    }
    // Bounded replay cursors may forget old terminal ids, but a live request
    // identity must remain authoritative for its entire awaiting/opening life.
    if (registration.requestIds.has(call.id) || registration.operations.has(call.id) || liveOpeningDuplicate) return
    rememberBounded(registration.requestIds, call.id, MAX_REMEMBERED_REQUESTS)

    if (registration.cancelledRequestIds.has(call.id)) {
      await this.writeResult(runtimeId, call.id, 'Open URL request cancelled.', true)
      return
    }
    if (call.toolName !== DESKTOP_OPEN_URL_TOOL.name) {
      await this.writeResult(runtimeId, call.id, 'Unknown host tool.', true)
      return
    }
    // Registration can be uncertain after a delivered command timed out. A
    // well-formed delivered call still needs a terminal response, never a hang.
    if (registration.phase !== 'registered') {
      await this.writeResult(runtimeId, call.id, 'Host tool unavailable.', true)
      return
    }
    if (!isRecord(call.arguments) || Object.keys(call.arguments).length !== 1 || !('url' in call.arguments)) {
      await this.writeResult(runtimeId, call.id, 'Invalid open URL request.', true)
      return
    }
    const url = normalizedOpenUrl(call.arguments.url)
    if (!url) {
      await this.writeResult(runtimeId, call.id, 'Invalid open URL request.', true)
      return
    }
    if (registration.operations.size + registration.openingOperations.size >= MAX_OPEN_URL_OPERATIONS) {
      await this.writeResult(runtimeId, call.id, 'Host tool unavailable: too many pending requests.', true)
      return
    }

    const key: DesktopOpenUrlHostKey = {
      runtimeId,
      registrationGeneration: registration.generation,
      requestId: call.id,
    }
    registration.operations.set(call.id, {
      kind: 'open-url',
      key,
      toolCallId: call.toolCallId,
      url,
      phase: 'awaiting-user',
    })
    this.notify(registration)
  }

  async cancel(runtimeId: string, cancellationId: string, targetId: string): Promise<boolean> {
    if (!validRuntimeId(runtimeId) || !boundedIdentifier(cancellationId) || !boundedIdentifier(targetId)) return false
    const registration = this.registrations.get(runtimeId)
    if (!registration || registration.cancellationIds.has(cancellationId)) return false
    rememberBounded(registration.cancellationIds, cancellationId, MAX_REMEMBERED_CANCELLATIONS)
    rememberBounded(registration.cancelledRequestIds, targetId, MAX_REMEMBERED_CANCELLATIONS)
    const operation = registration.operations.get(targetId)
    if (!operation || operation.key.registrationGeneration !== registration.generation || operation.phase !== 'awaiting-user') return false
    await this.settle(registration, operation, 'cancelled', 'Open URL request cancelled.', true)
    return true
  }

  hasPendingOperations(runtimeId: string): boolean {
    if (!validRuntimeId(runtimeId)) return false
    const registration = this.registrations.get(runtimeId)
    return (registration?.operations.size ?? 0) + (registration?.openingOperations.size ?? 0) > 0
  }

  snapshot(runtimeId: string, ownerId: number): HostAuthorizationSnapshot {
    if (!validRuntimeId(runtimeId) || !validOwnerId(ownerId)) return emptySnapshot(runtimeId)
    const registration = this.registrations.get(runtimeId)
    if (!registration || registration.ownerId !== ownerId) return emptySnapshot(runtimeId)
    for (const operation of registration.operations.values()) {
      if (operation.phase !== 'awaiting-user') continue
      return {
        runtimeId,
        registrationGeneration: registration.generation,
        pending: { requestId: operation.key.requestId, kind: 'open-url', url: operation.url },
      }
    }
    return { runtimeId, registrationGeneration: registration.generation, pending: null }
  }

  onChanged(runtimeId: string, ownerId: number, callback: (snapshot: HostAuthorizationSnapshot) => void): () => void {
    const id = requireId(runtimeId, 'runtimeId')
    const owner = requireOwnerId(ownerId)
    const listener: AuthorizationListener = { ownerId: owner, callback }
    const registration = this.registration(id)
    registration.listeners.add(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      registration.listeners.delete(listener)
    }
  }

  onAnyChanged(callback: (ownerId: number, snapshot: HostAuthorizationSnapshot) => void): () => void {
    this.anyListeners.add(callback)
    return () => {
      this.anyListeners.delete(callback)
    }
  }

  async respond(ownerId: number, input: HostAuthorizationResponseInput | null | undefined): Promise<boolean> {
    if (!isRecord(input)
      || !validOwnerId(ownerId)
      || Object.keys(input).length !== 4
      || !validRuntimeId(input.runtimeId)
      || !boundedIdentifier(input.requestId)
      || !Number.isSafeInteger(input.registrationGeneration)
      || (input.decision !== 'approve' && input.decision !== 'deny')) return false
    const registration = this.registrations.get(input.runtimeId)
    if (!registration
      || registration.ownerId !== ownerId
      || registration.generation !== input.registrationGeneration
      || registration.phase !== 'registered') return false
    const operation = registration.operations.get(input.requestId)
    const head = this.head(registration)
    if (!operation || operation !== head || operation.phase !== 'awaiting-user') return false

    if (input.decision === 'deny') {
      await this.settle(registration, operation, 'denied', 'Open URL request denied by the user.', true)
      return true
    }

    // Only the stored URL is revalidated and executed after authorization;
    // renderer response fields cannot replace it or invoke another scheme.
    const url = normalizedOpenUrl(operation.url)
    if (!url || url !== operation.url
      || registration.ownerId !== ownerId
      || registration.generation !== operation.key.registrationGeneration
      || registration.phase !== 'registered') {
      await this.settle(registration, operation, 'error', 'Host tool unavailable.', true)
      return true
    }
    operation.phase = 'opening'
    registration.operations.delete(operation.key.requestId)
    registration.openingOperations.add(operation)
    this.notify(registration)

    let terminal: 'opened' | 'error' = 'opened'
    let text = 'Opened the approved web page.'
    let isError = false
    try {
      await this.dependencies.openExternal(url)
    } catch {
      terminal = 'error'
      text = 'The approved web page could not be opened.'
      isError = true
    }
    // Cancellation or retirement after the effect begins cannot reverse it.
    // Preserve this genuine outcome instead of reporting a false cancellation.
    await this.settle(registration, operation, terminal, text, isError)
    return true
  }

  private registration(runtimeId: string): RuntimeRegistration {
    const existing = this.registrations.get(runtimeId)
    if (existing) return existing
    const created = emptyRegistration(runtimeId)
    this.registrations.set(runtimeId, created)
    return created
  }

  private nextGeneration(registration: RuntimeRegistration): number {
    if (registration.generation >= Number.MAX_SAFE_INTEGER) throw new Error('Host tool registration generation exhausted')
    return registration.generation + 1
  }

  private head(registration: RuntimeRegistration): ActiveOperation | undefined {
    for (const operation of registration.operations.values()) {
      if (operation.phase === 'awaiting-user') return operation
    }
    return undefined
  }

  private async invalidate(
    registration: RuntimeRegistration,
    generation: number,
    ownerId: number | null,
    phase: RegistrationPhase,
    text: string,
    terminal: 'error' | 'runtime-ended',
  ): Promise<void> {
    const previousOwnerId = registration.ownerId
    registration.generation = generation
    registration.ownerId = ownerId
    registration.phase = phase
    const operations = [...registration.operations.values()]
    registration.operations.clear()
    const settlements: Promise<void>[] = []
    for (const operation of operations) {
      if (operation.phase === 'awaiting-user') settlements.push(this.settle(registration, operation, terminal, text, true, false))
    }
    this.notify(registration, previousOwnerId)
    await Promise.all(settlements)
  }

  private async settle(
    registration: RuntimeRegistration,
    operation: ActiveOperation,
    terminal: NonNullable<OpenUrlOperation['terminal']>,
    text: string,
    isError: boolean,
    notify = true,
  ): Promise<void> {
    if (operation.phase === 'terminal') return
    operation.phase = 'terminal'
    operation.terminal = terminal
    registration.openingOperations.delete(operation)
    if (registration.generation === operation.key.registrationGeneration
      && registration.operations.get(operation.key.requestId) === operation) {
      registration.operations.delete(operation.key.requestId)
    }
    if (notify) this.notify(registration)
    await this.writeResult(operation.key.runtimeId, operation.key.requestId, text, isError)
  }

  private async writeResult(runtimeId: string, requestId: string, text: string, isError: boolean): Promise<void> {
    const result: DesktopHostToolResult = {
      type: 'host_tool_result',
      id: requestId,
      result: { content: [{ type: 'text', text }] },
      ...(isError ? { isError: true } : {}),
    }
    try {
      await this.dependencies.writeResult(runtimeId, result)
    } catch {
      // The operation is already terminal; retries could correlate a late
      // duplicate with different state, so transport loss is not re-answered.
    }
  }

  private notify(registration: RuntimeRegistration, clearedOwnerId: number | null = null): void {
    for (const listener of registration.listeners) {
      try {
        listener.callback(this.snapshot(registration.runtimeId, listener.ownerId))
      } catch {
        // A renderer listener cannot interrupt protocol settlement or cleanup.
      }
    }
    for (const listener of this.anyListeners) {
      if (registration.ownerId !== null) {
        try {
          listener(registration.ownerId, this.snapshot(registration.runtimeId, registration.ownerId))
        } catch {
          // A renderer listener cannot interrupt protocol settlement or cleanup.
        }
      }
      if (clearedOwnerId !== null && clearedOwnerId !== registration.ownerId) {
        try {
          listener(clearedOwnerId, { runtimeId: registration.runtimeId, registrationGeneration: registration.generation, pending: null })
        } catch {
          // A renderer listener cannot interrupt protocol settlement or cleanup.
        }
      }
    }
  }
}
