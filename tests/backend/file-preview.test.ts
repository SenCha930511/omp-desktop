import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FilePreviewService,
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_PDF_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
} from '../../electron/main/file-preview'
import { ProjectService } from '../../electron/main/projects'
import { JsonStateStore } from '../../electron/main/store'
import { lstatSync } from 'node:fs'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), prefix))
  tempDirs.push(dir)
  return dir
}

async function createAuthorizedFixture() {
  const dir = makeTemp('omp-file-preview-')
  const projectDir = join(dir, 'project')
  const outsideDir = join(dir, 'outside')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })

  const stat = lstatSync(projectDir, { bigint: true })
  const canonicalProject = realpathSync(projectDir)
  const store = new JsonStateStore(join(dir, 'state.json'))
  await store.update((state) => {
    state.projects.push({
      id: 'proj-1',
      harness: 'omp',
      name: 'Project',
      path: canonicalProject,
      folders: [canonicalProject],
      primaryFolder: canonicalProject,
      pinned: false,
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      folderIdentities: {
        [canonicalProject]: { dev: stat.dev.toString(), ino: stat.ino.toString() },
      },
    })
  })
  const projects = new ProjectService(store, () => null)
  return { dir, projectDir: canonicalProject, outsideDir: realpathSync(outsideDir), projects }
}

describe('FilePreviewService', () => {
  it('reads markdown, text, image, and pdf files inside an authorized project', async () => {
    const { projectDir, projects } = await createAuthorizedFixture()
    const mdFile = join(projectDir, 'README.md')
    const tsFile = join(projectDir, 'src.ts')
    const pngFile = join(projectDir, 'chart.png')
    const pdfFile = join(projectDir, 'spec.pdf')

    writeFileSync(mdFile, '# Title\n\nHello **world**')
    writeFileSync(tsFile, 'export const ok = true\n')
    writeFileSync(pngFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    writeFileSync(pdfFile, Buffer.from('%PDF-1.4\n%test\n'))

    const service = new FilePreviewService({
      authorizeProjectPath: (path) => projects.authorizePath(path),
      windowProvider: () => null,
    })

    const md = await service.readFile('README.md', projectDir)
    expect(md).toMatchObject({ kind: 'markdown', path: mdFile, name: 'README.md', content: '# Title\n\nHello **world**', truncated: false })

    const ts = await service.readFile(pathToFileURL(tsFile).href)
    expect(ts).toMatchObject({ kind: 'text', path: tsFile, name: 'src.ts', content: 'export const ok = true\n', truncated: false })

    const img = await service.readFile('./chart.png?v=1', projectDir)
    expect(img).toMatchObject({ kind: 'image', path: pngFile, name: 'chart.png', mimeType: 'image/png' })
    if (img.kind === 'image') expect(Buffer.from(img.base64, 'base64')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    const pdf = await service.readFile(pdfFile)
    expect(pdf).toMatchObject({ kind: 'pdf', path: pdfFile, name: 'spec.pdf', mimeType: 'application/pdf' })
  })

  it('rejects paths outside authorized projects and symlink escapes', async () => {
    const { projectDir, outsideDir, projects } = await createAuthorizedFixture()
    const secretFile = join(outsideDir, 'secret.txt')
    writeFileSync(secretFile, 'top-secret')
    const symlinkPath = join(projectDir, 'escape.txt')
    symlinkSync(secretFile, symlinkPath)

    const service = new FilePreviewService({
      authorizeProjectPath: (path) => projects.authorizePath(path),
      windowProvider: () => null,
    })

    await expect(service.readFile(secretFile)).rejects.toThrow(/not inside/i)
    await expect(service.readFile(symlinkPath)).rejects.toThrow(/not inside/i)
    await expect(service.readFile('../outside/secret.txt', projectDir)).rejects.toThrow(/not inside/i)
  })

  it('allows reading an external file only after explicit user dialog selection', async () => {
    const { outsideDir, projects } = await createAuthorizedFixture()
    const externalNote = join(outsideDir, 'notes.md')
    writeFileSync(externalNote, '# External Note')

    const openDialog = vi.fn(async () => ({ canceled: false, filePaths: [externalNote] }))
    const service = new FilePreviewService({
      authorizeProjectPath: (path) => projects.authorizePath(path),
      windowProvider: () => null,
      openDialog,
    })

    await expect(service.readFile(externalNote)).rejects.toThrow(/not inside/i)
    const picked = await service.pickFile()
    expect(picked).toEqual({ path: externalNote, name: 'notes.md' })

    const loaded = await service.readFile(externalNote)
    expect(loaded).toMatchObject({ kind: 'markdown', path: externalNote, content: '# External Note' })
  })

  it('classifies binary files as unsupported and truncates oversized text/markdown files', async () => {
    const { projectDir, projects } = await createAuthorizedFixture()
    const binFile = join(projectDir, 'archive.bin')
    const bigText = join(projectDir, 'huge.log')
    const bigImage = join(projectDir, 'huge.png')
    const bigPdf = join(projectDir, 'huge.pdf')

    writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02, 0x03]))
    writeFileSync(bigText, 'a'.repeat(MAX_TEXT_PREVIEW_BYTES + 100))
    writeFileSync(bigImage, Buffer.alloc(MAX_IMAGE_PREVIEW_BYTES + 1, 1))
    writeFileSync(bigPdf, Buffer.alloc(MAX_PDF_PREVIEW_BYTES + 1, 1))

    const service = new FilePreviewService({
      authorizeProjectPath: (path) => projects.authorizePath(path),
      windowProvider: () => null,
    })

    expect(await service.readFile(binFile)).toMatchObject({ kind: 'unsupported', name: 'archive.bin' })

    const textPayload = await service.readFile(bigText)
    expect(textPayload).toMatchObject({ kind: 'text', truncated: true })
    if (textPayload.kind === 'text') expect(textPayload.content.length).toBe(MAX_TEXT_PREVIEW_BYTES)

    expect(await service.readFile(bigImage)).toMatchObject({ kind: 'too-large', maxBytes: MAX_IMAGE_PREVIEW_BYTES })
    expect(await service.readFile(bigPdf)).toMatchObject({ kind: 'too-large', maxBytes: MAX_PDF_PREVIEW_BYTES })
  })

  it('serves local HTML previews with sibling assets over loopback and blocks traversal', async () => {
    const { projectDir, outsideDir, projects } = await createAuthorizedFixture()
    const htmlFile = join(projectDir, 'report.html')
    const cssFile = join(projectDir, 'style.css')
    const outsideSecret = join(outsideDir, 'secret.txt')
    const escapeSymlink = join(projectDir, 'escape.txt')
    writeFileSync(htmlFile, '<!doctype html><link rel="stylesheet" href="style.css"><h1>Report</h1>')
    writeFileSync(cssFile, 'h1 { color: red; }')
    writeFileSync(outsideSecret, 'hidden')
    symlinkSync(outsideSecret, escapeSymlink)

    const service = new FilePreviewService({
      authorizeProjectPath: (path) => projects.authorizePath(path),
      windowProvider: () => null,
    })

    try {
      const payload = await service.readFile('report.html', projectDir)
      expect(payload).toMatchObject({
        kind: 'html',
        path: htmlFile,
        name: 'report.html',
        truncated: false,
      })
      if (payload.kind !== 'html' || !payload.previewUrl) throw new Error('Expected html previewUrl')

      const htmlResponse = await fetch(payload.previewUrl)
      expect(htmlResponse.status).toBe(200)
      expect(htmlResponse.headers.get('content-type')).toContain('text/html')
      expect(await htmlResponse.text()).toContain('<h1>Report</h1>')

      const cssUrl = new URL('style.css', payload.previewUrl).href
      const cssResponse = await fetch(cssUrl)
      expect(cssResponse.status).toBe(200)
      expect(cssResponse.headers.get('content-type')).toContain('text/css')
      expect(await cssResponse.text()).toBe('h1 { color: red; }')

      const normalizedTraversalResponse = await fetch(`${new URL('.', payload.previewUrl).href}%2e%2e/outside/secret.txt`)
      expect(normalizedTraversalResponse.status).toBe(404)

      const encodedTraversalResponse = await fetch(payload.previewUrl.replace('report.html', '..%2foutside%2fsecret.txt'))
      expect(encodedTraversalResponse.status).toBe(403)

      const symlinkResponse = await fetch(new URL('escape.txt', payload.previewUrl).href)
      expect(symlinkResponse.status).toBe(403)

      const badTokenResponse = await fetch(new URL('/invalidtoken/report.html', payload.previewUrl).href)
      expect(badTokenResponse.status).toBe(404)
    } finally {
      await service.dispose()
    }
  })

  it('supports .jfif and OS-decoded formats such as .heic and .tiff with unsupported fallback', async () => {
    const { projectDir, projects } = await createAuthorizedFixture()
    const jfifFile = join(projectDir, 'photo.jfif')
    const heicFile = join(projectDir, 'photo.heic')
    const tiffFile = join(projectDir, 'scan.tiff')
    const brokenHeic = join(projectDir, 'broken.heic')

    writeFileSync(jfifFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    writeFileSync(brokenHeic, Buffer.from('not-a-real-heic'))

    const stubService = new FilePreviewService({
      authorizeProjectPath: (path) => projects.authorizePath(path),
      windowProvider: () => null,
      decodeNativeImage: async (target) => {
        if (target.endsWith('broken.heic')) return null
        return { mimeType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
      },
    })

    expect(await stubService.readFile('photo.jfif', projectDir)).toMatchObject({
      kind: 'image',
      mimeType: 'image/jpeg',
      name: 'photo.jfif',
    })
    writeFileSync(heicFile, Buffer.from('placeholder-heic'))
    expect(await stubService.readFile('photo.heic', projectDir)).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      name: 'photo.heic',
    })
    expect(await stubService.readFile('broken.heic', projectDir)).toMatchObject({
      kind: 'unsupported',
      name: 'broken.heic',
    })

    if (process.platform === 'darwin') {
      const samplePng = join(projectDir, 'seed.png')
      writeFileSync(
        samplePng,
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
      )
      execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', samplePng, '--out', heicFile], { stdio: 'ignore' })
      execFileSync('/usr/bin/sips', ['-s', 'format', 'tiff', samplePng, '--out', tiffFile], { stdio: 'ignore' })

      const nativeService = new FilePreviewService({
        authorizeProjectPath: (path) => projects.authorizePath(path),
        windowProvider: () => null,
      })

      for (const candidate of [heicFile, tiffFile]) {
        const result = await nativeService.readFile(candidate)
        expect(result.kind).toBe('image')
        if (result.kind === 'image') {
          expect(result.mimeType).toBe('image/png')
          expect(Buffer.from(result.base64, 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        }
      }
      expect(await nativeService.readFile(brokenHeic)).toMatchObject({ kind: 'unsupported', name: 'broken.heic' })
    }
  })
})
