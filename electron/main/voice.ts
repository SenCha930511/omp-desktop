import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { VOICE_CREDENTIAL_PROVIDERS } from '../../src/types/api'
import type {
  AppSettings,
  VoiceCredentialProvider,
  VoiceCredentialStorageStatus,
  VoiceCredentialStatus,
} from '../../src/types/api'
import type { ProcessResult } from './process-utils'
import { isRecord, requireExistingPath, requireRecord, requireSelfHostedVoiceUrl, requireString } from './validation'

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const MAX_SECRET_BYTES = 16 * 1024
const MAX_SDP_BYTES = 256 * 1024
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024
const REMOTE_TIMEOUT_MS = 90_000

interface SecretCodec {
  status(): VoiceCredentialStorageStatus
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

interface SecretFile {
  version: 1
  secrets: Partial<Record<VoiceCredentialProvider, string>>
}

interface VoiceServiceOptions {
  secretPath: string
  secretCodec: SecretCodec
  settings(): AppSettings
  fetch?: typeof fetch
  runProcess(file: string, args: readonly string[], options?: { timeoutMs?: number; maxBytes?: number }): Promise<ProcessResult>
  environment?: NodeJS.ProcessEnv
}

function voiceSecretStorageStatus(platform: NodeJS.Platform, encryptionAvailable: boolean, backend?: string): VoiceCredentialStorageStatus {
  if (platform === 'linux' && backend === 'basic_text') {
    return {
      available: false,
      message: 'OMP Desktop will not save voice API keys because this Linux desktop is using unprotected basic-text storage. Install and unlock GNOME Keyring (libsecret) or KWallet, then restart OMP Desktop.',
    }
  }
  if (platform === 'linux' && backend === 'unknown') {
    return {
      available: false,
      message: 'OMP Desktop cannot access a secure Linux credential store yet. Start it from a desktop session with GNOME Keyring (libsecret) or KWallet installed and unlocked, then restart OMP Desktop.',
    }
  }
  if (!encryptionAvailable) {
    return platform === 'linux'
      ? {
          available: false,
          message: 'OMP Desktop cannot find a secure Linux credential store. Install and unlock GNOME Keyring (libsecret) or KWallet, then restart OMP Desktop.',
        }
      : {
          available: false,
          message: 'OMP Desktop cannot access your operating system’s secure credential store. Unlock or repair it, then restart OMP Desktop.',
        }
  }
  return { available: true }
}

function credentialProvider(value: unknown): VoiceCredentialProvider {
  if (value !== 'openai' && value !== 'groq' && value !== 'deepgram' && value !== 'self-hosted') throw new TypeError('Invalid voice credential provider')
  return value
}

function selfHostedConfiguration(urlValue: unknown, modelValue: unknown): { endpoint: string; model: string } {
  const url = new URL(requireSelfHostedVoiceUrl(urlValue))
  const suffix = '/v1/audio/transcriptions'
  const path = url.pathname.replace(/\/+$/, '')
  if (!path.endsWith(suffix)) url.pathname = path.endsWith('/v1') ? `${path}/audio/transcriptions` : `${path}${suffix}`
  const model = requireString(modelValue, 'self-hosted voice model', { max: 128, trim: true })
  if (model && !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(model)) throw new TypeError('Self-hosted voice model is not valid')
  return { endpoint: url.toString(), model }
}

function silentWav(): Uint8Array {
  const samples = 1_600
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  write(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); write(8, 'WAVE')
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, samples * 2, true)
  return bytes
}

function boundedAudio(value: unknown): Uint8Array {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer ? new Uint8Array(value) : null
  if (!bytes || bytes.byteLength < 44 || bytes.byteLength > MAX_AUDIO_BYTES) throw new TypeError('Audio must be a WAV buffer no larger than 25 MB')
  return bytes
}

function cleanText(value: unknown, label: string, max = 1_000_000): string {
  return requireString(value, label, { min: 1, max, trim: true })
}

class VoiceSecretStore {
  private loaded = false
  private values: SecretFile['secrets'] = {}
  private sessionValues: Partial<Record<VoiceCredentialProvider, string>> = {}
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly codec: SecretCodec,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.secrets)) return
      for (const provider of VOICE_CREDENTIAL_PROVIDERS) {
        const encrypted = raw.secrets[provider]
        if (typeof encrypted === 'string' && encrypted.length <= MAX_SECRET_BYTES * 4) this.values[provider] = encrypted
      }
    } catch { /* a missing or malformed secret file starts empty */ }
  }

  private environmentKey(provider: VoiceCredentialProvider): string | undefined {
    const key = this.environment[
      provider === 'openai' ? 'OPENAI_API_KEY'
        : provider === 'groq' ? 'GROQ_API_KEY'
          : provider === 'deepgram' ? 'DEEPGRAM_API_KEY' : 'VOICE_SELF_HOSTED_API_KEY'
    ]
    return key?.trim() || undefined
  }

  async status(): Promise<VoiceCredentialStatus> {
    await this.load()
    const storage = this.codec.status()
    const configured = { openai: false, groq: false, deepgram: false, 'self-hosted': false }
    const source: VoiceCredentialStatus['source'] = {}
    for (const provider of VOICE_CREDENTIAL_PROVIDERS) {
      if (this.sessionValues[provider]) {
        configured[provider] = true
        source[provider] = 'session'
      } else if (this.values[provider] && storage.available) {
        configured[provider] = true
        source[provider] = 'saved'
      } else if (this.environmentKey(provider)) {
        configured[provider] = true
        source[provider] = 'environment'
      } else if (this.values[provider]) {
        source[provider] = 'saved'
      }
    }
    return { configured, source, storage }
  }

  async get(provider: VoiceCredentialProvider): Promise<string> {
    const value = await this.getOptional(provider)
    if (value) return value
    const storage = this.codec.status()
    if (!storage.available) throw new Error(storage.message ?? 'Secure credential storage is unavailable on this system')
    throw new Error(`Add a ${provider} API key in Settings → Voice.`)
  }

  async getOptional(provider: VoiceCredentialProvider): Promise<string | undefined> {
    await this.load()
    const fromSession = this.sessionValues[provider]
    if (fromSession) return fromSession
    const encrypted = this.values[provider]
    const storage = this.codec.status()
    if (encrypted && storage.available) {
      try { return this.codec.decrypt(Buffer.from(encrypted, 'base64')) }
      catch { throw new Error(`The saved ${provider} voice key could not be decrypted. Save it again in Voice settings.`) }
    }
    const fromEnvironment = this.environmentKey(provider)
    if (fromEnvironment) return fromEnvironment
    if (encrypted && !storage.available) throw new Error(storage.message ?? 'Secure credential storage is unavailable on this system')
    return undefined
  }

  async save(providerValue: unknown, keyValue: unknown): Promise<VoiceCredentialStatus> {
    const provider = credentialProvider(providerValue)
    const key = requireString(keyValue, 'apiKey', { min: 1, max: MAX_SECRET_BYTES, trim: true })
    await this.load()
    const storage = this.codec.status()
    if (!storage.available) {
      this.sessionValues[provider] = key
      return this.status()
    }
    delete this.sessionValues[provider]
    this.values[provider] = this.codec.encrypt(key).toString('base64')
    await this.persist()
    return this.status()
  }

  async delete(providerValue: unknown): Promise<VoiceCredentialStatus> {
    const provider = credentialProvider(providerValue)
    await this.load()
    const hadSavedValue = Boolean(this.values[provider])
    delete this.sessionValues[provider]
    delete this.values[provider]
    if (hadSavedValue) await this.persist()
    return this.status()
  }

  private persist(): Promise<void> {
    const snapshot: SecretFile = { version: 1, secrets: { ...this.values } }
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
      await rename(temporary, this.path)
    })
    this.writeQueue = operation.catch(() => undefined)
    return operation
  }
}

function transcriptionSession(settings: AppSettings): Record<string, unknown> {
  return {
    type: 'transcription',
    audio: {
      input: {
        transcription: { model: settings.voiceOpenAiLiveTranscriptionModel, delay: 'low' },
        turn_detection: null,
      },
    },
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export class VoiceService {
  private readonly secrets: VoiceSecretStore
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: VoiceServiceOptions) {
    this.secrets = new VoiceSecretStore(options.secretPath, options.secretCodec, options.environment ?? process.env)
    this.fetchImpl = options.fetch ?? fetch
  }

  credentialStatus(): Promise<VoiceCredentialStatus> { return this.secrets.status() }
  saveApiKey(provider: unknown, key: unknown): Promise<VoiceCredentialStatus> { return this.secrets.save(provider, key) }
  deleteApiKey(provider: unknown): Promise<VoiceCredentialStatus> { return this.secrets.delete(provider) }

  async createRealtimeCall(raw: unknown): Promise<string> {
    const request = requireRecord(raw, 'realtime call')
    if (request.mode !== 'transcription') throw new TypeError('Invalid realtime call mode')
    const sdp = requireString(request.sdp, 'sdp', { min: 16, max: MAX_SDP_BYTES })
    if (!sdp.startsWith('v=0')) throw new TypeError('Invalid WebRTC session description')
    const key = await this.secrets.get('openai')
    const form = new FormData()
    form.set('sdp', sdp)
    form.set('session', JSON.stringify(transcriptionSession(this.options.settings())))
    const response = await this.withTimeout('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    }, 30_000)
    const answer = await response.text()
    if (!response.ok) throw new Error(`OpenAI realtime setup failed (${response.status}): ${answer.slice(0, 512)}`)
    if (!answer.startsWith('v=0')) throw new Error('OpenAI realtime setup returned an invalid session description')
    return answer
  }

  async transcribe(raw: unknown): Promise<string> {
    const request = requireRecord(raw, 'transcription request')
    const provider = request.provider
    if (provider !== 'openai' && provider !== 'groq' && provider !== 'deepgram' && provider !== 'self-hosted' && provider !== 'local-whisper') throw new TypeError('Invalid transcription provider')
    const audio = boundedAudio(request.audio)
    if (provider === 'local-whisper') return this.transcribeLocal(audio)
    const settings = this.options.settings()
    if (provider === 'self-hosted') {
      return this.transcribeSelfHosted(audio, settings.voiceSelfHostedUrl, settings.voiceSelfHostedModel)
    }
    if (provider === 'deepgram') {
      const key = await this.secrets.get('deepgram')
      const model = encodeURIComponent(settings.voiceDeepgramTranscriptionModel)
      const response = await this.withTimeout(`https://api.deepgram.com/v1/listen?model=${model}&smart_format=true&punctuate=true`, {
        method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' }, body: exactArrayBuffer(audio),
      })
      const data = await this.jsonResponse(response, 'Deepgram transcription')
      const text = isRecord(data.results) && Array.isArray(data.results.channels)
        && isRecord(data.results.channels[0]) && Array.isArray(data.results.channels[0].alternatives)
        && isRecord(data.results.channels[0].alternatives[0]) ? data.results.channels[0].alternatives[0].transcript : undefined
      return cleanText(text, 'Deepgram transcript')
    }
    const key = await this.secrets.get(provider)
    const form = new FormData()
    form.set('file', new Blob([exactArrayBuffer(audio)], { type: 'audio/wav' }), 'dictation.wav')
    form.set('model', provider === 'openai' ? settings.voiceOpenAiTranscriptionModel : settings.voiceGroqTranscriptionModel)
    form.set('response_format', 'json')
    const base = provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.groq.com/openai/v1'
    const response = await this.withTimeout(`${base}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
    })
    const data = await this.jsonResponse(response, `${provider} transcription`)
    return cleanText(data.text, `${provider} transcript`)
  }

  async testSelfHosted(raw: unknown): Promise<boolean> {
    const request = requireRecord(raw, 'self-hosted voice test')
    await this.transcribeSelfHosted(silentWav(), request.url, request.model, true)
    return true
  }

  private async transcribeLocal(audio: Uint8Array): Promise<string> {
    const settings = this.options.settings()
    const executable = await requireExistingPath(settings.voiceLocalWhisperExecutable, 'whisper.cpp executable')
    const model = await requireExistingPath(settings.voiceLocalWhisperModel, 'whisper.cpp model')
    const directory = await mkdtemp(join(tmpdir(), 'omp-desktop-voice-'))
    const input = join(directory, 'dictation.wav')
    const output = join(directory, 'transcript')
    try {
      await writeFile(input, audio)
      const result = await this.options.runProcess(executable, ['-m', model, '-f', input, '-nt', '-otxt', '-of', output], { timeoutMs: 5 * 60_000, maxBytes: 2 * 1024 * 1024 })
      if (result.timedOut) throw new Error('Local Whisper transcription timed out')
      if (result.outputExceeded) throw new Error('Local Whisper produced too much output')
      if (result.code !== 0) throw new Error(`Local Whisper failed: ${result.stderr.trim().slice(0, 512) || `exit ${result.code}`}`)
      return cleanText(await readFile(`${output}.txt`, 'utf8'), 'Local Whisper transcript')
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async transcribeSelfHosted(audio: Uint8Array, urlValue: unknown, modelValue: unknown, allowEmpty = false): Promise<string> {
    const { endpoint, model } = selfHostedConfiguration(urlValue, modelValue)
    const token = await this.secrets.getOptional('self-hosted')
    const form = new FormData()
    form.set('file', new Blob([exactArrayBuffer(audio)], { type: 'audio/wav' }), 'dictation.wav')
    if (model) form.set('model', model)
    else form.set('language', 'en-US')
    form.set('response_format', 'json')
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), REMOTE_TIMEOUT_MS)
    timer.unref()
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
        redirect: 'error',
        signal: abort.signal,
      })
      const data = await this.jsonResponse(response, 'Self-hosted transcription')
      if (typeof data.text !== 'string') throw new TypeError('Self-hosted transcript must be a string')
      return allowEmpty ? data.text.trim() : cleanText(data.text, 'Self-hosted transcript')
    } catch (error) {
      if (abort.signal.aborted) throw new Error('Self-hosted transcription timed out')
      throw error
    } finally { clearTimeout(timer) }
  }

  private async jsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
    const text = await this.boundedResponseText(response, label)
    if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text.slice(0, 512)}`)
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new Error(`${label} returned invalid JSON`) }
    return requireRecord(parsed, `${label} response`)
  }

  private async boundedResponseText(response: Response, label: string): Promise<string> {
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > MAX_PROVIDER_RESPONSE_BYTES) throw new Error(`${label} response was too large`)
    if (!response.body) return ''
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label} response was too large`)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder().decode(bytes)
  }

  private async withTimeout(url: string, init: RequestInit, timeoutMs = REMOTE_TIMEOUT_MS): Promise<Response> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    timer.unref()
    try { return await this.fetchImpl(url, { ...init, signal: abort.signal }) }
    catch (error) {
      if (abort.signal.aborted) throw new Error('Voice provider request timed out')
      throw error
    } finally { clearTimeout(timer) }
  }
}

export { voiceSecretStorageStatus }
export type { SecretCodec, VoiceServiceOptions }
