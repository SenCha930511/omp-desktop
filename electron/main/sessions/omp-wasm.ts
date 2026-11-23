import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BucketedMetadataAccumulator } from './bucketed'

interface WasmMemory {
  readonly buffer: ArrayBuffer
}

interface OmpWasmExports {
  memory: WasmMemory
  alloc(length: number): number
  dealloc(pointer: number, length: number): void
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
  result_ptr(): number
  result_len(): number
  clear_result(): void
}

export type OmpWasmResult =
  | { status: 'ok'; accumulator: BucketedMetadataAccumulator }
  | { status: 'fallback'; reason: string }
  | { status: 'error'; reason: string }

export interface OmpWasmDefaults {
  id: string
  createdAt: string
  updatedAt: string
}

const DEFAULT_WASM_NAME = 'omp-jsonl-core.wasm'
let instancePromise: Promise<OmpWasmExports | null> | undefined

export function ompWasmEnabled(): boolean {
  return process.env.OMP_DESKTOP_DISABLE_WASM !== '1'
}

function wasmCandidates(): string[] {
  const candidates: string[] = []
  const override = process.env.OMP_DESKTOP_WASM_PATH
  if (override) candidates.push(override)
  if (typeof __dirname === 'string') candidates.push(join(__dirname, DEFAULT_WASM_NAME))
  candidates.push(join(process.cwd(), 'out', 'main', DEFAULT_WASM_NAME))
  candidates.push(join(process.cwd(), 'assets', 'wasm', DEFAULT_WASM_NAME))
  return [...new Set(candidates)]
}

async function loadInstance(): Promise<OmpWasmExports | null> {
  for (const candidate of wasmCandidates()) {
    if (!existsSync(candidate)) continue
    try {
      const bytes = readFileSync(candidate)
      const { instance } = await WebAssembly.instantiate(bytes, {})
      const exports = instance.exports as unknown as OmpWasmExports
      if (exports.memory && typeof exports.memory.buffer === 'object') return exports
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

function writeBytes(exports: OmpWasmExports, bytes: Uint8Array): { pointer: number; length: number } {
  if (bytes.length === 0) return { pointer: 0, length: 0 }
  const pointer = exports.alloc(bytes.length)
  if (pointer === 0) throw new Error('WASM allocation failed')
  new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes)
  return { pointer, length: bytes.length }
}

function writeString(exports: OmpWasmExports, value: string): { pointer: number; length: number } {
  return writeBytes(exports, Buffer.from(value, 'utf8'))
}

function readResult(exports: OmpWasmExports, length: number): string {
  if (length === 0) return ''
  const pointer = exports.result_ptr()
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

export async function scanOmpMetadataBytes(bytes: Uint8Array, defaults: OmpWasmDefaults, titleSlotLength = 0): Promise<OmpWasmResult> {
  if (!ompWasmEnabled()) return { status: 'fallback', reason: 'disabled' }
  const exports = await instance()
  if (!exports) return { status: 'fallback', reason: 'unavailable' }
  const input = writeBytes(exports, bytes)
  const id = writeString(exports, defaults.id)
  const createdAt = writeString(exports, defaults.createdAt)
  const updatedAt = writeString(exports, defaults.updatedAt)
  try {
    const length = exports.scan(input.pointer, input.length, id.pointer, id.length, createdAt.pointer, createdAt.length, updatedAt.pointer, updatedAt.length, titleSlotLength)
    const parsed: unknown = JSON.parse(readResult(exports, length))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'fallback', reason: 'shape' }
    const raw = parsed as Record<string, unknown>
    if (raw.status === 'ok') {
      const accumulator = parseAccumulator(raw.accumulator)
      return accumulator ? { status: 'ok', accumulator } : { status: 'fallback', reason: 'accumulator' }
    }
    if (raw.status === 'error' && typeof raw.reason === 'string') return { status: 'error', reason: raw.reason }
    return { status: 'fallback', reason: typeof raw.reason === 'string' ? raw.reason : 'status' }
  } catch {
    return { status: 'fallback', reason: 'exception' }
  } finally {
    try {
      exports.clear_result()
      exports.dealloc(input.pointer, input.length)
      exports.dealloc(id.pointer, id.length)
      exports.dealloc(createdAt.pointer, createdAt.length)
      exports.dealloc(updatedAt.pointer, updatedAt.length)
    } catch {
      // A trapped instance is already unusable; the next call falls back.
    }
  }
}
