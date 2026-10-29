import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createTranscriptStore } from '@/app/transcript-store'
import {
  AGENT_EVENT_FLUSH_CHUNK,
  admitAgentEvent,
  authoritativeTranscriptReadIsCurrent,
  eventsForWorkspace,
  isTranscriptTerminalEvent,
  needsTranscriptReconciliation,
  reconcileTranscriptMessages,
  reconciliationMatches,
  type PendingAgentEvent,
  type TranscriptReconciliationMarker,
} from '@/app/agent-events'
import { runTranscriptRead } from '@/app/transcript-load'
import { reconcileTranscripts } from '@/app/transcript-reconcile'
import type { WorkspaceSnapshot } from '@/app/workspace'
import { createPrimeEventBuffer, createQueuedMessageEvent, createSteerAcceptedEvent, createSteerPickupEvent, createSteerRetractEvent, replayPrimeEvents } from '@/lib/events'
import type { PrimeEventBuffer } from '@/lib/events'
import { moveComposerDraft } from '@/lib/composer-draft'
import { findRuntimeForWorkspace, workspaceCwd } from '@/lib/workspace'
import { readPendingQueues, savePendingQueues, type WithdrawnQueue } from '@/lib/queued-prompt-storage'
import { parseSessionActionSnapshot } from '@/lib/session-actions'
import type { HarnessId, MessagePart, DesktopApi, ProjectRecord, PromptDeliveryIntent, QueuedPrompt, RuntimeInfo, SessionActionSnapshot, SessionRecord, TranscriptMessage } from '@/types/api'

/** Minimum spacing between two external-session transcript reads. Catalog
 *  syncs arrive per appended record, so an unpaced effect would re-read and
 *  re-parse the whole JSONL once per line. The window is anchored to the last
 *  read start (not reset per event) so a steady stream still refreshes. */
const EXTERNAL_TRANSCRIPT_READ_INTERVAL_MS = 500

let queuedPromptSequence = 0

function nextQueuedPromptId(): string {
  queuedPromptSequence += 1
  return `queued-${Date.now()}-${queuedPromptSequence}`
}

function queuedPromptOwner(
  project: ProjectRecord | undefined,
  session: SessionRecord | undefined,
  runtime: RuntimeInfo | undefined,
  generation: number,
): string | undefined {
  if (session?.filePath) return `${session.harness}:session:${session.filePath}`
  if (runtime?.sessionFile) return `${runtime.harness}:session:${runtime.sessionFile}`
  if (runtime) return `${runtime.harness}:runtime:${runtime.runtimeId}`
  if (project) return `${project.harness}:new:${project.id}:${generation}`
  return undefined
}

interface TranscriptLoad {
  generation: number
  sessionFile: string
  eventBuffer: PrimeEventBuffer
  runtimeId?: string
  reconciliation: boolean
  admissionRevision: number
  /** Set once the IPC was actually issued; a load already in flight must not
   *  be replaced by a newer admission of the same workspace. */
  started?: boolean
}

interface UseWorkspaceRuntimeOptions {
  bridge: DesktopApi | null
  /** Active harness; runtime discovery only attaches runtimes it owns. */
  harness?: HarnessId
  initialProject?: ProjectRecord
  initialSession?: SessionRecord
  sessions: SessionRecord[]
  initialMessages: TranscriptMessage[]
  reportError(error: unknown): void
}

export function useWorkspaceRuntime({
  bridge,
  harness = 'omp',
  initialProject,
  initialSession,
  sessions,
  initialMessages,
  reportError,
}: UseWorkspaceRuntimeOptions) {
  const [transcriptStore] = useState(() => createTranscriptStore(initialMessages))
  const transcriptSummary = useSyncExternalStore(transcriptStore.subscribeSummary, transcriptStore.getSummary)
  const setMessages = transcriptStore.update
  const [restoredQueues] = useState(readPendingQueues)
  const initialOwner = queuedPromptOwner(initialProject, initialSession, undefined, 0)
  const [pendingQueuedPrompts, setPendingQueuedPrompts] = useState<QueuedPrompt[]>(() => initialOwner ? restoredQueues.get(initialOwner) ?? [] : [])
  const pendingQueuedPromptsRef = useRef<QueuedPrompt[]>(pendingQueuedPrompts)
  const queuedPromptsByOwnerRef = useRef<Map<string, QueuedPrompt[]>>(restoredQueues)
  const observedSteerIdsRef = useRef<Set<string>>(new Set())
  /** Steers omp took from its steering list but still holds for the next turn. */
  const harnessHeldSteerIdsRef = useRef<Set<string>>(new Set())
  const activeQueuedPromptOwnerRef = useRef<string | undefined>(queuedPromptOwner(initialProject, initialSession, undefined, 0))
  const [activeProjectId, setActiveProjectId] = useState(initialProject?.id)
  const [activeSessionId, setActiveSessionId] = useState(initialSession?.id)
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0)
  const [loadingSession, setLoadingSession] = useState(false)
  const harnessRef = useRef(harness)
  harnessRef.current = harness
  const runtimeIdRef = useRef<string | null>(null)
  const runtimeSessionsRef = useRef<Map<string, string>>(new Map())
  const runtimeOwnerRef = useRef<{ runtimeId: string; generation: number } | null>(null)
  const workspaceRef = useRef<WorkspaceSnapshot>({
    generation: 0,
    project: initialProject,
    session: initialSession,
    cwd: workspaceCwd(initialProject, initialSession),
    sessionFile: initialSession?.filePath,
  })
  const transcriptLoadRef = useRef<TranscriptLoad | null>(null)
  /** Workspace whose on-disk transcript changed while no read was allowed. */
  const externalReadDirtyRef = useRef<{ generation: number; sessionFile: string } | null>(null)
  const externalReadTimerRef = useRef<number | null>(null)
  const lastExternalReadStartedAtRef = useRef(0)
  /** Set once the read path exists; a finished read schedules its follow-up. */
  const scheduleExternalReadRef = useRef<() => void>(() => {})
  const promptAdmissionRevisionRef = useRef(0)
  const promptAdmissionGenerationRef = useRef<number | null>(null)
  const reconciliationNeededRef = useRef<TranscriptReconciliationMarker | null>(null)
  const deferredReconciliationRef = useRef<TranscriptReconciliationMarker | null>(null)
  const pendingAgentEventsRef = useRef<PendingAgentEvent[]>([])
  const lastTranscriptReadWorkspaceRef = useRef<{ generation: number; sessionFile: string } | null>(null)
  // Set by adoptSessionId until the session catalog catches up with the row it
  // just indexed; guards the empty-transcript branch below from wiping the
  // in-flight turn while `activeSession` is briefly undefined.
  const adoptionPendingCatalogRef = useRef<string | null>(null)
  const agentEventFrameRef = useRef<number | null>(null)
  const chunkedFlushTimerRef = useRef<number | null>(null)
  const reconcileOnVisibleRef = useRef(false)

  const flushAgentEvents = useCallback(() => {
    if (agentEventFrameRef.current !== null) {
      cancelAnimationFrame(agentEventFrameRef.current)
      agentEventFrameRef.current = null
    }
    if (chunkedFlushTimerRef.current !== null) {
      window.clearTimeout(chunkedFlushTimerRef.current)
      chunkedFlushTimerRef.current = null
    }
    const generation = workspaceRef.current.generation
    const pending = pendingAgentEventsRef.current
    pendingAgentEventsRef.current = []
    const admitted = eventsForWorkspace(pending, generation)
    if (admitted.length) {
      setMessages((current) => replayPrimeEvents(current, admitted))
    }
  }, [])

  /** Reader-facing row events (the optimistic row, its retraction) apply
   * directly instead of through the event queue: they are click feedback, so
   * neither an in-flight authoritative read (a 20k-line transcript can
   * read for seconds) nor a stalled animation frame may park them. Removal
   * and insertion target their own row, so later frame flushes cannot be
   * reordered around them, and transcript reconciliation keeps un-persisted
   * local rows on merge. */
  const applyLocalRowEvent = useCallback((event: Record<string, unknown>) => {
    setMessages((current) => replayPrimeEvents(current, [event]))
  }, [])
  const flushAgentEventsChunked = useCallback(() => {
    if (chunkedFlushTimerRef.current !== null) return
    if (agentEventFrameRef.current !== null) {
      cancelAnimationFrame(agentEventFrameRef.current)
      agentEventFrameRef.current = null
    }
    if (pendingAgentEventsRef.current.length <= AGENT_EVENT_FLUSH_CHUNK) {
      flushAgentEvents()
      return
    }
    const flushChunk = () => {
      chunkedFlushTimerRef.current = null
      const generation = workspaceRef.current.generation
      const chunk = pendingAgentEventsRef.current.splice(0, AGENT_EVENT_FLUSH_CHUNK)
      const admitted = eventsForWorkspace(chunk, generation)
      if (admitted.length) setMessages((current) => replayPrimeEvents(current, admitted))
      if (pendingAgentEventsRef.current.length) chunkedFlushTimerRef.current = window.setTimeout(flushChunk, 0)
    }
    flushChunk()
  }, [flushAgentEvents])

  const attachRuntime = useCallback((nextRuntime: RuntimeInfo | undefined, generation: number) => {
    if (workspaceRef.current.generation !== generation) return
    const next = nextRuntime ?? null
    const previousQueueOwner = activeQueuedPromptOwnerRef.current
    const nextQueueOwner = queuedPromptOwner(workspaceRef.current.project, workspaceRef.current.session, nextRuntime, generation)
    if (nextQueueOwner !== previousQueueOwner) {
      const currentQueue = pendingQueuedPromptsRef.current
      const restoredQueue = nextQueueOwner ? queuedPromptsByOwnerRef.current.get(nextQueueOwner) : undefined
      const nextQueue = currentQueue.length ? currentQueue : restoredQueue ?? []
      if (previousQueueOwner?.includes(':new:') || previousQueueOwner?.includes(':runtime:')) {
        queuedPromptsByOwnerRef.current.delete(previousQueueOwner)
      }
      if (nextQueueOwner && nextQueue.length) queuedPromptsByOwnerRef.current.set(nextQueueOwner, nextQueue)
      activeQueuedPromptOwnerRef.current = nextQueueOwner
      pendingQueuedPromptsRef.current = nextQueue
      setPendingQueuedPrompts(nextQueue)
    }
    if (next?.sessionFile) runtimeSessionsRef.current.set(next.runtimeId, next.sessionFile)
    runtimeIdRef.current = next?.runtimeId ?? null
    runtimeOwnerRef.current = next ? { runtimeId: next.runtimeId, generation } : null
    setRuntime(next)
  }, [])

  const activateWorkspace = useCallback((project?: ProjectRecord, session?: SessionRecord, nextRuntime?: RuntimeInfo) => {
    pendingAgentEventsRef.current = []
    adoptionPendingCatalogRef.current = null
    promptAdmissionRevisionRef.current = 0
    promptAdmissionGenerationRef.current = null
    reconciliationNeededRef.current = null
    deferredReconciliationRef.current = null
    reconcileOnVisibleRef.current = false
    if (agentEventFrameRef.current !== null) {
      cancelAnimationFrame(agentEventFrameRef.current)
      agentEventFrameRef.current = null
    }
    if (chunkedFlushTimerRef.current !== null) {
      window.clearTimeout(chunkedFlushTimerRef.current)
      chunkedFlushTimerRef.current = null
    }
    // A pending external refresh belongs to the workspace being left; carrying
    // it over would apply the old file's revision to the new session.
    externalReadDirtyRef.current = null
    if (externalReadTimerRef.current !== null) {
      window.clearTimeout(externalReadTimerRef.current)
      externalReadTimerRef.current = null
    }
    const generation = workspaceRef.current.generation + 1
    workspaceRef.current = {
      generation,
      project,
      session,
      cwd: workspaceCwd(project, session),
      sessionFile: session?.filePath,
    }
    transcriptLoadRef.current = bridge && session?.filePath
      ? { generation, sessionFile: session.filePath, eventBuffer: createPrimeEventBuffer(), reconciliation: false, admissionRevision: 0 }
      : null
    const queueOwner = queuedPromptOwner(project, session, nextRuntime, generation)
    const queuedPrompts = queueOwner ? queuedPromptsByOwnerRef.current.get(queueOwner) ?? [] : []
    activeQueuedPromptOwnerRef.current = queueOwner
    pendingQueuedPromptsRef.current = queuedPrompts
    setWorkspaceGeneration(generation)
    setPendingQueuedPrompts(queuedPrompts)
    setActiveProjectId(project?.id)
    setActiveSessionId(session?.id)
    attachRuntime(nextRuntime, generation)
    if (bridge) {
      setMessages([])
      setLoadingSession(Boolean(session?.filePath))
    }
    return generation
  }, [attachRuntime, bridge])

  // A draft workspace adopts the session its first prompt started. This only
  // mutates session identity — no generation bump, transcript reset, or
  // runtime re-attach — so an in-flight admission keeps its guards while the
  // sidebar selection and composer key move to the real session.
  const adoptSessionId = useCallback((session: SessionRecord) => {
    const current = workspaceRef.current
    // The composer keys on the session id, so it remounts onto the adopted
    // scope; carry what was typed under the draft scope first.
    const projectScope = current.project?.id ?? 'no-project'
    moveComposerDraft(`${projectScope}:new`, `${projectScope}:${session.id}`)
    workspaceRef.current = {
      ...current,
      session,
      sessionFile: session.filePath,
      cwd: workspaceCwd(current.project, session),
    }
    // The just-started runtime attaches in the same batch, making the session
    // locally owned; mark the workspace as read so the transcript effect does
    // not fire a cold file read that would clobber the in-flight admission.
    lastTranscriptReadWorkspaceRef.current = { generation: current.generation, sessionFile: session.filePath }
    adoptionPendingCatalogRef.current = session.id
    setActiveSessionId(session.id)
  }, [])

  // The workspace's own runtime may start reporting a different session
  // file: a native session boundary (OMP fork/branch/switch executed inside
  // the session) or a file move keeps the running runtime writing to a new
  // path. Compact never does this — it compacts in place on the same file.
  // Follow the owned runtime by adopting the catalog record for its new
  // file, identity only.
  const followOwnedRuntimeSession = useCallback((followed: SessionRecord) => {
    const current = workspaceRef.current
    workspaceRef.current = {
      ...current,
      session: followed,
      sessionFile: followed.filePath,
      cwd: workspaceCwd(current.project, followed),
    }
    // An identity-only rebind, no transcript reset — the live event stream
    // keeps flowing under the same running runtime on its new file, which
    // already carries the history.
    lastTranscriptReadWorkspaceRef.current = { generation: current.generation, sessionFile: followed.filePath }
    adoptionPendingCatalogRef.current = followed.id
    setActiveSessionId(followed.id)
  }, [])


  const reconcileRuntime = useCallback(async (generation: number) => {
    if (!bridge) return
    const selected = workspaceRef.current
    if (selected.generation !== generation || !selected.sessionFile) return
    try {
      const runtimes = (await bridge.agent.list()).filter((candidate) => candidate.harness === harnessRef.current)
      if (workspaceRef.current.generation !== generation) return
      let match = findRuntimeForWorkspace(runtimes, selected.cwd, selected.sessionFile)
      if (!match) {
        // The runtime we own now reports a different session file (a native
        // session boundary or a move). Follow the owned runtime instead of
        // detaching — the record for its new file appears in the catalog as
        // the sessions sync catches up.
        const owned = runtimes.find((candidate) => candidate.runtimeId === runtimeOwnerRef.current?.runtimeId)
        const followed = owned?.sessionFile && owned.sessionFile !== selected.sessionFile
          ? sessionsRef.current.find((session) => session.harness === harnessRef.current && session.filePath === owned.sessionFile)
          : undefined
        if (followed) {
          followOwnedRuntimeSession(followed)
          match = owned
        }
      }
      attachRuntime(match, generation)
    } catch (error) {
      if (workspaceRef.current.generation === generation) reportError(error)
    }
  }, [followOwnedRuntimeSession, attachRuntime, bridge, reportError])


  const startTranscriptRead = useCallback((
    selected: WorkspaceSnapshot,
    reconciliation: boolean,
    runtimeId?: string,
    admittedLoad?: TranscriptLoad,
  ) => {
    if (!bridge || !selected.sessionFile) return
    const previousLoad = transcriptLoadRef.current
    const pendingLoad = admittedLoad ?? {
      generation: selected.generation,
      sessionFile: selected.sessionFile,
      eventBuffer: previousLoad?.generation === selected.generation
        && previousLoad.sessionFile === selected.sessionFile
        && !previousLoad.eventBuffer.overflowed
        ? previousLoad.eventBuffer
        : createPrimeEventBuffer(),
      runtimeId,
      reconciliation,
      admissionRevision: promptAdmissionRevisionRef.current,
    }
    transcriptLoadRef.current = pendingLoad
    pendingLoad.started = true
    // A read that starts now already covers the newest on-disk state, so it
    // consumes the pending external refresh for this workspace instead of
    // queueing a second, redundant read behind it.
    const dirty = externalReadDirtyRef.current
    if (dirty && dirty.generation === pendingLoad.generation && dirty.sessionFile === pendingLoad.sessionFile) {
      externalReadDirtyRef.current = null
      if (externalReadTimerRef.current !== null) {
        window.clearTimeout(externalReadTimerRef.current)
        externalReadTimerRef.current = null
      }
    }

    void runTranscriptRead({
      read: () => bridge.sessions.read(selected.sessionFile!),
      isCurrent: () => transcriptLoadRef.current === pendingLoad
        && workspaceRef.current.generation === pendingLoad.generation
        && workspaceRef.current.sessionFile === pendingLoad.sessionFile,
      onValue: (value) => {
        if (pendingLoad.eventBuffer.overflowed) return
        const current = workspaceRef.current
        const readMarker = pendingLoad.runtimeId ? {
          generation: pendingLoad.generation,
          runtimeId: pendingLoad.runtimeId,
          sessionFile: pendingLoad.sessionFile,
          admissionRevision: pendingLoad.admissionRevision,
        } : null
        if (pendingLoad.reconciliation && readMarker
          && !authoritativeTranscriptReadIsCurrent(readMarker, {
            ...current,
            admissionRevision: promptAdmissionRevisionRef.current,
          }, runtimeIdRef.current)) {
          setMessages((messages) => pendingLoad.eventBuffer.replay(messages))
          return
        }
        // Post-turn reconciliation reads restore disk authority, but unchanged
        // messages keep their identity so memoized rows do not re-render.
        if (pendingLoad.reconciliation) {
          setMessages((messages) => reconcileTranscripts(messages, pendingLoad.eventBuffer.replay(value)))
          return
        }
        // Background reads (initial and external-sync) merge into the live
        // list so an optimistic message sent while the read was in flight is
        // not replaced away by older on-disk state.
        setMessages((messages) => reconcileTranscriptMessages(messages, pendingLoad.eventBuffer.replay(value)))
      },
      onError: (error) => {
        setMessages((messages) => pendingLoad.eventBuffer.replay(messages))
        reportError(error)
      },
      onFinally: () => {
        const recovering = transcriptLoadRef.current === pendingLoad && pendingLoad.eventBuffer.overflowed
        if (transcriptLoadRef.current === pendingLoad) transcriptLoadRef.current = null
        scheduleExternalReadRef.current()
        if (recovering && workspaceRef.current.generation === pendingLoad.generation && workspaceRef.current.sessionFile === pendingLoad.sessionFile) {
          if (document.visibilityState === 'visible') {
            reconcileOnVisibleRef.current = false
            startTranscriptRead(workspaceRef.current, pendingLoad.reconciliation, pendingLoad.runtimeId)
          } else reconcileOnVisibleRef.current = true
          return
        }
        if (workspaceRef.current.generation === pendingLoad.generation && !pendingLoad.reconciliation) {
          setLoadingSession(false)
        }
        const deferred = deferredReconciliationRef.current
        if (!deferred || transcriptLoadRef.current) return
        deferredReconciliationRef.current = null
        const current = workspaceRef.current
        if (reconciliationMatches(deferred, current.generation, deferred.runtimeId, current.sessionFile)) {
          flushAgentEvents()
          startTranscriptRead(current, true, deferred.runtimeId)
        }
      },
    })
  }, [bridge, flushAgentEvents, reportError])

  /** Reads a pending external refresh now. Never replaces a read in flight: the
   *  running read reconciles that state and schedules the follow-up itself. */
  const startExternalRead = useCallback(() => {
    const dirty = externalReadDirtyRef.current
    if (!dirty || document.visibilityState !== 'visible') return
    const selected = workspaceRef.current
    if (selected.generation !== dirty.generation || selected.sessionFile !== dirty.sessionFile) {
      externalReadDirtyRef.current = null
      return
    }
    const inFlight = transcriptLoadRef.current
    if (inFlight?.started && inFlight.generation === dirty.generation && inFlight.sessionFile === dirty.sessionFile) return
    lastExternalReadStartedAtRef.current = Date.now()
    startTranscriptRead(selected, false)
  }, [startTranscriptRead])

  const scheduleExternalRead = useCallback(() => {
    if (externalReadTimerRef.current !== null || !externalReadDirtyRef.current) return
    const delay = Math.max(0, EXTERNAL_TRANSCRIPT_READ_INTERVAL_MS - (Date.now() - lastExternalReadStartedAtRef.current))
    externalReadTimerRef.current = window.setTimeout(() => {
      externalReadTimerRef.current = null
      startExternalRead()
    }, delay)
  }, [startExternalRead])

  scheduleExternalReadRef.current = scheduleExternalRead

  const requestExternalTranscriptRead = useCallback((selected: WorkspaceSnapshot) => {
    if (!selected.sessionFile) return
    externalReadDirtyRef.current = { generation: selected.generation, sessionFile: selected.sessionFile }
    if (document.visibilityState !== 'visible') return
    scheduleExternalRead()
  }, [scheduleExternalRead])

  const runOverflowReconciliation = useCallback(() => {
    if (transcriptLoadRef.current?.eventBuffer.overflowed) { reconcileOnVisibleRef.current = true; return }
    reconcileOnVisibleRef.current = false
    pendingAgentEventsRef.current = []
    if (agentEventFrameRef.current !== null) {
      cancelAnimationFrame(agentEventFrameRef.current)
      agentEventFrameRef.current = null
    }
    if (chunkedFlushTimerRef.current !== null) {
      window.clearTimeout(chunkedFlushTimerRef.current)
      chunkedFlushTimerRef.current = null
    }
    const selected = workspaceRef.current
    if (!selected.sessionFile) return
    startTranscriptRead(selected, false)
  }, [startTranscriptRead])

  const queueAgentEvent = useCallback((event: Record<string, unknown>) => {
    const generation = workspaceRef.current.generation
    const owner = admitAgentEvent(generation, event, transcriptLoadRef.current, pendingAgentEventsRef.current)
    if (owner === 'overflow') {
      // The replay queue is beyond its bound; an authoritative transcript read
      // replaces replay. Defer the read until the document is visible again so a
      // hidden window does not re-read on every dropped event.
      reconcileOnVisibleRef.current = true
      pendingAgentEventsRef.current = []
      if (agentEventFrameRef.current !== null) {
        cancelAnimationFrame(agentEventFrameRef.current)
        agentEventFrameRef.current = null
      }
      if (typeof document === 'undefined' || document.visibilityState === 'visible') runOverflowReconciliation()
      return
    }
    if (owner === 'frame' && agentEventFrameRef.current === null && chunkedFlushTimerRef.current === null) {
      agentEventFrameRef.current = requestAnimationFrame(flushAgentEvents)
    }
  }, [flushAgentEvents, runOverflowReconciliation])

  const reconcileTranscriptForEvent = useCallback((runtimeId: string, event: Record<string, unknown>) => {
    const selected = workspaceRef.current
    const type = typeof event.type === 'string' ? event.type : ''
    // auto_retry_start also supersedes any in-flight reconciliation: the
    // agent_end that scheduled it did not actually end the turn, and the disk
    // read would replace the still-streaming transcript with finalized rows.
    if (type === 'agent_start' || type === 'turn_start' || type === 'compaction_start' || type === 'auto_retry_start') {
      const load = transcriptLoadRef.current
      if (load?.generation === selected.generation) {
        transcriptLoadRef.current = null
        deferredReconciliationRef.current = null
        setMessages((current) => load.eventBuffer.replay(current))
      }
    }
    if (promptAdmissionGenerationRef.current === selected.generation) {
      // transport_error and runtime_exit mean the admitted prompt will never
      // start; clear the admission so reconciliation stops being suppressed.
      if (type === 'agent_start' || type === 'turn_start' || type === 'transport_error' || type === 'runtime_exit') {
        promptAdmissionGenerationRef.current = null
      } else if (needsTranscriptReconciliation(event) || isTranscriptTerminalEvent(event)) return
    }
    if (!selected.sessionFile) return
    const marker: TranscriptReconciliationMarker = {
      generation: selected.generation,
      runtimeId,
      sessionFile: selected.sessionFile,
    }
    if (needsTranscriptReconciliation(event)) {
      reconciliationNeededRef.current = marker
      return
    }
    if (!isTranscriptTerminalEvent(event)) return

    const needed = reconciliationNeededRef.current
    if (needed && !reconciliationMatches(needed, selected.generation, runtimeId, selected.sessionFile)) return
    reconciliationNeededRef.current = null
    if (transcriptLoadRef.current) {
      deferredReconciliationRef.current = marker
      return
    }
    flushAgentEvents()
    startTranscriptRead(selected, true, runtimeId)
  }, [flushAgentEvents, startTranscriptRead])

  const prepareForPrompt = useCallback((generation: number): boolean => {
    if (workspaceRef.current.generation !== generation) return false
    promptAdmissionRevisionRef.current += 1
    promptAdmissionGenerationRef.current = generation
    reconciliationNeededRef.current = null
    const load = transcriptLoadRef.current
    // Supersede every pending transcript load, not only reconciliations: a
    // background read resolving after the prompt would otherwise replace the
    // optimistic user message with older on-disk state. The reconciliation
    // read after the turn's terminal event restores disk authority.
    if (load?.generation === generation) {
      transcriptLoadRef.current = null
      deferredReconciliationRef.current = null
      setMessages((current) => load.eventBuffer.replay(current))
    }
    return true
  }, [])

  const queuePrompt = useCallback((text: string, intent: PromptDeliveryIntent, parts?: MessagePart[], timestamp = Date.now()): string => {
    const queued: QueuedPrompt = { id: nextQueuedPromptId(), text, intent, timestamp, ...(parts ? { parts } : {}) }
    const next = [...pendingQueuedPromptsRef.current, queued]
    pendingQueuedPromptsRef.current = next
    const owner = activeQueuedPromptOwnerRef.current
    if (owner) queuedPromptsByOwnerRef.current.set(owner, next)
    savePendingQueues(queuedPromptsByOwnerRef.current)
    setPendingQueuedPrompts(next)
    // The submitted message renders in the transcript immediately; delivery
    // still follows the queue/steer logic and reconciles this row by id.
    // Slash commands keep their command-chip flow and never get a row here.
    // The row is reader feedback tied to the click, not harness state: it
    // bypasses the event queue so neither an in-flight authoritative read
    // (a 20k-line transcript can read for seconds) nor a stalled
    // animation frame can park it. Tool events target their own message ids,
    // so a directly applied row cannot be jumped by later frame flushes, and
    // transcript reconciliation keeps un-persisted local rows on merge.
    if (!/^\/\S+/.test(text.trim())) applyLocalRowEvent(createQueuedMessageEvent(queued))
    return queued.id
  }, [applyLocalRowEvent])
  const removeQueuedPrompt = useCallback((id: string) => {
    observedSteerIdsRef.current.delete(id)
    const current = pendingQueuedPromptsRef.current
    const next = current.filter((prompt) => prompt.id !== id)
    if (next.length !== current.length) {
      pendingQueuedPromptsRef.current = next
      const owner = activeQueuedPromptOwnerRef.current
      if (owner) {
        if (next.length) queuedPromptsByOwnerRef.current.set(owner, next)
        else queuedPromptsByOwnerRef.current.delete(owner)
      }
      setPendingQueuedPrompts(next)
      savePendingQueues(queuedPromptsByOwnerRef.current)
      return
    }
    for (const [owner, prompts] of queuedPromptsByOwnerRef.current) {
      const remaining = prompts.filter((prompt) => prompt.id !== id)
      if (remaining.length === prompts.length) continue
      if (remaining.length) queuedPromptsByOwnerRef.current.set(owner, remaining)
      else queuedPromptsByOwnerRef.current.delete(owner)
      // Wake the idle-flush effect for the visible thread after a background
      // delivery settles; its previous pass may have observed the global
      // single-flight guard while this prompt was being sent.
      setPendingQueuedPrompts([...pendingQueuedPromptsRef.current])
      savePendingQueues(queuedPromptsByOwnerRef.current)
      return
    }
  }, [])
  const updateQueuedPrompts = useCallback((transform: (prompt: QueuedPrompt) => QueuedPrompt) => {
    const update = (prompts: QueuedPrompt[]) => {
      let changed = false
      const next = prompts.map((prompt) => {
        const updated = transform(prompt)
        if (updated !== prompt) changed = true
        return updated
      })
      return changed ? next : prompts
    }
    const nextActive = update(pendingQueuedPromptsRef.current)
    if (nextActive !== pendingQueuedPromptsRef.current) {
      pendingQueuedPromptsRef.current = nextActive
      setPendingQueuedPrompts(nextActive)
    }
    for (const [owner, prompts] of queuedPromptsByOwnerRef.current) {
      const next = update(prompts)
      if (next !== prompts) queuedPromptsByOwnerRef.current.set(owner, next)
    }
    savePendingQueues(queuedPromptsByOwnerRef.current)
  }, [])
  const editQueuedPrompt = useCallback((id: string, text: string) => {
    updateQueuedPrompts((prompt) => prompt.id === id ? { ...prompt, text, flushAttemptFailed: false, recovered: false } : prompt)
  }, [updateQueuedPrompts])
  const updateQueuedPromptDelivery = useCallback((id: string, deliveryPending: boolean) => {
    updateQueuedPrompts((prompt) => prompt.id === id ? { ...prompt, deliveryPending } : prompt)
  }, [updateQueuedPrompts])
  const pauseQueuedPrompts = useCallback(() => {
    updateQueuedPrompts((prompt) => prompt.intent === 'queue' ? { ...prompt, recovered: true, flushAttemptFailed: true } : prompt)
  }, [updateQueuedPrompts])
  const markQueuedPromptFlushFailed = useCallback((id: string) => {
    updateQueuedPrompts((prompt) => prompt.id === id && !prompt.flushAttemptFailed
      ? { ...prompt, flushAttemptFailed: true }
      : prompt)
  }, [updateQueuedPrompts])
  const clearQueuedPromptFlushFailures = useCallback(() => {
    updateQueuedPrompts(({ flushAttemptFailed: _failed, ...prompt }) => prompt)
  }, [updateQueuedPrompts])
  const clearQueuedPrompts = useCallback(() => {
    const owner = activeQueuedPromptOwnerRef.current
    if (owner) queuedPromptsByOwnerRef.current.delete(owner)
    for (const prompt of pendingQueuedPromptsRef.current) {
      observedSteerIdsRef.current.delete(prompt.id)
      applyLocalRowEvent(createSteerRetractEvent({ id: prompt.id }))
    }
    pendingQueuedPromptsRef.current = []
    setPendingQueuedPrompts([])
    savePendingQueues(queuedPromptsByOwnerRef.current)
  }, [applyLocalRowEvent])
  /** Drops a queued prompt's optimistic transcript row (deletion, failure, or flush hand-off). */
  const retractQueuedPrompt = useCallback((id: string) => {
    applyLocalRowEvent(createSteerRetractEvent({ id }))
  }, [applyLocalRowEvent])

  const acceptSteer = useCallback((id: string) => {
    const prompt = pendingQueuedPromptsRef.current.find((candidate) => candidate.id === id && candidate.intent === 'steer')
    if (prompt) queueAgentEvent(createSteerAcceptedEvent(prompt))
  }, [queueAgentEvent])
  const reconcileQueuedPrompts = useCallback((snapshot: SessionActionSnapshot) => {
    const localSteers = pendingQueuedPromptsRef.current.filter((prompt) => prompt.intent === 'steer')
    if (!localSteers.length) return

    // Session action previews are literal for ordinary prompts and may be
    // compacted for very long ones. Match in queue order so duplicate steers
    // are still acknowledged one at a time.
    const unmatchedPreviews = [...snapshot.steering]
    const stillQueued = new Set<string>()
    for (const prompt of localSteers) {
      const previewIndex = unmatchedPreviews.findIndex((preview) => (
        preview === prompt.text || prompt.text.startsWith(preview) || preview.startsWith(prompt.text)
      ))
      if (previewIndex < 0) continue
      unmatchedPreviews.splice(previewIndex, 1)
      stillQueued.add(prompt.id)
      observedSteerIdsRef.current.add(prompt.id)
    }

    const settled = localSteers.filter((prompt) => (
      !stillQueued.has(prompt.id) && observedSteerIdsRef.current.has(prompt.id)
    ))
    // Steers the harness already picked up from its steering list but still
    // holds for the next turn: the queued count exceeding the desktop's own
    // queue rows means omp retained them. They keep their optimistic row and
    // queue entry — display-only, omp owns delivery — until the count shows
    // the harness delivered them.
    const queueIntentCount = pendingQueuedPromptsRef.current.filter((prompt) => prompt.intent === 'queue').length
    const retainedByHarness = snapshot.queuedCount > queueIntentCount
    for (const prompt of settled) {
      if (retainedByHarness) harnessHeldSteerIdsRef.current.add(prompt.id)
      else harnessHeldSteerIdsRef.current.delete(prompt.id)
    }
    const deliveredByHarness = snapshot.queuedCount <= queueIntentCount
      ? [...harnessHeldSteerIdsRef.current].filter((id) => (
        pendingQueuedPromptsRef.current.some((prompt) => prompt.id === id) && !stillQueued.has(id)
      ))
      : []
    for (const id of deliveredByHarness) harnessHeldSteerIdsRef.current.delete(id)
    if (!settled.length && !deliveredByHarness.length) return

    // A disappearing preview is a pickup only when the scheduler exposes an
    // active turn. Queue clearing/abort removes the pending row too, but must
    // not inject the cancelled message into transcript history.
    const pickedUp = snapshot.active?.kind === 'turn' ? settled.filter((prompt) => !harnessHeldSteerIdsRef.current.has(prompt.id)) : []
    const removedIds = new Set([...settled.filter((prompt) => !harnessHeldSteerIdsRef.current.has(prompt.id) && !pickedUp.includes(prompt)).map((prompt) => prompt.id), ...deliveredByHarness])
    // A steer that disappeared without an active turn was cancelled: its
    // optimistic row must go with its queue entry. A harness-delivered steer
    // retracts its row too — the harness events render the durable one.
    for (const id of removedIds) applyLocalRowEvent(createSteerRetractEvent({ id }))
    const next = pendingQueuedPromptsRef.current.filter((prompt) => !removedIds.has(prompt.id) && !pickedUp.some((picked) => picked.id === prompt.id))
    pendingQueuedPromptsRef.current = next
    const owner = activeQueuedPromptOwnerRef.current
    if (owner) {
      if (next.length) queuedPromptsByOwnerRef.current.set(owner, next)
      else queuedPromptsByOwnerRef.current.delete(owner)
    }
    for (const prompt of pickedUp) observedSteerIdsRef.current.delete(prompt.id)
    for (const id of removedIds) observedSteerIdsRef.current.delete(id)
    setPendingQueuedPrompts(next)

    // Keep the pickup boundary in the same ordered event buffer as preceding
    // tool output. Directly mutating messages here would let an unflushed tool
    // event jump below the newly inserted user row.
    if (pickedUp.length) queueAgentEvent(createSteerPickupEvent(pickedUp))
  }, [applyLocalRowEvent, queueAgentEvent])

  const acknowledgeSteer = useCallback((id: string, snapshot: SessionActionSnapshot) => {
    if (!pendingQueuedPromptsRef.current.some((prompt) => prompt.id === id && prompt.intent === 'steer')) return
    // The command response proves admission. Reconcile against the
    // post-admission snapshot returned with it so a steer that was picked up
    // before the renderer received either scheduler edge cannot remain stuck.
    observedSteerIdsRef.current.add(id)
    reconcileQueuedPrompts(snapshot)
  }, [reconcileQueuedPrompts])

  /** A steer the harness injected into the running turn: the durable user row
   *  already came from the harness, so only the optimistic row and queue entry
   *  are dropped here. omp's queuedMessageCount can stay at 1 until the turn
   *  ends, so the snapshot fold alone would leave the chip behind. */
  const deliverQueuedSteer = useCallback((text: string) => {
    const prompt = pendingQueuedPromptsRef.current.find((candidate) => candidate.intent === 'steer' && candidate.text === text)
    if (!prompt) return
    observedSteerIdsRef.current.delete(prompt.id)
    harnessHeldSteerIdsRef.current.delete(prompt.id)
    applyLocalRowEvent(createSteerRetractEvent({ id: prompt.id }))
    const next = pendingQueuedPromptsRef.current.filter((candidate) => candidate.id !== prompt.id)
    pendingQueuedPromptsRef.current = next
    const owner = activeQueuedPromptOwnerRef.current
    if (owner) {
      if (next.length) queuedPromptsByOwnerRef.current.set(owner, next)
      else queuedPromptsByOwnerRef.current.delete(owner)
    }
    setPendingQueuedPrompts(next)
  }, [applyLocalRowEvent])

  /** Re-queues input omp withdrew for an abort (`abort_and_restore_queue`).
   * Steers the reply proves withdrawn lose their optimistic row and queue
   * entry; every returned message comes back as an unsent local item —
   * recovered, so only an explicit chip send can deliver it — under the
   * stopped session's owner, which also survives a workspace switch. */
  const restoreWithdrawnQueue = useCallback((withdrawn: WithdrawnQueue, owner: { harness: HarnessId; sessionFile?: string; runtimeId: string }) => {
    const ownerKey = owner.sessionFile
      ? `${owner.harness}:session:${owner.sessionFile}`
      : `${owner.harness}:runtime:${owner.runtimeId}`
    const withdrawnSteerTexts = new Map<string, number>()
    for (const message of withdrawn.steering) withdrawnSteerTexts.set(message.text, (withdrawnSteerTexts.get(message.text) ?? 0) + 1)
    const takeWithdrawnText = (text: string): boolean => {
      const remaining = withdrawnSteerTexts.get(text) ?? 0
      if (remaining <= 0) return false
      withdrawnSteerTexts.set(text, remaining - 1)
      return true
    }
    const dropWithdrawnSteers = (prompts: QueuedPrompt[]): QueuedPrompt[] => prompts.filter((prompt) => {
      if (prompt.intent !== 'steer' || !takeWithdrawnText(prompt.text)) return true
      observedSteerIdsRef.current.delete(prompt.id)
      harnessHeldSteerIdsRef.current.delete(prompt.id)
      applyLocalRowEvent(createSteerRetractEvent({ id: prompt.id }))
      return false
    })
    const restored: QueuedPrompt[] = [...withdrawn.steering, ...withdrawn.followUp].map((message) => ({
      id: nextQueuedPromptId(),
      text: message.text,
      intent: 'queue' as const,
      timestamp: Date.now(),
      parts: [{ type: 'text' as const, text: message.text }, ...(message.images ?? [])],
      recovered: true,
      flushAttemptFailed: true,
    }))
    const bucket = queuedPromptsByOwnerRef.current.get(ownerKey) ?? []
    const nextBucket = [...dropWithdrawnSteers(bucket), ...restored]
    if (nextBucket.length) queuedPromptsByOwnerRef.current.set(ownerKey, nextBucket)
    else queuedPromptsByOwnerRef.current.delete(ownerKey)
    if (activeQueuedPromptOwnerRef.current === ownerKey) {
      pendingQueuedPromptsRef.current = nextBucket
      setPendingQueuedPrompts(nextBucket)
    }
    savePendingQueues(queuedPromptsByOwnerRef.current)
  }, [applyLocalRowEvent])

  /** Removes one message omp holds, by the queue-chip text its state reports.
   * Returns the removal outcome — including the removed message's images and
   * omp's transport-loss flag when it reports one — or null when the runtime
   * or RPC is unreachable; omp's own events remain the display authority. */
  const removeHarnessQueuedMessage = useCallback(async (message: string, queue: 'steering' | 'followUp'): Promise<{ removed: boolean; images?: MessagePart[]; imagesDropped?: boolean } | null> => {
    const runtimeId = runtimeIdRef.current
    if (!bridge || !runtimeId) return null
    try {
      const response = await bridge.agent.command(runtimeId, { type: 'remove_queued_message', message, queue })
      const actions = parseSessionActionSnapshot(response.sessionActions)
      if (actions) setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, sessionActions: actions } : current)
      const data = response.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null
      const raw = data as Record<string, unknown>
      const images = Array.isArray(raw.images)
        ? raw.images.flatMap((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return []
            const candidate = value as Record<string, unknown>
            return candidate.type === 'image' && typeof candidate.data === 'string' && typeof candidate.mimeType === 'string'
              ? [{ type: 'image' as const, data: candidate.data, mimeType: candidate.mimeType }]
              : []
          })
        : undefined
      return { removed: raw.removed === true, ...(images?.length ? { images } : {}), ...(raw.imagesDropped === true ? { imagesDropped: true } : {}) }
    } catch {
      return null
    }
  }, [bridge])

  /** Moves one queued follow-up omp holds to the end of the steering queue. */
  const promoteHarnessQueuedMessage = useCallback(async (message: string): Promise<{ promoted: boolean } | null> => {
    const runtimeId = runtimeIdRef.current
    if (!bridge || !runtimeId) return null
    try {
      const response = await bridge.agent.command(runtimeId, { type: 'promote_queued_message', message })
      const actions = parseSessionActionSnapshot(response.sessionActions)
      if (actions) setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, sessionActions: actions } : current)
      const data = response.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null
      return { promoted: (data as Record<string, unknown>).promoted === true }
    } catch {
      return null
    }
  }, [bridge])

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const locallyOwnedActiveSession = Boolean(
    activeSession?.filePath && runtime?.sessionFile === activeSession.filePath,
  )
  const externalSessionUpdatedAt = locallyOwnedActiveSession ? undefined : activeSession?.updatedAt
  const externalSessionSyncRevision = locallyOwnedActiveSession ? undefined : activeSession?.syncRevision
  const attachedRuntimeSessionFile = runtime?.sessionFile
  const attachedRuntimeId = runtime?.runtimeId
  useEffect(() => {
    // Follow the owned runtime's session-file change live: a native session
    // boundary or a move redirects the running runtime to a new path
    // (observed through runtime_state pushes and runtime re-attach).
    // Compact rewrites in place and never appears here. The catalog row for
    // the new file arrives with the next sessions sync — the effect retries
    // as `sessions` updates.
    if (!bridge || !attachedRuntimeSessionFile || !attachedRuntimeId) return
    if (runtimeOwnerRef.current?.runtimeId !== attachedRuntimeId) return
    const selected = workspaceRef.current
    if (!selected.sessionFile || attachedRuntimeSessionFile === selected.sessionFile) return
    const followed = sessions.find((session) => session.harness === harnessRef.current && session.filePath === attachedRuntimeSessionFile)
    if (followed) followOwnedRuntimeSession(followed)
  }, [followOwnedRuntimeSession, attachedRuntimeId, attachedRuntimeSessionFile, bridge, sessions])

  useEffect(() => {
    if (!bridge || !activeSession?.filePath) {
      // While an adopted session is un-read the catalog may flap (row missing
      // under the live workspace): keep the in-flight transcript instead of
      // blanking it under older on-disk state. Cleared by activateWorkspace.
      if (bridge && !activeSession && adoptionPendingCatalogRef.current !== workspaceRef.current.session?.id) {
        transcriptLoadRef.current = null
        lastTranscriptReadWorkspaceRef.current = null
        setMessages([])
      }
      setLoadingSession(false)
      return
    }
    const selected = workspaceRef.current
    if (selected.generation !== workspaceGeneration || selected.sessionFile !== activeSession.filePath) {
      // Recovery: an admitted load for the live workspace snapshot must still be
      // started even when this render's catalog view diverges (for example a
      // renamed session record), or its events buffer forever and the session
      // never finishes loading.
      const admitted = transcriptLoadRef.current
      if (admitted && !admitted.reconciliation
        && admitted.generation === selected.generation
        && admitted.sessionFile === selected.sessionFile
        && selected.sessionFile
        && lastTranscriptReadWorkspaceRef.current?.generation !== selected.generation) {
        lastTranscriptReadWorkspaceRef.current = { generation: selected.generation, sessionFile: selected.sessionFile }
        startTranscriptRead(selected, false, undefined, admitted)
      }
      return
    }
    const previousReadWorkspace = lastTranscriptReadWorkspaceRef.current
    const workspaceChanged = previousReadWorkspace?.generation !== selected.generation
      || previousReadWorkspace.sessionFile !== activeSession.filePath
    lastTranscriptReadWorkspaceRef.current = { generation: selected.generation, sessionFile: activeSession.filePath }
    if (!workspaceChanged && locallyOwnedActiveSession) return
    const admittedLoad = transcriptLoadRef.current
    if (admittedLoad?.generation === workspaceGeneration && admittedLoad.sessionFile === activeSession.filePath) {
      if (admittedLoad.reconciliation) return
      // An admitted load that already issued its IPC keeps it: re-admitting the
      // same workspace would start a second read of the same file, and the
      // newer catalog revision is only a stale marker for the read in flight.
      if (!admittedLoad.started) { startTranscriptRead(selected, false, undefined, admittedLoad); return }
      if (!workspaceChanged) requestExternalTranscriptRead(selected)
      return
    }
    // A workspace switch is a first load and stays immediate; a catalog revision
    // for the file already shown is an external append and is coalesced.
    if (workspaceChanged) startTranscriptRead(selected, false)
    else requestExternalTranscriptRead(selected)
  }, [activeSession?.filePath, bridge, externalSessionSyncRevision, externalSessionUpdatedAt, locallyOwnedActiveSession, requestExternalTranscriptRead, startTranscriptRead, workspaceGeneration])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (reconcileOnVisibleRef.current) {
        runOverflowReconciliation()
        return
      }
      flushAgentEventsChunked()
      // Returning to the foreground refreshes at once: the reader is looking at
      // the transcript now, so the coalescing window is not applied here.
      if (externalReadDirtyRef.current) startExternalRead()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [flushAgentEventsChunked, runOverflowReconciliation, startExternalRead])

  useEffect(() => () => {
    transcriptLoadRef.current = null
    if (agentEventFrameRef.current !== null) cancelAnimationFrame(agentEventFrameRef.current)
    if (chunkedFlushTimerRef.current !== null) window.clearTimeout(chunkedFlushTimerRef.current)
    if (externalReadTimerRef.current !== null) window.clearTimeout(externalReadTimerRef.current)
  }, [])

  useEffect(() => { savePendingQueues(queuedPromptsByOwnerRef.current) }, [pendingQueuedPrompts, workspaceGeneration])

  return {
    get messages() { return transcriptStore.getSnapshot() },
    transcriptStore,
    transcriptSummary,
    setMessages,
    pendingQueuedPrompts,
    queuePrompt,
    restoreWithdrawnQueue,
    removeHarnessQueuedMessage,
    promoteHarnessQueuedMessage,
    removeQueuedPrompt,
    editQueuedPrompt,
    updateQueuedPromptDelivery,
    pauseQueuedPrompts,
    markQueuedPromptFlushFailed,
    clearQueuedPromptFlushFailures,
    clearQueuedPrompts,
    acceptSteer,
    retractQueuedPrompt,
    reconcileQueuedPrompts,
    acknowledgeSteer,
    deliverQueuedSteer,
    activeProjectId,
    activeSessionId,
    runtime,
    setRuntime,
    workspaceGeneration,
    loadingSession,
    runtimeIdRef,
    runtimeSessionsRef,
    runtimeOwnerRef,
    workspaceRef,
    activateWorkspace,
    adoptSessionId,
    attachRuntime,
    reconcileRuntime,
    prepareForPrompt,
    queueAgentEvent,
    reconcileTranscriptForEvent,
  }
}
