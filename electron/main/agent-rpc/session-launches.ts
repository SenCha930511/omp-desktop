import type { RuntimeInfo } from '../../../src/types/api'

/** Who asked for a launch: interactive callers carry the renderer that owns host tools. */
export interface LaunchAudience {
  readonly interactive: boolean
  readonly ownerId?: number
  /** Capability/runtime environment generation; a changed generation cannot join. */
  readonly revision?: number
}

export interface LaunchTicket {
  readonly audience: LaunchAudience
  /** Resolves with a fully ready runtime; rejects with the owner's start error. */
  readonly ready: Promise<RuntimeInfo>
}

export interface OwnedLaunch extends LaunchTicket {
  /** Idempotent. Only the owner may publish, and only after handshake/decorate/host tools. */
  publish(info: RuntimeInfo): void
  /** Idempotent. Every owner exit path calls exactly one of publish/fail. */
  fail(error: unknown): void
}

export type LaunchDecision =
  | { readonly kind: 'owner'; readonly launch: OwnedLaunch }
  | { readonly kind: 'join'; readonly ticket: LaunchTicket }
  | { readonly kind: 'defer'; readonly ticket: LaunchTicket }

interface PendingLaunch {
  readonly deferred: PromiseWithResolvers<RuntimeInfo>
  readonly ticket: LaunchTicket
}

const sameAudience = (left: LaunchAudience, right: LaunchAudience): boolean =>
  left.interactive === right.interactive && left.ownerId === right.ownerId && left.revision === right.revision

/**
 * At most one launch in flight per canonical session path. The owner spawns the
 * child; a caller with the identical audience joins it and a caller with a
 * different audience defers until that launch settles, so a session file is
 * never opened by a second child just because two callers raced on startup.
 *
 * The pending entry only lives across the handshake: `publish`/`fail` delete it
 * in the same synchronous step that settles the ticket, so a published runtime
 * is never joined again and the map cannot pin an obsolete session path after
 * the authoritative identity is known.
 */
export class SessionLaunches {
  private readonly launches = new Map<string, PendingLaunch>()

  /** Synchronous compare-and-insert: no await inside, so two callers cannot both become owner. */
  begin(canonicalSessionPath: string, audience: LaunchAudience): LaunchDecision {
    const existing = this.launches.get(canonicalSessionPath)
    if (existing) {
      return { kind: sameAudience(existing.ticket.audience, audience) ? 'join' : 'defer', ticket: existing.ticket }
    }
    const deferred = Promise.withResolvers<RuntimeInfo>()
    // A ticket nobody joins must not surface as an unhandled rejection.
    deferred.promise.catch(() => undefined)
    const ticket: LaunchTicket = {
      audience: { interactive: audience.interactive, ownerId: audience.ownerId, revision: audience.revision },
      ready: deferred.promise,
    }
    const pending: PendingLaunch = { deferred, ticket }
    this.launches.set(canonicalSessionPath, pending)
    let settled = false
    const settle = (): boolean => {
      if (settled) return false
      settled = true
      if (this.launches.get(canonicalSessionPath) === pending) this.launches.delete(canonicalSessionPath)
      return true
    }
    const launch: OwnedLaunch = {
      audience: ticket.audience,
      ready: deferred.promise,
      publish: (info) => { if (settle()) deferred.resolve(info) },
      fail: (error) => { if (settle()) deferred.reject(error) },
    }
    return { kind: 'owner', launch }
  }

  pending(canonicalSessionPath: string): LaunchTicket | undefined {
    return this.launches.get(canonicalSessionPath)?.ticket
  }
}
