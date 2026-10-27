/**
 * Renderer-side bookkeeping for compactions whose authoritative session state
 * still awaits synchronization (sync_pending). useAgentEvents owns the
 * lifecycle: the pending entry appears with the compaction_sync_pending event
 * (or the desktop.compaction-sync warning notice) and disappears with the
 * next authoritative runtime_state snapshot — including the one the user's
 * manual refresh retry produces. The transcript divider subscribes to offer
 * that retry exactly while it can still help.
 */
export interface CompactionSyncPending {
  runtimeId: string
}

let snapshot: CompactionSyncPending | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export const compactionSyncPendingStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getSnapshot(): CompactionSyncPending | null { return snapshot },
  setPending(runtimeId: string): void {
    if (snapshot?.runtimeId === runtimeId) return
    snapshot = { runtimeId }
    emit()
  },
  clear(runtimeId?: string): void {
    if (!snapshot) return
    if (runtimeId !== undefined && snapshot.runtimeId !== runtimeId) return
    snapshot = null
    emit()
  },
}
