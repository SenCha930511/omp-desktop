import type { Readable } from 'node:stream'
import { JsonlLineBuffer } from './jsonl-line-buffer'
import { SESSION_FILE_RECORD_LIMIT_BYTES } from './jsonl-limits'

const MAX_UNFRAMED_BYTES = SESSION_FILE_RECORD_LIMIT_BYTES

/** Strict JSONL parser: only LF is a delimiter; U+2028/U+2029 stay inside JSON strings. */
export async function* strictJsonLines(stream: Readable, maxUnframedBytes = MAX_UNFRAMED_BYTES): AsyncGenerator<string> {
  const buffer = new JsonlLineBuffer(maxUnframedBytes)
  for await (const raw of stream) {
    for (const line of buffer.push(raw as Buffer | string)) yield line
  }
  const finalLine = buffer.finish()
  if (finalLine !== undefined) yield finalLine
}

export class StrictJsonlDecoder {
  private readonly buffer: JsonlLineBuffer

  constructor(private readonly onLine: (line: string) => void, maxUnframedBytes = MAX_UNFRAMED_BYTES) {
    this.buffer = new JsonlLineBuffer(maxUnframedBytes, 'RPC')
  }

  push(chunk: Buffer | string): void {
    for (const line of this.buffer.push(chunk)) if (line) this.onLine(line)
  }

  end(): void {
    const finalLine = this.buffer.finish()
    if (finalLine !== undefined) this.onLine(finalLine)
  }
}
