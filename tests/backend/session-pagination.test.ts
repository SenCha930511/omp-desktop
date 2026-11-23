import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionService } from '../../electron/main/sessions'
import { createTranscriptReader, type TranscriptFileReader, type TranscriptPageReaderResult } from '../../electron/main/sessions/transcript'
import { JsonStateStore } from '../../electron/main/store'
import type { TranscriptMessage, TranscriptReadPageResult } from '../../src/types/api'

const dirs: string[] = []
const stores: JsonStateStore[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.allSettled(stores.splice(0).map((store) => store.ready()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

function setup(transcriptReader?: TranscriptFileReader): { root: string; project: string; service: SessionService } {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), 'omp-desktop-pages-'))
  dirs.push(dir)
  const root = join(dir, 'sessions')
  mkdirSync(root)
  const project = join(dir, 'project')
  mkdirSync(project)
  const store = new JsonStateStore(join(dir, 'state.json'))
  stores.push(store)
  const service = new SessionService(store, null, undefined, transcriptReader ? { transcriptReader } : undefined)
  Object.defineProperty(service, 'sessionRoot', { value: root })
  return { root, project, service }
}

function writeChain(file: string, project: string, count: number, textLength = 0): string[] {
  const lines = [JSON.stringify({ type: 'session', id: 'paging', cwd: project })]
  let parentId: string | null = null
  for (let index = 0; index < count; index += 1) {
    const id = `message-${index}`
    lines.push(JSON.stringify({
      type: 'message', id, parentId,
      message: { role: 'user', content: `${String(index).padStart(4, '0')}:${'x'.repeat(textLength)}` },
    }))
    parentId = id
  }
  writeFileSync(file, `${lines.join('\n')}\n`)
  return lines
}

function readyCursor(result: TranscriptReadPageResult): string {
  if (result.status !== 'ok') throw new Error(`Expected ok page, received ${result.status}`)
  if (result.older.state !== 'ready') throw new Error(`Expected a ready page cursor, received ${JSON.stringify(result.older)}`)
  return result.older.cursor
}

function messages(result: TranscriptReadPageResult): TranscriptMessage[] {
  if (result.status !== 'ok') throw new Error(`Expected ok page, received ${result.status}`)
  return result.messages
}

describe('SessionService transcript page snapshots', () => {
  it('returns the legacy newest suffix, exact end-exclusive adjacency, and deterministic cursor reuse', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'long.jsonl')
    writeChain(file, project, 850)

    const newest = await service.readPage(file)
    expect(messages(newest)).toEqual(await service.read(file))
    expect(newest).toMatchObject({ status: 'ok', endExclusiveMessageId: null })
    expect(messages(newest).map((message) => message.id)).toEqual(Array.from({ length: 400 }, (_, index) => `message-${index + 450}`))
    if (newest.status !== 'ok') throw new Error('Expected an ok newest page')
    expect(newest.snapshotId).toMatch(/^[0-9a-f-]{36}$/)
    const firstCursor = readyCursor(newest)

    const middle = await service.readPage(file, { cursor: firstCursor })
    expect(messages(middle).map((message) => message.id)).toEqual(Array.from({ length: 400 }, (_, index) => `message-${index + 50}`))
    expect(middle).toMatchObject({ status: 'ok', snapshotId: newest.snapshotId, endExclusiveMessageId: 'message-450' })
    expect(await service.readPage(file, { cursor: firstCursor })).toEqual(middle)

    const oldest = await service.readPage(file, { cursor: readyCursor(middle) })
    expect(messages(oldest).map((message) => message.id)).toEqual(Array.from({ length: 50 }, (_, index) => `message-${index}`))
    expect(oldest).toMatchObject({ status: 'ok', endExclusiveMessageId: 'message-50', older: { state: 'end' } })
    expect([...messages(oldest), ...messages(middle), ...messages(newest)].map((message) => message.id))
      .toEqual(Array.from({ length: 850 }, (_, index) => `message-${index}`))
  })

  it('invalidates continuations on append, same-id rewrite, truncation, and unknown or cross-file ids without newest fallback', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'mutable.jsonl')
    const other = join(root, 'other.jsonl')
    const lines = writeChain(file, project, 450)
    writeChain(other, project, 5)

    const appendedCursor = readyCursor(await service.readPage(file))
    appendFileSync(file, `${JSON.stringify({ type: 'message', id: 'appended', parentId: 'message-449', message: { role: 'user', content: 'new tail' } })}\n`)
    expect(await service.readPage(file, { cursor: appendedCursor })).toEqual({ status: 'stale', reason: 'file-changed' })

    const rewrittenCursor = readyCursor(await service.readPage(file))
    const rewritten = lines.map((line) => line.replace('content":"0449:', 'content":"0449-rewritten-with-a-longer-value:'))
    appendFileSync(file, '')
    writeFileSync(file, `${rewritten.join('\n')}\n`)
    expect(await service.readPage(file, { cursor: rewrittenCursor })).toEqual({ status: 'stale', reason: 'file-changed' })

    const truncatedCursor = readyCursor(await service.readPage(file))
    writeFileSync(file, `${lines.slice(0, 100).join('\n')}\n`)
    expect(await service.readPage(file, { cursor: truncatedCursor })).toEqual({ status: 'stale', reason: 'file-changed' })
    expect(await service.readPage(file, { cursor: '00000000-0000-0000-0000-000000000000' })).toEqual({ status: 'stale', reason: 'unknown-cursor' })
    expect(await service.readPage(other, { cursor: truncatedCursor })).toEqual({ status: 'stale', reason: 'unknown-cursor' })
  })

  it('expires cursors lazily and never mixes locally streaming reads', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'streaming.jsonl')
    writeChain(file, project, 401)
    let streaming = true
    service.bindRuntimeHooks({
      get: () => ({ isStreaming: streaming }),
      stop: async () => undefined,
      rename: async () => false,
    })

    const streamingPage = await service.readPage(file)
    expect(streamingPage).toMatchObject({ status: 'ok', snapshotId: null, older: { state: 'unavailable', reason: 'streaming' } })
    expect(messages(streamingPage)).toEqual(await service.read(file))

    streaming = false
    let now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const cursor = readyCursor(await service.readPage(file))
    streaming = true
    expect(await service.readPage(file, { cursor })). toEqual({ status: 'unavailable', reason: 'streaming' })
    streaming = false
    now += 5 * 60 * 1_000 + 1
    expect(await service.readPage(file, { cursor })).toEqual({ status: 'stale', reason: 'unknown-cursor' })
  })

  it('fails typed stale when an unchanged-stamp reader reports a different active branch', async () => {
    let branchAnchor = 'branch-a'
    const readPage = vi.fn(async (): Promise<TranscriptPageReaderResult> => ({
      status: 'ok',
      messages: [{ id: 'page-anchor', role: 'user', parts: [{ type: 'text', text: 'bounded' }] }],
      endExclusiveMessageId: null,
      remaining: { textChars: 1, toolChars: 1, argsChars: 1, imageChars: 1, parts: 1 },
      older: { state: 'ready' }, stamp: 'same-private-stamp', branchAnchor, fileChanging: false,
    }))
    const transcriptReader: TranscriptFileReader = Object.assign(async (): Promise<TranscriptMessage[]> => [], { readPage })
    const { root, project, service } = setup(transcriptReader)
    const file = join(root, 'branch.jsonl')
    writeChain(file, project, 2)
    const cursor = readyCursor(await service.readPage(file))

    branchAnchor = 'branch-b'
    expect(await service.readPage(file, { cursor })).toEqual({ status: 'stale', reason: 'branch-changed' })
  })

  it('evicts whole snapshots and their cursors at the eight-snapshot LRU bound', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'snapshot-0.jsonl')
    writeChain(file, project, 401)
    const cursor = readyCursor(await service.readPage(file))
    for (let index = 1; index <= 8; index += 1) {
      const next = join(root, `snapshot-${index}.jsonl`)
      writeChain(next, project, 2)
      expect((await service.readPage(next)).status).toBe('ok')
    }

    expect(await service.readPage(file, { cursor })).toEqual({ status: 'stale', reason: 'unknown-cursor' })
  })

  it('single-flights cursor reads independently and keeps deterministic result envelopes', async () => {
    let active = 0
    let peak = 0
    let release = (): void => undefined
    let gate: Promise<void> | undefined
    const readPage = vi.fn(async (): Promise<TranscriptPageReaderResult> => {
      active += 1
      peak = Math.max(peak, active)
      if (gate) await gate
      active -= 1
      return {
        status: 'ok',
        messages: [{ id: 'page-anchor', role: 'user', parts: [{ type: 'text', text: 'bounded' }] }],
        endExclusiveMessageId: null,
        remaining: { textChars: 1, toolChars: 1, argsChars: 1, imageChars: 1, parts: 1 },
        older: { state: 'ready' },
        stamp: 'private-stamp', branchAnchor: 'page-anchor', fileChanging: false,
      }
    })
    const transcriptReader: TranscriptFileReader = Object.assign(async (): Promise<TranscriptMessage[]> => [], { readPage })
    const { root, project, service } = setup(transcriptReader)
    const file = join(root, 'flight.jsonl')
    writeChain(file, project, 2)
    const deferred = Promise.withResolvers<void>()
    gate = deferred.promise
    release = deferred.resolve

    const first = service.readPage(file)
    const duplicate = service.readPage(file)
    await vi.waitFor(() => expect(readPage).toHaveBeenCalledTimes(1))
    release()
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate])
    expect(duplicateResult).toBe(firstResult)
    expect(peak).toBe(1)
    const cursor = readyCursor(firstResult)

    const cursorGate = Promise.withResolvers<void>()
    gate = cursorGate.promise
    const concurrent = service.readPage(file, { cursor })
    const concurrentDuplicate = service.readPage(file, { cursor })
    await vi.waitFor(() => expect(readPage).toHaveBeenCalledTimes(2))
    cursorGate.resolve()
    expect(await concurrentDuplicate).toEqual(await concurrent)
    expect(readPage).toHaveBeenCalledTimes(2)
    const older = await service.readPage(file, { cursor })
    expect(readyCursor(older)).toBe(readyCursor(await service.readPage(file, { cursor })))
  })
})

describe('cumulative transcript display budgets', () => {
  it('does not reset text budgets at page boundaries or emit an unusable end', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'text-budget.jsonl')
    writeChain(file, project, 900, 1_195) // Five id characters plus 1,195 text chars = 1,200 per row.

    const newest = await service.readPage(file)
    const middle = await service.readPage(file, { cursor: readyCursor(newest) })
    const oldest = await service.readPage(file, { cursor: readyCursor(middle) })
    const pages = [newest, middle, oldest].map(messages)

    expect(pages.map((page) => page.length)).toEqual([400, 400, 74])
    const textChars = pages.flatMap((page) => page.flatMap((message) => message.parts.map((part) => part.type === 'text' ? part.text.length : 0)))
      .reduce((total, length) => total + length, 0)
    expect(textChars).toBe(1024 * 1024)
    expect(oldest).toMatchObject({ status: 'ok', remaining: { textChars: 0 }, older: { state: 'unavailable', reason: 'display-budget' } })
    const emittedIds = pages.flat().map((message) => message.id)
    expect(new Set(emittedIds).size).toBe(emittedIds.length)
  })

  it('charges every emitted occurrence of a deduplicated blob against the shared image budget', async () => {
    const hash = createHash('sha256').update('same-image').digest('hex')
    const dir = mkdtempSync(join(realpathSync.native(tmpdir()), 'omp-desktop-page-blobs-'))
    dirs.push(dir)
    writeFileSync(join(dir, hash), Buffer.alloc(46_080, 7)) // Exactly 61,440 base64 characters per occurrence.
    const reader = createTranscriptReader(undefined, dir)
    const { root, project, service } = setup(reader)
    const file = join(root, 'image-budget.jsonl')
    const lines = [JSON.stringify({ type: 'session', id: 'image-budget', cwd: project })]
    for (let index = 0; index < 450; index += 1) {
      lines.push(JSON.stringify({
        type: 'message', id: `image-${index}`, parentId: index ? `image-${index - 1}` : null,
        message: { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: `blob:sha256:${hash}` }] },
      }))
    }
    writeFileSync(file, `${lines.join('\n')}\n`)

    const newest = await service.readPage(file)
    expect(messages(newest)).toEqual(await service.read(file))
    const older = await service.readPage(file, { cursor: readyCursor(newest) })
    const emittedImageChars = [...messages(newest), ...messages(older)].flatMap((message) => message.parts)
      .reduce((total, part) => total + (part.type === 'image' ? part.data?.length ?? 0 : 0), 0)
    expect(emittedImageChars).toBe(24 * 1024 * 1024)
    expect(older).toMatchObject({ status: 'ok', remaining: { imageChars: 0 } })

    // Remaining rows still render intentional truncated-image placeholders
    // in this same fixed 400-row window, but acquire no further base64 bytes.
    expect(messages(older)).toHaveLength(50)
    const olderImageParts = messages(older).flatMap((message) => message.parts)
    expect(olderImageParts.filter((part) => part.type === 'image' && part.data !== undefined)).toHaveLength(10)
    expect(olderImageParts.filter((part) => part.type === 'image' && part.data === undefined && part.dataTruncated === true)).toHaveLength(40)
    expect(older).toMatchObject({ status: 'ok', older: { state: 'end' } })
  })
})
