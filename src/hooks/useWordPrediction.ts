import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, CompositionEvent, Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react'
import { MAX_PREDICTION_SUFFIX_CHARS, MAX_PREDICTION_TEXT_CHARS } from '@/lib/word-prediction'

const PREDICTION_DEBOUNCE_MS = 300

export interface WordPredictionAgent {
  command(runtimeId: string, command: Record<string, unknown>): Promise<Record<string, unknown>>
}

interface WordPredictionRecord {
  agent: WordPredictionAgent
  runtimeId: string
  sessionId: string
  draftKey: string
  generation: number
  text: string
  cursor: number
}

export interface VisibleWordPrediction extends WordPredictionRecord {
  suggestion: string
}

interface UseWordPredictionOptions {
  agent?: WordPredictionAgent | null
  runtimeId?: string | null
  sessionId?: string | null
  draftKey?: string
  value: string
  enabled: boolean
  menuOpen: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
  composingRef: RefObject<boolean>
  setValue: Dispatch<SetStateAction<string>>
}

function predictionSuffix(response: Record<string, unknown>): string | null {
  if (response.success !== true) return null
  const data = response.data
  if (typeof data !== 'object' || data === null || !('suffix' in data)) return null
  const suffix = data.suffix
  return typeof suffix === 'string' && suffix.length > 0 && suffix.length <= MAX_PREDICTION_SUFFIX_CHARS ? suffix : null
}

export function useWordPrediction({
  agent,
  runtimeId,
  sessionId,
  draftKey,
  value,
  enabled,
  menuOpen,
  textareaRef,
  composingRef,
  setValue,
}: UseWordPredictionOptions) {
  const [visible, setVisible] = useState<VisibleWordPrediction | null>(null)
  const visibleRef = useRef<VisibleWordPrediction | null>(null)
  const latestCandidateRef = useRef<WordPredictionRecord | null>(null)
  const queuedCandidateRef = useRef<WordPredictionRecord | null>(null)
  const requestRef = useRef<WordPredictionRecord | null>(null)
  const feedbackSentRef = useRef<WordPredictionRecord | null>(null)
  const generationRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const agentRef = useRef(agent)
  const runtimeIdRef = useRef(runtimeId)
  const sessionIdRef = useRef(sessionId)
  const draftKeyRef = useRef(draftKey)
  const valueRef = useRef(value)
  const enabledRef = useRef(enabled)
  const menuOpenRef = useRef(menuOpen)
  const setValueRef = useRef(setValue)
  agentRef.current = agent
  runtimeIdRef.current = runtimeId
  sessionIdRef.current = sessionId
  draftKeyRef.current = draftKey
  valueRef.current = value
  enabledRef.current = enabled
  menuOpenRef.current = menuOpen
  setValueRef.current = setValue

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const invalidate = () => {
    generationRef.current += 1
    clearTimer()
    latestCandidateRef.current = null
    queuedCandidateRef.current = null
    visibleRef.current = null
    if (mountedRef.current) setVisible(null)
  }

  const ownerMatches = (record: WordPredictionRecord) =>
    enabledRef.current &&
    !menuOpenRef.current &&
    agentRef.current === record.agent &&
    runtimeIdRef.current === record.runtimeId &&
    sessionIdRef.current === record.sessionId &&
    draftKeyRef.current === record.draftKey &&
    generationRef.current === record.generation

  const editorMatches = (record: WordPredictionRecord) => {
    const textarea = textareaRef.current
    return ownerMatches(record) &&
      !composingRef.current &&
      valueRef.current === record.text &&
      document.activeElement === textarea &&
      textarea?.value === record.text &&
      textarea.selectionStart === record.cursor &&
      textarea.selectionEnd === record.cursor
  }

  const sendFeedback = (record: VisibleWordPrediction, accepted: boolean) => {
    if (feedbackSentRef.current === record) return
    feedbackSentRef.current = record
    void record.agent.command(record.runtimeId, {
      type: 'predict_word_feedback',
      text: record.text,
      cursor: record.cursor,
      suggestion: record.suggestion,
      accepted,
    }).catch(() => undefined)
  }

  const dispatch = (record: WordPredictionRecord) => {
    if (!editorMatches(record)) {
      if (latestCandidateRef.current === record) invalidate()
      return
    }
    if (requestRef.current) {
      queuedCandidateRef.current = record
      return
    }
    void execute(record)
  }

  const execute = async (record: WordPredictionRecord) => {
    requestRef.current = record
    let suffix: string | null = null
    try {
      suffix = predictionSuffix(await record.agent.command(record.runtimeId, {
        type: 'predict_word',
        text: record.text,
        cursor: record.cursor,
      }))
    } catch {
      suffix = null
    }
    if (requestRef.current === record) requestRef.current = null
    if (mountedRef.current && latestCandidateRef.current === record && generationRef.current === record.generation) {
      if (!editorMatches(record)) {
        invalidate()
      } else {
        latestCandidateRef.current = null
        if (suffix) {
          const next = { ...record, suggestion: suffix }
          visibleRef.current = next
          setVisible(next)
        }
      }
    }
    const queued = queuedCandidateRef.current
    queuedCandidateRef.current = null
    if (queued && mountedRef.current && generationRef.current === queued.generation) await executeRef.current(queued)
  }

  const dispatchRef = useRef(dispatch)
  const executeRef = useRef(execute)
  const invalidateRef = useRef(invalidate)
  dispatchRef.current = dispatch
  executeRef.current = execute
  invalidateRef.current = invalidate

  const schedule = (textarea: HTMLTextAreaElement) => {
    const currentAgent = agentRef.current
    const currentRuntimeId = runtimeIdRef.current
    const currentSessionId = sessionIdRef.current
    const currentDraftKey = draftKeyRef.current
    const cursor = textarea.selectionStart
    const text = textarea.value
    if (
      !currentAgent ||
      !currentRuntimeId ||
      !currentSessionId ||
      !currentDraftKey ||
      !enabledRef.current ||
      menuOpenRef.current ||
      composingRef.current ||
      document.activeElement !== textarea ||
      cursor === null ||
      textarea.selectionEnd !== cursor ||
      text.length === 0 ||
      text.length > MAX_PREDICTION_TEXT_CHARS
    ) return
    generationRef.current += 1
    const record: WordPredictionRecord = {
      agent: currentAgent,
      runtimeId: currentRuntimeId,
      sessionId: currentSessionId,
      draftKey: currentDraftKey,
      generation: generationRef.current,
      text,
      cursor,
    }
    latestCandidateRef.current = record
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      if (generationRef.current === record.generation) dispatchRef.current(record)
    }, PREDICTION_DEBOUNCE_MS)
  }

  const syncSelection = () => {
    const record = visibleRef.current ?? latestCandidateRef.current
    if (record && !editorMatches(record)) invalidateRef.current()
  }
  const syncSelectionRef = useRef(syncSelection)
  syncSelectionRef.current = syncSelection

  useLayoutEffect(() => {
    const record = visibleRef.current ?? latestCandidateRef.current
    if (record && !editorMatches(record)) invalidate()
  }, [agent, runtimeId, sessionId, draftKey, value, enabled, menuOpen, visible])

  useEffect(() => {
    const onSelectionChange = () => syncSelectionRef.current()
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      clearTimer()
      latestCandidateRef.current = null
      queuedCandidateRef.current = null
      requestRef.current = null
      visibleRef.current = null
    }
  }, [])

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const current = visibleRef.current
    const isComposing = composingRef.current || ('isComposing' in event.nativeEvent && event.nativeEvent.isComposing === true)
    if (current && !isComposing && ownerMatches(current) && valueRef.current === current.text && document.activeElement === event.currentTarget) {
      sendFeedback(current, false)
    }
    invalidate()
    if (!isComposing) schedule(event.currentTarget)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      invalidate()
      return false
    }
    if (
      event.key !== 'Tab' ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      composingRef.current
    ) return false
    const current = visibleRef.current
    if (!current || !editorMatches(current)) return false
    const textarea = event.currentTarget
    event.preventDefault()
    invalidate()
    textarea.setRangeText(current.suggestion, current.cursor, current.cursor, 'end')
    setValueRef.current(textarea.value)
    sendFeedback(current, true)
    return true
  }

  const onCompositionStart = () => invalidate()
  const onCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    invalidate()
    schedule(event.currentTarget)
  }

  return {
    visible,
    onChange,
    onKeyDown,
    onKeyUp: syncSelection,
    onSelect: syncSelection,
    onBlur: invalidate,
    onCompositionStart,
    onCompositionEnd,
  }
}
