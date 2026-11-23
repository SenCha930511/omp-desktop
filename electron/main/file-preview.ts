import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { open as openFileHandle, lstat, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FilePreviewPayload, PickedFileRecord } from '../../src/types/api'
import { requireExistingPath, requireString } from './validation'

export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024
export const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024
export const MAX_PDF_PREVIEW_BYTES = 25 * 1024 * 1024
const MAX_USER_PICKED_FILES = 64
const BINARY_SNIFF_BYTES = 8 * 1024

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx'])

const TEXT_EXTENSIONS = new Set([
  '.txt', '.log', '.csv', '.tsv', '.json', '.jsonc', '.jsonl',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.xml',
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

  constructor(private readonly dependencies: FilePreviewDependencies) {}

  private rememberPickedFile(canonicalPath: string): void {
    this.userPickedFiles.delete(canonicalPath)
    this.userPickedFiles.add(canonicalPath)
    if (this.userPickedFiles.size > MAX_USER_PICKED_FILES) {
      const oldest = this.userPickedFiles.values().next()
      if (!oldest.done) this.userPickedFiles.delete(oldest.value)
    }
  }

  async pickFile(): Promise<PickedFileRecord | null> {
    const options: OpenDialogOptions = {
      title: 'Open file',
      properties: ['openFile'],
      filters: [
        { name: 'Supported files', extensions: ['md', 'markdown', 'mdx', 'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'json', 'ts', 'tsx', 'js', 'jsx', 'css', 'html', 'yml', 'yaml'] },
        { name: 'Documents & Text', extensions: ['md', 'markdown', 'mdx', 'txt', 'pdf', 'log', 'csv', 'json', 'yaml', 'yml', 'toml', 'xml'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'] },
        { name: 'All files', extensions: ['*'] },
      ],
    }
    const result = this.dependencies.openDialog
      ? await this.dependencies.openDialog(options)
      : (() => {
          const parent = this.dependencies.windowProvider()
          return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
        })()
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

    if (!this.userPickedFiles.has(canonical)) {
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

    if (MARKDOWN_EXTENSIONS.has(extension)) {
      const truncated = sizeBytes > MAX_TEXT_PREVIEW_BYTES
      const bytes = await readBoundedBytes(canonical, MAX_TEXT_PREVIEW_BYTES)
      return { kind: 'markdown', path: canonical, name, content: bytes.toString('utf8'), truncated, sizeBytes }
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
