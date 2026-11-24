const RPC_REQUEST_ID_PLACEHOLDER = '00000000-0000-0000-0000-000000000000'

/** Frames OMP Desktop writes to an agent RPC child's stdin. */
export const RPC_WRITE_FRAME_LIMIT_BYTES = 2 * 1024 * 1024

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null

function utf8ByteLength(value: string): number {
  if (encoder) return encoder.encode(value).length
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

/** Byte count of the JSONL request frame, including the newline. */
export function rpcFrameBytes(command: Record<string, unknown>): number {
  return utf8ByteLength(`${JSON.stringify({ ...command, id: RPC_REQUEST_ID_PLACEHOLDER })}\n`)
}
