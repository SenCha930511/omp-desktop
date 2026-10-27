import { describe, expect, it } from 'vitest'
import { bashResultFailed, bashResultStatusText, buildBashResultMessage, readBashResult } from '../../src/lib/bash-result'
import { translate, type MessageKey } from '../../src/lib/i18n'

const t = (key: MessageKey, values?: Record<string, string | number>) => translate('en', key, values)

describe('readBashResult', () => {
  it('parses a complete upstream BashResult', () => {
    const result = readBashResult({
      output: 'hello', cancelled: false, truncated: true, timedOut: false,
      totalLines: 500, totalBytes: 20_000, outputLines: 100, outputBytes: 4_000,
      exitCode: 0, artifactId: 'art-1', artifactElidedBytes: 16_000,
      images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
    })
    expect(result).toEqual({
      output: 'hello', cancelled: false, truncated: true, timedOut: false,
      exitCode: 0, artifactId: 'art-1', artifactElidedBytes: 16_000,
      images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
    })
  })

  it('strips ANSI control sequences from terminal output', () => {
    expect(readBashResult({ output: '\u001b[31mred\u001b[0m' }).output).toBe('red')
    expect(readBashResult({ output: 'a\bb' }).output).toBe('b')
  })

  it('degrades malformed fields instead of throwing', () => {
    expect(readBashResult(undefined)).toEqual({ output: '', cancelled: false, truncated: false, timedOut: false, images: [] })
    expect(readBashResult({ output: 42, cancelled: 'yes', exitCode: 'x', images: [{ data: '' }, { mimeType: 1 }] })).toEqual({
      output: '', cancelled: false, truncated: false, timedOut: false, images: [],
    })
  })
})

describe('bashResultStatusText / bashResultFailed', () => {
  it('reports every state flag', () => {
    const cancelled = readBashResult({ output: '', cancelled: true })
    expect(bashResultFailed(cancelled)).toBe(true)
    expect(bashResultStatusText(cancelled, t)).toBe('[cancelled]')

    const failed = readBashResult({ output: 'boom', exitCode: 3, truncated: true })
    expect(bashResultFailed(failed)).toBe(true)
    expect(bashResultStatusText(failed, t)).toBe('[exit code 3] · [output truncated]')

    const timedOut = readBashResult({ output: '', timedOut: true })
    expect(bashResultStatusText(timedOut, t)).toBe('[timed out]')

    const artifact = readBashResult({ output: '', artifactId: 'art-9', artifactElidedBytes: 1_000 })
    expect(bashResultStatusText(artifact, t)).toBe('[full output saved to artifact art-9; 1000 bytes elided]')

    const ok = readBashResult({ output: 'fine', exitCode: 0 })
    expect(bashResultFailed(ok)).toBe(false)
    expect(bashResultStatusText(ok, t)).toBe('')
  })
})

describe('buildBashResultMessage', () => {
  it('builds a tool row matching the history bashExecution shape', () => {
    const message = buildBashResultMessage('bash-1', 'ls', readBashResult({ output: 'out', exitCode: 0 }), t, 1_700_000_000_000)
    expect(message.id).toBe('bash-1')
    expect(message.role).toBe('tool')
    expect(message.parts[0]).toEqual({ type: 'toolCall', id: 'bash-1', name: 'bash', args: { command: 'ls' } })
    expect(message.parts[1]).toEqual({ type: 'toolResult', name: 'bash', text: 'out', isError: false })
  })

  it('appends the status line and marks failures', () => {
    const message = buildBashResultMessage('bash-2', 'false', readBashResult({ output: '', exitCode: 1 }), t)
    expect(message.parts[1]).toMatchObject({ type: 'toolResult', isError: true })
    expect(message.parts[1]).toMatchObject({ text: '[exit code 1]' })
  })

  it('routes non-text image output into image parts', () => {
    const message = buildBashResultMessage('bash-3', 'shot', readBashResult({
      output: '', images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
    }), t)
    expect(message.parts[2]).toEqual({ type: 'image', partId: 'bash-3-image-0', data: 'aW1hZ2U=', mimeType: 'image/png' })
  })
})
