import { describe, expect, it, vi } from 'vitest'
import { rpcRequestFrameBytes } from '../../electron/main/agent-rpc/limits'
import { fitPromptImagesForTransport, PromptImagesTooLargeError } from '../../src/lib/prompt-image-fit'
import { RPC_WRITE_FRAME_LIMIT_BYTES, rpcFrameBytes } from '../../src/lib/rpc-frame'
import type { PromptImage } from '../../src/types/api'

const image = (data: string, mimeType = 'image/png'): PromptImage => ({ type: 'image', data, mimeType })

describe('prompt image transport fitting', () => {
  it('leaves a frame that already fits unchanged', async () => {
    const images = [image('iVBORw0KGgo=')]
    const transcode = vi.fn()
    const fitted = await fitPromptImagesForTransport({ type: 'prompt', message: 'look', images }, transcode)
    expect(fitted).toBe(images)
    expect(transcode).not.toHaveBeenCalled()
  })

  it('re-encodes only the images that exceed the per-image share and stays under the frame limit', async () => {
    const huge = image('A'.repeat(3 * 1024 * 1024))
    const transcode = vi.fn(async (_image: PromptImage, maxBase64Chars: number) => image('A'.repeat(maxBase64Chars - 256), 'image/webp'))
    const fitted = await fitPromptImagesForTransport({ type: 'prompt', message: 'look', images: [huge] }, transcode)

    expect(transcode).toHaveBeenCalledTimes(1)
    expect(fitted[0]?.mimeType).toBe('image/webp')
    expect(rpcFrameBytes({ type: 'prompt', message: 'look', images: fitted })).toBeLessThanOrEqual(RPC_WRITE_FRAME_LIMIT_BYTES)
  })

  it('fits multiple images against the shared frame budget', async () => {
    const huge = image('A'.repeat(2 * 1024 * 1024))
    const transcode = vi.fn(async (_image: PromptImage, maxBase64Chars: number) => image('A'.repeat(maxBase64Chars - 512), 'image/webp'))
    const fitted = await fitPromptImagesForTransport({ type: 'steer', message: 'inspect both', images: [huge, huge] }, transcode)

    expect(transcode).toHaveBeenCalledTimes(2)
    expect(rpcFrameBytes({ type: 'steer', message: 'inspect both', images: fitted })).toBeLessThanOrEqual(RPC_WRITE_FRAME_LIMIT_BYTES)
  })

  it('fails visibly instead of sending when an image cannot be reduced enough', async () => {
    const huge = image('A'.repeat(3 * 1024 * 1024))
    await expect(fitPromptImagesForTransport({ type: 'prompt', message: 'look', images: [huge] }, async () => null))
      .rejects.toBeInstanceOf(PromptImagesTooLargeError)
  })

  it('accounts for the message when deciding whether the frame fits', async () => {
    const message = 'm'.repeat(1_500_000)
    const huge = image('A'.repeat(1_000_000))
    const transcode = vi.fn(async (_image: PromptImage, maxBase64Chars: number) => image('A'.repeat(maxBase64Chars - 256), 'image/webp'))
    const fitted = await fitPromptImagesForTransport({ type: 'prompt', message, images: [huge] }, transcode)

    expect(transcode).toHaveBeenCalledTimes(1)
    expect(rpcFrameBytes({ type: 'prompt', message, images: fitted })).toBeLessThanOrEqual(RPC_WRITE_FRAME_LIMIT_BYTES)
  })

  it('shares the exact frame calculation with the main process', () => {
    const command = { type: 'prompt', message: 'look', images: [image('iVBORw0KGgo=')] }
    expect(rpcRequestFrameBytes(command)).toBe(rpcFrameBytes(command))
  })
})
