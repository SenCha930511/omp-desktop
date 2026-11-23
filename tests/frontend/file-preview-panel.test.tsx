// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilePreviewPanel } from '../../src/components/inspector/FilePreviewPanel'
import { FilesPanel } from '../../src/components/inspector/FilesPanel'
import type { FilePreviewPayload, ProjectRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'desktop')
  vi.restoreAllMocks()
})

describe('FilePreviewPanel', () => {
  it('renders markdown and toggles raw source view', async () => {
    const read = vi.fn(async (): Promise<FilePreviewPayload> => ({
      kind: 'markdown',
      path: '/repo/README.md',
      name: 'README.md',
      content: '# Heading\n\n**Bold** text',
      truncated: false,
      sizeBytes: 22,
    }))
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { files: { read, pick: vi.fn() } },
    })

    await act(async () => {
      root.render(
        <FilePreviewPanel
          filePath="/repo/README.md"
          onOpenFile={vi.fn()}
          onReveal={vi.fn()}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('.file-preview__path')?.textContent).toBe('/repo/README.md')
    expect(container.querySelector('.file-preview__markdown h1')?.textContent).toBe('Heading')
    expect(container.querySelector('.file-preview__markdown strong')?.textContent).toBe('Bold')

    const toggleRaw = container.querySelector<HTMLButtonElement>('button[aria-label="Show raw source"]')!
    act(() => toggleRaw.click())
    expect(container.querySelector('.file-preview__code')).not.toBeNull()
    expect(container.querySelector('.file-preview__code')?.textContent).toContain('# Heading')
  })

  it('renders HTML preview in a partitioned webview, supports opening in a Browser tab, and toggles raw source', async () => {
    const read = vi.fn(async (): Promise<FilePreviewPayload> => ({
      kind: 'html',
      path: '/repo/demo.html',
      name: 'demo.html',
      content: '<h1>Hello HTML</h1>',
      truncated: false,
      sizeBytes: 19,
      previewUrl: 'http://127.0.0.1:41234/token/demo.html',
    }))
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { files: { read, pick: vi.fn() } },
    })

    const onOpenInBrowser = vi.fn()
    await act(async () => {
      root.render(
        <FilePreviewPanel
          filePath="/repo/demo.html"
          onOpenFile={vi.fn()}
          onOpenInBrowser={onOpenInBrowser}
          onReveal={vi.fn()}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    const webview = container.querySelector('webview.file-preview__webview')
    expect(webview?.getAttribute('src')).toBe('http://127.0.0.1:41234/token/demo.html')
    expect(webview?.getAttribute('partition')).toBe('persist:omp-desktop-browser')

    const openBrowserBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Open in Browser tab"]')!
    act(() => openBrowserBtn.click())
    expect(onOpenInBrowser).toHaveBeenCalledWith('http://127.0.0.1:41234/token/demo.html', 'demo.html')

    const toggleRaw = container.querySelector<HTMLButtonElement>('button[aria-label="Show raw source"]')!
    act(() => toggleRaw.click())
    expect(container.querySelector('.file-preview__code')?.textContent).toContain('<h1>Hello HTML</h1>')
  })

  it('renders text files, zoomable images, and revokes PDF blob URLs on unmount', async () => {
    const createObjectURL = vi.fn(() => 'blob:omp-desktop://app/pdf-1')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))

    const read = vi.fn(async (filePath: string): Promise<FilePreviewPayload> => {
      if (filePath.endsWith('.ts')) {
        return { kind: 'text', path: filePath, name: 'app.ts', content: 'const x = 1\nconst y = 2', truncated: false, sizeBytes: 23 }
      }
      if (filePath.endsWith('.png')) {
        return { kind: 'image', path: filePath, name: 'chart.png', mimeType: 'image/png', base64: 'iVBORw0KGgo=', sizeBytes: 8 }
      }
      return { kind: 'pdf', path: filePath, name: 'doc.pdf', mimeType: 'application/pdf', base64: 'JVBERi0xLjQK', sizeBytes: 9 }
    })
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { files: { read, pick: vi.fn() } },
    })

    await act(async () => {
      root.render(
        <FilePreviewPanel
          filePath="/repo/app.ts"
          onOpenFile={vi.fn()}
          onReveal={vi.fn()}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelectorAll('.file-preview__code-line')).toHaveLength(2)

    await act(async () => {
      root.render(
        <FilePreviewPanel
          filePath="/repo/chart.png"
          onOpenFile={vi.fn()}
          onReveal={vi.fn()}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    const img = container.querySelector<HTMLImageElement>('.file-preview__image')!
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')?.click())
    expect(img.style.width).toBe('125%')

    await act(async () => {
      root.render(
        <FilePreviewPanel
          filePath="/repo/doc.pdf"
          onOpenFile={vi.fn()}
          onReveal={vi.fn()}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    const iframe = container.querySelector<HTMLIFrameElement>('iframe.file-preview__pdf')!
    expect(iframe.getAttribute('src')).toBe('blob:omp-desktop://app/pdf-1')
    expect(createObjectURL).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:omp-desktop://app/pdf-1')
    root = createRoot(container)
  })

  it('opens files in preview on click in FilesPanel while retaining reveal button', async () => {
    const listFiles = vi.fn(async () => ({
      entries: [{ path: 'README.md', type: 'file' as const }],
      skipped: 0,
    }))
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { projects: { listFiles } },
    })
    const project: ProjectRecord = {
      id: 'p1',
      harness: 'omp',
      name: 'demo',
      path: '/repo',
      folders: ['/repo'],
      primaryFolder: '/repo',
      pinned: false,
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      sessionCount: 0,
    }
    const onOpenFile = vi.fn()
    const onReveal = vi.fn()

    await act(async () => {
      root.render(<FilesPanel project={project} git={{ isRepo: false, files: [] }} onReveal={onReveal} onOpenFile={onOpenFile} />)
      await Promise.resolve()
    })

    act(() => container.querySelector<HTMLButtonElement>('.file-tree__item.is-file')?.click())
    expect(onOpenFile).toHaveBeenCalledWith('/repo/README.md')
    expect(onReveal).not.toHaveBeenCalled()

    act(() => container.querySelector<HTMLButtonElement>('.file-tree__reveal')?.click())
    expect(onReveal).toHaveBeenCalledWith('/repo/README.md')
  })
})
