import { appendFileSync, createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOmpSessionMetadataReader } from '../../electron/main/sessions/omp'
import { nodeMetadataReaderIo } from '../../electron/main/sessions/metadata'
import { releaseOmpWasmAllocations, resetOmpWasmForTests, scanOmpMetadataBytes } from '../../electron/main/sessions/omp-wasm'

const wasmPath = resolve('assets/wasm/omp-jsonl-core.wasm')
const defaults = { id: 'fallback-id', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

function line(value: unknown): string {
  return JSON.stringify(value)
}

const directories: string[] = []

beforeEach(() => {
  process.env.OMP_DESKTOP_WASM_PATH = wasmPath
  delete process.env.OMP_DESKTOP_DISABLE_WASM
})

afterEach(() => {
  process.env.OMP_DESKTOP_WASM_PATH = wasmPath
  delete process.env.OMP_DESKTOP_DISABLE_WASM
  resetOmpWasmForTests()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function writeWasmFile(bytes: number[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'omp-desktop-wasm-artifact-'))
  directories.push(directory)
  const file = join(directory, 'fake.wasm')
  writeFileSync(file, Buffer.from(bytes))
  return file
}

function titleSlot(title: string): string {
  const base = JSON.stringify({ type: 'title', title, pad: '' })
  return JSON.stringify({ type: 'title', title, pad: ' '.repeat(255 - Buffer.byteLength(base)) })
}

describe('OMP metadata WASM scanner', () => {
  it('matches the TS accumulator fields for a representative session', async () => {
    const lines = [
      line({ type: 'session', id: 's1', cwd: '/p', timestamp: '2026-01-01T00:00:00.000Z', parentSession: 'parent', previousSessionFiles: ['/old', '/old', '/other'] }),
      line({ type: 'model_change', model: 'openai/gpt-5', role: 'default' }),
      line({ type: 'thinking_level_change', thinkingLevel: 'high' }),
      line({ type: 'title_change', title: 'My title' }),
      line({ type: 'message', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] } }),
      line({ type: 'message', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: 'done', stopReason: 'end' } }),
    ]
    const tail = `${lines.join('\n')}\n`

    const result = await scanOmpMetadataBytes(Buffer.from(tail), defaults)
    expect(result).toEqual({
      status: 'ok',
      accumulator: {
        id: 's1',
        projectPath: '/p',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
        sawRecordTimestamp: true,
        lastUserMessageAt: '2026-01-01T00:00:01.000Z',
        model: 'gpt-5',
        provider: 'openai',
        thinkingLevel: 'high',
        displayName: 'My title',
        parentSession: 'parent',
        previousSessionFiles: ['/old', '/other'],
        firstUser: 'hello\nworld',
        preview: 'done',
        lastUserTexts: ['hello\nworld'],
        lastRole: 'assistant',
        stopReason: 'end',
        records: 6,
      },
    })
  })

  it('falls back when a timestamp is outside the RFC3339 fast path', async () => {
    const tail = `${line({ type: 'session', id: 's1', timestamp: '2026-01-01' })}\n`
    await expect(scanOmpMetadataBytes(Buffer.from(tail), defaults)).resolves.toMatchObject({ status: 'fallback' })
  })

  it('falls back on malformed JSON so the TS reader can skip it', async () => {
    const tail = `${line({ type: 'session', id: 's1' })}\nnot json\n${line({ type: 'message', message: { role: 'user', content: 'hello' } })}\n`
    await expect(scanOmpMetadataBytes(Buffer.from(tail), defaults)).resolves.toMatchObject({ status: 'fallback' })
  })

  it('returns a fallback when UTF-16 truncation would split a surrogate pair', async () => {
    const text = `${'a'.repeat(1376)}😀${'b'.repeat(2719)}`
    const tail = `${line({ type: 'message', message: { role: 'user', content: text } })}\n`
    await expect(scanOmpMetadataBytes(Buffer.from(tail), defaults)).resolves.toMatchObject({ status: 'fallback' })
  })

  it('accepts an empty input without a null slice', async () => {
    const result = await scanOmpMetadataBytes(Buffer.alloc(0), defaults)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('Expected an accumulator')
    expect(result.accumulator.id).toBe('fallback-id')
    expect(result.accumulator.records).toBe(0)
  })

  it('falls back when the artifact has no scanner exports', async () => {
    process.env.OMP_DESKTOP_WASM_PATH = writeWasmFile([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x00, 0x01])
    resetOmpWasmForTests()
    await expect(scanOmpMetadataBytes(Buffer.from(''), defaults)).resolves.toEqual({ status: 'fallback', reason: 'unavailable' })
  })

  it('falls back when the artifact is not wasm', async () => {
    process.env.OMP_DESKTOP_WASM_PATH = writeWasmFile([0, 1, 2, 3])
    resetOmpWasmForTests()
    await expect(scanOmpMetadataBytes(Buffer.from(''), defaults)).resolves.toEqual({ status: 'fallback', reason: 'unavailable' })
  })

  it('ignores model changes with a non-default present role', async () => {
    const lines = [
      line({ type: 'session', id: 'roles' }),
      line({ type: 'model_change', role: 'default', model: 'openai/gpt-5' }),
      line({ type: 'model_change', role: null, model: 'null/model' }),
      line({ type: 'model_change', role: 7, model: 'number/model' }),
      line({ type: 'model_change', role: 'task', model: 'task/model' }),
      line({ type: 'model_change', model: 'other/final' }),
    ]
    const tail = `${lines.join('\n')}\n`
    const result = await scanOmpMetadataBytes(Buffer.from(tail), defaults)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('Expected an accumulator')
    expect(result.accumulator.provider).toBe('other')
    expect(result.accumulator.model).toBe('final')
  })

  it('falls back for numeric timestamps outside the four-digit year range', async () => {
    const yearTenThousand = line({ type: 'session', id: 's1', timestamp: 253_402_300_800_000 })
    await expect(scanOmpMetadataBytes(Buffer.from(`${yearTenThousand}\n`), defaults)).resolves.toMatchObject({ status: 'fallback' })
    const maximum = line({ type: 'session', id: 's1', timestamp: 8.64e15 })
    await expect(scanOmpMetadataBytes(Buffer.from(`${maximum}\n`), defaults)).resolves.toMatchObject({ status: 'fallback' })
  })

  it('continues freeing allocations when cleanup throws', () => {
    const freed: number[] = []
    releaseOmpWasmAllocations({
      clear_result() { throw new Error('trap') },
      dealloc(pointer) { freed.push(pointer); if (pointer === 1) throw new Error('trap') },
    }, [{ pointer: 1, length: 1 }, { pointer: 2, length: 1 }, { pointer: 3, length: 1 }])
    expect(freed).toEqual([1, 2, 3])
  })

  it('falls back on deep JSON that JavaScript accepts', async () => {
    const nested = '['.repeat(500) + '0' + ']'.repeat(500)
    const raw = `{"type":"message","message":{"role":"user","content":"deep"},"deep":${nested}}`
    expect(() => JSON.parse(raw)).not.toThrow()
    await expect(scanOmpMetadataBytes(Buffer.from(`${raw}\n`), defaults)).resolves.toMatchObject({ status: 'fallback' })
  })

  it('falls back when the title slot contains a lone surrogate', async () => {
    const slot = titleSlot('\ud800')
    await expect(scanOmpMetadataBytes(Buffer.from(`${slot}\n`), defaults, 256)).resolves.toMatchObject({ status: 'fallback' })
  })

  it('falls back for valid JS JSON that serde rejects', async () => {
    const surrogate = '{"type":"message","message":{"role":"user","content":"\\ud800"}}'
    await expect(scanOmpMetadataBytes(Buffer.from(`${surrogate}\n`), defaults)).resolves.toMatchObject({ status: 'fallback' })
    const overflow = '{"type":"message","message":{"role":"user","content":"x"},"n":1e400}'
    await expect(scanOmpMetadataBytes(Buffer.from(`${overflow}\n`), defaults)).resolves.toMatchObject({ status: 'fallback' })
  })

  it('honors the disable switch', async () => {
    process.env.OMP_DESKTOP_DISABLE_WASM = '1'
    await expect(scanOmpMetadataBytes(Buffer.from(''), defaults)).resolves.toEqual({ status: 'fallback', reason: 'disabled' })
  })
})


describe('OMP metadata WASM integration', () => {
  it('matches the incremental TS reader and reuses the cold cache', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omp-desktop-wasm-'))
    directories.push(directory)
    const file = join(directory, '2026-01-01T00-00-00-000Z_wasm-session.jsonl')
    const header = JSON.stringify({ type: 'session', version: 3, id: 'wasm-session', cwd: '/project', timestamp: '2026-01-01T00:00:00.000Z' })
    const user = JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'hello' } })
    const assistant = JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: 'world', stopReason: 'end' } })
    writeFileSync(file, `${titleSlot('WASM title')}\n${header}\n${user}\n${assistant}\n`)

    let reads = 0
    const io = {
      inspect: async (path: string) => statSync(path),
      openStream: (path: string, start: number, end: number) => createReadStream(path, { start, end }),
      readPrefix: nodeMetadataReaderIo.readPrefix,
      readAll: async (path: string) => { reads += 1; return readFileSync(path) },
    }
    const wasmReader = createOmpSessionMetadataReader(io)
    const tsReader = createOmpSessionMetadataReader({ ...io, readAll: undefined })

    const wasm = await wasmReader(file)
    const ts = await tsReader(file)
    expect(wasm).toEqual(ts)
    expect(wasm.title).toBe('WASM title')
    expect(wasm.preview).toBe('world')
    expect(wasm.lastUserTexts).toEqual(['hello'])
    expect(reads).toBe(1)

    expect(await wasmReader(file)).toEqual(wasm)
    expect(reads).toBe(1)

    appendFileSync(file, `${JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'user', content: 'second' } })}\n`)
    expect(await wasmReader(file)).toEqual(await tsReader(file))
    expect(reads).toBe(1)
  })

  it('falls back to the TS reader when disabled', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omp-desktop-wasm-disabled-'))
    directories.push(directory)
    const file = join(directory, '2026-01-01T00-00-00-000Z_disabled.jsonl')
    writeFileSync(file, `${titleSlot('Disabled')}\n${JSON.stringify({ type: 'session', id: 'disabled', cwd: '/project', timestamp: '2026-01-01T00:00:00.000Z' })}\n`)
    let reads = 0
    const io = {
      inspect: async (path: string) => statSync(path),
      openStream: (path: string, start: number, end: number) => createReadStream(path, { start, end }),
      readPrefix: nodeMetadataReaderIo.readPrefix,
      readAll: async (path: string) => { reads += 1; return readFileSync(path) },
    }
    process.env.OMP_DESKTOP_DISABLE_WASM = '1'
    const metadata = await createOmpSessionMetadataReader(io)(file)
    expect(metadata.title).toBe('Disabled')
    expect(reads).toBe(0)
  })
})
