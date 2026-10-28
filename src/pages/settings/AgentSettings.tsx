import { Bot, Keyboard, RefreshCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '@/lib/errors'
import { HARNESS_AGENT_NAMES, HARNESS_PRODUCT_NAMES } from '@/lib/harness'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { detectRendererPlatform, shortcutLabel } from '@/lib/platform-shortcuts'
import { HARNESS_IDS, type HarnessId, OMP_APPROVAL_MODES, type OmpApprovalMode, PRIME_EFFORT_SELECTORS, type PrimeEffortSelector } from '@/types/api'
import type { SettingsMetaSectionProps } from './contracts'
import { DraftSettingField } from './DraftSettingField'
import { SettingsToggle } from './SettingsToggle'

const APPROVAL_MODE_LABELS: Record<OmpApprovalMode, MessageKey> = {
  inherit: 'agent.approval.inherit',
  'always-ask': 'agent.approval.alwaysAsk',
  write: 'agent.approval.write',
  yolo: 'agent.approval.yolo',
}

const EFFORT_LABELS: Record<PrimeEffortSelector, MessageKey> = {
  auto: 'composer.reasoning.auto',
  off: 'composer.reasoning.off',
  minimal: 'composer.reasoning.minimal',
  low: 'composer.reasoning.low',
  medium: 'composer.reasoning.medium',
  high: 'composer.reasoning.high',
  xhigh: 'composer.reasoning.xhigh',
  max: 'composer.reasoning.max',
}

export function AgentSettings({ settings, meta, onUpdate, onRefreshHarnesses }: SettingsMetaSectionProps) {
  const { t } = useI18n()
  const activeHarness = settings.activeHarness
  const detectedHarnesses = HARNESS_IDS.filter((harness) => Boolean(meta?.harnesses[harness].path))
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const platform = meta?.platform ?? detectRendererPlatform()
  const oppositeActionShortcut = shortcutLabel(platform, ['Primary', 'Enter'])
  const newLineShortcut = shortcutLabel(platform, ['Shift', 'Enter'])
  const refreshHarnesses = async () => {
    if (refreshing) return
    setRefreshing(true)
    setRefreshError('')
    try {
      await onRefreshHarnesses()
    } catch (error) {
      setRefreshError(errorMessage(error))
    } finally {
      setRefreshing(false)
    }
  }
  const runtimePathValidation = (value: string, harness: HarnessId): string => {
    if (!value) return ''
    const absolute = meta?.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') : value.startsWith('/')
    return absolute ? '' : t('agent.runtime.pathValidation', { name: HARNESS_AGENT_NAMES[harness] })
  }
  return (
    <>
      <header>
        <h1>{t('agent.title')}</h1>
        <p>{t('agent.description')}</p>
      </header>
      <section className="settings-group">
        <h2>{t('agent.harness')}</h2>
        <label className="settings-row">
          <span>
            <strong>{t('agent.defaultHarness.label')}</strong>
            <small>{t('agent.defaultHarness.description')}</small>
          </span>
          <select
            value={detectedHarnesses.includes(activeHarness) ? activeHarness : ''}
            disabled={!detectedHarnesses.length}
            onChange={(event) => {
              void onUpdate({ activeHarness: event.target.value as HarnessId })
            }}
          >
            {!detectedHarnesses.length ? <option value="">{t('agent.defaultHarness.none')}</option> : null}
            {detectedHarnesses.map((harness) => (
              <option key={harness} value={harness}>
                {HARNESS_PRODUCT_NAMES[harness]}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('agent.approval.label')}</strong>
            <small>{t('agent.approval.description')}</small>
          </span>
          <select
            value={settings.ompApprovalMode}
            onChange={(event) => {
              void onUpdate({ ompApprovalMode: event.target.value as OmpApprovalMode })
            }}
          >
            {OMP_APPROVAL_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(APPROVAL_MODE_LABELS[mode])}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('agent.defaultEffort.label')}</strong>
            <small>{t('agent.defaultEffort.description')}</small>
          </span>
          <select
            value={settings.defaultEffort}
            onChange={(event) => {
              void onUpdate({ defaultEffort: event.target.value as PrimeEffortSelector })
            }}
          >
            {PRIME_EFFORT_SELECTORS.map((level) => (
              <option key={level} value={level}>
                {t(EFFORT_LABELS[level])}
              </option>
            ))}
          </select>
        </label>
      </section>
      <section className="settings-group">
        <div className="settings-group__heading">
          <h2>{t('agent.runtime')}</h2>
          <button
            type="button"
            className="button button--compact"
            disabled={refreshing}
            onClick={() => {
              void refreshHarnesses()
            }}
          >
            <RefreshCw className={refreshing ? 'spin' : ''} size={13} />
            {refreshing ? t('agent.runtime.refreshing') : t('agent.runtime.refresh')}
          </button>
        </div>
        {refreshError ? (
          <p className="settings-error" role="alert">
            {refreshError}
          </p>
        ) : null}
        {HARNESS_IDS.map((harness) => {
          const name = HARNESS_AGENT_NAMES[harness]
          const status = meta?.harnesses[harness]
          return (
            <div className="runtime-card" key={harness}>
              <span className={status?.path ? 'is-online' : ''}>
                <Bot size={17} />
              </span>
              <div>
                <strong>{status?.path ? t('agent.runtime.ready', { name }) : t('agent.runtime.notDetected', { name })}</strong>
                <small title={status?.problem ? `${status.problem.path}: ${status.problem.reason}` : undefined}>
                  {status?.path ?? (status?.problem ? `${status.problem.path}: ${status.problem.reason}` : t('agent.runtime.installHint', { name }))}
                </small>
              </div>
              {/* omp reports "omp/18.13.2"; keep only the semver so the badge reads v18.13.2, not "vomp/…". */}
              {status?.version ? <code>v{status.version.split('/').at(-1)}</code> : null}
            </div>
          )
        })}
        <p className="settings-group__description">{t('agent.runtime.discovery')}</p>
        {HARNESS_IDS.map((harness) => (
          <DraftSettingField
            key={harness}
            id={`runtime-path-${harness}`}
            label={t('agent.runtime.pathOverride', { name: HARNESS_AGENT_NAMES[harness] })}
            description={t('agent.runtime.pathOverride.description')}
            committedValue={settings.runtimePaths[harness]}
            validate={(value) => runtimePathValidation(value.trim(), harness)}
            normalize={(value) => value.trim()}
            onCommit={async (value) => {
              await onUpdate({ runtimePaths: { ...settings.runtimePaths, [harness]: value } })
              await refreshHarnesses()
            }}
          />
        ))}
      </section>
      <section className="settings-group">
        <h2>{t('agent.transcript')}</h2>
        <SettingsToggle
          checked={settings.showReasoningSummaries}
          onChange={(showReasoningSummaries) => {
            void onUpdate({ showReasoningSummaries })
          }}
          label={t('agent.reasoning.label')}
          description={t('agent.reasoning.description')}
        />
        <SettingsToggle
          checked={settings.showToolCalls}
          onChange={(showToolCalls) => {
            void onUpdate({ showToolCalls })
          }}
          label={t('agent.toolCalls.label')}
          description={t('agent.toolCalls.description')}
        />
        <SettingsToggle
          checked={settings.reasoningExpandedByDefault}
          onChange={(reasoningExpandedByDefault) => { void onUpdate({ reasoningExpandedByDefault }) }}
          label={t('agent.reasoningExpanded.label')}
          description={t('agent.reasoningExpanded.description')}
        />
      </section>
      <section className="settings-group">
        <h2>{t('agent.shortcuts')}</h2>
        <label className="settings-row">
          <span>
            <strong>{t('agent.shortcuts.primary.label')}</strong>
            <small>{t('agent.shortcuts.primary.description', { opposite: oppositeActionShortcut, newline: newLineShortcut })}</small>
          </span>
          <span className="shortcut-choice" role="radiogroup" aria-label={t('agent.shortcuts.primary.aria')}>
            {(['queue', 'steer'] as const).map((action) => (
              <button
                key={action}
                type="button"
                className={`button button--compact ${settings.messageEnterAction === action ? 'is-active' : ''}`}
                role="radio"
                aria-checked={settings.messageEnterAction === action}
                onClick={() => {
                  void onUpdate({ messageEnterAction: action })
                }}
              >
                {action === 'queue' ? t('agent.shortcuts.queue') : t('agent.shortcuts.steer')}
              </button>
            ))}
          </span>
        </label>
        <div className="shortcut-row">
          <span>
            <Keyboard size={14} />
            {settings.messageEnterAction === 'queue' ? t('agent.shortcuts.queueMessage') : t('agent.shortcuts.steerTurn')}
          </span>
          <kbd>Enter</kbd>
        </div>
        <div className="shortcut-row">
          <span>
            <Keyboard size={14} />
            {settings.messageEnterAction === 'queue' ? t('agent.shortcuts.steerTurn') : t('agent.shortcuts.queueMessage')}
          </span>
          <kbd>{oppositeActionShortcut}</kbd>
        </div>
      </section>
      <section className="settings-group">
        <h2>{t('agent.permissions')}</h2>
        <div className="info-row">
          <ShieldCheck size={15} />
          <div>
            <strong>{t('agent.permissions.workspace')}</strong>
            <small>{t('agent.permissions.workspace.description')}</small>
          </div>
        </div>
      </section>
    </>
  )
}
