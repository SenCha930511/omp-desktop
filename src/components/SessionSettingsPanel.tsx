import { memo, type ReactNode } from 'react'
import type { SessionSettingKey, SessionSettingsApi } from '@/hooks/useSessionSettings'
import { type MessageKey, useI18n } from '@/lib/i18n'
import type { SessionCacheWarmingMode, SessionInterruptMode, SessionQueueMode } from '@/types/api'

/**
 * Context popover 的「session 設定」區塊(六項工作階段設定)。
 * 值一律透傳 controller.values(= runtime 快照:get_state / set_* 回聲,
 * RPC 為真相);點擊即送對應上游命令,不做樂觀更新、不寫 GUI 自有檔。
 * 上游尚未回報的值顯示「未知」提示而非猜測(false-looking)狀態。
 */
export const SessionSettingsPanel = memo(function SessionSettingsPanel({ controller }: { controller: SessionSettingsApi }) {
  const { t } = useI18n()
  const values = controller.values
  const row = (labelKey: MessageKey, descriptionKey: MessageKey, pendingKey: SessionSettingKey, control: ReactNode, known: boolean) => (
    <div className="session-settings__row" aria-busy={controller.pending.has(pendingKey) || undefined}>
      <div className="session-settings__text">
        <span className="session-settings__label">
          {t(labelKey)}
          {controller.pending.has(pendingKey) ? <small className="session-settings__pending">{t('sessionSettings.loading')}</small> : null}
        </span>
        <small className="session-settings__description">{t(descriptionKey)}</small>
        {known ? null : <small className="session-settings__unknown">{t('sessionSettings.unknown')}</small>}
      </div>
      {control}
    </div>
  )
  const toggle = (key: SessionSettingKey, value: boolean | undefined, onChange: (next: boolean) => void) => (
    <button
      type="button"
      role="switch"
      className={`session-settings__switch ${value === true ? 'is-on' : ''} ${value === undefined ? 'is-unknown' : ''}`}
      aria-checked={value === true}
      disabled={!controller.ready || controller.pending.has(key)}
      onClick={() => void onChange(value !== true)}
    >
      <span className="session-settings__thumb" />
    </button>
  )
  const segmented = <T extends string>(key: SessionSettingKey, value: T | undefined, options: ReadonlyArray<{ value: T; labelKey: MessageKey }>, onChange: (next: T) => void) => (
    <div className="session-settings__segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`session-settings__option ${value === option.value ? 'is-active' : ''}`}
          aria-pressed={value === option.value}
          disabled={!controller.ready || controller.pending.has(key)}
          onClick={() => void onChange(option.value)}
        >
          {t(option.labelKey)}
        </button>
      ))}
    </div>
  )
  const queueOptions: ReadonlyArray<{ value: SessionQueueMode; labelKey: MessageKey }> = [
    { value: 'all', labelKey: 'sessionSettings.mode.all' },
    { value: 'one-at-a-time', labelKey: 'sessionSettings.mode.oneAtATime' },
  ]
  const interruptOptions: ReadonlyArray<{ value: SessionInterruptMode; labelKey: MessageKey }> = [
    { value: 'immediate', labelKey: 'sessionSettings.mode.immediate' },
    { value: 'wait', labelKey: 'sessionSettings.mode.wait' },
  ]
  const cacheWarmingOptions: ReadonlyArray<{ value: SessionCacheWarmingMode; labelKey: MessageKey }> = [
    { value: 'off', labelKey: 'sessionSettings.cacheWarming.off' },
    { value: 'streaming', labelKey: 'sessionSettings.cacheWarming.streaming' },
    { value: 'idle', labelKey: 'sessionSettings.cacheWarming.idle' },
  ]
  return (
    <section className="session-settings" aria-label={t('sessionSettings.title')}>
      <header className="session-settings__header">
        <h4>{t('sessionSettings.title')}</h4>
        <small className="session-settings__scope">{t('sessionSettings.scope.session')}</small>
      </header>
      {row('sessionSettings.autoCompaction.label', 'sessionSettings.autoCompaction.description', 'autoCompaction',
        toggle('autoCompaction', values?.autoCompaction, controller.setAutoCompaction), values?.autoCompaction !== undefined)}
      {row('sessionSettings.autoRetry.label', 'sessionSettings.autoRetry.description', 'autoRetry',
        toggle('autoRetry', values?.autoRetry, controller.setAutoRetry), values?.autoRetry !== undefined)}
      {row('sessionSettings.steeringMode.label', 'sessionSettings.steeringMode.description', 'steeringMode',
        segmented('steeringMode', values?.steeringMode, queueOptions, controller.setSteeringMode), values?.steeringMode !== undefined)}
      {row('sessionSettings.followUpMode.label', 'sessionSettings.followUpMode.description', 'followUpMode',
        segmented('followUpMode', values?.followUpMode, queueOptions, controller.setFollowUpMode), values?.followUpMode !== undefined)}
      {row('sessionSettings.interruptMode.label', 'sessionSettings.interruptMode.description', 'interruptMode',
        segmented('interruptMode', values?.interruptMode, interruptOptions, controller.setInterruptMode), values?.interruptMode !== undefined)}
      <div className="session-settings__row" aria-busy={controller.pending.has('cacheWarming') || undefined}>
        <div className="session-settings__text">
          <span className="session-settings__label">
            {t('sessionSettings.cacheWarming.label')}
            {controller.pending.has('cacheWarming') ? <small className="session-settings__pending">{t('sessionSettings.loading')}</small> : null}
          </span>
          <small className="session-settings__description">{t('sessionSettings.cacheWarming.description')}</small>
          <small className="session-settings__scope-tag">{t('sessionSettings.scope.sessionOverride')}</small>
          {values?.cacheWarming === undefined ? <small className="session-settings__unknown">{t('sessionSettings.unknown')}</small> : null}
        </div>
        {segmented('cacheWarming', values?.cacheWarming, cacheWarmingOptions, controller.setCacheWarming)}
      </div>
    </section>
  )
})
