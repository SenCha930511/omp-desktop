import { Check, KeyRound, Laptop, LoaderCircle, Mic2, RefreshCw, Server, ShieldAlert, ShieldCheck, Trash2, Waves } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui'
import { errorMessage } from '@/lib/errors'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import {
  DEEPGRAM_MODELS,
  GROQ_MODELS,
  OPENAI_FILE_MODELS,
  OPENAI_LIVE_MODELS,
  optionsWithCurrent,
  VOICE_PROVIDER_OPTIONS,
  type VoiceOption,
} from '@/lib/voice-options'
import type { AppSettings, DesktopApi, VoiceCredentialProvider, VoiceCredentialStatus, VoiceTranscriptionProvider } from '@/types/api'
import type { SettingsSectionProps } from './contracts'

const CREDENTIALS: Array<{ id: VoiceCredentialProvider; name: string; nameKey?: MessageKey; monogram: string; detailKey: MessageKey }> = [
  { id: 'openai', name: 'OpenAI', monogram: 'OA', detailKey: 'voice.credentials.openai.detail' },
  { id: 'groq', name: 'Groq', monogram: 'GQ', detailKey: 'voice.credentials.groq.detail' },
  { id: 'deepgram', name: 'Deepgram', monogram: 'DG', detailKey: 'voice.credentials.deepgram.detail' },
  { id: 'self-hosted', name: 'Self-hosted endpoint', nameKey: 'voice.credentials.selfHosted.name', monogram: 'SH', detailKey: 'voice.credentials.selfHosted.detail' },
]

const CONNECTION_CREDENTIALS = CREDENTIALS.filter((item) => item.id !== 'self-hosted')

interface VoiceSettingsProps extends SettingsSectionProps {
  voice: DesktopApi['voice'] | null
  platform?: NodeJS.Platform
}

type VoiceServiceState = 'checking' | 'ready' | 'restart-required' | 'error'
type SelfHostedTestState = 'idle' | 'testing' | 'connected' | 'error'

function needsDesktopRestart(error: unknown): boolean {
  return /No handler registered for ['"]voice:/i.test(errorMessage(error))
}

function ModelSelect({ label, description, value, options, onChange }: { label: string; description: string; value: string; options: VoiceOption[]; onChange(value: string): void }) {
  const { t } = useI18n()
  const choices = optionsWithCurrent(options, value)
  const selected = choices.find((option) => option.value === value)
  return (
    <label className="voice-choice-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <span className="voice-choice-control">
        <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
          {choices.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
              {option.recommended ? t('voice.recommendedSuffix') : ''}
            </option>
          ))}
        </select>
        {selected ? <small>{selected.detail}</small> : null}
      </span>
    </label>
  )
}

function PathInput({ label, description, placeholder, value, onCommit }: { label: string; description: string; placeholder: string; value: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <label className="voice-path-field">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft)
        }}
      />
    </label>
  )
}

export function VoiceSettings({ settings, onUpdate, voice, platform = 'darwin' }: VoiceSettingsProps) {
  const { t } = useI18n()
  const [status, setStatus] = useState<VoiceCredentialStatus | null>(null)
  const [serviceState, setServiceState] = useState<VoiceServiceState>(voice ? 'checking' : 'restart-required')
  const [credential, setCredential] = useState<VoiceCredentialProvider | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [selfHostedUrl, setSelfHostedUrl] = useState(settings.voiceSelfHostedUrl)
  const [selfHostedModel, setSelfHostedModel] = useState(settings.voiceSelfHostedModel)
  const [selfHostedTestState, setSelfHostedTestState] = useState<SelfHostedTestState>('idle')
  const [selfHostedMessage, setSelfHostedMessage] = useState('')

  useEffect(() => setSelfHostedUrl(settings.voiceSelfHostedUrl), [settings.voiceSelfHostedUrl])
  useEffect(() => setSelfHostedModel(settings.voiceSelfHostedModel), [settings.voiceSelfHostedModel])

  useEffect(() => {
    let active = true
    if (!voice) {
      setServiceState('restart-required')
      return
    }
    setServiceState('checking')
    void voice
      .credentialStatus()
      .then((next) => {
        if (active) {
          setStatus(next)
          setServiceState('ready')
        }
      })
      .catch((error) => {
        if (!active) return
        setStatus(null)
        if (needsDesktopRestart(error)) {
          setCredential(null)
          setFailure('')
          setServiceState('restart-required')
        } else {
          setFailure(errorMessage(error))
          setServiceState('error')
        }
      })
    return () => {
      active = false
    }
  }, [voice])

  const credentialName = (id: VoiceCredentialProvider): string => {
    const item = CREDENTIALS.find((entry) => entry.id === id)
    return item ? (item.nameKey ? t(item.nameKey) : item.name) : id
  }

  const saveCredential = async () => {
    if (!voice || !credential || !apiKey.trim()) return
    setBusy(true)
    setFailure('')
    try {
      setStatus(await voice.saveApiKey(credential, apiKey))
      setApiKey('')
      setCredential(null)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const removeCredential = async (provider: VoiceCredentialProvider) => {
    if (!voice) return
    setBusy(true)
    setFailure('')
    try {
      setStatus(await voice.deleteApiKey(provider))
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const closeCredential = () => {
    if (!busy) {
      setCredential(null)
      setApiKey('')
      setFailure('')
    }
  }
  const openCredential = (provider: VoiceCredentialProvider) => {
    setFailure('')
    setCredential(provider)
  }
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    void onUpdate({ [key]: value } as Pick<AppSettings, K>)
  }
  const testSelfHosted = async () => {
    if (!voice || !selfHostedUrl.trim()) return
    setSelfHostedTestState('testing')
    setSelfHostedMessage('')
    const url = selfHostedUrl.trim()
    const model = selfHostedModel.trim()
    try {
      await voice.testSelfHosted({ url, model })
      await onUpdate({ voiceSelfHostedUrl: url, voiceSelfHostedModel: model })
      setSelfHostedTestState('connected')
      setSelfHostedMessage(t('voice.selfHosted.connected'))
    } catch (error) {
      setSelfHostedTestState('error')
      setSelfHostedMessage(errorMessage(error))
    }
  }
  const provider = VOICE_PROVIDER_OPTIONS.find((option) => option.value === settings.voiceTranscriptionProvider) ?? VOICE_PROVIDER_OPTIONS[0]
  const selectedCredential = provider.credential
  const selectedConfigured = selectedCredential ? (status?.configured[selectedCredential] ?? false) : true
  const secureStorageAvailable = status?.storage.available ?? false

  return (
    <>
      <header className="voice-settings-header">
        <span className="voice-settings-header__icon">
          <Mic2 size={19} />
        </span>
        <div>
          <h1>{t('voice.title')}</h1>
          <p>{t('voice.description')}</p>
        </div>
      </header>

      {serviceState === 'restart-required' ? (
        <div className="voice-bridge-notice" role="status">
          <RefreshCw size={17} />
          <span>
            <strong>{t('voice.restart.title')}</strong>
            <small>{t('voice.restart.description', { shortcut: shortcutLabel(platform, ['Primary', 'Q']) })}</small>
          </span>
        </div>
      ) : null}

      <section className="voice-section" aria-labelledby="voice-connections-title">
        <div className="voice-section__heading">
          <span>
            <ShieldCheck size={15} />
          </span>
          <div>
            <h2 id="voice-connections-title">{t('voice.connections')}</h2>
            <p>{t('voice.connections.description')}</p>
          </div>
        </div>
        {serviceState === 'ready' && status && !secureStorageAvailable ? (
          <div className="voice-storage-notice" role="alert">
            <ShieldAlert size={17} />
            <span>
              <strong>{t('voice.storage.title')}</strong>
              <small>{t('voice.storage.description', { message: status.storage.message ?? '' })}</small>
            </span>
          </div>
        ) : null}
        {voice ? (
          <div className="voice-connection-grid">
            {CONNECTION_CREDENTIALS.map((item) => {
              const configured = status?.configured[item.id] ?? false
              const source = status?.source[item.id]
              const name = credentialName(item.id)
              return (
                <article className={`voice-connection-card${configured ? ' is-connected' : ''}`} key={item.id}>
                  <span className="voice-provider-mark" aria-hidden="true">
                    {item.monogram}
                  </span>
                  <div className="voice-connection-card__body">
                    <span className="voice-connection-card__title">
                      <strong>{name}</strong>
                      <i>
                        {serviceState === 'checking'
                          ? t('voice.status.checking')
                          : serviceState === 'restart-required'
                            ? t('voice.status.restartRequired')
                            : serviceState === 'error'
                              ? t('voice.status.unavailable')
                              : configured
                                ? source === 'environment'
                                  ? t('voice.status.environmentKey')
                                  : source === 'session'
                                    ? t('voice.status.sessionOnly')
                                    : t('voice.status.connected')
                                : source === 'saved' && !secureStorageAvailable
                                  ? t('voice.status.storageLocked')
                                  : t('voice.status.notConnected')}
                      </i>
                    </span>
                    <small>{t(item.detailKey)}</small>
                  </div>
                  {serviceState === 'ready' ? (
                    <button type="button" className="button" disabled={busy} onClick={() => openCredential(item.id)}>
                      <KeyRound size={13} /> {configured ? t('voice.replaceKey') : t('voice.addKey')}
                    </button>
                  ) : null}
                  {serviceState === 'ready' && (source === 'saved' || source === 'session') ? (
                    <button type="button" className="button button--icon" aria-label={t('voice.removeKey', { name })} disabled={busy} onClick={() => void removeCredential(item.id)}>
                      <Trash2 size={13} />
                    </button>
                  ) : null}
                </article>
              )
            })}
          </div>
        ) : null}
        {failure && !credential ? (
          <p className="settings-error" role="alert">
            {failure}
          </p>
        ) : null}
      </section>

      <section className="voice-section" aria-labelledby="voice-dictation-title">
        <div className="voice-section__heading">
          <span>
            <Waves size={15} />
          </span>
          <div>
            <h2 id="voice-dictation-title">{t('voice.dictation')}</h2>
            <p>{t('voice.dictation.description')}</p>
          </div>
        </div>
        <div className="voice-setup-card">
          <label className="voice-choice-row">
            <span>
              <strong>{t('voice.dictation.service')}</strong>
              <small>{t('voice.dictation.service.description')}</small>
            </span>
            <span className="voice-choice-control">
              <select
                aria-label={t('voice.dictation.service.aria')}
                value={settings.voiceTranscriptionProvider}
                onChange={(event) => update('voiceTranscriptionProvider', event.target.value as VoiceTranscriptionProvider)}
              >
                {VOICE_PROVIDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                    {option.recommended ? t('voice.recommendedSuffix') : ''}
                  </option>
                ))}
              </select>
              <small>{provider.detail}</small>
            </span>
          </label>

          {settings.voiceTranscriptionProvider === 'openai-live' ? (
            <ModelSelect
              label={t('voice.dictation.model')}
              description={t('voice.dictationModel.openaiLive')}
              value={settings.voiceOpenAiLiveTranscriptionModel}
              options={OPENAI_LIVE_MODELS}
              onChange={(value) => update('voiceOpenAiLiveTranscriptionModel', value)}
            />
          ) : null}
          {settings.voiceTranscriptionProvider === 'openai' ? (
            <ModelSelect
              label={t('voice.dictation.model')}
              description={t('voice.dictationModel.openai')}
              value={settings.voiceOpenAiTranscriptionModel}
              options={OPENAI_FILE_MODELS}
              onChange={(value) => update('voiceOpenAiTranscriptionModel', value)}
            />
          ) : null}
          {settings.voiceTranscriptionProvider === 'groq' ? (
            <ModelSelect
              label={t('voice.dictation.model')}
              description={t('voice.dictationModel.groq')}
              value={settings.voiceGroqTranscriptionModel}
              options={GROQ_MODELS}
              onChange={(value) => update('voiceGroqTranscriptionModel', value)}
            />
          ) : null}
          {settings.voiceTranscriptionProvider === 'deepgram' ? (
            <ModelSelect
              label={t('voice.dictation.model')}
              description={t('voice.dictationModel.deepgram')}
              value={settings.voiceDeepgramTranscriptionModel}
              options={DEEPGRAM_MODELS}
              onChange={(value) => update('voiceDeepgramTranscriptionModel', value)}
            />
          ) : null}
          {settings.voiceTranscriptionProvider === 'self-hosted' ? (
            <div className="voice-self-hosted-setup">
              <span className="voice-local-setup__intro">
                <Server size={15} />
                <span>
                  <strong>{t('voice.selfHosted.title')}</strong>
                  <small>{t('voice.selfHosted.description')}</small>
                </span>
              </span>
              <label className="voice-path-field">
                <span>
                  <strong>{t('voice.selfHosted.url.label')}</strong>
                  <small>{t('voice.selfHosted.url.description')}</small>
                </span>
                <input
                  aria-label={t('voice.selfHosted.url.aria')}
                  type="url"
                  value={selfHostedUrl}
                  placeholder="http://127.0.0.1:9000"
                  spellCheck={false}
                  onChange={(event) => {
                    setSelfHostedUrl(event.target.value)
                    setSelfHostedTestState('idle')
                    setSelfHostedMessage('')
                  }}
                  onBlur={() => {
                    const value = selfHostedUrl.trim()
                    if (value !== settings.voiceSelfHostedUrl) update('voiceSelfHostedUrl', value)
                  }}
                />
              </label>
              <label className="voice-path-field">
                <span>
                  <strong>{t('voice.selfHosted.model.label')}</strong>
                  <small>{t('voice.selfHosted.model.description')}</small>
                </span>
                <input
                  aria-label={t('voice.selfHosted.model.aria')}
                  value={selfHostedModel}
                  placeholder="nvidia/parakeet-tdt-0.6b-v3"
                  spellCheck={false}
                  onChange={(event) => {
                    setSelfHostedModel(event.target.value)
                    setSelfHostedTestState('idle')
                    setSelfHostedMessage('')
                  }}
                  onBlur={() => {
                    const value = selfHostedModel.trim()
                    if (value !== settings.voiceSelfHostedModel) update('voiceSelfHostedModel', value)
                  }}
                />
              </label>
              <div className="voice-self-hosted-auth">
                <span>
                  <strong>{t('voice.selfHosted.token.label')}</strong>
                  <small>{t('voice.selfHosted.token.description')}</small>
                </span>
                <span className="voice-self-hosted-auth__actions">
                  <i>
                    {status?.configured['self-hosted']
                      ? status.source['self-hosted'] === 'session'
                        ? t('voice.selfHosted.token.sessionOnly')
                        : status.source['self-hosted'] === 'environment'
                          ? t('voice.selfHosted.token.environment')
                          : t('voice.selfHosted.token.saved')
                      : status?.source['self-hosted'] === 'saved'
                        ? t('voice.selfHosted.token.storageLocked')
                        : t('voice.selfHosted.token.none')}
                  </i>
                  {voice && serviceState === 'ready' ? (
                    <button type="button" className="button" disabled={busy} onClick={() => openCredential('self-hosted')}>
                      <KeyRound size={13} /> {status?.configured['self-hosted'] ? t('voice.selfHosted.token.replace') : t('voice.selfHosted.token.add')}
                    </button>
                  ) : null}
                  {voice && serviceState === 'ready' && (status?.source['self-hosted'] === 'saved' || status?.source['self-hosted'] === 'session') ? (
                    <button type="button" className="button button--icon" aria-label={t('voice.selfHosted.token.remove')} disabled={busy} onClick={() => void removeCredential('self-hosted')}>
                      <Trash2 size={13} />
                    </button>
                  ) : null}
                </span>
              </div>
              <div className="voice-self-hosted-connect">
                <span>
                  <strong>{t('voice.selfHosted.check.label')}</strong>
                  <small>{t('voice.selfHosted.check.description')}</small>
                </span>
                <button type="button" className="button button--primary" disabled={!voice || !selfHostedUrl.trim() || selfHostedTestState === 'testing'} onClick={() => void testSelfHosted()}>
                  {selfHostedTestState === 'testing' ? <LoaderCircle className="is-spinning" size={13} /> : <Server size={13} />}{' '}
                  {selfHostedTestState === 'testing' ? t('voice.selfHosted.testing') : t('voice.selfHosted.connect')}
                </button>
              </div>
              {selfHostedMessage ? (
                <p className={`voice-self-hosted-result is-${selfHostedTestState}`} role={selfHostedTestState === 'error' ? 'alert' : 'status'}>
                  {selfHostedTestState === 'connected' ? <Check size={13} /> : <ShieldAlert size={13} />}
                  {selfHostedMessage}
                </p>
              ) : null}
              <p className="voice-self-hosted-note">{t('voice.selfHosted.note')}</p>
            </div>
          ) : null}
          {settings.voiceTranscriptionProvider === 'local-whisper' ? (
            <div className="voice-local-setup">
              <span className="voice-local-setup__intro">
                <Laptop size={15} />
                <span>
                  <strong>{t('voice.localWhisper.title')}</strong>
                  <small>{t('voice.localWhisper.description')}</small>
                </span>
              </span>
              <PathInput
                label={t('voice.localWhisper.executable.label')}
                description={t('voice.localWhisper.executable.description')}
                placeholder="/opt/homebrew/bin/whisper-cli"
                value={settings.voiceLocalWhisperExecutable}
                onCommit={(value) => update('voiceLocalWhisperExecutable', value)}
              />
              <PathInput
                label={t('voice.localWhisper.model.label')}
                description={t('voice.localWhisper.model.description')}
                placeholder="/path/to/ggml-large-v3-turbo.bin"
                value={settings.voiceLocalWhisperModel}
                onCommit={(value) => update('voiceLocalWhisperModel', value)}
              />
            </div>
          ) : null}

          {settings.voiceTranscriptionProvider === 'self-hosted' ? (
            <div className={`voice-requirement${selfHostedUrl.trim() ? ' is-ready' : ''}`}>
              <span>
                {selfHostedUrl.trim() ? <Check size={13} /> : <Server size={13} />}
                {selfHostedUrl.trim() ? t('voice.selfHosted.configured') : t('voice.selfHosted.urlRequired')}
              </span>
            </div>
          ) : selectedCredential ? (
            <div className={`voice-requirement${selectedConfigured ? ' is-ready' : ''}`}>
              <span>
                {selectedConfigured ? <Check size={13} /> : <KeyRound size={13} />}
                {selectedConfigured ? t('voice.requirement.connected', { name: credentialName(selectedCredential) }) : t('voice.requirement.keyRequired', { name: credentialName(selectedCredential) })}
              </span>
              {!selectedConfigured && voice && serviceState === 'ready' ? (
                <button type="button" onClick={() => openCredential(selectedCredential)}>
                  {t('voice.addKey')}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="voice-requirement is-ready">
              <span>
                <Check size={13} />
                {t('voice.requirement.local')}
              </span>
            </div>
          )}
        </div>
      </section>

      {credential ? (
        <Modal
          title={t('voice.credentials.connectTitle', { name: credentialName(credential) })}
          onClose={closeCredential}
          footer={
            <>
              <button type="button" className="button" disabled={busy} onClick={closeCredential}>
                {t('voice.credentials.cancel')}
              </button>
              <button type="button" className="button button--primary" disabled={busy || !apiKey.trim()} onClick={() => void saveCredential()}>
                {busy ? t('voice.credentials.saving') : credential === 'self-hosted' ? t('voice.credentials.saveToken') : t('voice.credentials.saveApiKey')}
              </button>
            </>
          }
        >
          <p className="modal-intro">
            {secureStorageAvailable
              ? credential === 'self-hosted'
                ? t('voice.credentials.introTokenSecure')
                : t('voice.credentials.introKeySecure')
              : credential === 'self-hosted'
                ? t('voice.credentials.introTokenInsecure')
                : t('voice.credentials.introKeyInsecure')}
          </p>
          {failure ? (
            <p className="settings-error" role="alert">
              {failure}
            </p>
          ) : null}
          <label className="field">
            <span>{credential === 'self-hosted' ? t('voice.credentials.token.label') : t('voice.credentials.apiKey.label')}</span>
            <input
              autoFocus
              type="password"
              value={apiKey}
              autoComplete="off"
              spellCheck={false}
              placeholder={credential === 'self-hosted' ? t('voice.credentials.pasteToken') : t('voice.credentials.pasteApiKey')}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
        </Modal>
      ) : null}
    </>
  )
}
