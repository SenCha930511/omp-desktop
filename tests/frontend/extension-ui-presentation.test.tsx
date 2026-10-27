// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionUiPresentation } from '../../src/components/ExtensionUiPresentation'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

async function renderPresentation(props: Record<string, unknown>): Promise<void> {
  await act(async () => { root.render(createElement(ExtensionUiPresentation, props)) })
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  button.focus()
  await act(async () => { button.click() })
}

function aboveSection(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.extension-presentation--above')
}

function belowSection(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.extension-presentation--below')
}

function editorSection(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.extension-presentation__editor')
}

function openUrlSection(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.extension-presentation__open-url')
}

describe('extension presentation status and widgets', () => {
  it('renders status entries in order', async () => {
    await renderPresentation({
      status: [
        { key: 'build', text: 'running' },
        { key: 'tests', text: 'passing' },
      ],
    })
    const items = Array.from(document.querySelectorAll<HTMLElement>('.extension-presentation__status-item'))
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('build')
    expect(items[0]?.textContent).toContain('running')
    expect(items[1]?.textContent).toContain('tests')
    expect(items[1]?.textContent).toContain('passing')
  })

  it('renders widget lines as text, never raw HTML', async () => {
    await renderPresentation({
      widgets: [{ key: 'todo', lines: ['<img src=x onerror=alert(1)>', 'plain line'] }],
    })
    const widget = document.querySelector<HTMLElement>('.extension-presentation__widget')
    expect(widget).not.toBeNull()
    expect(widget?.querySelector('img')).toBeNull()
    expect(widget?.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(widget?.textContent).toContain('plain line')
  })

  it('places widgets by placement around the composer children', async () => {
    await renderPresentation({
      widgets: [
        { key: 'above', lines: ['above line'], placement: 'aboveEditor' },
        { key: 'default', lines: ['default line'] },
        { key: 'below', lines: ['below line'], placement: 'belowEditor' },
      ],
      children: createElement('div', { className: 'composer-marker' }, 'composer'),
    })
    expect(aboveSection()?.textContent).toContain('above line')
    expect(aboveSection()?.textContent).toContain('default line')
    expect(aboveSection()?.textContent).not.toContain('below line')
    expect(belowSection()?.textContent).toContain('below line')
    expect(belowSection()?.textContent).not.toContain('above line')
    // The composer children render between the two sections: the marker
    // follows the above section and precedes the below section.
    const marker = document.querySelector<HTMLElement>('.composer-marker')
    expect(marker).not.toBeNull()
    const above = aboveSection()
    const below = belowSection()
    expect(above).not.toBeNull()
    expect(below).not.toBeNull()
    expect(above!.compareDocumentPosition(marker!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(marker!.compareDocumentPosition(below!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('renders no presentation sections when there is nothing to show', async () => {
    await renderPresentation({ children: createElement('div', { className: 'composer-marker' }, 'composer') })
    expect(aboveSection()).toBeNull()
    expect(belowSection()).toBeNull()
    expect(document.querySelector('.composer-marker')).not.toBeNull()
  })
})

describe('extension presentation editor text updates', () => {
  it('shows the pending text with a preview and a conflict warning only when the draft is nonempty', async () => {
    await renderPresentation({
      editorText: { runtimeId: 'runtime-a', text: 'extension draft text' },
      composerDraft: '',
      activeRuntimeId: 'runtime-a',
    })
    expect(editorSection()).not.toBeNull()
    expect(editorSection()?.textContent).toContain('extension draft text')
    expect(document.querySelector('.extension-presentation__editor-conflict')).toBeNull()

    await renderPresentation({
      editorText: { runtimeId: 'runtime-a', text: 'extension draft text' },
      composerDraft: 'my own typing',
      activeRuntimeId: 'runtime-a',
    })
    expect(document.querySelector('.extension-presentation__editor-conflict')).not.toBeNull()
  })

  it('applies and dismisses the update only through explicit user action', async () => {
    const onApplyEditorText = vi.fn()
    const onDismissEditorText = vi.fn()
    await renderPresentation({
      editorText: { runtimeId: 'runtime-a', text: 'extension draft text' },
      composerDraft: 'my own typing',
      activeRuntimeId: 'runtime-a',
      onApplyEditorText,
      onDismissEditorText,
    })
    const buttons = Array.from(editorSection()?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    expect(buttons).toHaveLength(2)
    await clickButton(buttons[0])
    expect(onApplyEditorText).toHaveBeenCalledTimes(1)
    expect(onApplyEditorText).toHaveBeenCalledWith('extension draft text')
    await clickButton(buttons[1])
    expect(onDismissEditorText).toHaveBeenCalledTimes(1)
  })

  it('ignores editor text from a different runtime', async () => {
    await renderPresentation({
      editorText: { runtimeId: 'runtime-b', text: 'stale text' },
      composerDraft: '',
      activeRuntimeId: 'runtime-a',
    })
    expect(editorSection()).toBeNull()
  })

  it('renders nothing when there is no pending editor text', async () => {
    await renderPresentation({ editorText: null, composerDraft: '', activeRuntimeId: 'runtime-a' })
    expect(editorSection()).toBeNull()
  })
})

describe('extension presentation open url requests', () => {
  it('shows url, copy target, and instructions, and opens only on explicit action', async () => {
    const onOpenUrl = vi.fn()
    const onDismissOpenUrl = vi.fn()
    await renderPresentation({
      openUrl: { runtimeId: 'runtime-a', url: 'https://example.com/auth?state=abc', launchUrl: 'http://127.0.0.1:8945/cb', instructions: 'Open to log in' },
      activeRuntimeId: 'runtime-a',
      onOpenUrl,
      onDismissOpenUrl,
    })
    const section = openUrlSection()
    expect(section).not.toBeNull()
    expect(section?.textContent).toContain('https://example.com/auth?state=abc')
    expect(section?.textContent).toContain('http://127.0.0.1:8945/cb')
    expect(section?.textContent).toContain('Open to log in')
    const buttons = Array.from(section?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    expect(buttons).toHaveLength(2)
    await clickButton(buttons[0])
    expect(onOpenUrl).toHaveBeenCalledTimes(1)
    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com/auth?state=abc')
    await clickButton(buttons[1])
    expect(onDismissOpenUrl).toHaveBeenCalledTimes(1)
  })

  it('ignores open url requests from a different runtime', async () => {
    await renderPresentation({
      openUrl: { runtimeId: 'runtime-b', url: 'https://example.com/auth' },
      activeRuntimeId: 'runtime-a',
    })
    expect(openUrlSection()).toBeNull()
  })

  it('renders nothing when there is no open url request', async () => {
    await renderPresentation({ openUrl: null, activeRuntimeId: 'runtime-a' })
    expect(openUrlSection()).toBeNull()
  })
})
