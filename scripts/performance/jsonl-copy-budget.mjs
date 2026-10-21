import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { build } from 'esbuild'

// Bundle the production buffer in memory so this check writes no build or user data.
const built = await build({
  entryPoints: [resolve('electron/main/jsonl-line-buffer.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
})
const { JsonlLineBuffer } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const originalConcat = Buffer.concat
for (const sizeMiB of [1, 4, 8]) {
  const bytes = sizeMiB * 1024 * 1024
  const chunk = Buffer.alloc(64 * 1024, 120)
  const buffer = new JsonlLineBuffer()
  let copiedBytes = 0
  Buffer.concat = (parts, ...args) => {
    copiedBytes += parts.reduce((total, part) => total + part.length, 0)
    return originalConcat.call(Buffer, parts, ...args)
  }
  try {
    for (let offset = 0; offset < bytes; offset += chunk.length) assert.equal([...buffer.push(chunk)].length, 0)
    const lines = [...buffer.push('\n')]
    assert.equal(lines.length, 1)
    assert.equal(lines[0].length, bytes)
    assert.equal(buffer.byteLength, 0)
    assert.ok(copiedBytes <= bytes, 'Line assembly exceeded its linear copy budget')
    console.log(JSON.stringify({ sizeMiB, chunkKiB: 64, concatCopiedMiB: copiedBytes / 1024 / 1024 }))
  } finally { Buffer.concat = originalConcat }
}
