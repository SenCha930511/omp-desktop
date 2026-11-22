import { useEffect, useState } from 'react'
import type { SubagentPanelState } from '@/hooks/useSubagents'
import { useSubagentAttention } from '@/hooks/useSubagentAttention'
import { useI18n } from '@/lib/i18n'
import { AgentTranscript } from '../SubagentsPanel'
import { SubagentRoster } from '../SubagentRoster'

export interface SubagentsTabPanelProps {
  state: SubagentPanelState
  connected: boolean
  showReasoning?: boolean
  showTools?: boolean
}

/**
 * Inspector tab: the session roster stacked above the selected agent's
 * transcript. The inspector column is 340–660px wide, so the roster never
 * becomes a side column and the transcript never splits the conversation.
 */
export function SubagentsTabPanel({ state, connected, showReasoning = true, showTools = true }: SubagentsTabPanelProps) {
  const { t } = useI18n()
  const [actionError, setActionError] = useState<string>()
  const selected = state.agents.find((agent) => agent.id === state.selectedId)
  const unread = useSubagentAttention(state.agents, selected?.id)
  useEffect(() => {
    setActionError(undefined)
  }, [selected?.id])
  // 取消回報:false = 上游確認不在執行(不當作取消成功);RPC 失敗如實顯示。
  const cancelAgent = async (id: string) => {
    if (!state.cancel) return
    setActionError(undefined)
    try {
      if (!(await state.cancel(id))) setActionError(t('agents.cancelNotRunning'))
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const loadEarlierAgent = async (id: string) => {
    if (!state.loadEarlier) return
    setActionError(undefined)
    try {
      await state.loadEarlier(id)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const changeSubscription = async (level: 'off' | 'progress' | 'events') => {
    if (!state.setSubscriptionLevel) return
    setActionError(undefined)
    try {
      await state.setSubscriptionLevel(level)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const error = state.error?.includes('invalid subagent roster') ? t('agents.error.roster') : state.error?.includes('Invalid subagent transcript') ? t('agents.error.transcript') : state.error
  return (
    <section className="subagents subagents-tab" aria-label={t('agents.title')}>
      <SubagentRoster
        agents={state.agents}
        selectedId={selected?.id}
        connected={connected}
        unread={unread}
        onSelect={state.select}
        onCancel={
          state.cancel
            ? (id) => {
                void cancelAgent(id)
              }
            : undefined
        }
        pendingActions={state.pendingActions}
        subscriptionLevel={state.subscriptionLevel}
        onSubscriptionChange={
          state.setSubscriptionLevel
            ? (level) => {
                void changeSubscription(level)
              }
            : undefined
        }
      />
      {error && (
        <p className="subagents__error" role="alert">
          {error}
        </p>
      )}
      {actionError && (
        <p className="subagents__error" role="alert">
          {actionError}
        </p>
      )}
      {selected ? (
        <AgentTranscript
          key={`${selected.id}:${selected.revision ?? 0}`}
          agent={selected}
          active
          showReasoning={showReasoning}
          showTools={showTools}
          pendingActions={state.pendingActions}
          onSteer={state.steer}
          onLoadEarlier={
            state.loadEarlier
              ? (id) => {
                  void loadEarlierAgent(id)
                }
              : undefined
          }
          onClose={() => state.select(undefined)}
        />
      ) : (
        <div className="subagents-tab__empty">
          <p>{t('agents.selectAgent')}</p>
        </div>
      )}
    </section>
  )
}
