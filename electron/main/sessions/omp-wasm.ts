import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TranscriptMessage } from '../../../src/types/api'
import type { BucketedMetadataAccumulator } from './bucketed'

interface WasmMemory {
  readonly buffer: ArrayBuffer
}

interface OmpWasmExports {
  memory: WasmMemory
  alloc(length: number): number
  dealloc(pointer: number, length: number): void
  io_buf_ptr(): number
  io_buf_cap(): number
  scan(
    bytesPointer: number,
    bytesLength: number,
    idPointer: number,
    idLength: number,
    createdPointer: number,
    createdLength: number,
    updatedPointer: number,
    updatedLength: number,
    titleSlotLength: number,
  ): number
  meta_begin(
    idPointer: number,
    idLength: number,
    createdPointer: number,
    createdLength: number,
    updatedPointer: number,
    updatedLength: number,
    titleSlotLength: number,
  ): number
  meta_chunk(length: number): number
  meta_finish(): number
  meta_reset(): void
  transcript_begin(dialectMode: number): number
  transcript_chunk(length: number): number
  transcript_finish(): number
  transcript_reset(): void
  result_ptr(): number
  result_len(): number
  clear_result(): void
}

export type OmpWasmResult =
  | { status: 'ok'; accumulator: BucketedMetadataAccumulator }
  | { status: 'fallback'; reason: string }
  | { status: 'error'; reason: string }

export type OmpTranscriptWasmResult =
  | { status: 'ok'; messages: TranscriptMessage[] }
  | { status: 'fallback'; reason: string }
  | { status: 'error'; reason: string }

export interface OmpWasmDefaults {
  id: string
  createdAt: string
  updatedAt: string
}

const DEFAULT_WASM_NAME = 'omp-jsonl-core.wasm'
const MAX_TRANSCRIPT_FILE_BYTES = 256 * 1024 * 1024
const STREAM_CHUNK_BYTES = 256 * 1024
const REQUIRED_EXPORTS = [
  'alloc',
  'dealloc',
  'io_buf_ptr',
  'io_buf_cap',
  'scan',
  'meta_begin',
  'meta_chunk',
  'meta_finish',
  'meta_reset',
  'transcript_begin',
  'transcript_chunk',
  'transcript_finish',
  'transcript_reset',
  'result_ptr',
  'result_len',
  'clear_result',
] as const

let instancePromise: Promise<OmpWasmExports | null> | undefined
let metaStreamLock: Promise<void> = Promise.resolve()
let transcriptStreamLock: Promise<void> = Promise.resolve()

async function withLock<T>(kind: 'meta' | 'transcript', run: () => Promise<T>): Promise<T> {
  const previous = kind === 'meta' ? metaStreamLock : transcriptStreamLock
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  if (kind === 'meta') metaStreamLock = gate
  else transcriptStreamLock = gate
  await previous
  try {
    return await run()
  } finally {
    release()
  }
}

export function ompWasmEnabled(): boolean {
  return process.env.OMP_DESKTOP_DISABLE_WASM !== '1'
}

function wasmCandidates(): string[] {
  const override = process.env.OMP_DESKTOP_WASM_PATH
  if (override) return [override]
  const candidates: string[] = []
  if (typeof __dirname === 'string') candidates.push(join(__dirname, DEFAULT_WASM_NAME))
  candidates.push(join(process.cwd(), 'out', 'main', DEFAULT_WASM_NAME))
  candidates.push(join(process.cwd(), 'assets', 'wasm', DEFAULT_WASM_NAME))
  return [...new Set(candidates)]
}

function isOmpWasmExports(value: unknown): value is OmpWasmExports {
  if (!value || typeof value !== 'object') return false
  const memory = Reflect.get(value, 'memory')
  if (!memory || typeof memory !== 'object' || typeof Reflect.get(memory, 'buffer') !== 'object') return false
  return REQUIRED_EXPORTS.every((name) => typeof Reflect.get(value, name) === 'function')
}

async function loadInstance(): Promise<OmpWasmExports | null> {
  for (const candidate of wasmCandidates()) {
    if (!existsSync(candidate)) continue
    try {
      const bytes = readFileSync(candidate)
      const { instance } = await WebAssembly.instantiate(bytes, {})
      if (isOmpWasmExports(instance.exports)) return instance.exports
    } catch {
      // Try the next candidate. A broken artifact must never take the app down.
    }
  }
  return null
}

function instance(): Promise<OmpWasmExports | null> {
  instancePromise ??= loadInstance()
  return instancePromise
}

export function resetOmpWasmForTests(): void {
  instancePromise = undefined
}

interface OmpWasmCleanup {
  clear_result(): void
  dealloc(pointer: number, length: number): void
}

export function releaseOmpWasmAllocations(exports: OmpWasmCleanup, allocations: ReadonlyArray<{ pointer: number; length: number }>): void {
  try {
    exports.clear_result()
  } catch {
    // Keep freeing the independently allocated arguments.
  }
  for (const allocation of allocations) {
    try {
      exports.dealloc(allocation.pointer, allocation.length)
    } catch {
      // A trapped free must not skip the remaining allocations.
    }
  }
}

function writeBytes(exports: OmpWasmExports, bytes: Uint8Array): { pointer: number; length: number } {
  if (bytes.length === 0) return { pointer: 0, length: 0 }
  const pointer = exports.alloc(bytes.length)
  if (pointer === 0) throw new Error('WASM allocation failed')
  try {
    new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes)
  } catch (error) {
    exports.dealloc(pointer, bytes.length)
    throw error
  }
  return { pointer, length: bytes.length }
}

function writeString(exports: OmpWasmExports, value: string): { pointer: number; length: number } {
  return writeBytes(exports, Buffer.from(value, 'utf8'))
}

function writeIoSlice(exports: OmpWasmExports, slice: Uint8Array): void {
  if (slice.length === 0) return
  const pointer = exports.io_buf_ptr()
  new Uint8Array(exports.memory.buffer, pointer, slice.length).set(slice)
}

function readResult(exports: OmpWasmExports, length: number): string {
  if (length === 0) return ''
  const pointer = exports.result_ptr()
  if (pointer === 0) throw new Error('WASM result pointer is missing')
  return Buffer.from(new Uint8Array(exports.memory.buffer, pointer, length)).toString('utf8')
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((item): item is string => typeof item === 'string') ? value : undefined
}

function parseAccumulator(value: unknown): BucketedMetadataAccumulator | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.projectPath !== 'string' || typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') return undefined
  if (typeof raw.sawRecordTimestamp !== 'boolean' || typeof raw.firstUser !== 'string' || typeof raw.preview !== 'string') return undefined
  if (typeof raw.records !== 'number' || !Number.isSafeInteger(raw.records) || raw.records < 0) return undefined
  const previousSessionFiles = stringArray(raw.previousSessionFiles)
  const lastUserTexts = stringArray(raw.lastUserTexts)
  if (!previousSessionFiles || !lastUserTexts) return undefined
  return {
    id: raw.id,
    projectPath: raw.projectPath,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    sawRecordTimestamp: raw.sawRecordTimestamp,
    lastUserMessageAt: optionalString(raw.lastUserMessageAt),
    model: optionalString(raw.model),
    provider: optionalString(raw.provider),
    thinkingLevel: optionalString(raw.thinkingLevel),
    displayName: optionalString(raw.displayName),
    parentSession: optionalString(raw.parentSession),
    previousSessionFiles,
    firstUser: raw.firstUser,
    preview: raw.preview,
    lastUserTexts,
    lastRole: optionalString(raw.lastRole),
    stopReason: optionalString(raw.stopReason),
    records: raw.records,
  }
}

function parseMetadataResult(parsed: unknown): OmpWasmResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'fallback', reason: 'shape' }
  const raw = parsed as Record<string, unknown>
  if (raw.status === 'ok') {
    const accumulator = parseAccumulator(raw.accumulator)
    return accumulator ? { status: 'ok', accumulator } : { status: 'fallback', reason: 'accumulator' }
  }
  if (raw.status === 'error' && typeof raw.reason === 'string') return { status: 'error', reason: raw.reason }
  return { status: 'fallback', reason: typeof raw.reason === 'string' ? raw.reason : 'status' }
}

function beginMetaStream(exports: OmpWasmExports, defaults: OmpWasmDefaults, titleSlotLength: number): number {
  const allocations: Array<{ pointer: number; length: number }> = []
  try {
    const id = writeString(exports, defaults.id)
    allocations.push(id)
    const createdAt = writeString(exports, defaults.createdAt)
    allocations.push(createdAt)
    const updatedAt = writeString(exports, defaults.updatedAt)
    allocations.push(updatedAt)
    return exports.meta_begin(id.pointer, id.length, createdAt.pointer, createdAt.length, updatedAt.pointer, updatedAt.length, titleSlotLength)
  } finally {
    for (const allocation of allocations) {
      try { exports.dealloc(allocation.pointer, allocation.length) } catch { /* ignore */ }
    }
  }
}

export async function scanOmpMetadataBytes(bytes: Uint8Array, defaults: OmpWasmDefaults, titleSlotLength = 0): Promise<OmpWasmResult> {
  if (!ompWasmEnabled()) return { status: 'fallback', reason: 'disabled' }
  const exports = await instance()
  if (!exports) return { status: 'fallback', reason: 'unavailable' }

  const ioCap = exports.io_buf_cap()
  if (bytes.length <= ioCap) {
    const allocations: Array<{ pointer: number; length: number }> = []
    try {
      let inputPointer = 0
      if (bytes.length > 0) {
        inputPointer = exports.io_buf_ptr()
        new Uint8Array(exports.memory.buffer, inputPointer, bytes.length).set(bytes)
      }
      const id = writeString(exports, defaults.id)
      allocations.push(id)
      const createdAt = writeString(exports, defaults.createdAt)
      allocations.push(createdAt)
      const updatedAt = writeString(exports, defaults.updatedAt)
      allocations.push(updatedAt)
      const length = exports.scan(inputPointer, bytes.length, id.pointer, id.length, createdAt.pointer, createdAt.length, updatedAt.pointer, updatedAt.length, titleSlotLength)
      return parseMetadataResult(JSON.parse(readResult(exports, length)))
    } catch {
      return { status: 'fallback', reason: 'exception' }
    } finally {
      releaseOmpWasmAllocations(exports, allocations)
    }
  }

  return withLock('meta', async () => {
    try {
      const beginStatus = beginMetaStream(exports, defaults, titleSlotLength)
      if (beginStatus !== 0) return parseMetadataResult(JSON.parse(readResult(exports, exports.result_len())))
      for (let offset = 0; offset < bytes.length; offset += ioCap) {
        const slice = bytes.subarray(offset, Math.min(bytes.length, offset + ioCap))
        writeIoSlice(exports, slice)
        const status = exports.meta_chunk(slice.length)
        if (status !== 0) return parseMetadataResult(JSON.parse(readResult(exports, exports.result_len())))
      }
      const length = exports.meta_finish()
      return parseMetadataResult(JSON.parse(readResult(exports, length)))
    } catch {
      return { status: 'fallback', reason: 'exception' }
    } finally {
      try { exports.meta_reset() } catch { /* ignore */ }
      try { exports.clear_result() } catch { /* ignore */ }
    }
  })
}

export async function scanOmpMetadataStream(filePath: string, maxBytes: number, defaults: OmpWasmDefaults, titleSlotLength = 0): Promise<OmpWasmResult> {
  if (!ompWasmEnabled()) return { status: 'fallback', reason: 'disabled' }
  const exports = await instance()
  if (!exports) return { status: 'fallback', reason: 'unavailable' }

  return withLock('meta', async () => {
    const ioCap = exports.io_buf_cap()
    const stream = createReadStream(filePath, { highWaterMark: Math.min(STREAM_CHUNK_BYTES, ioCap) })
    try {
      const beginStatus = beginMetaStream(exports, defaults, titleSlotLength)
      if (beginStatus !== 0) return parseMetadataResult(JSON.parse(readResult(exports, exports.result_len())))
      let total = 0
      for await (const rawChunk of stream) {
        const chunk = typeof rawChunk === 'string' ? Buffer.from(rawChunk, 'utf8') : rawChunk as Buffer
        total += chunk.length
        if (total > maxBytes) return { status: 'fallback', reason: 'too-large' }
        for (let offset = 0; offset < chunk.length; offset += ioCap) {
          const slice = chunk.subarray(offset, Math.min(chunk.length, offset + ioCap))
          writeIoSlice(exports, slice)
          const status = exports.meta_chunk(slice.length)
          if (status !== 0) return parseMetadataResult(JSON.parse(readResult(exports, exports.result_len())))
        }
      }
      const length = exports.meta_finish()
      return parseMetadataResult(JSON.parse(readResult(exports, length)))
    } catch {
      return { status: 'fallback', reason: 'exception' }
    } finally {
      stream.destroy()
      try { exports.meta_reset() } catch { /* ignore */ }
      try { exports.clear_result() } catch { /* ignore */ }
    }
  })
}

function parseTranscriptWasmResult(parsed: unknown): OmpTranscriptWasmResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'fallback', reason: 'shape' }
  const raw = parsed as Record<string, unknown>
  if (raw.status === 'ok' && Array.isArray(raw.messages)) {
    return { status: 'ok', messages: raw.messages as TranscriptMessage[] }
  }
  if (raw.status === 'error' && typeof raw.reason === 'string') return { status: 'error', reason: raw.reason }
  return { status: 'fallback', reason: typeof raw.reason === 'string' ? raw.reason : 'status' }
}

export async function readTranscriptTailWithWasm(filePath: string, dialectMode: 0 | 1): Promise<OmpTranscriptWasmResult> {
  if (!ompWasmEnabled()) return { status: 'fallback', reason: 'disabled' }
  const exports = await instance()
  if (!exports) return { status: 'fallback', reason: 'unavailable' }

  return withLock('transcript', async () => {
    const ioCap = exports.io_buf_cap()
    const stream = createReadStream(filePath, { highWaterMark: Math.min(STREAM_CHUNK_BYTES, ioCap) })
    try {
      if (exports.transcript_begin(dialectMode) !== 0) {
        return parseTranscriptWasmResult(JSON.parse(readResult(exports, exports.result_len())))
      }
      let total = 0
      for await (const rawChunk of stream) {
        const chunk = typeof rawChunk === 'string' ? Buffer.from(rawChunk, 'utf8') : rawChunk as Buffer
        total += chunk.length
        if (total > MAX_TRANSCRIPT_FILE_BYTES) return { status: 'error', reason: 'file-too-large' }
        for (let offset = 0; offset < chunk.length; offset += ioCap) {
          const slice = chunk.subarray(offset, Math.min(chunk.length, offset + ioCap))
          writeIoSlice(exports, slice)
          const status = exports.transcript_chunk(slice.length)
          if (status !== 0) return parseTranscriptWasmResult(JSON.parse(readResult(exports, exports.result_len())))
        }
      }
      const length = exports.transcript_finish()
      return parseTranscriptWasmResult(JSON.parse(readResult(exports, length)))
    } catch {
      return { status: 'fallback', reason: 'exception' }
    } finally {
      stream.destroy()
      try { exports.transcript_reset() } catch { /* ignore */ }
      try { exports.clear_result() } catch { /* ignore */ }
    }
  })
}
