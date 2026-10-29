import { appendFileSync, createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createIncrementalMetadataReader, type MetadataLineParser, type SessionMetadata, type SessionMetadataReaderIo } from '../../electron/main/sessions/metadata'

interface Accumulator { texts: string[] }

/** Minimal parser whose accumulator carries the same shape that matters here:
 *  a large string array (lastUserTexts / previousSessionFiles) beside scalars. */
const parser: MetadataLineParser<Accumulator> = {
  createAccumulator: () => ({ texts: [] }),
  ingestLine: (accumulator, line) => {
    if (line.trim()) accumulator.texts.push(line)
  },
  snapshot: (accumulator, filePath, fallbackUpdated): SessionMetadata => ({
    id: filePath,
    projectPath: '/project',
    filePath,
    title: 'fixture',
    createdAt: fallbackUpdated,
    updatedAt: fallbackUpdated,
    status: 'idle',
    depth: 0,
    lastUserTexts: accumulator.texts.slice(-3),
  }),
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('incremental metadata cache budget', () => {
  it('charges retained array fields so the byte budget actually evicts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omp-desktop-metadata-cache-'))
    dirs.push(root)
    const first = join(root, 'first.jsonl')
    const second = join(root, 'second.jsonl')
    // ~12 kB of retained text per file, held in an array field. Larger than the
    // 4 KiB verify tail so an incremental resume starts well past byte 0.
    const line = `${JSON.stringify({ text: 'x'.repeat(12_000) })}\n`
    writeFileSync(first, line)
    writeFileSync(second, line)

    const starts: number[] = []
    const io: SessionMetadataReaderIo = {
      inspect: async (path) => statSync(path),
      openStream: (path, start, end) => {
        starts.push(start)
        return createReadStream(path, { start, end })
      },
    }
    // Budget fits one file's charged state (~28 kB) but not two.
    const read = createIncrementalMetadataReader(parser, io, 0, 40_000)
    await read(first)
    await read(second)

    starts.length = 0
    appendFileSync(first, `${JSON.stringify({ text: 'y' })}\n`)
    await read(first)

    // An evicted entry re-reads from the start; a retained one resumes at the
    // previous size. Only the charged-array accounting produces the eviction.
    expect(starts).toEqual([0])
  })
})
