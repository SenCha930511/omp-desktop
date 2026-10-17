import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: { fromPartition: vi.fn(), defaultSession: {} } }))

import { SettingsService } from '../../electron/main/settings-schedules'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
function makeService(validateShell: (shell: unknown) => string = () => '/bin/zsh', onDidUpdate?: ConstructorParameters<typeof SettingsService>[3]) {
  const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-settings-'))
  dirs.push(dir)
  return new SettingsService(new JsonStateStore(join(dir, 'state.json')), validateShell, undefined, onDidUpdate)
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('SettingsService.update', () => {
  it('persists the thinking disclosure default and rejects non-boolean values', async () => {
    const service = makeService()
    expect(service.get().reasoningExpandedByDefault).toBe(false)
    expect(service.get().conversationDensity).toBe('comfortable')
    expect(service.get().subagentsPanelPinned).toBe(false)
    await service.update({ subagentsPanelPinned: true })
    expect(service.get().subagentsPanelPinned).toBe(true)
    await expect(service.update({ subagentsPanelPinned: 'yes' } as never)).rejects.toThrow('subagentsPanelPinned')
    await service.update({ conversationDensity: 'compact' })
    expect(service.get().conversationDensity).toBe('compact')
    await expect(service.update({ conversationDensity: 'dense' } as never)).rejects.toThrow('density')
    await service.update({ reasoningExpandedByDefault: true })
    expect(service.get().reasoningExpandedByDefault).toBe(true)
    await expect(service.update({ reasoningExpandedByDefault: 'yes' } as never)).rejects.toThrow('reasoningExpandedByDefault')
  })
  it('applies every field of a full valid patch', async () => {
    const service = makeService()
    const next = await service.update({
      theme: 'dark',
      locale: 'zh-CN',
      interfaceFontScale: 105,
      projectSortMode: 'alphabetical',
      sidebarOpen: false,
      inspectorOpen: true,
      showFileChangesPopup: false,
      checkoutStrategy: 'branch',
      keepRunningInBackground: true,
      launchAtLogin: true,
      terminalOpen: true,
      defaultInspectorTab: 'changes',
      browserHome: 'https://example.test/',
      browserAskForDownloads: false,
      terminalShell: '/bin/zsh',
      reduceMotion: true,
      showReasoningSummaries: false,
      showToolCalls: false,
      messageEnterAction: 'steer',
      runtimePaths: { omp: '/opt/omp' },
      telemetry: false,
      askUserEnabled: false,
      ompDisabledProviders: ['anthropic', 'anthropic'],
      ompDisabledModels: ['anthropic/claude-sonnet-4'],
      lastSelectedModels: { omp: 'anthropic/claude-opus' },
      activeHarness: 'omp',
      ompApprovalMode: 'always-ask',
      voiceTranscriptionProvider: 'groq',
      voiceOpenAiLiveTranscriptionModel: 'gpt-realtime-whisper',
      voiceOpenAiTranscriptionModel: 'gpt-4o-mini-transcribe',
      voiceGroqTranscriptionModel: 'whisper-large-v3',
      voiceDeepgramTranscriptionModel: 'nova-3-general',
      voiceSelfHostedUrl: 'https://speech.example.test/v1',
      voiceSelfHostedModel: 'nvidia/parakeet-tdt-0.6b-v3',
      voiceLocalWhisperExecutable: '/opt/whisper-cli',
      voiceLocalWhisperModel: '/opt/ggml-model.bin',
    })
    expect(next).toMatchObject({
      theme: 'dark', locale: 'zh-CN', interfaceFontScale: 105, projectSortMode: 'alphabetical', sidebarOpen: false, inspectorOpen: true, showFileChangesPopup: false, checkoutStrategy: 'branch', keepRunningInBackground: true, launchAtLogin: true, terminalOpen: true,
      defaultInspectorTab: 'changes', browserHome: 'https://example.test/',
      browserAskForDownloads: false, terminalShell: '/bin/zsh', reduceMotion: true,
      showReasoningSummaries: false, showToolCalls: false, messageEnterAction: 'steer',
      runtimePaths: { omp: '/opt/omp' },
      telemetry: false, askUserEnabled: false, ompDisabledProviders: ['anthropic'],
      ompDisabledModels: ['anthropic/claude-sonnet-4'],
      lastSelectedModels: { omp: 'anthropic/claude-opus' },
      activeHarness: 'omp', ompApprovalMode: 'always-ask',
      voiceTranscriptionProvider: 'groq', voiceSelfHostedUrl: 'https://speech.example.test/v1', voiceSelfHostedModel: 'nvidia/parakeet-tdt-0.6b-v3',
    })
    expect(service.get()).toEqual(next)
  })

  it('leaves unrelated settings untouched on a partial patch', async () => {
    const service = makeService()
    const before = service.get()
    const next = await service.update({ theme: 'light' })
    expect(next.theme).toBe('light')
    expect(next.sidebarOpen).toBe(before.sidebarOpen)
    expect(next.terminalShell).toBe(before.terminalShell)
  })

  it('accepts every supported locale preference', async () => {
    const service = makeService()
    await expect(service.update({ locale: 'zh-TW' })).resolves.toMatchObject({ locale: 'zh-TW' })
    await expect(service.update({ locale: 'system' })).resolves.toMatchObject({ locale: 'system' })
  })

  it('rejects unknown keys, invalid enums, and malformed values without persisting', async () => {
    const service = makeService()
    const before = service.get()
    await expect(service.update({ nope: true })).rejects.toThrow(/not supported/)
    await expect(service.update('dark')).rejects.toThrow(/must be an object/)
    await expect(service.update({ theme: 'solarized' })).rejects.toThrow(/Invalid theme/)
    await expect(service.update({ locale: 'fr' })).rejects.toThrow(/Invalid locale/)
    await expect(service.update({ interfaceFontScale: 111 })).rejects.toThrow(/Invalid interface font scale/)
    await expect(service.update({ projectSortMode: 'invalid' })).rejects.toThrow(/Invalid project sort mode/)
    await expect(service.update({ defaultInspectorTab: 'tools' })).rejects.toThrow(/Invalid inspector tab/)
    await expect(service.update({ checkoutStrategy: 'folders' })).rejects.toThrow(/Invalid checkout strategy/)
    await expect(service.update({ messageEnterAction: 'send' })).rejects.toThrow(/Invalid message Enter action/)
    await expect(service.update({ runtimePaths: { prime: 'relative/prime-agent', omp: '' } })).rejects.toThrow(/not supported/)
    await expect(service.update({ runtimePaths: { omp: 'relative/omp', extra: '/tmp/evil' } })).rejects.toThrow(/not supported/)
    await expect(service.update({ enabledHarnesses: ['omp'] })).rejects.toThrow(/not supported/)
    await expect(service.update({ sidebarOpen: 'yes' })).rejects.toThrow(/must be a boolean/)
    await expect(service.update({ keepRunningInBackground: 'yes' })).rejects.toThrow(/must be a boolean/)
    await expect(service.update({ launchAtLogin: 1 })).rejects.toThrow(/must be a boolean/)
    await expect(service.update({ askUserEnabled: 'yes' })).rejects.toThrow(/must be a boolean/)
    await expect(service.update({ browserHome: 'javascript:alert(1)' })).rejects.toThrow(/scheme/)
    await expect(service.update({ disabledProviders: ['../evil'] })).rejects.toThrow(/not supported/)
    await expect(service.update({ disabledModels: ['../evil'] })).rejects.toThrow(/not supported/)
    await expect(service.update({ piDisabledProviders: ['../evil'] })).rejects.toThrow(/not supported/)
    await expect(service.update({ piDisabledModels: ['provider/model with spaces'] })).rejects.toThrow(/not supported/)
    await expect(service.update({ ompDisabledProviders: ['../evil'] })).rejects.toThrow(/provider ID/)
    await expect(service.update({ ompDisabledProviders: Array.from({ length: 257 }, () => 'p') })).rejects.toThrow(/bounded/)
    await expect(service.update({ ompDisabledModels: ['missing-slash'] })).rejects.toThrow(/model key/)
    await expect(service.update({ lastSelectedModels: { omp: 'missing-slash' } })).rejects.toThrow(/model key/)
    await expect(service.update({ lastSelectedModels: { omp: '', hostile: 'openai/gpt' } })).rejects.toThrow(/not supported/)
    await expect(service.update({ activeHarness: 'pi' })).rejects.toThrow(/Invalid harness/)
    await expect(service.update({ ompApprovalMode: 'sudo' })).rejects.toThrow(/Invalid OMP approval mode/)
    await expect(service.update({ voiceTranscriptionProvider: 'carrier-pigeon' })).rejects.toThrow(/Invalid voice transcription provider/)
    await expect(service.update({ voiceSelfHostedUrl: 'ftp://speech.example.test' })).rejects.toThrow(/scheme/)
    await expect(service.update({ voiceSelfHostedUrl: 'http://8.8.8.8:9000' })).rejects.toThrow(/use HTTPS for public hosts/)
    await expect(service.update({ voiceSelfHostedUrl: 'https://user:secret@speech.example.test' })).rejects.toThrow(/credentials/)
    await expect(service.update({ voiceSelfHostedUrl: 'https://speech.example.test/#secret' })).rejects.toThrow(/query or fragment/)
    await expect(service.update({ voiceSelfHostedModel: '../bad model' })).rejects.toThrow(/not valid/)
    expect(service.get()).toEqual(before)
  })

  it('accepts project sort modes', async () => {
    const service = makeService()
    await expect(service.update({ projectSortMode: 'alphabetical' })).resolves.toMatchObject({ projectSortMode: 'alphabetical' })
  })

  it('accepts loopback HTTP and remote HTTPS self-hosted transcription servers', async () => {
    const service = makeService()
    await expect(service.update({ voiceTranscriptionProvider: 'self-hosted', voiceSelfHostedUrl: 'http://127.0.0.1:9000', voiceSelfHostedModel: 'mlx-community/whisper-large-v3' })).resolves.toMatchObject({
      voiceTranscriptionProvider: 'self-hosted',
      voiceSelfHostedUrl: 'http://127.0.0.1:9000/',
      voiceSelfHostedModel: 'mlx-community/whisper-large-v3',
    })
    await expect(service.update({ voiceSelfHostedUrl: 'https://speech.example.test/v1' })).resolves.toMatchObject({ voiceSelfHostedUrl: 'https://speech.example.test/v1' })
  })

  it('dedupes ompDisabledProviders and pins the active harness', async () => {
    const service = makeService()
    const next = await service.update({ activeHarness: 'omp', ompDisabledProviders: ['openai', 'openai', 'anthropic'] })
    expect(next.activeHarness).toBe('omp')
    expect(next.ompDisabledProviders).toEqual(['openai', 'anthropic'])
  })

  it('rejects the removed legacy enabled-harness set instead of accepting it', async () => {
    const service = makeService()
    await expect(service.update({ enabledHarnesses: ['omp'] })).rejects.toThrow(/not supported/)
    await expect(service.update({ enabledHarnesses: ['prime', 'pi'] })).rejects.toThrow(/not supported/)
    expect(service.get().activeHarness).toBe('omp')
  })

  it('routes terminalShell through the injected shell validator', async () => {
    const validateShell = vi.fn(() => '/bin/bash')
    const service = makeService(validateShell)
    const next = await service.update({ terminalShell: '/bin/bash' })
    expect(validateShell).toHaveBeenCalledWith('/bin/bash')
    expect(next.terminalShell).toBe('/bin/bash')
    validateShell.mockImplementation(() => { throw new TypeError('shell is not allowed') })
    await expect(service.update({ terminalShell: '/tmp/evil' })).rejects.toThrow(/not allowed/)
  })

  it('reports the persisted previous and next settings to lifecycle integrations', async () => {
    const onDidUpdate = vi.fn()
    const service = makeService(undefined, onDidUpdate)
    const before = service.get()
    const next = await service.update({ keepRunningInBackground: true })
    expect(onDidUpdate).toHaveBeenCalledWith(before, next)
    expect(next.keepRunningInBackground).toBe(true)
  })
})
