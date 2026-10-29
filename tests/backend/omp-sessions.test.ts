import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, createReadStream, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
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
import { createBranchSummaryTranscriptReader } from '../../electron/main/sessions/bucketed'
import { MAX_PART_IMAGE_CHARS } from '../../src/lib/events/message-content'

const dirs: string[] = []
const stores: JsonStateStore[] = []
afterEach(async () => {
  // State stores initialize asynchronously; settle every tracked store before
  // its temp dir is removed so the init rename never hits a missing path.
  await Promise.allSettled(stores.splice(0).map((store) => store.ready()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

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
  header?: Record<string, unknown>
} = {}): void {
  const timestamp = options.timestamp ?? '2026-08-08T02:12:49.414Z'
  const slot = titleSlot(options.title ?? '', timestamp)
  expect(Buffer.byteLength(`${slot}\n`, 'utf8')).toBe(OMP_TITLE_SLOT_BYTES)
  writeFileSync(file, [
    slot,
    JSON.stringify({ type: 'session', version: 3, id: options.id ?? '019fdf24-f686-7000-86fd-e1eaf84626c6', timestamp, cwd: options.cwd ?? '/tmp', ...options.header }),
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

function setup(maxSessionFiles?: number): { root: string; project: string; service: SessionService; store: JsonStateStore } {
  const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-omp-sessions-')); dirs.push(dir)
  const root = join(dir, 'sessions'); mkdirSync(root)
  const project = join(dir, 'project'); mkdirSync(project)
  const store = new JsonStateStore(join(dir, 'state.json')); stores.push(store)
  const service = new SessionService(store, null, maxSessionFiles, ompSessionServiceOptions(root))
  return { root, project, service, store }
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

  it('keeps the tail user texts so delivered queue previews can clear mid-turn', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, {
      id: 'omp-session-1',
      cwd: project,
      title: 'Slot title',
      entries: [
        ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }], timestamp: 1786155361373 } }, '2026-08-08T02:16:01.414Z'),
        ompEntry('message', 'cc33dd44', 'aa11bb22', { message: { role: 'user', content: [{ type: 'text', text: 'queued steer one' }], timestamp: 1786155362489 } }, '2026-08-08T02:16:02.495Z'),
        ompEntry('message', 'ee55ff66', 'cc33dd44', { message: { role: 'user', content: [{ type: 'text', text: 'queued steer two' }], timestamp: 1786155363597 } }, '2026-08-08T02:16:03.601Z'),
        ompEntry('message', 'ab12cd34', 'ee55ff66', { message: { role: 'user', content: [{ type: 'text', text: 'queued steer three' }], timestamp: 1786155364611 } }, '2026-08-08T02:16:04.615Z'),
        ompEntry('message', 'ef56ab78', 'ab12cd34', { message: { role: 'user', content: [{ type: 'text', text: 'queued steer four' }], timestamp: 1786155365623 } }, '2026-08-08T02:16:05.627Z'),
      ],
    })

    const records = await service.list()
    expect(records[0]?.lastUserTexts).toEqual(['queued steer two', 'queued steer three', 'queued steer four'])
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

describe('OMP transcript active-leaf selection (upstream v18.12.6 parity)', () => {
  const question = ompEntry('message', 'm1', null, { message: { role: 'user', content: 'question' } })
  const answer = ompEntry('message', 'm2', 'm1', { message: { role: 'assistant', content: 'answer' } })
  const read = async (entries: string[]): Promise<Array<[string, unknown]>> => {
    const { root, project, service, store } = setup()
    // The service kicks off state-store initialization asynchronously; await
    // it so the temp dir is never torn down mid-initialize (ENOENT rename).
    await store.ready()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, { cwd: project, entries })
    const transcript = await service.read(file)
    return transcript.map((message) => [message.role, message.parts])
  }
  const conversation: Array<[string, Array<{ type: string; text: string }>]> = [
    ['user', [{ type: 'text', text: 'question' }]],
    ['assistant', [{ type: 'text', text: 'answer' }]],
  ]

  it('renders the branch captured by a late off-branch record instead of the off-branch tail', async () => {
    // Upstream sessionEntryLeafId: an entry written off the active branch
    // (appendMessageToBranch) replays to the leaf it captured at append time.
    await expect(read([
      question,
      answer,
      ompEntry('message', 'm3', 'm1', { message: { role: 'user', content: 'background result' }, activeLeafId: 'm2' }),
    ])).resolves.toEqual(conversation)
  })

  it('walks through a trailing non-renderable leaf to its renderable ancestors', async () => {
    // title_change self-selects as the leaf and parents onto the conversation;
    // resolveSessionLeafId makes it the active node even though it never renders.
    await expect(read([
      question,
      answer,
      ompEntry('title_change', 't1', 'm2', { title: 'Renamed', source: 'user' }),
    ])).resolves.toEqual(conversation)
  })

  it('traverses a non-renderable captured active leaf', async () => {
    // A late off-branch record may capture a leaf that is itself a
    // non-renderable node (model_change); the parent walk must pass through it.
    await expect(read([
      question,
      answer,
      ompEntry('model_change', 'c1', 'm2', { model: 'gpt-5', role: 'main' }),
      ompEntry('message', 'm3', 'm1', { message: { role: 'user', content: 'late usage' }, activeLeafId: 'c1' }),
    ])).resolves.toEqual(conversation)
  })

  it('renders an empty transcript when the last record captures a cleared (null) active leaf', async () => {
    // resolveSessionLeafId: an explicit activeLeafId null selects no active
    // branch; the retained conversation must NOT come back via any fallback.
    await expect(read([
      question,
      answer,
      ompEntry('model_usage', 'u1', 'm1', { purpose: 'turn', activeLeafId: null }),
    ])).resolves.toEqual([])
  })

  it('falls back to the newest self-selecting record when a captured leaf id no longer exists', async () => {
    // A captured leaf removed by rollback/rewrite: resolveSessionLeafId falls
    // back to lastSelfSelectedLeafId instead of adopting the off-branch tail.
    await expect(read([
      question,
      answer,
      ompEntry('message', 'm3', 'm1', { message: { role: 'user', content: 'stray' }, activeLeafId: 'rolled-back' }),
    ])).resolves.toEqual(conversation)
  })

  it('keeps legacy last-entry selection when no record captures an active leaf', async () => {
    // Legacy files predate activeLeafId; a trailing self-selecting
    // non-renderable record still resolves through its parent chain.
    await expect(read([
      question,
      answer,
      ompEntry('model_usage', 'u1', 'm2', { purpose: 'turn' }),
    ])).resolves.toEqual(conversation)
  })

  it('still renders the retained conversation when a trailing non-renderable record roots its own branch', async () => {
    // A non-renderable record with parentId null (e.g. extension data) becomes
    // the resolved leaf but its branch retains nothing renderable; the
    // dead-branch fallback must keep the transcript open on the last
    // retained renderable record.
    await expect(read([
      question,
      answer,
      ompEntry('custom', 'x1', null, { payload: 'extension data' }),
    ])).resolves.toEqual(conversation)
  })

  it('lets a later self-selecting record override an earlier cleared leaf', async () => {
    await expect(read([
      question,
      answer,
      ompEntry('model_usage', 'u1', 'm1', { purpose: 'turn', activeLeafId: null }),
      ompEntry('message', 'm4', 'm2', { message: { role: 'user', content: 'follow-up' } }),
    ])).resolves.toEqual([...conversation, ['user', [{ type: 'text', text: 'follow-up' }]]])
  })
})

describe('OMP transcript active-leaf selection beyond the retained edge window', () => {
  const question = ompEntry('message', 'm1', null, { message: { role: 'user', content: 'question' } })
  const answer = ompEntry('message', 'm2', 'm1', { message: { role: 'assistant', content: 'answer' } })
  const conversation: Array<[string, Array<{ type: string; text: string }>]> = [
    ['user', [{ type: 'text', text: 'question' }]],
    ['assistant', [{ type: 'text', text: 'answer' }]],
  ]
  const read = async (entries: string[]): Promise<Array<[string, unknown]>> => {
    const { root, project, service, store } = setup()
    await store.ready()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, { cwd: project, entries })
    const transcript = await service.read(file)
    return transcript.map((message) => [message.role, message.parts])
  }

  it('renders the old retained conversation a late off-branch record captures past the edge window', async () => {
    // The forward pass retains only the newest 40k id→parentId edges. With
    // 40k+ off-branch non-renderable records after the conversation, the
    // captured leaf m2 is still retained as renderable but its edge (and its
    // ancestors') fell out of the window: the captured branch must still be
    // selected and walked, not treated as a dangling capture.
    const usage: string[] = []
    for (let index = 0; index < 40_005; index += 1) usage.push(ompEntry('model_usage', `u${index}`, 'm2', { purpose: 'turn' }))
    await expect(read([
      question,
      answer,
      ...usage,
      ompEntry('message', 'm9', 'm1', { message: { role: 'user', content: 'late' }, activeLeafId: 'm2' }),
    ])).resolves.toEqual(conversation)
  })

  it('recovers ancestor edges evicted mid-chain when a deep non-renderable tail self-selects', async () => {
    // A 40k-deep chain of non-renderable records parents onto the retained
    // conversation and its last record self-selects as the leaf. The walk
    // from that leaf dead-ends where the edge window expired; the missing
    // ancestor chain must be recovered so the conversation still renders.
    const chain: string[] = []
    for (let index = 1; index <= 40_005; index += 1) {
      chain.push(ompEntry('model_change', `c${index}`, index === 1 ? 'm2' : `c${index - 1}`, { model: 'gpt-5', role: 'main' }))
    }
    await expect(read([question, answer, ...chain])).resolves.toEqual(conversation)
  })

  it('heals five interleaved eviction gaps in one branch written out of order', async () => {
    // Out-of-order appends (no duplicate ids, no corrupt records) leave the
    // retained window holding only the late-group edges, so the branch from
    // the leaf L crosses five separate eviction gaps (a13, a10, a7, a4, a1)
    // and the fallback walk from X crosses five more (b13, b10, b7, b4, b1).
    // Every gap must heal in the same read: the retained conversation
    // m1, m2, X renders in full, not just the fallback prefix X.
    const chainParent = (id: string): string | null => {
      if (id === 'm1') return null
      if (id === 'm2') return 'm1'
      if (id === 'X') return 'b13'
      const index = Number(id.slice(1))
      if (id.startsWith('b')) return index === 1 ? 'm2' : `b${index - 1}`
      return index === 1 ? 'X' : `a${index - 1}`
    }
    const marker = (id: string) => ompEntry('model_change', id, chainParent(id), { model: 'gpt-5', role: 'main' })
    const earlyIds = ['b1', 'b3', 'b4', 'b6', 'b7', 'b9', 'b10', 'b12', 'b13', 'a1', 'a3', 'a4', 'a6', 'a7', 'a9', 'a10', 'a12', 'a13']
    const lateIds = ['b2', 'b5', 'b8', 'b11', 'a2', 'a5', 'a8', 'a11']
    const fillers: string[] = []
    for (let index = 0; index < 40_005; index += 1) fillers.push(ompEntry('model_usage', `f${index}`, 'm2', { purpose: 'turn' }))
    await expect(read([
      question,
      answer,
      ...earlyIds.map(marker),
      ompEntry('message', 'X', 'b13', { message: { role: 'user', content: 'deep follow-up' } }),
      ...fillers,
      ...lateIds.map(marker),
      ompEntry('model_change', 'L', 'a13', { model: 'gpt-5', role: 'main' }),
    ])).resolves.toEqual([
      ...conversation,
      ['user', [{ type: 'text', text: 'deep follow-up' }]],
    ])
  })

  it('recovers a duplicate ancestor by its last occurrence instead of flipping to a stale branch', async () => {
    // B is rewritten mid-file: B@1 parents on branch A, B@2 (the last write,
    // which the forward pass honors) parents on branch B. A capture of T
    // must resolve T -> B@2 -> m2b and render branch B; anchoring T's run on
    // the stale B@1 occurrence silently flips the transcript to branch A.
    const fillers: string[] = []
    for (let index = 0; index < 40_005; index += 1) fillers.push(ompEntry('model_usage', `f${index}`, 'm2b', { purpose: 'turn' }))
    await expect(read([
      ompEntry('model_change', 'B', 'm2a', { model: 'gpt-5', role: 'main' }),
      ompEntry('message', 'm1a', null, { message: { role: 'user', content: 'branch a question' } }),
      ompEntry('message', 'm2a', 'm1a', { message: { role: 'assistant', content: 'branch a answer' } }),
      ompEntry('message', 'm1b', null, { message: { role: 'user', content: 'branch b question' } }),
      ompEntry('message', 'm2b', 'm1b', { message: { role: 'assistant', content: 'branch b answer' } }),
      ompEntry('model_change', 'T', 'B', { model: 'gpt-5', role: 'main' }),
      ompEntry('model_change', 'B', 'm2b', { model: 'gpt-5', role: 'main' }),
      ...fillers,
      ompEntry('model_usage', 'Z', 'm2b', { purpose: 'turn', activeLeafId: 'T' }),
    ])).resolves.toEqual([
      ['user', [{ type: 'text', text: 'branch b question' }]],
      ['assistant', [{ type: 'text', text: 'branch b answer' }]],
    ])
  })
})

describe('OMP transcript reverse recovery reader boundaries', () => {
  const question = ompEntry('message', 'm1', null, { message: { role: 'user', content: 'question' } })
  const answer = ompEntry('message', 'm2', 'm1', { message: { role: 'assistant', content: 'answer' } })
  const conversation: Array<[string, Array<{ type: string; text: string }>]> = [
    ['user', [{ type: 'text', text: 'question' }]],
    ['assistant', [{ type: 'text', text: 'answer' }]],
  ]
  // A dangling capture forces the bounded backward pass to scan the whole
  // file, so every line crosses the reverse reader before the safe
  // self-selected fallback renders the conversation.
  const danglingCapture = ompEntry('model_usage', 'u1', 'm2', { purpose: 'turn', activeLeafId: 'rolled-back' })

  const readRaw = async (entries: string[], separator: string, trailing: string): Promise<Array<[string, unknown]>> => {
    const { root, project, service, store } = setup()
    await store.ready()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    const header = JSON.stringify({
      type: 'session', version: 3, id: '019fdf24-f686-7000-86fd-e1eaf84626c6',
      timestamp: '2026-08-08T02:12:49.414Z', cwd: project,
    })
    writeFileSync(file, [titleSlot(''), header, ...entries].join(separator) + trailing)
    const transcript = await service.read(file)
    return transcript.map((message) => [message.role, message.parts])
  }

  it('reassembles records larger than the reverse reader chunk size', async () => {
    // A 512 KiB record spans several 64 KiB reverse-read chunks; the scan
    // must reassemble it on a newline boundary and keep walking (functional
    // guard only — no wallclock assertion).
    const huge = 'x'.repeat(512 * 1024)
    await expect(readRaw([
      question,
      answer,
      ompEntry('custom', 'big', 'm2', { payload: huge }),
      danglingCapture,
    ], '\n', '\n')).resolves.toEqual(conversation)
  })

  it('tolerates CRLF line endings through the reverse pass', async () => {
    await expect(readRaw([question, answer, danglingCapture], '\r\n', '\r\n')).resolves.toEqual(conversation)
  })

  it('reads an unterminated final record through the reverse pass', async () => {
    await expect(readRaw([question, answer, danglingCapture], '\n', '')).resolves.toEqual(conversation)
  })
})

describe('OMP transcript payload and recovery budget boundaries', () => {
  const read = async (entries: string[]): Promise<Array<[string, unknown]>> => {
    const { root, project, service, store } = setup()
    await store.ready()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, { cwd: project, entries })
    const transcript = await service.read(file)
    return transcript.map((message) => [message.role, message.parts])
  }

  it('fails closed when a confirmed capture loses all retained payload to eviction', async () => {
    // Branch A renders, then 10,005 renderable branch-B messages evict A's
    // payloads from the 10k FIFO. The final record captures A's leaf: the
    // read must reject rather than silently render branch B's conversation.
    const flood: string[] = []
    for (let index = 0; index < 10_005; index += 1) {
      flood.push(ompEntry('message', `b${index}`, index === 0 ? 'm2' : `b${index - 1}`, { message: { role: 'assistant', content: `flood ${index}` } }))
    }
    await expect(read([
      ompEntry('message', 'm1', null, { message: { role: 'user', content: 'question' } }),
      ompEntry('message', 'm2', 'm1', { message: { role: 'assistant', content: 'answer' } }),
      ...flood,
      ompEntry('model_usage', 'u1', 'm2', { purpose: 'turn', activeLeafId: 'm2' }),
    ])).rejects.toThrow('too large to display')
  })

  it('drops the stale payload when a rewrite flips an id from renderable to non-renderable', async () => {
    // Payload must be last-write-wins like the edges: rewriting `dup` as a
    // non-renderable record removes its stale message instead of leaving it
    // in the retained graph.
    await expect(read([
      ompEntry('message', 'm1', null, { message: { role: 'user', content: 'kept' } }),
      ompEntry('message', 'dup', 'm1', { message: { role: 'user', content: 'stale payload' } }),
      ompEntry('model_change', 'dup', 'm1', { model: 'gpt-5', role: 'main' }),
    ])).resolves.toEqual([['user', [{ type: 'text', text: 'kept' }]]])
  })

  it('rejects instead of falling back when the recovery edge budget is exceeded', async () => {
    // 9,000 distinct ~1kB ids charge ~18.6 MiB of recovery edge state, past
    // the 16 MiB budget: the dangling capture must reject, never silently
    // adopt the self-selected fallback branch.
    const wide = (index: number) => `x${'i'.repeat(1_000)}${index}`
    const flood: string[] = []
    for (let index = 0; index < 9_000; index += 1) flood.push(ompEntry('model_usage', wide(index), null, { purpose: 'turn' }))
    await expect(read([
      ...flood,
      ompEntry('model_usage', 'z', null, { purpose: 'turn', activeLeafId: 'ghost' }),
    ])).rejects.toThrow('too large to display')
  })

  it('completes recovery just under the edge budget and renders the safe fallback', async () => {
    // 7,000 distinct ~1kB ids charge ~14.5 MiB, under the budget: recovery
    // completes, the dangling capture falls back to the newest self-selecting
    // record, and the payload-less transcript renders empty without error.
    const wide = (index: number) => `x${'i'.repeat(1_000)}${index}`
    const flood: string[] = []
    for (let index = 0; index < 7_000; index += 1) flood.push(ompEntry('model_usage', wide(index), null, { purpose: 'turn' }))
    await expect(read([
      ...flood,
      ompEntry('model_usage', 'z', null, { purpose: 'turn', activeLeafId: 'ghost' }),
    ])).resolves.toEqual([])
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
  it('branches through the runtime forker to a fresh bucketed sibling with a distinct id, leaving the source untouched', async () => {
    const { root, project, service, store } = setup()
    // The service kicks off state-store initialization asynchronously; await
    // it so the temp dir is never torn down mid-initialize (ENOENT rename).
    await store.ready()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, {
      id: 'source-session',
      cwd: project,
      title: 'Source title',
      entries: [ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'question' } })],
    })
    const before = readFileSync(file)
    const seen: Array<{ filePath: string; cwd: string }> = []
    service.setRuntimeForker(async (filePath, cwd) => {
      seen.push({ filePath, cwd })
      const id = randomUUID()
      // The engine performs the fork: a fresh identity whose parent lineage
      // names the source, artifacts included.
      const target = join(root, '-bucket', `${new Date().toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`)
      writeOmpSession(target, {
        id,
        cwd,
        header: { parentSession: 'source-session' },
        entries: [ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'question' } })],
      })
      return target
    })

    const branched = await service.branch(file)

    expect(seen).toEqual([{ filePath: realpathSync(file), cwd: realpathSync(project) }])
    expect(branched.filePath).not.toBe(realpathSync(file))
    expect(dirname(branched.filePath)).toBe(realpathSync(join(root, '-bucket')))
    expect(basename(branched.filePath)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]+\.jsonl$/)
    expect(branched.id).not.toBe('source-session')
    expect(readFileSync(file).equals(before)).toBe(true)
    // The engine-written fork carries a fresh identity and source parent
    // lineage; the service never rewrites JSONL itself.
    expect(JSON.parse(readFileSync(branched.filePath, 'utf8').split('\n')[1])).toMatchObject({
      type: 'session', id: branched.id, cwd: realpathSync(project), parentSession: 'source-session',
    })
    expect(branched.parentSession).toBe('source-session')

    const records = await service.list(undefined, true)
    expect(new Set(records.map((record) => record.id))).toEqual(new Set(['source-session', branched.id]))
  })

  it('rejects branch and setPinned for paths outside the session root', async () => {
    const { root, project, service, store } = setup()
    await store.ready()
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
    const store = new JsonStateStore(statePath); stores.push(store)
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

    const verifier = new JsonStateStore(statePath); stores.push(verifier)
    expect(verifier.snapshot().pinnedSessions).toEqual([realpathSync(fileB)])
  })
})

describe('session lineage references', () => {
  it('keeps a child that names a parentSession visible beside its source', async () => {
    const { root, project, service, store } = setup()
    // The service kicks off state-store initialization asynchronously; await
    // it so the temp dir is never torn down mid-initialize (ENOENT rename).
    await store.ready()
    mkdirSync(join(root, '-bucket'))
    const parentFile = join(root, '-bucket', NAME_A)
    const siblingFile = join(root, '-bucket', NAME_B)
    writeOmpSession(parentFile, { id: 'parent-session', cwd: project })
    writeOmpSession(siblingFile, { id: 'sibling-session', cwd: project, timestamp: '2026-08-09T10:00:00.000Z', header: { parentSession: 'parent-session' } })
    await service.setPinned(parentFile, true)

    const records = await service.list()
    expect(records.map((record) => record.id).sort()).toEqual(['parent-session', 'sibling-session'])
    // Pin ownership stays with the file the user pinned; lineage never
    // transfers display flags between conversations.
    expect(records.find((record) => record.id === 'parent-session')?.pinned).toBe(true)
    expect(records.find((record) => record.id === 'sibling-session')?.pinned).toBe(false)
  })

  it('keeps every sibling that names the same parentSession visible', async () => {
    const { root, project, service, store } = setup()
    // The service kicks off state-store initialization asynchronously; await
    // it so the temp dir is never torn down mid-initialize (ENOENT rename).
    await store.ready()
    mkdirSync(join(root, '-bucket'))
    writeOmpSession(join(root, '-bucket', NAME_A), { id: 'source-session', cwd: project })
    // Siblings naming one source can be deliberate branches the user kept:
    // every conversation stays listed.
    writeOmpSession(join(root, '-bucket', `2026-08-09T10:00:00.000Z_${'0'.repeat(8)}-0000-7000-8000-0000000000b1.jsonl`), { id: 'branch-one', cwd: project, timestamp: '2026-08-09T10:00:00.000Z', header: { parentSession: 'source-session' } })
    writeOmpSession(join(root, '-bucket', `2026-08-09T11:00:00.000Z_${'0'.repeat(8)}-0000-7000-8000-0000000000b2.jsonl`), { id: 'branch-two', cwd: project, timestamp: '2026-08-09T11:00:00.000Z', header: { parentSession: 'source-session' } })
    writeOmpSession(join(root, '-bucket', `2026-08-09T12:00:00.000Z_${'0'.repeat(8)}-0000-7000-8000-0000000000b3.jsonl`), { id: 'branch-three', cwd: project, timestamp: '2026-08-09T12:00:00.000Z', header: { parentSession: 'source-session' } })

    const records = await service.list()
    expect(records.map((record) => record.id).sort()).toEqual(['branch-one', 'branch-three', 'branch-two', 'source-session'])
  })

  it('leaves a parked runtime on its own file instead of retargeting it through lineage', async () => {
    const { root, project, service, store } = setup()
    // The service kicks off state-store initialization asynchronously; await
    // it so the temp dir is never torn down mid-initialize (ENOENT rename).
    await store.ready()
    mkdirSync(join(root, '-bucket'))
    const parentFile = join(root, '-bucket', NAME_A)
    const siblingFile = join(root, '-bucket', NAME_B)
    writeOmpSession(parentFile, { id: 'parent-session', cwd: project })
    writeOmpSession(siblingFile, { id: 'sibling-session', cwd: project, timestamp: '2026-08-09T10:00:00.000Z', header: { parentSession: 'parent-session' } })
    const adopted: Array<[string, string]> = []
    const parkedFile = await service.requireSessionPath(parentFile)
    const hooks = {
      get: () => undefined,
      all: () => [{ runtimeId: 'rt-parked', sessionFile: parkedFile, isStreaming: false, isCompacting: false }],
      stop: async () => undefined,
      rename: async () => false,
      adoptSuperseded: (oldPath: string, newPath: string) => { adopted.push([oldPath, newPath]) },
    }
    service.bindRuntimeHooks(hooks)

    const records = await service.list()
    expect(records.map((record) => record.id).sort()).toEqual(['parent-session', 'sibling-session'])
    expect(adopted).toEqual([])
  })

  it('lists a streaming session and its lineage child together', async () => {
    const { root, project, service, store } = setup()
    // The service kicks off state-store initialization asynchronously; await
    // it so the temp dir is never torn down mid-initialize (ENOENT rename).
    await store.ready()
    mkdirSync(join(root, '-bucket'))
    const parentFile = join(root, '-bucket', NAME_A)
    const siblingFile = join(root, '-bucket', NAME_B)
    writeOmpSession(parentFile, { id: 'parent-session', cwd: project })
    writeOmpSession(siblingFile, { id: 'sibling-session', cwd: project, timestamp: '2026-08-09T10:00:00.000Z', header: { parentSession: 'parent-session' } })
    const adopted: Array<[string, string]> = []
    const liveFile = await service.requireSessionPath(parentFile)
    const hooks = {
      get: () => undefined,
      all: () => [{ runtimeId: 'rt-live', sessionFile: liveFile, isStreaming: true, isCompacting: false }],
      stop: async () => undefined,
      rename: async () => false,
      adoptSuperseded: (oldPath: string, newPath: string) => { adopted.push([oldPath, newPath]) },
    }
    service.bindRuntimeHooks(hooks)

    const records = await service.list()
    expect(records.find((record) => record.id === 'parent-session')?.status).toBe('running')
    expect(records.map((record) => record.id).sort()).toEqual(['parent-session', 'sibling-session'])
    expect(adopted).toEqual([])
  })

  it('keeps unreferenced, same-time, and self references visible', async () => {
    const { root, project, service, store } = setup()
    // The service kicks off state-store initialization asynchronously; await
    // it so the temp dir is never torn down mid-initialize (ENOENT rename).
    await store.ready()
    mkdirSync(join(root, '-bucket'))
    writeOmpSession(join(root, '-bucket', NAME_A), { id: 'plain-old', cwd: project })
    writeOmpSession(join(root, '-bucket', `2026-08-08T02-12-49-414Z_${'0'.repeat(8)}-0000-7000-8000-0000000000aa.jsonl`), {
      id: 'same-time', cwd: project, header: { parentSession: 'plain-old' },
    })
    writeOmpSession(join(root, '-bucket', NAME_C), { id: 'self-ref', cwd: project, header: { parentSession: 'self-ref' } })

    const ids = (await service.list()).map((record) => record.id).sort()
    expect(ids).toEqual(['plain-old', 'same-time', 'self-ref'])
  })
})

describe('OMP image blob references', () => {
  it('resolves blob:sha256 image data from the blob store into inline parts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-omp-blobs-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const blobs = join(dir, 'blobs'); mkdirSync(blobs)
    const hash = 'a'.repeat(64)
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    writeFileSync(join(blobs, hash), pngHeader)
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, {
      id: 'blob-session',
      cwd: project,
      entries: [ompEntry('message', 'm1', null, { message: { role: 'user', timestamp: 1_700_000_000_000, content: [
        { type: 'text', text: 'Look at this' },
        { type: 'image', mimeType: 'image/png', data: `blob:sha256:${hash}` },
      ] } }, '2026-08-08T02:13:01.000Z')],
    })
    const store = new JsonStateStore(join(dir, 'state.json')); stores.push(store)
    const service = new SessionService(store, null, undefined, {
      ...ompSessionServiceOptions(root),
      transcriptReader: createBranchSummaryTranscriptReader(blobs),
    })

    const messages = await service.read(realpathSync(file))
    const image = messages.flatMap((message) => message.parts).find((part) => part.type === 'image')
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png', data: pngHeader.toString('base64'), dataTruncated: undefined })
  })

  it('marks a missing blob as unavailable instead of failing the transcript read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-omp-blobs-missing-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(join(root, '-bucket'), { recursive: true })
    const blobs = join(dir, 'blobs'); mkdirSync(blobs)
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, {
      id: 'blob-session',
      entries: [ompEntry('message', 'm1', null, { message: { role: 'user', timestamp: 1_700_000_000_000, content: [
        { type: 'image', mimeType: 'image/png', data: `blob:sha256:${'b'.repeat(64)}` },
      ] } }, '2026-08-08T02:13:01.000Z')],
    })
    const reader = createBranchSummaryTranscriptReader(blobs)

    const messages = await reader(realpathSync(file), false)
    const image = messages.flatMap((message) => message.parts).find((part) => part.type === 'image')
    expect(image).toMatchObject({ type: 'image', dataTruncated: true })
  })

  it('reads only the prefix of an oversized blob instead of buffering the whole file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-omp-blobs-large-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(join(root, '-bucket'), { recursive: true })
    const project = join(dir, 'project'); mkdirSync(project)
    const blobs = join(dir, 'blobs'); mkdirSync(blobs)
    const hash = 'c'.repeat(64)
    // 20 MiB blob: the transcript can only ever show the first 6 MiB of bytes.
    writeFileSync(join(blobs, hash), Buffer.alloc(20 * 1024 * 1024, 7))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, {
      id: 'blob-session-large',
      cwd: project,
      entries: [ompEntry('message', 'm1', null, { message: { role: 'user', timestamp: 1_700_000_000_000, content: [
        { type: 'image', mimeType: 'image/png', data: `blob:sha256:${hash}` },
      ] } }, '2026-08-08T02:13:01.000Z')],
    })

    const maxBytes = Math.floor(MAX_PART_IMAGE_CHARS * 3 / 4)
    let requested = 0
    // FileHandle is a type-only export, so the read spy is installed on the
    // prototype of a real handle; the reader opens its own handle from the same
    // prototype.
    const probe = await open(join(blobs, hash), 'r')
    const prototype = Object.getPrototypeOf(probe) as { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> }
    const originalRead = prototype.read
    const readSpy = vi.spyOn(prototype, 'read').mockImplementation(function (this: unknown, buffer: Buffer, offset: number, length: number, position: number) {
      requested += length
      return originalRead.call(this, buffer, offset, length, position)
    })
    try {
      const reader = createBranchSummaryTranscriptReader(blobs)
      const messages = await reader(realpathSync(file), false)
      const image = messages.flatMap((message) => message.parts).find((part) => part.type === 'image')
      expect(image).toMatchObject({ type: 'image', dataTruncated: true })
      expect((image as { data?: string }).data).toHaveLength(MAX_PART_IMAGE_CHARS)
      // Bounded I/O, not just bounded output: the 20 MiB file is never buffered.
      expect(requested).toBeGreaterThan(0)
      expect(requested).toBeLessThanOrEqual(maxBytes)
    } finally {
      readSpy.mockRestore()
      await probe.close()
    }
  })
})
