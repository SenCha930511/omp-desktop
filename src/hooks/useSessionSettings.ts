import { useCallback, useMemo, useState } from 'react'
import type {
  DesktopApi,
  RuntimeInfo,
  SessionCacheWarmingMode,
  SessionInterruptMode,
  SessionQueueMode,
  SessionSettingsSnapshot,
} from '@/types/api'

export type SessionSettingKey = keyof SessionSettingsSnapshot

export interface SessionSettingsApi {
  /**
   * 目前快照,直接透傳 runtime.sessionSettings——初值與後續值一律來自
   * get_state / set_* 回聲推下的 runtime_state(真相在 RPC 側,GUI 不寫
   * 自有設定檔)。欄位 undefined = 上游尚未回報(18.13 的 autoRetry /
   * cacheWarming),UI 顯示未知而非猜測。
   */
  readonly values: SessionSettingsSnapshot | undefined
  /** 有 live runtime 才能送 RPC;新工作階段尚未附掛時為 false。 */
  readonly ready: boolean
  /** 逐項 in-flight 標記;快照由 runtime_state 收尾,不用樂觀更新。 */
  readonly pending: ReadonlySet<SessionSettingKey>
  setAutoCompaction(enabled: boolean): Promise<void>
  setAutoRetry(enabled: boolean): Promise<void>
  setSteeringMode(mode: SessionQueueMode): Promise<void>
  setFollowUpMode(mode: SessionQueueMode): Promise<void>
  setInterruptMode(mode: SessionInterruptMode): Promise<void>
  setCacheWarming(mode: SessionCacheWarmingMode): Promise<void>
}

/**
 * Session 設定六件組的 RPC 通道。每次切換即時送對應上游命令;runtime 的
 * runtime_state 推送把新值帶回(成功才改值)。失敗回報給呼叫端提供的
 * reportError,介面不留存任何本地副本。
 */
export function useSessionSettings(
  bridge: DesktopApi | null | undefined,
  runtime: RuntimeInfo | null | undefined,
  reportError: (error: unknown) => void,
): SessionSettingsApi {
  const [pending, setPending] = useState<ReadonlySet<SessionSettingKey>>(() => new Set())
  const runtimeId = runtime?.runtimeId

  const send = useCallback(
    async (key: SessionSettingKey, command: Record<string, unknown>) => {
      if (!bridge || !runtimeId) return
      setPending((current) => new Set(current).add(key))
      try {
        const response = await bridge.agent.command(runtimeId, command)
        // 上游以 success:false 回絕(例如未知命令)時,值不會變——報錯而不是假裝同步。
        if (response.success === false) throw new Error(typeof response.error === 'string' ? response.error : `RPC ${String(command.type)} was rejected`)
      } catch (error) {
        reportError(error)
      } finally {
        setPending((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      }
    },
    [bridge, runtimeId, reportError],
  )

  return useMemo<SessionSettingsApi>(
    () => ({
      values: runtime?.sessionSettings,
      ready: Boolean(bridge && runtimeId),
      pending,
      setAutoCompaction: (enabled) => send('autoCompaction', { type: 'set_auto_compaction', enabled }),
      setAutoRetry: (enabled) => send('autoRetry', { type: 'set_auto_retry', enabled }),
      setSteeringMode: (mode) => send('steeringMode', { type: 'set_steering_mode', mode }),
      setFollowUpMode: (mode) => send('followUpMode', { type: 'set_follow_up_mode', mode }),
      setInterruptMode: (mode) => send('interruptMode', { type: 'set_interrupt_mode', mode }),
      setCacheWarming: (mode) => send('cacheWarming', { type: 'set_cache_warming', mode }),
    }),
    [bridge, runtimeId, runtime?.sessionSettings, pending, send],
  )
}
