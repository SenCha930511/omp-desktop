import { ArrowLeft, AudioLines, Bot, Boxes, ChevronRight, Info, LockKeyhole, MessagesSquare, Settings2, Sun, Terminal } from 'lucide-react'
import { type ComponentType, useEffect, useState } from 'react'
import { BrowserGlobe, Modal } from '@/components/ui'
import { errorMessage } from '@/lib/errors'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { detectRendererPlatform } from '@/lib/platform-shortcuts'
import type { SessionSettingsApi } from '@/hooks/useSessionSettings'
import type { AppMeta, AppSettings, AppUpdateState, DesktopApi, LatestReleaseCheck, PrimeModelCatalog } from '@/types/api'
import { AboutSettings } from './settings/AboutSettings'
import { AgentSettings } from './settings/AgentSettings'
import { SessionSettings } from './settings/SessionSettings'
import { AppearanceSettings } from './settings/AppearanceSettings'
import { BrowserSettings } from './settings/BrowserSettings'
import type { SettingsSection, SettingsUpdate } from './settings/contracts'
import { GeneralSettings } from './settings/GeneralSettings'
import { PrivacySettings } from './settings/PrivacySettings'
import { ProvidersSettings } from './settings/ProviderSettings'
import { TerminalSettings } from './settings/TerminalSettings'
import { VoiceSettings } from './settings/VoiceSettings'

const sections: Array<{ id: SettingsSection; label: MessageKey; icon: ComponentType<{ size?: number }> }> = [
  { id: 'general', label: 'settings.general', icon: Settings2 },
  { id: 'appearance', label: 'settings.appearance', icon: Sun },
  { id: 'agent', label: 'settings.harness', icon: Bot },
  { id: 'session', label: 'settings.session', icon: MessagesSquare },
  { id: 'providers', label: 'settings.providers', icon: Boxes },
  { id: 'voice', label: 'settings.voice', icon: AudioLines },
  { id: 'browser', label: 'settings.browser', icon: BrowserGlobe },
  { id: 'terminal', label: 'settings.terminal', icon: Terminal },
  { id: 'privacy', label: 'settings.privacy', icon: LockKeyhole },
  { id: 'about', label: 'settings.about', icon: Info },
]
interface SettingsPageProps {
  settings: AppSettings
  meta?: AppMeta | null
  providerCatalog: PrimeModelCatalog | null
  voice: DesktopApi['voice'] | null
  updateState?: AppUpdateState | null
  onUpdateAction?(): void | Promise<void>
  onCheckLatestRelease?(): Promise<LatestReleaseCheck>
  onOpenExternal?(url: string): Promise<boolean> | void
  onUpdate: SettingsUpdate
  onClose(): void
  onResetBrowser(): Promise<void> | void
  onOpenDocs(): void
  onRefreshHarnesses(): Promise<void>
  /** Controller for the active session's runtime-backed settings; absent when no session is open. */
  sessionSettings?: SessionSettingsApi
  initialSection?: SettingsSection
  /** Re-applies initialSection for repeated navigation requests to the same section. */
  initialSectionRequestId?: number
}

export function SettingsPage({
  settings,
  meta,
  providerCatalog,
  sessionSettings,
  voice,
  updateState,
  onUpdateAction,
  onCheckLatestRelease,
  onOpenExternal,
  onClose,
  onUpdate,
  onResetBrowser,
  onOpenDocs,
  onRefreshHarnesses,
  initialSection = 'general',
  initialSectionRequestId = 0,
}: SettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState('')
  const { t } = useI18n()
  const platform = meta?.platform ?? detectRendererPlatform()

  useEffect(() => {
    setSection(initialSection)
  }, [initialSection, initialSectionRequestId])

  const resetBrowser = async () => {
    setResetting(true)
    setResetError('')
    try {
      await onResetBrowser()
      setConfirmReset(false)
    } catch (error) {
      setResetError(errorMessage(error))
    } finally {
      setResetting(false)
    }
  }

  const content = (() => {
    switch (section) {
      case 'general':
        return <GeneralSettings settings={settings} onUpdate={onUpdate} platform={platform} />
      case 'appearance':
        return <AppearanceSettings settings={settings} onUpdate={onUpdate} />
      case 'agent':
        return <AgentSettings settings={settings} meta={meta} onUpdate={onUpdate} onRefreshHarnesses={onRefreshHarnesses} />
      case 'session':
        return <SessionSettings sessionSettings={sessionSettings} />
      case 'providers':
        return (
          <ProvidersSettings
            harness={settings.activeHarness}
            catalog={providerCatalog}
            onOpenDocs={onOpenDocs}
          />
        )
      case 'voice':
        return <VoiceSettings settings={settings} onUpdate={onUpdate} voice={voice} platform={platform} />
      case 'browser':
        return (
          <BrowserSettings
            settings={settings}
            onUpdate={onUpdate}
            onRequestReset={() => {
              setResetError('')
              setConfirmReset(true)
            }}
          />
        )
      case 'terminal':
        return <TerminalSettings settings={settings} onUpdate={onUpdate} platform={platform} />
      case 'privacy':
        return <PrivacySettings settings={settings} onUpdate={onUpdate} />
      case 'about':
        return <AboutSettings meta={meta} updateState={updateState} onUpdateAction={onUpdateAction} onCheckLatestRelease={onCheckLatestRelease} onOpenExternal={onOpenExternal} onOpenDocs={onOpenDocs} />
    }
  })()

  return (
    <div className="settings-page">
      <nav className="settings-nav" aria-label={t('settings.sections')}>
        <button type="button" className="settings-nav__close" onClick={onClose}>
          <ArrowLeft size={14} />
          <span>{t('settings.backToSession')}</span>
        </button>
        {sections.map((item) => {
          const Icon = item.icon
          return (
            <button type="button" key={item.id} className={section === item.id ? 'is-active' : ''} onClick={() => setSection(item.id)}>
              <Icon size={14} />
              <span>{t(item.label)}</span>
              <ChevronRight size={12} />
            </button>
          )
        })}
      </nav>
      <div className="settings-content scroll-area">
        <div className="settings-content__inner">{content}</div>
      </div>
      {confirmReset ? (
        <Modal
          title={t('settings.resetTitle')}
          onClose={() => {
            if (!resetting) setConfirmReset(false)
          }}
          footer={
            <>
              <button type="button" className="button" disabled={resetting} onClick={() => setConfirmReset(false)}>
                {t('settings.resetCancel')}
              </button>
              <button
                type="button"
                className="button button--danger"
                disabled={resetting}
                onClick={() => {
                  void resetBrowser()
                }}
              >
                {resetting ? t('settings.resetClearing') : t('settings.resetConfirm')}
              </button>
            </>
          }
        >
          <p>{t('settings.resetDescription')}</p>
          {resetError ? (
            <p className="settings-error" role="alert">
              {resetError}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  )
}
