import { SESSION_FILE_RECORD_LIMIT_BYTES } from './jsonl-limits'

/** Owns unfinished fragments; decoding and prefix assembly happen once per complete line. */
export class JsonlLineBuffer {
  private fragments: Buffer[] = []
  private bytes = 0

  constructor(private readonly maxBytes = SESSION_FILE_RECORD_LIMIT_BYTES, private readonly recordName = 'JSONL') {}

  get byteLength(): number { return this.bytes }

  /** Speculative metadata reads must not commit a partial record or mutate the retained fragment list. */
  clone(): JsonlLineBuffer {
    const copy = new JsonlLineBuffer(this.maxBytes, this.recordName)
    copy.fragments = this.fragments.slice()
    copy.bytes = this.bytes
    return copy
  }

  *push(chunk: Buffer | string): Generator<string> {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    let start = 0
    while (true) {
      const newline = bytes.indexOf(0x0a, start)
      if (newline < 0) break
      const fragment = bytes.subarray(start, newline)
      this.checkSize(fragment)
      const line = this.fragments.length ? Buffer.concat([...this.fragments, fragment], this.bytes + fragment.length) : fragment
      this.fragments = []
      this.bytes = 0
      yield this.decode(line)
      start = newline + 1
    }
    const rest = bytes.subarray(start)
    if (rest.length) {
      this.checkSize(rest)
      // Own only the suffix so a tiny partial record cannot retain a large input chunk.
      this.fragments.push(Buffer.from(rest))
      this.bytes += rest.length
    }
  }

  snapshot(): string | undefined {
    if (!this.bytes) return undefined
    return this.decode(this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments, this.bytes))
  }

  finish(): string | undefined {
    const line = this.snapshot()
    this.fragments = []
    this.bytes = 0
    return line
  }

  private checkSize(fragment: Buffer): void {
    const size = this.bytes + fragment.length
    const last = fragment.length ? fragment.at(-1) : this.fragments.at(-1)?.at(-1)
    // A trailing CR is framing, including when CR and LF arrive in separate chunks.
    if (size > this.maxBytes + Number(last === 0x0d)) throw new Error(`${this.recordName} record exceeded the maximum frame size`)
  }

  private decode(line: Buffer): string {
    return line.toString('utf8', 0, line.at(-1) === 0x0d ? line.length - 1 : line.length)
  }
}
