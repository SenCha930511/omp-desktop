import { useEffect } from 'react'
import { contextUsageFromEvent, sessionUsageFromEvent } from '@/app/agent-events'
import { applySessionLifecycleEvent, sessionLifecycleChange } from '@/app/session-attention'
import { shouldNotifyCompletion, showCompletionNotification } from '@/lib/completion-notify'
import { compactionSyncPendingStore } from '@/lib/compaction-sync-state'
import { agentNoticeBody, agentNoticeFromEvent, isConfigWarningsChangedEvent } from '@/lib/events/reduce'
import { fallbackModelFromRecord } from '@/lib/events/model-fallback'
import { useI18n } from '@/lib/i18n'
import { parseSessionActionSnapshot } from '@/lib/session-actions'
import { parseSlashCommands } from '@/lib/slash-commands'
import type { WorkspaceSnapshot } from '@/app/workspace'
import type { DesktopApi, RuntimeInfo, SessionActionSnapshot, SessionRecord } from '@/types/api'

interface UseAgentEventsOptions {
  bridge: DesktopApi | null
  runtimeIdRef: React.RefObject<string | null>
  runtimeSessionsRef: React.RefObject<Map<string, string>>
  runtimeOwnerRef: React.RefObject<{ runtimeId: string; generation: number } | null>
  workspaceRef: React.RefObject<WorkspaceSnapshot>
  setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>
  setRuntime: React.Dispatch<React.SetStateAction<RuntimeInfo | null>>
  reconcileQueuedPrompts?(snapshot: SessionActionSnapshot): void
  clearQueuedPromptFlushFailures?(): void
  clearQueuedPrompts?(): void
  queueAgentEvent(event: Record<string, unknown>): void
  onNotice?(text: string, tone: 'info' | 'warning' | 'error'): void
  /** 上游 config_warnings_changed:設定警告集合改變(reload 或 .broken-* 隔離後),用於重新整理功能目錄。 */
  onConfigWarningsChanged?(): void
  onCommandOutput?(text: string, failed?: boolean): void
  reconcileTranscriptForEvent(runtimeId: string, event: Record<string, unknown>): void
  showExtensionUi(runtimeId: string, event: Record<string, unknown>): void
  clearExtensionUi(runtimeId?: string): void
  refreshGit(): Promise<void>
  refreshGitOnTerminalEvent: boolean
  activeSessionVisible: boolean
}

export function useAgentEvents({
  bridge,
  runtimeIdRef,
  runtimeSessionsRef,
  runtimeOwnerRef,
  workspaceRef,
  setSessions,
  setRuntime,
  reconcileQueuedPrompts = () => undefined,
  clearQueuedPromptFlushFailures = () => undefined,
  clearQueuedPrompts = () => undefined,
  queueAgentEvent,
  onNotice = () => undefined,
  onConfigWarningsChanged = () => undefined,
  onCommandOutput,
  reconcileTranscriptForEvent,
  showExtensionUi,
  clearExtensionUi,
  refreshGit,
  refreshGitOnTerminalEvent,
  activeSessionVisible,
}: UseAgentEventsOptions) {
  const { t } = useI18n()
  useEffect(() => {
    if (!bridge) return
    let gitRefreshTimer: number | null = null
    const scheduleGitRefresh = () => {
      if (gitRefreshTimer !== null) return
      gitRefreshTimer = window.setTimeout(() => {
        gitRefreshTimer = null
        void refreshGit()
      }, 160)
    }
    const unsubscribe = bridge.agent.onEvent(({ runtimeId, event }) => {
      const type = typeof event.type === 'string' ? event.type : ''
      const sessionFile = runtimeSessionsRef.current.get(runtimeId)
        ?? (runtimeIdRef.current === runtimeId ? workspaceRef.current.sessionFile : undefined)
      if (sessionFile) {
        runtimeSessionsRef.current.set(runtimeId, sessionFile)
        if (sessionLifecycleChange(event)) {
          const visible = activeSessionVisible && workspaceRef.current.sessionFile === sessionFile
          setSessions((items) => items.map((session) => session.filePath === sessionFile
            ? applySessionLifecycleEvent(session, event, visible)
            : session))
        }
      }
      showExtensionUi(runtimeId, event)
      if (type === 'runtime_exit') clearExtensionUi(runtimeId)
      // A notice that cannot land in the visible transcript — another
      // session's runtime, or the active session hidden behind another view —
      // still reaches the user through the app toast; the transcript row
      // itself renders from the event in the active runtime below.
      if (type === 'notice') {
        const notice = agentNoticeFromEvent(event)
        if (notice && (runtimeIdRef.current !== runtimeId || !activeSessionVisible)) {
          const toastKey = notice.level === 'error' ? 'transcript.notice.toast.error'
            : notice.level === 'warning' ? 'transcript.notice.toast.warning' : 'transcript.notice.toast.info'
          onNotice(t(toastKey, { text: agentNoticeBody(notice) }), notice.level)
        }
      }
      // 上游設定警告集合改變(/mcp reload、/reload-plugins 或 .broken-* 隔離
      // 後):事件本身不帶 payload,警告細節留在 session;GUI 提示一次並觸發
      // 功能目錄重新探索(目錄會反映新定義、disabled/enabled 清單與隔離檔)。
      // 不進 transcript(config_warnings_changed 不是訊息),也不限 active
      // runtime——設定變更是全域的。
      if (isConfigWarningsChangedEvent(event)) {
        onNotice(t('transcript.notice.toast.configWarnings'), 'warning')
        onConfigWarningsChanged()
      }
      if (runtimeIdRef.current !== runtimeId) {
        if (type === 'runtime_exit') runtimeSessionsRef.current.delete(runtimeId)
        return
      }
      // The manual-compact path reports a failed post-compact state read as a
      // warning notice because no formal lifecycle events fire. Track the
      // pending sync for the active runtime so the divider can offer the
      // user-triggered refresh retry.
      if (type === 'notice' && agentNoticeFromEvent(event)?.source === 'desktop.compaction-sync') {
        compactionSyncPendingStore.setPending(runtimeId)
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, synchronizationPending: true } : current)
      }
      if (type === 'context_usage') {
        const contextUsage = contextUsageFromEvent(event)
        if (contextUsage) setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, contextUsage } : current)
        return
      }
      if (type === 'command_output') {
        if (typeof event.text === 'string') onCommandOutput?.(event.text)
        return
      }
      if (type === 'extension_ui_request' && event.method === 'notify') {
        if (typeof event.message === 'string') onCommandOutput?.(event.message, event.notifyType === 'error')
        return
      }
      if (type === 'available_commands_update') {
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, availableCommands: parseSlashCommands(event.commands) } : current)
        return
      }
      if (type === 'thinking_level_changed') {
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, thinkingLevel: event.thinkingLevel as string | undefined, configuredThinkingLevel: (event.configured ?? event.thinkingLevel) as RuntimeInfo['configuredThinkingLevel'] } : current)
        return
      }
      if (type === 'runtime_state') {
        const state = event.state as RuntimeInfo | undefined
        if (state?.runtimeId === runtimeId) {
          // An authoritative snapshot replaces the runtime wholesale; the
          // renderer-tracked sync flag drops with it on purpose, whether the
          // refresh came from the harness or the manual retry.
          compactionSyncPendingStore.clear(runtimeId)
          setRuntime((current) => current?.runtimeId === runtimeId ? state : current)
        }
        return
      }
      if (type === 'session_usage') {
        const sessionUsage = sessionUsageFromEvent(event)
        if (sessionUsage) setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, sessionUsage } : current)
        return
      }
      if (type === 'session_action_update') {
        const sessionActions = parseSessionActionSnapshot(event.actions)
        if (sessionActions) {
          setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, sessionActions } : current)
          reconcileQueuedPrompts(sessionActions)
        }
      }

      queueAgentEvent(event)
      reconcileTranscriptForEvent(runtimeId, event)
      if (type === 'agent_start') {
        setRuntime((current) => current?.runtimeId === runtimeId
          ? { ...current, isStreaming: true, isCompacting: false, executingModel: null }
          : current)
      }
      if (type === 'retry_fallback_applied' || type === 'retry_fallback_succeeded') {
        const fallback = fallbackModelFromRecord(event)
        if (fallback) {
          setRuntime((current) => current?.runtimeId === runtimeId
            ? { ...current, executingModel: { provider: fallback.provider, id: fallback.id, label: fallback.label, isFallback: true } }
            : current)
        }
      }
      if (type === 'compaction_start') {
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isCompacting: true } : current)
      }
      // A sync_pending outcome ended the compaction run even though the
      // formal compaction_end never arrived; willRetry stays formal-only.
      if (type === 'compaction_end' || type === 'compaction_sync_pending') {
        const syncPending = type === 'compaction_sync_pending'
        if (syncPending) compactionSyncPendingStore.setPending(runtimeId)
        else compactionSyncPendingStore.clear(runtimeId)
        setRuntime((current) => current?.runtimeId === runtimeId
          ? { ...current, isCompacting: false, synchronizationPending: syncPending, isStreaming: event.willRetry === true || current.isStreaming }
          : current)
      }
      // A provider auto-retry continues the same turn after a backoff delay:
      // the agent_end that preceded auto_retry_start was not the end of the
      // turn, so the runtime stays busy until the retry resolves.
      if (type === 'auto_retry_start') {
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isStreaming: true } : current)
      }
      if (type === 'auto_retry_end' && event.success !== true) {
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isStreaming: false } : current)
      }
      // Local-only slash commands admit immediately; their completion arrives
      // as prompt_result with agentInvoked:false instead of agent_end.
      if (type === 'prompt_result' && event.agentInvoked === false) {
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isStreaming: false, isCompacting: false } : current)
      }
      if (type === 'runtime_exit') {
        clearExtensionUi(runtimeId)
        // A stopped runtime can never serve the state refresh; a lingering
        // divider stays visible as history but offers no retry.
        compactionSyncPendingStore.clear(runtimeId)
        runtimeSessionsRef.current.delete(runtimeId)
        runtimeIdRef.current = null
        runtimeOwnerRef.current = null
        setRuntime((current) => current?.runtimeId === runtimeId ? null : current)
      } else if (type === 'agent_end' || type === 'extension_error' || type === 'error' || type === 'transport_error') {
        clearQueuedPromptFlushFailures()
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isStreaming: false, isCompacting: false } : current)
        if (refreshGitOnTerminalEvent) scheduleGitRefresh()
        // Long runs often end while the window sits unfocused — nudge once
        // per finished turn so the user knows to come back.
        if (type === 'agent_end' && shouldNotifyCompletion()) {
          const owned = runtimeOwnerRef.current?.runtimeId === runtimeId
          const session = owned ? workspaceRef.current.session : undefined
          showCompletionNotification(t('conversation.notify.completeTitle'), session?.title || t('conversation.notify.completeFallback'))
        }
      }
    })
    return () => {
      unsubscribe()
      if (gitRefreshTimer !== null) window.clearTimeout(gitRefreshTimer)
    }
  }, [
    activeSessionVisible,
    bridge,
    clearExtensionUi,
    clearQueuedPromptFlushFailures,
    clearQueuedPrompts,
    reconcileQueuedPrompts,
    workspaceRef,
    queueAgentEvent,
    onNotice,
    onConfigWarningsChanged,
    onCommandOutput,
    reconcileTranscriptForEvent,
    refreshGit,
    refreshGitOnTerminalEvent,
    runtimeIdRef,
    runtimeOwnerRef,
    runtimeSessionsRef,
    t,
    setRuntime,
    setSessions,
    showExtensionUi,
  ])
}
