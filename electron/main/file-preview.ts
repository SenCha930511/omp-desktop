import { dialog, nativeImage, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { lstat, mkdtemp, open as openFileHandle, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FilePreviewPayload, PickedFileRecord } from '../../src/types/api'
import { processFailureReason, runProcess } from './process-utils'
import { requireExistingPath, requireString } from './validation'

export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024
export const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024
export const MAX_PDF_PREVIEW_BYTES = 25 * 1024 * 1024
const MAX_USER_PICKED_FILES = 64
const MAX_HTML_PREVIEW_ROOTS = 32
const BINARY_SNIFF_BYTES = 8 * 1024

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}

const TRANSCODED_IMAGE_EXTENSIONS = new Set([
  '.heic', '.heif', '.tif', '.tiff', '.jp2', '.icns', '.psd', '.tga', '.dng',
])

const ASSET_MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx'])
const HTML_EXTENSIONS = new Set(['.html', '.htm'])

const TEXT_EXTENSIONS = new Set([
  '.txt', '.log', '.csv', '.tsv', '.json', '.jsonc', '.jsonl',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.css', '.scss', '.sass', '.less', '.xml',
  '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.env',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.pyi', '.rs', '.go', '.java', '.kt', '.kts', '.swift',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.cs',
  '.rb', '.php', '.lua', '.r', '.sql', '.graphql', '.gql',
  '.diff', '.patch', '.tex', '.bib', '.vue', '.svelte', '.astro',
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc',
  '.prettierrc', '.eslintrc',
])

const TEXT_BASENAMES = new Set([
  'dockerfile', 'makefile', 'procfile', 'readme', 'license', 'changelog',
  'authors', 'contributors', '.gitignore', '.gitattributes', '.editorconfig',
  '.npmrc', '.nvmrc', '.dockerignore',
])

export interface FilePreviewDependencies {
  authorizeProjectPath: (path: string) => Promise<string>
  windowProvider: () => BrowserWindow | null
  openDialog?: (options: OpenDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>
  enableHtmlServer?: boolean
  decodeNativeImage?: (canonicalPath: string, extension: string) => Promise<{ mimeType: string; bytes: Buffer } | null>
}

async function decodeOsImage(canonicalPath: string): Promise<{ mimeType: string; bytes: Buffer } | null> {
  if (process.platform === 'darwin') {
    const workDir = await mkdtemp(join(tmpdir(), 'omp-img-'))
    try {
      const pngOut = join(workDir, 'preview.png')
      const pngOutcome = await runProcess('/usr/bin/sips', ['-s', 'format', 'png', canonicalPath, '--out', pngOut], { timeoutMs: 15_000 })
      if (!processFailureReason(pngOutcome)) {
        const pngBytes = await readFile(pngOut).catch(() => null)
        if (pngBytes && pngBytes.length > 0 && pngBytes.length <= MAX_IMAGE_PREVIEW_BYTES) {
          return { mimeType: 'image/png', bytes: pngBytes }
        }
      }
      const jpgOut = join(workDir, 'preview.jpg')
      const jpgOutcome = await runProcess(
        '/usr/bin/sips',
        ['-s', 'format', 'jpeg', '-s', 'formatOptions', '88', canonicalPath, '--out', jpgOut],
        { timeoutMs: 15_000 },
      )
      if (!processFailureReason(jpgOutcome)) {
        const jpgBytes = await readFile(jpgOut).catch(() => null)
        if (jpgBytes && jpgBytes.length > 0 && jpgBytes.length <= MAX_IMAGE_PREVIEW_BYTES) {
          return { mimeType: 'image/jpeg', bytes: jpgBytes }
        }
      }
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
    return null
  }
  if (process.platform === 'win32') {
    try {
      const thumb = await nativeImage.createThumbnailFromPath(canonicalPath, { width: 2048, height: 2048 })
      if (!thumb.isEmpty()) {
        const pngBytes = thumb.toPNG()
        if (pngBytes.length > 0 && pngBytes.length <= MAX_IMAGE_PREVIEW_BYTES) {
          return { mimeType: 'image/png', bytes: pngBytes }
        }
        const jpgBytes = thumb.toJPEG(88)
        if (jpgBytes.length > 0 && jpgBytes.length <= MAX_IMAGE_PREVIEW_BYTES) {
          return { mimeType: 'image/jpeg', bytes: jpgBytes }
        }
      }
    } catch {
      return null
    }
  }
  return null
}

interface HtmlPreviewGrant {
  rootDir: string
  exactFile?: string
}

function isWithinRoot(rootDir: string, candidate: string): boolean {
  const rel = relative(rootDir, candidate)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

function normalizeRequestedPath(rawPath: string, rawBaseDir?: string): string {
  let candidate = rawPath.trim()
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate)
    } catch {
      throw new TypeError('Invalid file URL')
    }
  } else {
    // Strip optional URL query/hash suffixes from markdown image/link references if local.
    const queryIndex = candidate.indexOf('?')
    const hashIndex = candidate.indexOf('#')
    const cut = [queryIndex, hashIndex].filter((index) => index >= 0)
    if (cut.length > 0 && !isAbsolute(candidate)) {
      candidate = candidate.slice(0, Math.min(...cut))
    }
    try {
      candidate = decodeURIComponent(candidate)
    } catch {
      // Keep raw string when percent-encoding is not valid.
    }
  }
  if (!candidate) throw new TypeError('file path is too short')
  if (isAbsolute(candidate)) return candidate
  if (!rawBaseDir) throw new TypeError('file path must be absolute')
  const baseDir = requireString(rawBaseDir, 'baseDir', { min: 1, max: 4096 })
  if (!isAbsolute(baseDir)) throw new TypeError('baseDir must be absolute')
  return resolve(baseDir, candidate)
}

async function readBoundedBytes(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await openFileHandle(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    let offset = 0
    while (offset < maxBytes) {
      const { bytesRead } = await handle.read(buffer, offset, maxBytes - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return offset === maxBytes ? buffer : buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

export class FilePreviewService {
  private readonly userPickedFiles = new Set<string>()
  private readonly htmlGrants = new Map<string, HtmlPreviewGrant>()
  private htmlServer: Server | null = null
  private htmlServerPort: number | null = null
  private htmlServerStarting: Promise<number | null> | null = null
  private disposed = false

  constructor(private readonly dependencies: FilePreviewDependencies) {}

  private rememberPickedFile(canonicalPath: string): void {
    this.userPickedFiles.delete(canonicalPath)
    this.userPickedFiles.add(canonicalPath)
    if (this.userPickedFiles.size > MAX_USER_PICKED_FILES) {
      const oldest = this.userPickedFiles.values().next()
      if (!oldest.done) this.userPickedFiles.delete(oldest.value)
    }
  }

  private async ensureHtmlServerPort(): Promise<number | null> {
    if (this.disposed || this.dependencies.enableHtmlServer === false) return null
    if (this.htmlServerPort !== null) return this.htmlServerPort
    if (this.htmlServerStarting) return this.htmlServerStarting
    this.htmlServerStarting = new Promise<number | null>((resolvePort) => {
      const server = createServer((req, res) => {
        void this.serveHtmlAsset(req.method ?? '', req.url ?? '', res)
      })
      server.once('error', () => resolvePort(null))
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : null
        if (!port || this.disposed) {
          server.close()
          resolvePort(null)
          return
        }
        server.unref?.()
        this.htmlServer = server
        this.htmlServerPort = port
        resolvePort(port)
      })
    }).finally(() => {
      this.htmlServerStarting = null
    })
    return this.htmlServerStarting
  }

  private async serveHtmlAsset(
    method: string,
    rawUrl: string,
    res: { writeHead(status: number, headers?: Record<string, string>): void; end(chunk?: Buffer | string): void },
  ): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    try {
      const url = new URL(rawUrl, 'http://127.0.0.1')
      const segments = url.pathname.split('/').slice(1)
      const token = segments[0] ?? ''
      const encodedRel = segments.slice(1).join('/')
      const grant = this.htmlGrants.get(token)
      if (!grant || !encodedRel) {
        res.writeHead(404)
        res.end()
        return
      }
      let relPath: string
      try {
        relPath = decodeURIComponent(encodedRel)
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      if (!relPath || relPath.includes('\0') || relPath.includes('\\')) {
        res.writeHead(403)
        res.end()
        return
      }
      const resolved = resolve(grant.rootDir, relPath)
      if (!isWithinRoot(grant.rootDir, resolved)) {
        res.writeHead(403)
        res.end()
        return
      }
      const canonical = await realpath(resolved)
      if (!isWithinRoot(grant.rootDir, canonical)) {
        res.writeHead(403)
        res.end()
        return
      }
      if (grant.exactFile) {
        if (canonical !== grant.exactFile) {
          res.writeHead(403)
          res.end()
          return
        }
      } else {
        await this.dependencies.authorizeProjectPath(canonical)
      }
      const info = await lstat(canonical)
      if (!info.isFile() || info.size > MAX_IMAGE_PREVIEW_BYTES) {
        res.writeHead(info.isFile() ? 413 : 404)
        res.end()
        return
      }
      const ext = extname(canonical).toLowerCase()
      const contentType = ASSET_MIME_TYPES[ext] ?? IMAGE_MIME_TYPES[ext] ?? 'application/octet-stream'
      const body = method === 'HEAD' ? undefined : await readBoundedBytes(canonical, MAX_IMAGE_PREVIEW_BYTES)
      res.writeHead(200, {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  }

  private async registerHtmlPreviewUrl(canonicalFile: string, isUserPicked: boolean): Promise<string | undefined> {
    const port = await this.ensureHtmlServerPort()
    if (!port) return undefined
    const rootDir = dirname(canonicalFile)
    const entry: HtmlPreviewGrant = isUserPicked ? { rootDir, exactFile: canonicalFile } : { rootDir }
    for (const [existingToken, existingGrant] of this.htmlGrants) {
      if (existingGrant.rootDir === entry.rootDir && existingGrant.exactFile === entry.exactFile) {
        return `http://127.0.0.1:${port}/${existingToken}/${encodeURIComponent(basename(canonicalFile))}`
      }
    }
    const token = randomBytes(18).toString('hex')
    this.htmlGrants.set(token, entry)
    if (this.htmlGrants.size > MAX_HTML_PREVIEW_ROOTS) {
      const oldest = this.htmlGrants.keys().next()
      if (!oldest.done) this.htmlGrants.delete(oldest.value)
    }
    return `http://127.0.0.1:${port}/${token}/${encodeURIComponent(basename(canonicalFile))}`
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.htmlGrants.clear()
    const server = this.htmlServer
    this.htmlServer = null
    this.htmlServerPort = null
    if (!server) return
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }

  async pickFile(): Promise<PickedFileRecord | null> {
    const options: OpenDialogOptions = {
      title: 'Open file',
      properties: ['openFile'],
      filters: [
        { name: 'Supported files', extensions: ['md', 'markdown', 'mdx', 'txt', 'pdf', 'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'svg', 'heic', 'heif', 'tif', 'tiff', 'json', 'ts', 'tsx', 'js', 'jsx', 'css', 'html', 'yml', 'yaml'] },
        { name: 'Documents & Text', extensions: ['md', 'markdown', 'mdx', 'txt', 'pdf', 'log', 'csv', 'json', 'yaml', 'yml', 'toml', 'xml'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic', 'heif', 'tif', 'tiff'] },
        { name: 'All files', extensions: ['*'] },
      ],
    }
    const result = await (this.dependencies.openDialog
      ? this.dependencies.openDialog(options)
      : (() => {
          const parent = this.dependencies.windowProvider()
          return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
        })())
    if (result.canceled || result.filePaths.length !== 1) return null
    const picked = await requireExistingPath(result.filePaths[0], 'picked file')
    const stat = await lstat(picked)
    if (!stat.isFile()) throw new TypeError('Selected path must be a regular file')
    const canonical = await realpath(picked)
    this.rememberPickedFile(canonical)
    return { path: canonical, name: basename(canonical) || canonical }
  }

  async readFile(rawPathValue: unknown, rawBaseDirValue?: unknown): Promise<FilePreviewPayload> {
    const rawPath = requireString(rawPathValue, 'file path', { min: 1, max: 4096 })
    const rawBaseDir = rawBaseDirValue === undefined ? undefined : requireString(rawBaseDirValue, 'baseDir', { min: 1, max: 4096 })
    const resolved = normalizeRequestedPath(rawPath, rawBaseDir)
    const canonical = await requireExistingPath(resolved, 'file path')
    const stat = await lstat(canonical)
    if (!stat.isFile()) throw new TypeError('Preview target must be a regular file')

    const isUserPicked = this.userPickedFiles.has(canonical)
    if (!isUserPicked) {
      await this.dependencies.authorizeProjectPath(canonical)
    }

    const name = basename(canonical) || canonical
    const extension = extname(canonical).toLowerCase()
    const sizeBytes = stat.size

    if (extension === '.pdf') {
      if (sizeBytes > MAX_PDF_PREVIEW_BYTES) {
        return { kind: 'too-large', path: canonical, name, sizeBytes, maxBytes: MAX_PDF_PREVIEW_BYTES }
      }
      const bytes = await readBoundedBytes(canonical, MAX_PDF_PREVIEW_BYTES)
      return { kind: 'pdf', path: canonical, name, mimeType: 'application/pdf', base64: bytes.toString('base64'), sizeBytes }
    }

    const imageMimeType = IMAGE_MIME_TYPES[extension]
    if (imageMimeType) {
      if (sizeBytes > MAX_IMAGE_PREVIEW_BYTES) {
        return { kind: 'too-large', path: canonical, name, sizeBytes, maxBytes: MAX_IMAGE_PREVIEW_BYTES }
      }
      const bytes = await readBoundedBytes(canonical, MAX_IMAGE_PREVIEW_BYTES)
      return { kind: 'image', path: canonical, name, mimeType: imageMimeType, base64: bytes.toString('base64'), sizeBytes }
    }

    if (TRANSCODED_IMAGE_EXTENSIONS.has(extension)) {
      if (sizeBytes > MAX_PDF_PREVIEW_BYTES) {
        return { kind: 'too-large', path: canonical, name, sizeBytes, maxBytes: MAX_PDF_PREVIEW_BYTES }
      }
      const decoded = await (this.dependencies.decodeNativeImage ?? decodeOsImage)(canonical, extension)
      if (!decoded || decoded.bytes.length === 0 || decoded.bytes.length > MAX_IMAGE_PREVIEW_BYTES) {
        return { kind: 'unsupported', path: canonical, name, sizeBytes, extension }
      }
      return {
        kind: 'image',
        path: canonical,
        name,
        mimeType: decoded.mimeType,
        base64: decoded.bytes.toString('base64'),
        sizeBytes,
      }
    }

    if (MARKDOWN_EXTENSIONS.has(extension)) {
      const truncated = sizeBytes > MAX_TEXT_PREVIEW_BYTES
      const bytes = await readBoundedBytes(canonical, MAX_TEXT_PREVIEW_BYTES)
      return { kind: 'markdown', path: canonical, name, content: bytes.toString('utf8'), truncated, sizeBytes }
    }

    if (HTML_EXTENSIONS.has(extension)) {
      const truncated = sizeBytes > MAX_TEXT_PREVIEW_BYTES
      const bytes = await readBoundedBytes(canonical, MAX_TEXT_PREVIEW_BYTES)
      const previewUrl = await this.registerHtmlPreviewUrl(canonical, isUserPicked)
      return { kind: 'html', path: canonical, name, content: bytes.toString('utf8'), truncated, sizeBytes, previewUrl }
    }

    const knownText = TEXT_EXTENSIONS.has(extension) || TEXT_BASENAMES.has(name.toLowerCase())
    if (!knownText) {
      const sniffLength = Math.min(sizeBytes, BINARY_SNIFF_BYTES)
      const sniff = sniffLength > 0 ? await readBoundedBytes(canonical, sniffLength) : Buffer.alloc(0)
      if (sniff.includes(0)) {
        return { kind: 'unsupported', path: canonical, name, sizeBytes, extension }
      }
    }

    const truncated = sizeBytes > MAX_TEXT_PREVIEW_BYTES
    const bytes = await readBoundedBytes(canonical, MAX_TEXT_PREVIEW_BYTES)
    return { kind: 'text', path: canonical, name, content: bytes.toString('utf8'), truncated, sizeBytes }
  }
}
