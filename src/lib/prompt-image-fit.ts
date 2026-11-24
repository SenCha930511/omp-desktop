import type { PromptImage } from '@/types/api'
import { RPC_WRITE_FRAME_LIMIT_BYTES, rpcFrameBytes } from './rpc-frame'

export type PromptImageCommandType = 'prompt' | 'steer' | 'follow_up'

export interface FitPromptImagesInput {
  type: PromptImageCommandType
  message: string
  images: PromptImage[]
}

/** Injectable seam for unit tests; production uses the canvas implementation below. */
export type PromptImageTranscoder = (image: PromptImage, maxBase64Chars: number) => Promise<PromptImage | null>

export class PromptImagesTooLargeError extends Error {
  constructor() {
    super('The attached images exceed the RPC transport limit')
    this.name = 'PromptImagesTooLargeError'
  }
}

const SAFETY_BYTES = 2048
const MIN_IMAGE_BASE64_CHARS = 32 * 1024
const MAX_CANVAS_EDGE = 4096
const SCALES = [1, 0.85, 0.7, 0.55, 0.42, 0.32, 0.24]
const QUALITIES = [0.92, 0.84, 0.76, 0.68, 0.6, 0.52]

function frameBytes(input: FitPromptImagesInput, images: PromptImage[]): number {
  return rpcFrameBytes({ type: input.type, message: input.message, images })
}

/**
 * Fit prompt images into one RPC write frame. Images under the budget stay
 * byte-for-byte unchanged; only the images that would overflow the transport
 * are re-encoded. The main-process frame guard remains the final authority.
 */
export function fitPromptImagesForTransport(
  input: FitPromptImagesInput,
  transcode: PromptImageTranscoder = transcodeImageForBudget,
): PromptImage[] | Promise<PromptImage[]> {
  if (frameBytes(input, input.images) <= RPC_WRITE_FRAME_LIMIT_BYTES - SAFETY_BYTES) return input.images
  return fitLargePromptImages(input, transcode)
}

async function fitLargePromptImages(input: FitPromptImagesInput, transcode: PromptImageTranscoder): Promise<PromptImage[]> {
  if (input.images.length === 0) throw new PromptImagesTooLargeError()

  const emptyFrameBytes = frameBytes(input, [])
  let perImageChars = Math.floor((RPC_WRITE_FRAME_LIMIT_BYTES - SAFETY_BYTES - emptyFrameBytes) / input.images.length)
  let working = [...input.images]

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (perImageChars < MIN_IMAGE_BASE64_CHARS) throw new PromptImagesTooLargeError()
    let changed = false
    for (let index = 0; index < working.length; index += 1) {
      const image = working[index]!
      if (image.data.length <= perImageChars) continue
      const next = await transcode(image, perImageChars)
      if (!next || next.data.length > perImageChars) throw new PromptImagesTooLargeError()
      working[index] = next
      changed = true
    }
    if (frameBytes(input, working) <= RPC_WRITE_FRAME_LIMIT_BYTES - SAFETY_BYTES) return working
    if (!changed) throw new PromptImagesTooLargeError()
    perImageChars = Math.floor(perImageChars * 0.75)
  }
  throw new PromptImagesTooLargeError()
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return window.btoa(binary)
}

function bytesFromBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = window.atob(data)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality))
}

/** Browser-only fallback used by the production call site. */
export async function transcodeImageForBudget(image: PromptImage, maxBase64Chars: number): Promise<PromptImage | null> {
  // Canvas can only encode a still frame; reject an oversized animation instead
  // of silently dropping its frames.
  if (image.mimeType === 'image/gif') return null
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null
  const bitmap = await createImageBitmap(new Blob([bytesFromBase64(image.data)], { type: image.mimeType }))
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    return null
  }
  const initialScale = Math.min(1, MAX_CANVAS_EDGE / Math.max(bitmap.width, bitmap.height))
  const outputType = image.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/webp'
  try {
    for (const scale of SCALES) {
      const width = Math.max(1, Math.round(bitmap.width * initialScale * scale))
      const height = Math.max(1, Math.round(bitmap.height * initialScale * scale))
      canvas.width = width
      canvas.height = height
      context.clearRect(0, 0, width, height)
      context.drawImage(bitmap, 0, 0, width, height)
      for (const quality of QUALITIES) {
        const blob = await canvasToBlob(canvas, outputType, quality)
        if (!blob) continue
        const data = base64FromBytes(new Uint8Array(await blob.arrayBuffer()))
        if (data.length <= maxBase64Chars) return { type: 'image', mimeType: outputType, data }
      }
    }
    return null
  } finally {
    bitmap.close()
  }
}
