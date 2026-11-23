// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownText } from '../../src/components/MarkdownText'
import { Transcript } from '../../src/components/Transcript'
import { MarkdownWorkspaceProvider } from '../../src/lib/markdown-workspace'
import type { TranscriptMessage } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'desktop')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Markdown and model output images', () => {
  it('renders inline data-URI images directly via TranscriptImage', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo='
    act(() => {
      root.render(<MarkdownText text={`![Inline chart](${dataUri})`} />)
    })

    const img = container.querySelector<HTMLImageElement>('.markdown-image img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe(dataUri)
    expect(img?.getAttribute('alt')).toBe('Inline chart')
  })

  it('loads authorized local workspace images via desktop.files.read', async () => {
    const read = vi.fn(async () => ({
      kind: 'image' as const,
      path: '/workspace/project/charts/output.png',
      name: 'output.png',
      mimeType: 'image/png',
      base64: 'iVBORw0KGgo=',
      sizeBytes: 8,
    }))
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { files: { read, pick: vi.fn() } },
    })

    await act(async () => {
      root.render(
        <MarkdownWorkspaceProvider cwd="/workspace/project">
          <MarkdownText text="![Generated plot](./charts/output.png)" />
        </MarkdownWorkspaceProvider>,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(read).toHaveBeenCalledWith('./charts/output.png', '/workspace/project')
    const img = container.querySelector<HTMLImageElement>('.markdown-image img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(img?.getAttribute('alt')).toBe('Generated plot')
  })

  it('keeps remote https images blocked as placeholders and falls back cleanly on read errors', async () => {
    const read = vi.fn(async () => {
      throw new Error('path is not inside an added project')
    })
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { files: { read, pick: vi.fn() } },
    })

    await act(async () => {
      root.render(
        <MarkdownWorkspaceProvider cwd="/workspace/project">
          <MarkdownText text={'![Remote](https://example.com/a.png)\n\n![Missing](../secret.png)'} />
        </MarkdownWorkspaceProvider>,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('[Image: Remote]')
    expect(container.textContent).toContain('[Image: Missing]')
  })

  it('opens local markdown links in the workspace callback when provided', () => {
    const onOpenFile = vi.fn()
    act(() => {
      root.render(
        <MarkdownWorkspaceProvider cwd="/workspace/project" onOpenFile={onOpenFile}>
          <MarkdownText text="See [Report](./docs/report.md) for details." />
        </MarkdownWorkspaceProvider>,
      )
    })

    const button = container.querySelector<HTMLButtonElement>('.markdown-file-link')
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('Report')
    act(() => button?.click())
    expect(onOpenFile).toHaveBeenCalledWith('/workspace/project/docs/report.md')
  })

  it('renders image parts inside streaming ActiveAssistantMessage turns', () => {
    const messages: TranscriptMessage[] = [
      {
        id: 'assistant-streaming-1',
        role: 'assistant',
        streaming: true,
        parts: [
          { type: 'text', text: 'Here is the generated chart:' },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        ],
      },
    ]

    act(() => {
      root.render(
        <Transcript
          messages={messages}
          git={{ isRepo: false, files: [] }}
          active
          onOpenChanges={vi.fn()}
          onSuggestion={vi.fn()}
        />,
      )
    })

    const img = container.querySelector<HTMLImageElement>('img.image-part')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(img?.getAttribute('alt')).toBe('Model output image')
  })
})
