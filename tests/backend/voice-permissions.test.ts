import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isAllowedRendererAudioPermission } from '../../electron/main/voice-permissions'

describe('renderer microphone permission', () => {
  const expected = 'omp-desktop://app/index.html'

  it('allows audio only for the exact main renderer document', () => {
    expect(isAllowedRendererAudioPermission(expected, expected, expected, ['audio'])).toBe(true)
    expect(isAllowedRendererAudioPermission(expected, expected, expected, ['audio', 'video'])).toBe(false)
    expect(isAllowedRendererAudioPermission(expected, expected, expected, ['video'])).toBe(false)
  })

  it('rejects remote, navigated, and missing renderer identities', () => {
    expect(isAllowedRendererAudioPermission('https://example.com/', expected, expected, ['audio'])).toBe(false)
    expect(isAllowedRendererAudioPermission(expected, 'https://example.com/', expected, ['audio'])).toBe(false)
    expect(isAllowedRendererAudioPermission(expected, expected, '', ['audio'])).toBe(false)
    expect(isAllowedRendererAudioPermission(expected, expected, expected, undefined)).toBe(false)
  })

  it('configures the macOS app and helper processes for microphone input', () => {
    const entitlement = '<key>com.apple.security.device.audio-input</key>'
    for (const path of ['build/entitlements.mac.plist', 'build/entitlements.mac.inherit.plist']) {
      const plist = readFileSync(path, 'utf8')
      expect(plist).toMatch(new RegExp(`${entitlement}\\s*<true\\s*/>`))
    }
  })
})
