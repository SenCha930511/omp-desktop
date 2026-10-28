import type { AppMeta, AppSettings } from '@/types/api'

export type SettingsSection = 'general' | 'appearance' | 'agent' | 'session' | 'providers' | 'voice' | 'browser' | 'terminal' | 'privacy' | 'about'

export type SettingsUpdate = (patch: Partial<AppSettings>) => Promise<void> | void

export interface SettingsSectionProps {
  settings: AppSettings
  onUpdate: SettingsUpdate
}

export interface SettingsMetaSectionProps extends SettingsSectionProps {
  meta?: AppMeta | null
  onRefreshHarnesses(): Promise<void>
}

export const SETTINGS_FIELD_SECTIONS = {
  theme: 'appearance',
  accentColor: 'appearance',
  locale: 'appearance',
  interfaceFontScale: 'appearance',
  projectSortMode: 'general',
  sidebarOpen: 'general',
  inspectorOpen: 'general',
  showFileChangesPopup: 'general',
  checkoutStrategy: 'general',
  idleSessionMinutes: 'general',
  keepRunningInBackground: 'general',
  launchAtLogin: 'general',
  terminalOpen: 'terminal',
  defaultInspectorTab: 'general',
  browserHome: 'browser',
  browserAskForDownloads: 'browser',
  terminalShell: 'terminal',
  reduceMotion: 'appearance',
  showReasoningSummaries: 'agent',
  reasoningExpandedByDefault: 'agent',
  defaultEffort: 'agent',
  conversationDensity: 'general',
  subagentsPanelPinned: 'agent',
  showToolCalls: 'agent',
  messageEnterAction: 'agent',
  inputShortcutsVersion: 'general',
  runtimePaths: 'agent',
  telemetry: 'privacy',
  askUserEnabled: 'agent',
  browserEnabled: 'agent',
  computerUseEnabled: 'agent',
  lastSelectedModels: 'providers',
  activeHarness: 'agent',
  ompApprovalMode: 'agent',
  voiceTranscriptionProvider: 'voice',
  voiceOpenAiLiveTranscriptionModel: 'voice',
  voiceOpenAiTranscriptionModel: 'voice',
  voiceGroqTranscriptionModel: 'voice',
  voiceDeepgramTranscriptionModel: 'voice',
  voiceSelfHostedUrl: 'voice',
  voiceSelfHostedModel: 'voice',
  voiceLocalWhisperExecutable: 'voice',
  voiceLocalWhisperModel: 'voice',
} as const satisfies Record<keyof AppSettings, SettingsSection>
