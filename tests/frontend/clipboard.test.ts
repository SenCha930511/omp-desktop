// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeClipboardText } from '../../src/lib/clipboard'

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value })
}

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand)
  else Reflect.deleteProperty(document, 'execCommand')
})

describe('writeClipboardText', () => {
  it('prefers the async Clipboard API when it succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await writeClipboardText('hello clipboard')

    expect(writeText).toHaveBeenCalledWith('hello clipboard')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to execCommand("copy") when the Clipboard API rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'))
    setClipboard({ writeText })
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await writeClipboardText('fallback text')

    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('falls back to execCommand("copy") when the Clipboard API is unavailable', async () => {
    setClipboard(undefined)
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await writeClipboardText('legacy text')

    expect(execCommand).toHaveBeenCalledWith('copy')
    // The fallback scratch textarea must not be left in the document.
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('throws "Copy is unavailable" when the fallback copy command fails', async () => {
    setClipboard(undefined)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })

    await expect(writeClipboardText('uncopyable')).rejects.toThrow('Copy is unavailable')
  })
})
