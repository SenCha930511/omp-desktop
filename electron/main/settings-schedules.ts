import { session } from 'electron'
import { isAbsolute } from 'node:path'
import { ACCENT_COLORS, BROWSER_PARTITION, HARNESS_IDS, INTERFACE_FONT_SCALES, PRIME_EFFORT_SELECTORS, PROJECT_SORT_MODES, type AppSettings, type ProjectSortMode } from '../../src/types/api'
import type { JsonStateStore } from './store'
import { isRecord, rejectUnknownKeys, requireBoolean, requireSelfHostedVoiceUrl, requireString, requireWebUrl } from './validation'

export class SettingsService {
  constructor(
    private readonly store: JsonStateStore,
    private readonly validateShell: (shell: unknown) => string,
    private readonly cancelBrowserDownloads: () => void = () => undefined,
    private readonly onDidUpdate: (previous: AppSettings, next: AppSettings) => void | Promise<void> = () => undefined,
  ) {}

  get(): AppSettings { return this.store.getSettings() }

  async update(raw: unknown): Promise<AppSettings> {
    if (!isRecord(raw)) throw new TypeError('settings patch must be an object')
    // One validator per AppSettings field, compiler-enforced: adding a field
    // without a validator (or vice versa) is a type error, so a patch can
    // never be silently rejected or silently dropped.
    const validators: { [K in keyof AppSettings]: (value: unknown) => AppSettings[K] } = {
      conversationDensity: (value) => {
        if (value !== 'compact' && value !== 'comfortable') throw new TypeError('Invalid conversation density')
        return value
      },
      theme: (value) => {
        if (value !== 'system' && value !== 'light' && value !== 'dark') throw new TypeError('Invalid theme')
        return value
      },
      locale: (value) => {
        if (value !== 'system' && value !== 'en' && value !== 'zh-CN' && value !== 'zh-TW') throw new TypeError('Invalid locale')
        return value
      },
      accentColor: (value) => {
        if (!(ACCENT_COLORS as readonly string[]).includes(value as string)) throw new TypeError('Invalid accent color')
        return value as AppSettings['accentColor']
      },
      interfaceFontScale: (value) => {
        if (!INTERFACE_FONT_SCALES.includes(value as AppSettings['interfaceFontScale'])) throw new TypeError('Invalid interface font scale')
        return value as AppSettings['interfaceFontScale']
      },
      projectSortMode: (value) => {
        if (!PROJECT_SORT_MODES.includes(value as ProjectSortMode)) throw new TypeError('Invalid project sort mode')
        return value as ProjectSortMode
      },
      sidebarOpen: (value) => requireBoolean(value, 'sidebarOpen'),
      inspectorOpen: (value) => requireBoolean(value, 'inspectorOpen'),
      showFileChangesPopup: (value) => requireBoolean(value, 'showFileChangesPopup'),
      checkoutStrategy: (value) => {
        if (value !== 'worktree' && value !== 'branch') throw new TypeError('Invalid checkout strategy')
        return value
      },
      keepRunningInBackground: (value) => requireBoolean(value, 'keepRunningInBackground'),
      launchAtLogin: (value) => requireBoolean(value, 'launchAtLogin'),
      terminalOpen: (value) => requireBoolean(value, 'terminalOpen'),
      browserAskForDownloads: (value) => requireBoolean(value, 'browserAskForDownloads'),
      reduceMotion: (value) => requireBoolean(value, 'reduceMotion'),
      showReasoningSummaries: (value) => requireBoolean(value, 'showReasoningSummaries'),
      reasoningExpandedByDefault: (value) => requireBoolean(value, 'reasoningExpandedByDefault'),
      defaultEffort: (value) => {
        if (!(PRIME_EFFORT_SELECTORS as readonly string[]).includes(value as string)) throw new TypeError('Invalid default reasoning effort')
        return value as AppSettings['defaultEffort']
      },
      subagentsPanelPinned: (value) => requireBoolean(value, 'subagentsPanelPinned'),
      showToolCalls: (value) => requireBoolean(value, 'showToolCalls'),
      telemetry: (value) => requireBoolean(value, 'telemetry'),
      askUserEnabled: (value) => requireBoolean(value, 'askUserEnabled'),
      browserEnabled: (value) => requireBoolean(value, 'browserEnabled'),
      computerUseEnabled: (value) => requireBoolean(value, 'computerUseEnabled'),
      defaultInspectorTab: (value) => {
        if (value !== 'summary' && value !== 'changes' && value !== 'browser' && value !== 'files') throw new TypeError('Invalid inspector tab')
        return value
      },
      messageEnterAction: (value) => {
        if (value !== 'queue' && value !== 'steer') throw new TypeError('Invalid message Enter action')
        return value
      },
      runtimePaths: (value) => {
        if (!isRecord(value)) throw new TypeError('runtimePaths must be an object')
        rejectUnknownKeys(value, HARNESS_IDS, 'runtimePaths')
        const paths = {} as AppSettings['runtimePaths']
        for (const harness of HARNESS_IDS) {
          const path = requireString(value[harness], `runtimePaths.${harness}`, { max: 4_096 })
          if (path && !isAbsolute(path)) throw new TypeError(`runtimePaths.${harness} must be absolute`)
          paths[harness] = path
        }
        return paths
      },
      browserHome: (value) => requireWebUrl(value),
      terminalShell: (value) => this.validateShell(value),
      activeHarness: (value) => {
        if (value !== 'omp') throw new TypeError('Invalid harness')
        return value
      },
      ompApprovalMode: (value) => {
        if (value !== 'inherit' && value !== 'always-ask' && value !== 'write' && value !== 'yolo') throw new TypeError('Invalid OMP approval mode')
        return value
      },
      voiceTranscriptionProvider: (value) => {
        if (value !== 'openai-live' && value !== 'openai' && value !== 'groq' && value !== 'deepgram' && value !== 'self-hosted' && value !== 'local-whisper') throw new TypeError('Invalid voice transcription provider')
        return value
      },
      voiceOpenAiLiveTranscriptionModel: (value) => this.voiceModel(value, 'voiceOpenAiLiveTranscriptionModel'),
      voiceOpenAiTranscriptionModel: (value) => this.voiceModel(value, 'voiceOpenAiTranscriptionModel'),
      voiceGroqTranscriptionModel: (value) => this.voiceModel(value, 'voiceGroqTranscriptionModel'),
      voiceDeepgramTranscriptionModel: (value) => this.voiceModel(value, 'voiceDeepgramTranscriptionModel'),
      voiceSelfHostedUrl: (value) => {
        const url = requireString(value, 'voiceSelfHostedUrl', { max: 2_048, trim: true })
        return url ? requireSelfHostedVoiceUrl(url) : ''
      },
      voiceSelfHostedModel: (value) => {
        const model = requireString(value, 'voiceSelfHostedModel', { max: 128, trim: true })
        if (model && !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(model)) throw new TypeError('voiceSelfHostedModel is not valid')
        return model
      },
      voiceLocalWhisperExecutable: (value) => requireString(value, 'voiceLocalWhisperExecutable', { max: 4_096, trim: true }),
      voiceLocalWhisperModel: (value) => requireString(value, 'voiceLocalWhisperModel', { max: 4_096, trim: true }),
      inputShortcutsVersion: (value) => {
        if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) throw new TypeError('inputShortcutsVersion must be a non-negative integer')
        return value as number | undefined
      },
      lastSelectedModels: (value) => {
        if (!isRecord(value)) throw new TypeError('lastSelectedModels must be an object')
        rejectUnknownKeys(value, HARNESS_IDS, 'lastSelectedModels')
        const models = {} as AppSettings['lastSelectedModels']
        for (const harness of HARNESS_IDS) {
          const model = requireString(value[harness], `lastSelectedModels.${harness}`, { max: 385, trim: true })
          if (model && !/^[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9._:/+-]{1,256}$/i.test(model)) throw new TypeError(`lastSelectedModels.${harness} is not a valid model key`)
          models[harness] = model
        }
        return models
      },
    }
    const keys = Object.keys(validators) as Array<keyof AppSettings>
    rejectUnknownKeys(raw, keys, 'settings patch')
    const patch: Partial<AppSettings> = {}
    const applyField = <K extends keyof AppSettings>(key: K): void => {
      const validate = validators[key]
      if (raw[key] !== undefined && validate) patch[key] = validate(raw[key])
    }
    for (const key of keys) applyField(key)
    let previous: AppSettings | undefined
    const next = await this.store.update((state) => {
      previous = structuredClone(state.settings)
      const next = { ...state.settings, ...patch }
      Object.assign(state.settings, next)
      return state.settings
    })
    await this.onDidUpdate(previous!, next)
    return next
  }

  private voiceModel(value: unknown, label: string): string {
    const model = requireString(value, label, { min: 1, max: 128, trim: true })
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(model)) throw new TypeError(`${label} is not valid`)
    return model
  }

  async resetBrowserData(): Promise<boolean> {
    try {
      this.cancelBrowserDownloads()
      const browserSession = session.fromPartition(BROWSER_PARTITION)
      await Promise.all([
        browserSession.clearStorageData(), browserSession.clearCache(), browserSession.clearAuthCache(),
        session.defaultSession.clearStorageData(), session.defaultSession.clearCache(), session.defaultSession.clearAuthCache(),
      ])
      return true
    } catch (error) {
      console.warn('Browser data reset failed:', error instanceof Error ? error.message : error)
      return false
    }
  }
}
