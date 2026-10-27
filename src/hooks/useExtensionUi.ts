import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ExtensionUiResponse } from '@/components/ExtensionUiModal'
import {
  ASK_USER_TIMEOUT_MS,
  askAnswersViolation,
  parseExtensionUiCancel,
  parseExtensionUiFrame,
  parseExtensionUiPresentation,
  type ExtensionUiPresentation,
  type ExtensionUiQuestionnaireRequest,
  type ExtensionUiRequest,
} from '@/lib/extension-ui'
import {
  classifyUnhandledExtensionUiFrame,
  type ExtensionUiCapabilityNotice,
} from '@/lib/extension-capabilities'
import type { DesktopApi, RuntimeInfo, SessionRecord } from '@/types/api'

interface UseExtensionUiOptions {
  bridge: DesktopApi | null
  activeRuntimeId?: string
  runtimeSessionsRef: React.RefObject<Map<string, string>>
  setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>
  setRuntime: React.Dispatch<React.SetStateAction<RuntimeInfo | null>>
  reportError(error: unknown): void
}

type QuestionnaireSelectRequest = Extract<ExtensionUiRequest, { method: 'select' }>

export interface PendingExtensionUi {
  runtimeId: string
  request: ExtensionUiRequest
  requests?: QuestionnaireSelectRequest[]
}

export function pendingExtensionUiForRuntime(
  pending: ReadonlyMap<string, PendingExtensionUi>,
  runtimeId?: string,
): PendingExtensionUi | null {
  return runtimeId ? pending.get(runtimeId) ?? null : null
}

function requestIds(pending: PendingExtensionUi): string[] {
  return pending.request.method === 'questionnaire'
    ? (pending.requests ?? []).map((request) => request.id)
    : [pending.request.id]
}

function staleKey(runtimeId: string, requestId: string): string {
  return `${runtimeId}:${requestId}`
}

function buildQuestionnairePending(
  runtimeId: string,
  requests: QuestionnaireSelectRequest[],
  timeout: number | undefined,
): PendingExtensionUi {
  const questions = requests
    .map((item) => ({
      id: item.id,
      title: item.title,
      options: item.options,
      index: item.questionnaire?.index ?? 0,
    }))
    .sort((a, b) => a.index - b.index)
  const total = requests[0]?.questionnaire?.total ?? requests.length
  const request: ExtensionUiQuestionnaireRequest = {
    method: 'questionnaire',
    id: requests[0]?.questionnaire?.groupId ?? requests[0]?.id ?? '',
    title: `Answer ${total} question${total === 1 ? '' : 's'}`,
    questions,
    total,
    complete: questions.length >= total,
    timeout,
  }
  return { runtimeId, request, requests }
}

export interface ExtensionUiWidgetState {
  key: string
  lines: string[]
  placement?: 'aboveEditor' | 'belowEditor'
}

export interface ExtensionUiEditorTextUpdate {
  runtimeId: string
  text: string
}

export interface ExtensionUiOpenUrlRequest {
  runtimeId: string
  url: string
  launchUrl?: string
  instructions?: string
}

export function useExtensionUi({
  bridge,
  activeRuntimeId,
  runtimeSessionsRef,
  setSessions,
  setRuntime,
  reportError,
}: UseExtensionUiOptions) {
  const [extensionUi, setExtensionUi] = useState<PendingExtensionUi | null>(null)
  // Presentation state (setStatus / setWidget / set_editor_text / open_url),
  // scoped per runtime so nothing leaks across sessions.
  const [statusByRuntime, setStatusByRuntime] = useState<Map<string, Map<string, string>>>(new Map())
  const [widgetByRuntime, setWidgetByRuntime] = useState<Map<string, Map<string, ExtensionUiWidgetState>>>(new Map())
  const [editorTextByRuntime, setEditorTextByRuntime] = useState<Map<string, string>>(new Map())
  const [openUrlByRuntime, setOpenUrlByRuntime] = useState<Map<string, ExtensionUiOpenUrlRequest>>(new Map())
  // Explicit "unsupported/unrecognized extension update" notices (phase 6.3):
  // frames OMP emitted that this app cannot render surface here instead of
  // being silently dropped.
  const [noticeByRuntime, setNoticeByRuntime] = useState<Map<string, Map<string, ExtensionUiCapabilityNotice>>>(new Map())
  const extensionUiRef = useRef<PendingExtensionUi | null>(null)
  const pendingByRuntimeRef = useRef<Map<string, PendingExtensionUi>>(new Map())
  // Dialog requests waiting behind the one currently shown for their runtime.
  const queuedByRuntimeRef = useRef<Map<string, ExtensionUiRequest[]>>(new Map())
  const timerByRuntimeRef = useRef<Map<string, number>>(new Map())
  // Questionnaire groups this app has already answered cancelled (user dismiss
  // or timeout); late group members are answered cancelled without a dialog.
  const settledQuestionnaireGroupsRef = useRef<Set<string>>(new Set())
  // Latest-ref indirection so the timeout handler can advance the queue
  // without a circular useCallback dependency on advanceRuntime.
  const advanceRuntimeRef = useRef<(runtimeId: string) => void>(() => undefined)
  // Requests OMP settled itself via an upstream cancel frame. They must never
  // receive a second response from this app.
  const staleRequestIdsRef = useRef<Set<string>>(new Set())
  const activeRuntimeIdRef = useRef(activeRuntimeId)
  useLayoutEffect(() => { activeRuntimeIdRef.current = activeRuntimeId })

  const showPendingForActiveRuntime = useCallback(() => {
    const visible = pendingExtensionUiForRuntime(pendingByRuntimeRef.current, activeRuntimeIdRef.current)
    extensionUiRef.current = visible
    setExtensionUi(visible)
  }, [])

  const clearExtensionUi = useCallback((runtimeId?: string) => {
    const targetRuntimeId = runtimeId ?? extensionUiRef.current?.runtimeId
    if (!targetRuntimeId) return
    const timer = timerByRuntimeRef.current.get(targetRuntimeId)
    if (timer !== undefined) window.clearTimeout(timer)
    timerByRuntimeRef.current.delete(targetRuntimeId)
    pendingByRuntimeRef.current.delete(targetRuntimeId)
    queuedByRuntimeRef.current.delete(targetRuntimeId)
    setStatusByRuntime((current) => {
      if (!current.has(targetRuntimeId)) return current
      const next = new Map(current)
      next.delete(targetRuntimeId)
      return next
    })
    setWidgetByRuntime((current) => {
      if (!current.has(targetRuntimeId)) return current
      const next = new Map(current)
      next.delete(targetRuntimeId)
      return next
    })
    setEditorTextByRuntime((current) => {
      if (!current.has(targetRuntimeId)) return current
      const next = new Map(current)
      next.delete(targetRuntimeId)
      return next
    })
    setOpenUrlByRuntime((current) => {
      if (!current.has(targetRuntimeId)) return current
      const next = new Map(current)
      next.delete(targetRuntimeId)
      return next
    })
    setNoticeByRuntime((current) => {
      if (!current.has(targetRuntimeId)) return current
      const next = new Map(current)
      next.delete(targetRuntimeId)
      return next
    })
    if (extensionUiRef.current?.runtimeId === targetRuntimeId) {
      extensionUiRef.current = null
      setExtensionUi(null)
    }
  }, [])

  const recordCapabilityNotice = useCallback((runtimeId: string, notice: ExtensionUiCapabilityNotice) => {
    setNoticeByRuntime((current) => {
      const next = new Map(current)
      const entries = new Map(next.get(runtimeId) ?? [])
      // Refresh insertion order for dedupe; bounded so a chatty upstream
      // method cannot flood the composer area.
      entries.delete(notice.id)
      entries.set(notice.id, notice)
      while (entries.size > 8) entries.delete(entries.keys().next().value as string)
      next.set(runtimeId, entries)
      return next
    })
  }, [])

  const sendCancelledResponse = useCallback((runtimeId: string, requestId: string, options?: { timedOut?: boolean }) => {
    if (!bridge || staleRequestIdsRef.current.has(staleKey(runtimeId, requestId))) return
    void bridge.agent.command(runtimeId, {
      type: 'extension_ui_response',
      id: requestId,
      cancelled: true,
      ...(options?.timedOut ? { timedOut: true } : {}),
    }).catch(() => undefined)
  }, [bridge])

  const cancelPending = useCallback((pending: PendingExtensionUi, options?: { timedOut?: boolean }) => {
    for (const id of requestIds(pending)) sendCancelledResponse(pending.runtimeId, id, options)
  }, [sendCancelledResponse])

  const applyPresentation = useCallback((runtimeId: string, update: ExtensionUiPresentation) => {
    if (update.kind === 'status') {
      setStatusByRuntime((current) => {
        const next = new Map(current)
        const entries = new Map(next.get(runtimeId) ?? [])
        if (update.statusText === undefined) entries.delete(update.statusKey)
        else entries.set(update.statusKey, update.statusText)
        if (entries.size === 0) next.delete(runtimeId)
        else next.set(runtimeId, entries)
        return next
      })
      return
    }
    if (update.kind === 'widget') {
      setWidgetByRuntime((current) => {
        const next = new Map(current)
        const entries = new Map(next.get(runtimeId) ?? [])
        if (update.widgetLines === undefined) entries.delete(update.widgetKey)
        else entries.set(update.widgetKey, { key: update.widgetKey, lines: update.widgetLines, ...(update.widgetPlacement ? { placement: update.widgetPlacement } : {}) })
        if (entries.size === 0) next.delete(runtimeId)
        else next.set(runtimeId, entries)
        return next
      })
      return
    }
    if (update.kind === 'editorText') {
      // Never applied automatically: the pending update stays visible until
      // the app consumes or dismisses it, so a nonempty composer draft can
      // surface a conflict instead of being overwritten.
      setEditorTextByRuntime((current) => new Map(current).set(runtimeId, update.text))
      return
    }
    setOpenUrlByRuntime((current) => new Map(current).set(runtimeId, { runtimeId, url: update.url, ...(update.launchUrl ? { launchUrl: update.launchUrl } : {}), ...(update.instructions ? { instructions: update.instructions } : {}) }))
  }, [])

  const setDisplayedPending = useCallback((runtimeId: string, pending: PendingExtensionUi) => {
    pendingByRuntimeRef.current.set(runtimeId, pending)
    if (activeRuntimeIdRef.current === runtimeId) {
      extensionUiRef.current = pending
      setExtensionUi(pending)
    }
  }, [])

  const scheduleTimeout = useCallback((pending: PendingExtensionUi) => {
    const timeout = 'timeout' in pending.request ? pending.request.timeout : undefined
    if (timeout === undefined || timerByRuntimeRef.current.has(pending.runtimeId)) return
    timerByRuntimeRef.current.set(pending.runtimeId, window.setTimeout(() => {
      const current = pendingByRuntimeRef.current.get(pending.runtimeId)
      if (!current || current.request.id !== pending.request.id) return
      if (current.request.method === 'questionnaire') settledQuestionnaireGroupsRef.current.add(`${pending.runtimeId}:${pending.request.id}`)
      // Only native ask uses the timedOut flag: OMP then answers each question
      // with its recommended (else first) option. Manual cancels, aborts, and
      // every other dialog method stay plain cancelled.
      cancelPending(current, current.request.method === 'ask' ? { timedOut: true } : undefined)
      advanceRuntimeRef.current(pending.runtimeId)
    }, timeout))
  }, [cancelPending])

  const presentRequest = useCallback((runtimeId: string, request: ExtensionUiRequest) => {
    if (request.method === 'select' && request.questionnaire) {
      // Gather same-group siblings that piled up in the queue so the
      // questionnaire stays grouped even when it arrived behind another dialog.
      const queued = queuedByRuntimeRef.current.get(runtimeId) ?? []
      const group: QuestionnaireSelectRequest[] = [request]
      const remaining: ExtensionUiRequest[] = []
      for (const item of queued) {
        if (item.method === 'select' && item.questionnaire?.groupId === request.questionnaire.groupId) group.push(item)
        else remaining.push(item)
      }
      queuedByRuntimeRef.current.set(runtimeId, remaining)
      const pending = buildQuestionnairePending(runtimeId, group, request.timeout ?? ASK_USER_TIMEOUT_MS)
      setDisplayedPending(runtimeId, pending)
      scheduleTimeout(pending)
      return
    }
    const pending: PendingExtensionUi = { runtimeId, request }
    setDisplayedPending(runtimeId, pending)
    scheduleTimeout(pending)
  }, [scheduleTimeout, setDisplayedPending])

  const advanceRuntime = useCallback((runtimeId: string) => {
    const timer = timerByRuntimeRef.current.get(runtimeId)
    if (timer !== undefined) window.clearTimeout(timer)
    timerByRuntimeRef.current.delete(runtimeId)
    for (;;) {
      const queued = queuedByRuntimeRef.current.get(runtimeId)
      const next = queued?.shift()
      if (!next) {
        clearExtensionUi(runtimeId)
        return
      }
      if (next.method === 'select' && next.questionnaire
        && settledQuestionnaireGroupsRef.current.has(`${runtimeId}:${next.questionnaire.groupId}`)) {
        sendCancelledResponse(runtimeId, next.id)
        continue
      }
      presentRequest(runtimeId, next)
      return
    }
  }, [clearExtensionUi, presentRequest, sendCancelledResponse])
  useLayoutEffect(() => { advanceRuntimeRef.current = advanceRuntime })

  const enqueueRequest = useCallback((runtimeId: string, request: ExtensionUiRequest) => {
    const queued = queuedByRuntimeRef.current.get(runtimeId) ?? []
    // Duplicate frames for a request already shown or queued are ignored.
    const displayed = pendingByRuntimeRef.current.get(runtimeId)
    const alreadyKnown = (displayed ? requestIds(displayed).includes(request.id) : false)
      || queued.some((item) => item.id === request.id)
    if (alreadyKnown) return
    queuedByRuntimeRef.current.set(runtimeId, [...queued, request])
  }, [])

  const respondToExtensionUi = useCallback(async (response: ExtensionUiResponse) => {
    const pending = extensionUiRef.current
    if (!pending) return
    const runtimeId = pending.runtimeId
    const cancelled = 'cancelled' in response && response.cancelled
    const liveIds = requestIds(pending).filter((id) => !staleRequestIdsRef.current.has(staleKey(runtimeId, id)))
    if (cancelled && pending.request.method === 'questionnaire') {
      // The whole group is dismissed: late members are answered cancelled.
      settledQuestionnaireGroupsRef.current.add(`${runtimeId}:${pending.request.id}`)
    }
    advanceRuntime(runtimeId)
    if (cancelled) {
      for (const id of liveIds) sendCancelledResponse(runtimeId, id)
      return
    }
    if (liveIds.length === 0) return
    setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isStreaming: true } : current)
    const pendingSession = runtimeSessionsRef.current.get(runtimeId)
    if (pendingSession) {
      setSessions((items) => items.map((session) => session.filePath === pendingSession
        ? { ...session, status: 'running', unread: false }
        : session))
    }
    if (!bridge) return
    try {
      if (pending.request.method === 'questionnaire') {
        if ('values' in response) {
          for (const request of pending.requests ?? []) {
            if (staleRequestIdsRef.current.has(staleKey(runtimeId, request.id))) continue
            await bridge.agent.command(runtimeId, {
              type: 'extension_ui_response',
              id: request.id,
              value: response.values[request.id] ?? '',
            })
          }
        }
        return
      }
      if (pending.request.method === 'ask' && 'answers' in response) {
        // Mirror upstream's strict validation: a malformed payload would fail
        // the whole ask tool call, so it is answered cancelled with a clear
        // error instead of ever being sent.
        const violation = askAnswersViolation(pending.request.questions, response.answers)
        if (violation) {
          for (const id of liveIds) sendCancelledResponse(runtimeId, id)
          reportError(new Error(`Ask answers were cancelled because they were invalid: ${violation}.`))
          return
        }
        await bridge.agent.command(runtimeId, {
          type: 'extension_ui_response',
          id: pending.request.id,
          answers: response.answers,
        })
        return
      }
      await bridge.agent.command(runtimeId, {
        type: 'extension_ui_response',
        id: pending.request.id,
        ...response,
      })
    } catch (error) {
      setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isStreaming: false } : current)
      if (activeRuntimeIdRef.current === runtimeId) reportError(error)
    }
  }, [advanceRuntime, bridge, reportError, runtimeSessionsRef, sendCancelledResponse, setRuntime, setSessions])

  const handleUpstreamCancel = useCallback((runtimeId: string, targetId: string) => {
    // OMP settled this dialog itself; never answer it afterwards.
    staleRequestIdsRef.current.add(staleKey(runtimeId, targetId))
    const pending = pendingByRuntimeRef.current.get(runtimeId)
    if (pending && requestIds(pending).includes(targetId)) {
      if (pending.request.method === 'questionnaire') {
        const remainingRequests = (pending.requests ?? []).filter((request) => request.id !== targetId)
        if (remainingRequests.length === 0) {
          advanceRuntime(runtimeId)
          return
        }
        const updated = buildQuestionnairePending(runtimeId, remainingRequests, pending.request.timeout)
        setDisplayedPending(runtimeId, updated)
        return
      }
      advanceRuntime(runtimeId)
      return
    }
    const queued = queuedByRuntimeRef.current.get(runtimeId)
    if (!queued) return
    const remaining = queued.filter((request) => request.id !== targetId)
    if (remaining.length === 0) queuedByRuntimeRef.current.delete(runtimeId)
    else queuedByRuntimeRef.current.set(runtimeId, remaining)
  }, [advanceRuntime, setDisplayedPending])

  const showExtensionUi = useCallback((runtimeId: string, rawEvent: Record<string, unknown>) => {
    const presentation = parseExtensionUiPresentation(rawEvent)
    if (presentation) {
      if ('rejection' in presentation) {
        reportError(new Error(`Extension presentation frame ignored: ${presentation.rejection.reason}.`))
        return
      }
      applyPresentation(runtimeId, presentation.update)
      return
    }
    const cancel = parseExtensionUiCancel(rawEvent)
    if (cancel) {
      handleUpstreamCancel(runtimeId, cancel.targetId)
      return
    }
    const frame = parseExtensionUiFrame(rawEvent)
    if (!frame) {
      // Nothing handled this frame. Parity phase 6.3: never drop it silently —
      // surface an explicit notice. Unknown methods may be dialog requests a
      // newer OMP awaits; a cancelled response is ignored upstream when no
      // request is pending, so it is safe to send and prevents a hang.
      const notice = classifyUnhandledExtensionUiFrame(rawEvent)
      if (!notice) return
      recordCapabilityNotice(runtimeId, notice)
      if (notice.kind === 'unknown' && notice.requestId) sendCancelledResponse(runtimeId, notice.requestId)
      return
    }
    if (frame.status === 'rejected') {
      // Answer actionable requests this app cannot render with an explicit
      // cancellation so OMP never waits on a dialog that will never appear.
      if (!bridge) return
      void bridge.agent.command(runtimeId, {
        type: 'extension_ui_response',
        id: frame.rejection.id,
        cancelled: true,
      }).catch(() => undefined)
      reportError(new Error(`Extension question was cancelled because it could not be shown: ${frame.rejection.reason}.`))
      return
    }
    const request = frame.request
    if (!bridge) return

    if (request.method === 'select' && request.questionnaire) {
      const questionnaireKey = `${runtimeId}:${request.questionnaire.groupId}`
      if (settledQuestionnaireGroupsRef.current.has(questionnaireKey)) {
        sendCancelledResponse(runtimeId, request.id)
        return
      }
      const previous = pendingByRuntimeRef.current.get(runtimeId)
      const previousRequest = previous?.request
      if (previous && previousRequest?.method === 'questionnaire' && previousRequest.id === request.questionnaire.groupId) {
        const existing = previous.requests ?? []
        const requests = existing.some((item) => item.id === request.id)
          ? existing
          : [...existing, request]
        const updated = buildQuestionnairePending(runtimeId, requests, previousRequest.timeout)
        setDisplayedPending(runtimeId, updated)
        scheduleTimeout(updated)
        return
      }
      if (previous) {
        enqueueRequest(runtimeId, request)
        return
      }
      presentRequest(runtimeId, request)
      return
    }

    if (pendingByRuntimeRef.current.has(runtimeId)) {
      enqueueRequest(runtimeId, request)
      return
    }
    presentRequest(runtimeId, request)
  }, [applyPresentation, bridge, enqueueRequest, handleUpstreamCancel, presentRequest, recordCapabilityNotice, reportError, scheduleTimeout, sendCancelledResponse])

  const hasOpenRequestForSession = useCallback((filePath: string): boolean => {
    for (const runtimeId of pendingByRuntimeRef.current.keys()) {
      if (runtimeSessionsRef.current.get(runtimeId) === filePath) return true
    }
    for (const runtimeId of queuedByRuntimeRef.current.keys()) {
      if (runtimeSessionsRef.current.get(runtimeId) === filePath) return true
    }
    return false
  }, [runtimeSessionsRef])

  const clearEditorTextUpdate = useCallback(() => {
    const runtimeId = activeRuntimeIdRef.current
    if (!runtimeId) return
    setEditorTextByRuntime((current) => {
      if (!current.has(runtimeId)) return current
      const next = new Map(current)
      next.delete(runtimeId)
      return next
    })
  }, [])

  const dismissOpenUrlRequest = useCallback(() => {
    const runtimeId = activeRuntimeIdRef.current
    if (!runtimeId) return
    setOpenUrlByRuntime((current) => {
      if (!current.has(runtimeId)) return current
      const next = new Map(current)
      next.delete(runtimeId)
      return next
    })
  }, [])

  const dismissCapabilityNotice = useCallback((noticeId: string) => {
    const runtimeId = activeRuntimeIdRef.current
    if (!runtimeId) return
    setNoticeByRuntime((current) => {
      const entries = current.get(runtimeId)
      if (!entries?.has(noticeId)) return current
      const next = new Map(current)
      const updated = new Map(entries)
      updated.delete(noticeId)
      if (updated.size === 0) next.delete(runtimeId)
      else next.set(runtimeId, updated)
      return next
    })
  }, [])

  const extensionStatus = activeRuntimeId
    ? Array.from(statusByRuntime.get(activeRuntimeId) ?? [], ([key, text]) => ({ key, text }))
    : []
  const extensionWidgets = activeRuntimeId
    ? Array.from(widgetByRuntime.get(activeRuntimeId) ?? [], ([, widget]) => widget)
    : []
  const editorTextUpdate = activeRuntimeId && editorTextByRuntime.has(activeRuntimeId)
    ? { runtimeId: activeRuntimeId, text: editorTextByRuntime.get(activeRuntimeId) ?? '' }
    : null
  const openUrlRequest = activeRuntimeId ? openUrlByRuntime.get(activeRuntimeId) ?? null : null
  const extensionCapabilityNotices = activeRuntimeId
    ? Array.from(noticeByRuntime.get(activeRuntimeId) ?? [], ([, notice]) => notice)
    : []


  useEffect(() => { showPendingForActiveRuntime() }, [activeRuntimeId, showPendingForActiveRuntime])

  useEffect(() => () => {
    for (const timer of timerByRuntimeRef.current.values()) window.clearTimeout(timer)
    for (const pending of pendingByRuntimeRef.current.values()) cancelPending(pending)
    for (const [runtimeId, requests] of queuedByRuntimeRef.current.entries()) {
      for (const request of requests) sendCancelledResponse(runtimeId, request.id)
    }
    timerByRuntimeRef.current.clear()
    pendingByRuntimeRef.current.clear()
    queuedByRuntimeRef.current.clear()
    settledQuestionnaireGroupsRef.current.clear()
    staleRequestIdsRef.current.clear()
  }, [cancelPending, sendCancelledResponse])

  return {
    extensionUi,
    clearExtensionUi,
    respondToExtensionUi,
    showExtensionUi,
    hasOpenRequestForSession,
    extensionStatus,
    extensionWidgets,
    editorTextUpdate,
    consumeEditorTextUpdate: clearEditorTextUpdate,
    dismissEditorTextUpdate: clearEditorTextUpdate,
    openUrlRequest,
    dismissOpenUrlRequest,
    extensionCapabilityNotices,
    dismissCapabilityNotice,
  }
}
