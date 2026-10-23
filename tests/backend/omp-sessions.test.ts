import { appendFileSync, closeSync, createReadStream, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionService } from '../../electron/main/sessions'
import { METADATA_VERIFY_TAIL_BYTES } from '../../electron/main/sessions/metadata'
import {
  createOmpSessionMetadataReader,
  isOmpSessionPath,
  OMP_TITLE_SLOT_BYTES,
  ompSessionServiceOptions,
  ompTimestampFromSessionName,
  writeOmpTitleSlot,
} from '../../electron/main/sessions/omp'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

function titleSlot(title: string, updatedAt = '2026-08-08T02:12:49.414Z'): string {
  const unpadded = JSON.stringify({ type: 'title', v: 1, title, updatedAt, pad: '' })
  const padding = OMP_TITLE_SLOT_BYTES - 1 - Buffer.byteLength(unpadded, 'utf8')
  if (padding < 0) throw new Error('Fixture title does not fit the slot')
  return JSON.stringify({ type: 'title', v: 1, title, updatedAt, pad: ' '.repeat(padding) })
}

function ompEntry(type: string, id: string, parentId: string | null, extra: Record<string, unknown> = {}, timestamp = '2026-08-08T02:13:00.000Z'): string {
  return JSON.stringify({ type, id, parentId, timestamp, ...extra })
}

function writeOmpSession(file: string, options: {
  id?: string
  cwd?: string
  title?: string
  timestamp?: string
  entries?: string[]
} = {}): void {
  const timestamp = options.timestamp ?? '2026-08-08T02:12:49.414Z'
  const slot = titleSlot(options.title ?? '', timestamp)
  expect(Buffer.byteLength(`${slot}\n`, 'utf8')).toBe(OMP_TITLE_SLOT_BYTES)
  writeFileSync(file, [
    slot,
    JSON.stringify({ type: 'session', version: 3, id: options.id ?? '019fdf24-f686-7000-86fd-e1eaf84626c6', timestamp, cwd: options.cwd ?? '/tmp' }),
    ...options.entries ?? [],
    '',
  ].join('\n'))
}

it('restores the configured auto selector rather than the resolved concrete level', async () => {
  const { root, project, service } = setup()
  mkdirSync(join(root, '-bucket'))
  const file = join(root, '-bucket', NAME_A)
  writeOmpSession(file, { cwd: project, entries: [ompEntry('thinking_level_change', 'auto-entry', null, { thinkingLevel: 'high', configured: 'auto' })] })
  expect((await service.list(undefined, true))[0]?.thinkingLevel).toBe('auto')
})

function rewriteTitleSlot(file: string, title: string): void {
  const slot = Buffer.from(`${titleSlot(title)}\n`, 'utf8')
  expect(slot.length).toBe(OMP_TITLE_SLOT_BYTES)
  const fd = openSync(file, 'r+')
  try { writeSync(fd, slot, 0, slot.length, 0) } finally { closeSync(fd) }
}

function setup(maxSessionFiles?: number): { root: string; project: string; service: SessionService } {
  const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-omp-sessions-')); dirs.push(dir)
  const root = join(dir, 'sessions'); mkdirSync(root)
  const project = join(dir, 'project'); mkdirSync(project)
  const store = new JsonStateStore(join(dir, 'state.json'))
  const service = new SessionService(store, null, maxSessionFiles, ompSessionServiceOptions(root))
  return { root, project, service }
}

const NAME_A = '2026-08-08T02-12-49-414Z_019fdf24-f686-7000-86fd-e1eaf84626c6.jsonl'
const NAME_B = '2026-08-09T10-00-00-000Z_019fdf24-0000-7000-8000-000000000001.jsonl'
const NAME_C = '2026-08-10T12-30-15-250Z_019fdf24-0000-7000-8000-000000000002.jsonl'

describe('OMP session file names', () => {
  it('derives ordering timestamps from the ISO file-name prefix, with or without a bucket prefix', () => {
    expect(ompTimestampFromSessionName(NAME_A)).toBe(Date.parse('2026-08-08T02:12:49.414Z'))
    expect(ompTimestampFromSessionName(`-tmp/${NAME_C}`)).toBe(Date.parse('2026-08-10T12:30:15.250Z'))
    expect(ompTimestampFromSessionName('legacy.jsonl')).toBeUndefined()
    expect(ompTimestampFromSessionName('01900000-0001-7000-8000-000000000000.jsonl')).toBeUndefined()
  })
})

describe('OMP metadata reader', () => {
  it('parses the title slot, header, model, thinking level, and user activity into a SessionRecord', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, {
      id: 'omp-session-1',
      cwd: project,
      title: 'Slot title',
      entries: [
        ompEntry('model_change', '090e7d4b', null, { model: 'anthropic/claude-opus-4-8', resolvedModelIsFallback: false }, '2026-08-08T02:12:49.458Z'),
        ompEntry('thinking_level_change', '77ca5df2', '090e7d4b', { thinkingLevel: 'high', configured: null }, '2026-08-08T02:12:49.458Z'),
        ompEntry('model_change', '9e21e960', '77ca5df2', { model: 'openai-codex/gpt-5.6-sol', role: 'default' }, '2026-08-08T02:15:26.437Z'),
        ompEntry('model_change', '15f3a4e9', '9e21e960', { model: 'other/side-model', role: 'compaction' }, '2026-08-08T02:15:27.000Z'),
        ompEntry('message', 'aa11bb22', '15f3a4e9', { message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }], timestamp: 1786155361373 } }, '2026-08-08T02:16:01.414Z'),
        ompEntry('message', 'cc33dd44', 'aa11bb22', { message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }], timestamp: 1786155362489 } }, '2026-08-08T02:16:02.495Z'),
      ],
    })

    const records = await service.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: 'omp-session-1',
      projectPath: realpathSync(project),
      title: 'Slot title',
      createdAt: '2026-08-08T02:12:49.414Z',
      updatedAt: '2026-08-08T02:16:02.495Z',
      lastUserMessageAt: new Date(1786155361373).toISOString(),
      status: 'complete',
      model: 'gpt-5.6-sol',
      provider: 'openai-codex',
      thinkingLevel: 'high',
      depth: 0,
      preview: 'the answer',
    })
  })

  it('falls back to title_change then the first user message when the slot title is empty', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    const untitled = join(root, '-bucket', NAME_A)
    writeOmpSession(untitled, {
      cwd: project,
      entries: [ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'name me by prompt' } })],
    })
    const renamed = join(root, '-bucket', NAME_B)
    writeOmpSession(renamed, {
      cwd: project,
      entries: [
        ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'original prompt' } }),
        ompEntry('title_change', 'bb22cc33', 'aa11bb22', { title: 'Renamed in tail' }),
      ],
    })

    const titles = new Map((await service.list()).map((record) => [record.filePath.endsWith(NAME_B) ? 'renamed' : 'untitled', record.title]))
    expect(titles.get('untitled')).toBe('name me by prompt')
    expect(titles.get('renamed')).toBe('Renamed in tail')
  })

  it('picks up an in-place title-slot rewrite without losing incremental tail state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-omp-title-')); dirs.push(dir)
    const file = join(dir, NAME_A)
    const bulk = Array.from({ length: 8 }, (_, index) => ompEntry('message', `aa11bb2${index}`, index ? `aa11bb2${index - 1}` : null, {
      message: { role: 'user', content: `filler ${'x'.repeat(600)}` },
    }))
    writeOmpSession(file, { title: 'Before rename', entries: bulk })
    expect(statSync(file).size).toBeGreaterThan(OMP_TITLE_SLOT_BYTES + METADATA_VERIFY_TAIL_BYTES)
    const opens: Array<{ start: number; end: number }> = []
    const reader = createOmpSessionMetadataReader({
      inspect: stat,
      openStream: (path, start, end) => {
        opens.push({ start, end })
        return createReadStream(path, { start, end })
      },
    })
    const tailOpens = () => opens.filter((open) => !(open.start === 0 && open.end === OMP_TITLE_SLOT_BYTES - 1))

    const first = await reader(file)
    const firstSize = statSync(file).size
    expect(first.title).toBe('Before rename')
    expect(tailOpens()).toEqual([{ start: OMP_TITLE_SLOT_BYTES, end: firstSize - 1 }])

    // The slot is rewritten in place (same byte length) while an entry appends:
    // the tail resumes from the verification window, never from byte zero.
    rewriteTitleSlot(file, 'After rename')
    appendFileSync(file, `${ompEntry('message', 'ee55ff66', 'aa11bb27', { message: { role: 'assistant', content: 'caught up' } }, '2026-08-08T03:00:00.000Z')}\n`)
    const second = await reader(file)
    expect(second.title).toBe('After rename')
    expect(second.preview).toBe('caught up')
    expect(second.updatedAt).toBe('2026-08-08T03:00:00.000Z')
    expect(tailOpens()).toHaveLength(2)
    expect(tailOpens()[1]).toEqual({ start: firstSize - METADATA_VERIFY_TAIL_BYTES, end: statSync(file).size - 1 })
    expect(tailOpens()[1]!.start).toBeGreaterThan(OMP_TITLE_SLOT_BYTES)

    // A rewrite with no append still refreshes the title on the next read.
    rewriteTitleSlot(file, 'Renamed again')
    expect((await reader(file)).title).toBe('Renamed again')
  })
})

describe('OMP catalog discovery', () => {
  it('notifies and surfaces a fresh title for an in-place title-slot rewrite', async () => {
    // The harness auto-names sessions by rewriting the first 256 bytes in
    // place; the live sidebar depends on that landing through the watcher and
    // invalidating the cached metadata.
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, { cwd: project, title: 'Before rename' })
    expect((await service.list(undefined, true))[0]?.title).toBe('Before rename')

    const reshoots: string[] = []
    const unsubscribe = service.onDidChange((event) => { if (event.filePath) reshoots.push(event.filePath) })
    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      // fs.watch can still be catching up on the file's creation during the
      // settle window; a residual event would satisfy the wait below against
      // a catalog that has not reconciled the rewrite yet. Only events from
      // after the rewrite count.
      reshoots.length = 0
      rewriteTitleSlot(file, 'Renamed by harness')
      const canonical = realpathSync(file)
      await vi.waitFor(() => expect(reshoots).toContain(canonical), { timeout: 10_000, interval: 50 })
      const current = (await service.list(undefined, true)).map((record) => record.title)
      expect(current).toContain('Renamed by harness')
    } finally {
      unsubscribe()
    }
  })


  it('recurses exactly one bucket level and ignores root files, deep files, and hidden names', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    mkdirSync(join(root, '-bucket', 'nested'))
    mkdirSync(join(root, '.hidden-bucket'))
    writeOmpSession(join(root, '-bucket', NAME_A), { id: 'visible', cwd: project })
    writeOmpSession(join(root, NAME_B), { id: 'root-level', cwd: project })
    writeOmpSession(join(root, '-bucket', 'nested', NAME_C), { id: 'too-deep', cwd: project })
    writeOmpSession(join(root, '.hidden-bucket', NAME_C), { id: 'hidden-bucket', cwd: project })
    writeOmpSession(join(root, '-bucket', `.${NAME_C}`), { id: 'hidden-file', cwd: project })
    writeFileSync(join(root, '-bucket', 'notes.txt'), 'not a session')

    const records = await service.list()
    expect(records.map((record) => record.id)).toEqual(['visible'])
  })

  it('admits the newest files by file-name timestamp, not directory or mtime order', async () => {
    const { root, project, service } = setup(2)
    mkdirSync(join(root, '-bucket-a'))
    mkdirSync(join(root, '-bucket-b'))
    const oldest = join(root, '-bucket-b', NAME_A)
    const middle = join(root, '-bucket-a', NAME_B)
    const newest = join(root, '-bucket-b', NAME_C)
    writeOmpSession(oldest, { id: 'oldest', cwd: project })
    writeOmpSession(middle, { id: 'middle', cwd: project })
    writeOmpSession(newest, { id: 'newest', cwd: project })
    // The oldest-named file gets the newest mtime: the pre-I/O admission bound
    // must still be decided by the file-name timestamp.
    const past = new Date('2026-08-01T00:00:00.000Z')
    utimesSync(middle, past, past)
    utimesSync(newest, past, past)

    const records = await service.list()
    expect(records.map((record) => record.id).sort()).toEqual(['middle', 'newest'])
  })
})

describe('OMP session path authorization', () => {
  it('contains sessions to one bucket level below the realpathed root', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    mkdirSync(join(root, '-bucket', 'nested'))
    const valid = join(root, '-bucket', NAME_A)
    writeOmpSession(valid, { cwd: project })
    writeOmpSession(join(root, NAME_B), { cwd: project })
    writeOmpSession(join(root, '-bucket', 'nested', NAME_C), { cwd: project })
    writeFileSync(join(root, '-bucket', 'notes.txt'), 'not a session')
    const outside = join(dirs.at(-1)!, 'outside.jsonl')
    writeOmpSession(outside, { cwd: project })
    symlinkSync(outside, join(root, '-bucket', 'escape.jsonl'))

    await expect(service.requireSessionPath(valid)).resolves.toBe(realpathSync(valid))
    await expect(service.requireSessionPath(join(root, NAME_B))).rejects.toThrow('outside the')
    await expect(service.requireSessionPath(join(root, '-bucket', 'nested', NAME_C))).rejects.toThrow('outside the')
    await expect(service.requireSessionPath(join(root, '-bucket', 'notes.txt'))).rejects.toThrow('outside the')
    await expect(service.requireSessionPath(join(root, '-bucket', 'escape.jsonl'))).rejects.toThrow('outside the')
  })

  it('validates candidate shapes without touching the filesystem', () => {
    expect(isOmpSessionPath('/root', `/root/-bucket/${NAME_A}`)).toBe(true)
    expect(isOmpSessionPath('/root', `/root/${NAME_A}`)).toBe(false)
    expect(isOmpSessionPath('/root', `/root/-bucket/deep/${NAME_A}`)).toBe(false)
    expect(isOmpSessionPath('/root', `/elsewhere/-bucket/${NAME_A}`)).toBe(false)
    expect(isOmpSessionPath('/root', '/root/-bucket/session.txt')).toBe(false)
  })
})

describe('OMP transcript access through the service', () => {
  it('reads an OMP transcript through the injected reader and authorized path', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, {
      cwd: project,
      entries: [
        ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'question' } }),
        ompEntry('message', 'cc33dd44', 'aa11bb22', { message: { role: 'assistant', content: 'answer' } }),
      ],
    })

    const transcript = await service.read(file)
    expect(transcript.map((message) => [message.role, message.parts])).toEqual([
      ['user', [{ type: 'text', text: 'question' }]],
      ['assistant', [{ type: 'text', text: 'answer' }]],
    ])
  })
})

describe('OMP session service harness identity', () => {
  it('stamps every record and change event with the omp harness', async () => {
    const { root, project, service } = setup()
    expect(service.harness).toBe('omp')
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, { cwd: project, entries: [ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'question' } })] })

    const records = await service.list()
    expect(records.map((record) => record.harness)).toEqual(['omp'])

    const events: Array<{ filePath?: string; harness?: string }> = []
    const unsubscribe = service.onDidChange((event) => events.push(event))
    try {
      const watcherHarness = service as unknown as { queueSessionChange(filename: string): void }
      // Recursive watchers report bucket-relative names one directory deep.
      watcherHarness.queueSessionChange(`-bucket/${NAME_A}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 400))
      expect(events).toContainEqual({ filePath: realpathSync(file), harness: 'omp' })

      // Deeper or hidden names cannot resolve to one session file and coalesce
      // into a catalog-wide refresh instead.
      events.splice(0)
      watcherHarness.queueSessionChange(`-bucket/nested/${NAME_A}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 400))
      expect(events).toEqual([{ harness: 'omp' }])
    } finally {
      unsubscribe()
    }
  })
})

describe('OMP file-level rename fallback', () => {
  it('rewrites the title slot in place without touching the session header', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, {
      cwd: project,
      title: 'Slot title',
      entries: [ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'first prompt' } })],
    })
    const before = readFileSync(file)
    const header = before.toString('utf8').split('\n')[1]

    expect(writeOmpTitleSlot(file, 'Renamed offline')).toBe(true)
    const after = readFileSync(file)
    expect(after.length).toBe(before.length)
    expect(after.toString('utf8').split('\n')[1]).toBe(header)
    expect((await service.list())[0]?.title).toBe('Renamed offline')
  })

  it('leaves a file whose first line is the session header untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-omp-no-slot-')); dirs.push(dir)
    const file = join(dir, NAME_A)
    const body = `${JSON.stringify({ type: 'session', version: 3, id: 'no-slot', timestamp: '2026-08-08T02:12:49.414Z', cwd: '/tmp' })}\n`
    writeFileSync(file, body)
    expect(writeOmpTitleSlot(file, 'Should not write')).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(body)
  })
})

describe('OMP session branching and pinning', () => {
  it('branches a session to a fresh bucketed sibling with a distinct id, leaving the source untouched', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, {
      id: 'source-session',
      cwd: project,
      title: 'Source title',
      entries: [ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'question' } })],
    })
    const before = readFileSync(file)

    const branched = await service.branch(file)

    expect(branched.filePath).not.toBe(realpathSync(file))
    expect(dirname(branched.filePath)).toBe(realpathSync(join(root, '-bucket')))
    expect(basename(branched.filePath)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]+\.jsonl$/)
    expect(branched.id).not.toBe('source-session')
    // OMP ties the file-name uuid to the session id; the fork keeps that convention.
    expect(branched.id).toBe(basename(branched.filePath, '.jsonl').split('_').at(-1))
    expect(readFileSync(file).equals(before)).toBe(true)

    // The fork copies the title slot and every entry verbatim; only the
    // session identity header carries the fresh id.
    const sourceLines = before.toString('utf8').split('\n')
    const copyLines = readFileSync(branched.filePath, 'utf8').split('\n')
    expect(copyLines).toHaveLength(sourceLines.length)
    expect(copyLines[0]).toBe(sourceLines[0])
    expect(copyLines.slice(2)).toEqual(sourceLines.slice(2))
    expect(JSON.parse(copyLines[1])).toMatchObject({ type: 'session', id: branched.id, cwd: project })

    const records = await service.list(undefined, true)
    expect(new Set(records.map((record) => record.id))).toEqual(new Set(['source-session', branched.id]))
  })

  it('rejects branch and setPinned for paths outside the session root', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, { cwd: project })
    const outside = join(dirname(root), 'outside.jsonl')
    writeOmpSession(outside, { cwd: project })

    await expect(service.branch(outside)).rejects.toThrow('outside the')
    await expect(service.setPinned(outside, true)).rejects.toThrow('outside the')
    await expect(service.branch(join(root, '-bucket', 'missing.jsonl'))).rejects.toThrow()
    expect(await service.list()).toHaveLength(1)
  })

  it('persists session pins in the app store and reflects them in list()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-omp-pins-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const statePath = join(dir, 'state.json')
    const store = new JsonStateStore(statePath)
    const service = new SessionService(store, null, undefined, ompSessionServiceOptions(root))
    mkdirSync(join(root, '-bucket'))
    const fileA = join(root, '-bucket', NAME_A)
    const fileB = join(root, '-bucket', NAME_B)
    writeOmpSession(fileA, { id: 'session-a', cwd: project })
    writeOmpSession(fileB, { id: 'session-b', cwd: project })
    const pinnedOf = async (id: string) => (await service.list()).find((record) => record.id === id)?.pinned

    expect(await pinnedOf('session-a')).toBe(false)
    await service.setPinned(fileA, true)
    expect(await pinnedOf('session-a')).toBe(true)
    expect(await pinnedOf('session-b')).toBe(false)
    // Re-pinning is idempotent and a second pin joins the persisted list.
    await service.setPinned(fileA, true)
    await service.setPinned(fileB, true)
    expect(await pinnedOf('session-a')).toBe(true)

    await service.setPinned(fileA, false)
    expect(await pinnedOf('session-a')).toBe(false)
    expect(await pinnedOf('session-b')).toBe(true)

    expect(new JsonStateStore(statePath).snapshot().pinnedSessions).toEqual([realpathSync(fileB)])
  })
})
