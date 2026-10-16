import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../electron/main/store'
import { VoiceService, voiceSecretStorageStatus, type VoiceServiceOptions } from '../../electron/main/voice'

const directories: string[] = []

function makeService(overrides: Partial<VoiceServiceOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'omp-desktop-voice-test-'))
  directories.push(directory)
  const options: VoiceServiceOptions = {
    secretPath: join(directory, 'voice-secrets.json'),
    secretCodec: {
      status: () => ({ available: true }),
      encrypt: (value) => Buffer.from(`encrypted:${value}`),
      decrypt: (value) => value.toString().replace(/^encrypted:/, ''),
    },
    settings: defaultSettings,
    runProcess: vi.fn(),
    environment: {},
    ...overrides,
  }
  return { service: new VoiceService(options), options }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('VoiceService', () => {
  it('rejects Linux basic-text storage with actionable setup guidance', () => {
    expect(voiceSecretStorageStatus('linux', true, 'basic_text')).toEqual({
      available: false,
      message: 'OMP Desktop will not save voice API keys because this Linux desktop is using unprotected basic-text storage. Install and unlock GNOME Keyring (libsecret) or KWallet, then restart OMP Desktop.',
    })
    expect(voiceSecretStorageStatus('linux', true, 'gnome_libsecret')).toEqual({ available: true })
    expect(voiceSecretStorageStatus('win32', true)).toEqual({ available: true })
  })

  it('stores encrypted API keys and only returns credential status', async () => {
    const { service } = makeService()
    expect(await service.credentialStatus()).toEqual({
      configured: { openai: false, groq: false, deepgram: false, 'self-hosted': false },
      source: {},
      storage: { available: true },
    })
    expect(await service.saveApiKey('openai', 'sk-secret-value')).toEqual({
      configured: { openai: true, groq: false, deepgram: false, 'self-hosted': false },
      source: { openai: 'saved' },
      storage: { available: true },
    })
    expect(JSON.stringify(await service.credentialStatus())).not.toContain('sk-secret-value')
  })

  it('does not decrypt or use a saved key while secure storage is unavailable', async () => {
    let storageAvailable = true
    const decrypt = vi.fn((value: Buffer) => value.toString().replace(/^encrypted:/, ''))
    const message = 'Install and unlock GNOME Keyring (libsecret) or KWallet, then restart OMP Desktop.'
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: 'Bearer sk-session-value' })
      return new Response('v=0\r\no=answer')
    })
    const { service } = makeService({
      secretCodec: {
        status: () => storageAvailable ? { available: true } : { available: false, message },
        encrypt: (value) => Buffer.from(`encrypted:${value}`),
        decrypt,
      },
      fetch: fetchMock as typeof fetch,
    })
    await service.saveApiKey('openai', 'sk-secret-value')
    storageAvailable = false

    await expect(service.credentialStatus()).resolves.toEqual({
      configured: { openai: false, groq: false, deepgram: false, 'self-hosted': false },
      source: { openai: 'saved' },
      storage: { available: false, message },
    })
    await expect(service.createRealtimeCall({ mode: 'transcription', sdp: 'v=0\r\no=offer-value' })).rejects.toThrow(message)
    expect(decrypt).not.toHaveBeenCalled()

    await expect(service.saveApiKey('openai', 'sk-session-value')).resolves.toEqual({
      configured: { openai: true, groq: false, deepgram: false, 'self-hosted': false },
      source: { openai: 'session' },
      storage: { available: false, message },
    })
    await expect(service.createRealtimeCall({ mode: 'transcription', sdp: 'v=0\r\no=offer-value' })).resolves.toContain('o=answer')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('keeps a fallback key only in memory when secure storage is unavailable', async () => {
    const message = 'Install and unlock GNOME Keyring (libsecret) or KWallet, then restart OMP Desktop.'
    const encrypt = vi.fn((value: string) => Buffer.from(`encrypted:${value}`))
    const { service, options } = makeService({
      secretCodec: {
        status: () => ({ available: false, message }),
        encrypt,
        decrypt: (value) => value.toString().replace(/^encrypted:/, ''),
      },
    })

    const status = await service.saveApiKey('groq', 'gsk-session-secret')
    expect(status).toEqual({
      configured: { openai: false, groq: true, deepgram: false, 'self-hosted': false },
      source: { groq: 'session' },
      storage: { available: false, message },
    })
    expect(JSON.stringify(status)).not.toContain('gsk-session-secret')
    expect(encrypt).not.toHaveBeenCalled()
    expect(existsSync(options.secretPath)).toBe(false)

    const restartedService = new VoiceService(options)
    await expect(restartedService.credentialStatus()).resolves.toEqual({
      configured: { openai: false, groq: false, deepgram: false, 'self-hosted': false },
      source: {},
      storage: { available: false, message },
    })
  })

  it('transcribes through a self-hosted Parakeet or Whisper endpoint with a securely stored token', async () => {
    const settings = {
      ...defaultSettings(),
      voiceTranscriptionProvider: 'self-hosted' as const,
      voiceSelfHostedUrl: 'https://speech.example.test/v1',
      voiceSelfHostedModel: 'nvidia/parakeet-tdt-0.6b-v3',
    }
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://speech.example.test/v1/audio/transcriptions')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('error')
      expect(init?.headers).toEqual({ Authorization: 'Bearer local-asr-token' })
      const form = init?.body as FormData
      expect(form.get('model')).toBe('nvidia/parakeet-tdt-0.6b-v3')
      expect(form.get('response_format')).toBe('json')
      expect(form.get('file')).toBeInstanceOf(Blob)
      return Response.json({ text: 'A local transcript.' })
    })
    const { service } = makeService({ settings: () => settings, fetch: fetchMock as typeof fetch })
    await service.saveApiKey('self-hosted', 'local-asr-token')

    await expect(service.transcribe({ provider: 'self-hosted', audio: new Uint8Array(44) })).resolves.toBe('A local transcript.')
    expect(JSON.stringify(await service.credentialStatus())).not.toContain('local-asr-token')
  })

  it('tests a token-free self-hosted endpoint through the actual transcription route', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:9000/v1/audio/transcriptions')
      expect(init?.headers).toBeUndefined()
      const form = init?.body as FormData
      expect(form.get('model')).toBeNull()
      expect(form.get('language')).toBe('en-US')
      expect((form.get('file') as Blob).size).toBeGreaterThan(44)
      return Response.json({ text: '' })
    })
    const { service } = makeService({ fetch: fetchMock as typeof fetch })

    await expect(service.testSelfHosted({ url: 'http://127.0.0.1:9000/v1/audio/transcriptions', model: '' })).resolves.toBe(true)
  })

  it('rejects insecure remote self-hosted URLs and oversized provider responses', async () => {
    const { service } = makeService()
    await expect(service.testSelfHosted({ url: 'http://8.8.8.8:9000', model: '' })).rejects.toThrow(/use HTTPS for public hosts/)

    const settings = { ...defaultSettings(), voiceSelfHostedUrl: 'https://speech.example.test', voiceSelfHostedModel: '' }
    const fetchMock = vi.fn(async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }))
    const oversized = makeService({ settings: () => settings, fetch: fetchMock as typeof fetch }).service
    await expect(oversized.transcribe({ provider: 'self-hosted', audio: new Uint8Array(44) })).rejects.toThrow(/response was too large/)
  })

  it('uses the selected native streaming transcription model', async () => {
    const settings = { ...defaultSettings(), voiceOpenAiLiveTranscriptionModel: 'gpt-realtime-whisper' }
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData
      const session = JSON.parse(String(form.get('session'))) as { audio: { input: { transcription: { model: string } } } }
      expect(session.audio.input.transcription.model).toBe('gpt-realtime-whisper')
      return new Response('v=0\r\no=answer')
    })
    const { service } = makeService({ settings: () => settings, fetch: fetchMock as typeof fetch })
    await service.saveApiKey('openai', 'sk-test')
    await service.createRealtimeCall({ mode: 'transcription', sdp: 'v=0\r\no=offer-value' })
  })
})
