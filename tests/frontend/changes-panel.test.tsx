// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangesCard } from '../../src/components/ChangesCard'
import { ChangesPanel } from '../../src/components/inspector/ChangesPanel'
import { ResizeHandle } from '../../src/components/ResizeHandle'
import { I18nProvider } from '../../src/lib/i18n'

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

describe('ChangesPanel status states', () => {
  it('reloads the selected diff after a same-path content update', async () => {
    const diff = vi.fn(async () => ({ text: 'old content' }))
    Object.defineProperty(window, 'desktop', { configurable: true, value: { git: { diff } } })
    const file = { path: 'file.txt', status: 'M', staged: false, additions: 1, deletions: 1 }
    await act(async () => {
      root.render(<ChangesPanel cwd="/project" git={{ isRepo: true, files: [{ ...file, contentHash: 'old' }] }} onRefreshGit={vi.fn()} />)
    })
    diff.mockResolvedValue({ text: 'new content' })
    await act(async () => {
      root.render(<ChangesPanel cwd="/project" git={{ isRepo: true, files: [{ ...file, contentHash: 'new' }] }} onRefreshGit={vi.fn()} />)
    })
    expect(diff).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('new content')
    expect(container.textContent).not.toContain('old content')
  })
  it('renders the no-repository state without an error banner', async () => {
    await act(async () => {
      root.render(<ChangesPanel cwd="/project" git={{ isRepo: false, files: [], error: 'Not a Git repository' }} onRefreshGit={vi.fn()} />)
    })
    expect(container.textContent).toContain('No Git repository')
    expect(container.textContent).not.toContain('Git status unavailable')
  })

  it('renders a distinct failure state with retry when the repo exists but status failed', async () => {
    const onRefreshGit = vi.fn()
    await act(async () => {
      root.render(<ChangesPanel cwd="/project" git={{ isRepo: true, files: [], error: 'Git status timed out; the result is unknown' }} onRefreshGit={onRefreshGit} />)
    })
    expect(container.textContent).toContain('Git status unavailable')
    expect(container.textContent).toContain('Git status timed out')
    expect(container.textContent).not.toContain('No Git repository')
    act(() => { container.querySelector('button')!.click() })
    expect(onRefreshGit).toHaveBeenCalledTimes(1)
  })
  it('dismisses the file changes card without opening the inspector', async () => {
    const onOpenChanges = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      root.render(<ChangesCard git={{ isRepo: true, files: [{ path: 'file.txt', status: 'M', staged: false, additions: 1, deletions: 0 }] }} onOpenChanges={onOpenChanges} onClose={onClose} />)
    })

    act(() => { container.querySelector<HTMLButtonElement>('.changes-card__close')!.click() })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onOpenChanges).not.toHaveBeenCalled()
  })

  it('confirms before undoing every changed file and opens the inspector from the review pill', async () => {
    const onOpenChanges = vi.fn()
    const onUndo = vi.fn()
    await act(async () => {
      root.render(
        <ChangesCard
          git={{ isRepo: true, files: [
            { path: 'src/one.ts', status: 'M', staged: false, additions: 3, deletions: 1 },
            { path: 'src/two.ts', status: 'M', staged: false, additions: 5, deletions: 2 },
          ] }}
          onOpenChanges={onOpenChanges}
          onUndo={onUndo}
        />,
      )
    })

    expect(container.textContent).toContain('2 files changed')
    const undo = container.querySelector<HTMLButtonElement>('.changes-card__undo')!
    act(() => { undo.click() })
    expect(onUndo).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Undo changes to 2 files?')

    act(() => { container.querySelector<HTMLButtonElement>('.changes-card__undo')!.click() })
    expect(onUndo).toHaveBeenCalledTimes(1)

    act(() => { container.querySelector<HTMLButtonElement>('.changes-card__review')!.click() })
    expect(onOpenChanges).toHaveBeenCalledTimes(1)
  })

  it('confirms undoing the selected file before restoring it', async () => {
    const restore = vi.fn(async () => true)
    const diff = vi.fn(async () => ({ path: 'file.txt', staged: false, text: '', truncated: false }))
    Object.defineProperty(window, 'desktop', { configurable: true, value: { git: { diff, restore } } })
    const onRefreshGit = vi.fn(async () => undefined)

    await act(async () => {
      root.render(<ChangesPanel cwd="/project" git={{ isRepo: true, files: [{ path: 'file.txt', status: 'M', staged: false, additions: 1, deletions: 0 }] }} onRefreshGit={onRefreshGit} />)
      await Promise.resolve()
    })
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('.diff-header button')].find((button) => button.textContent?.includes('Undo changes'))!.click()
    })
    expect(document.body.textContent).toContain('This discards the staged and unstaged changes')

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('.modal__footer button')].find((button) => button.textContent === 'Undo changes')!.click()
      await Promise.resolve()
    })
    expect(restore).toHaveBeenCalledWith('/project', ['file.txt'])
    expect(onRefreshGit).toHaveBeenCalledTimes(1)
  })

  it('disables mutating controls and offers an explicit grant for read-only projects', async () => {
    const onGrantProject = vi.fn(async () => undefined)
    const git = {
      isRepo: true,
      branch: 'main',
      files: [
        { path: 'file.txt', status: 'M', staged: false, additions: 1, deletions: 0 },
        { path: 'staged.txt', status: 'M', staged: true, additions: 1, deletions: 0 },
      ],
    }

    await act(async () => {
      root.render(<ChangesPanel git={git} readOnly onGrantProject={onGrantProject} onRefreshGit={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('read-only because it was discovered from session history')
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label)!
    expect(button('Stage').disabled).toBe(true)
    expect(button('Stage all').disabled).toBe(true)
    expect(button('Undo changes').disabled).toBe(true)
    expect(button('Commit').disabled).toBe(true)
    await act(async () => { button('Add project').click(); await Promise.resolve() })
    expect(onGrantProject).toHaveBeenCalledTimes(1)

    act(() => { button('Staged').click() })
    expect(button('Unstage').disabled).toBe(true)
    expect(button('Unstage all').disabled).toBe(true)
  })

  it('keeps mutating controls enabled for persisted projects', async () => {
    const git = {
      isRepo: true,
      branch: 'main',
      files: [
        { path: 'file.txt', status: 'M', staged: false, additions: 1, deletions: 0 },
        { path: 'staged.txt', status: 'M', staged: true, additions: 1, deletions: 0 },
      ],
    }

    await act(async () => {
      root.render(<ChangesPanel git={git} onRefreshGit={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label)!
    expect(button('Stage').disabled).toBe(false)
    expect(button('Stage all').disabled).toBe(false)
    expect(button('Undo changes').disabled).toBe(false)
    expect(button('Commit').disabled).toBe(false)
    act(() => { button('Staged').click() })
    expect(button('Unstage').disabled).toBe(false)
    expect(button('Unstage all').disabled).toBe(false)
  })
})

describe('localized diff and resize controls', () => {
  it.each([
    { locale: 'en', split: 'Split diff view', unified: 'Unified diff view', copy: 'Copy diff' },
    { locale: 'zh-TW', split: '分割差異檢視', unified: '統一差異檢視', copy: '複製差異' },
    { locale: 'zh-CN', split: '拆分差异视图', unified: '统一差异视图', copy: '复制差异' },
  ] as const)('localizes diff titles for $locale without translating repository data', async ({ locale, split, unified, copy }) => {
    const filePath = 'src/原始 <file>&.tsx'
    const rawDiff = [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      '@@ -1 +1 @@',
      '-const label = "Upstream"',
      '+const label = "上游"',
    ].join('\n')
    const diff = vi.fn(async () => ({ text: rawDiff }))
    Object.defineProperty(window, 'desktop', { configurable: true, value: { git: { diff } } })

    await act(async () => {
      root.render(
        <I18nProvider preference={locale}>
          <ChangesPanel cwd="/project" git={{ isRepo: true, files: [{ path: filePath, status: 'M', staged: false, additions: 1, deletions: 1 }] }} onRefreshGit={vi.fn()} />
        </I18nProvider>,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    const toggle = container.querySelector<HTMLButtonElement>(`.diff-header button[title="${split}"]`)!
    const copyButton = container.querySelector<HTMLButtonElement>(`.diff-header button[title="${copy}"]`)!
    const fileName = container.querySelector<HTMLSpanElement>('.diff-header > div > span')!
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(copyButton.disabled).toBe(false)
    expect(fileName.textContent).toBe(filePath)
    expect([...container.querySelectorAll('.diff-view code')].map((line) => line.textContent).join('\n')).toBe(rawDiff)

    act(() => { toggle.click() })
    const unifiedToggle = container.querySelector<HTMLButtonElement>(`.diff-header button[title="${unified}"]`)!
    expect(unifiedToggle.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector(`.diff-header button[title="${copy}"]`)).toBe(copyButton)
    expect([...container.querySelectorAll('.diff-view code')].map((line) => line.textContent).join('\n')).toBe(rawDiff)
    expect(fileName.textContent).toBe(filePath)
  })

  it.each([
    { locale: 'en', suffix: 'double-click to reset' },
    { locale: 'zh-TW', suffix: '按兩下即可重設' },
    { locale: 'zh-CN', suffix: '双击以重置' },
  ] as const)('localizes only the reset suffix for $locale', ({ locale, suffix }) => {
    const label = 'Upstream panel 名稱'
    const onChange = vi.fn()
    act(() => {
      root.render(
        <I18nProvider preference={locale}>
          <ResizeHandle orientation="vertical" label={label} value={400} min={200} max={600} defaultValue={320} onChange={onChange} />
        </I18nProvider>,
      )
    })

    const handle = container.querySelector<HTMLElement>('[role="separator"]')!
    expect(handle.getAttribute('aria-label')).toBe(label)
    expect(handle.title).toBe(`${label} · ${suffix}`)
    act(() => { handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith(320)
  })
})
