// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownMathPlugins, MarkdownMathState } from '../../src/components/markdown-math-plugins'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('remark-math')
  vi.doUnmock('rehype-katex')
  vi.doUnmock('katex/dist/katex.min.css')
})

describe('lazy Markdown math plugins', () => {
  it('shares one load promise and stable ready plugin arrays', async () => {
    vi.resetModules()
    const capability = await import('../../src/components/markdown-math-plugins')

    expect(capability.readMarkdownMathPlugins()).toBeUndefined()
    const firstLoad = capability.preloadMarkdownMathPlugins()
    const secondLoad = capability.preloadMarkdownMathPlugins()
    expect(secondLoad).toBe(firstLoad)

    const plugins = await firstLoad
    expect(capability.readMarkdownMathPlugins()).toBe(plugins)
    expect(capability.preloadMarkdownMathPlugins()).toBe(firstLoad)
    const cached = await secondLoad
    expect(cached).toBe(plugins)
    expect(cached.remarkPlugins).toBe(plugins.remarkPlugins)
    expect(cached.rehypePlugins).toBe(plugins.rehypePlugins)
    expect(cached.remarkPlugins).toHaveLength(2)
    expect(cached.rehypePlugins).toHaveLength(2)
  })

  it('loads concurrent math blocks once without rerendering plain blocks', async () => {
    vi.resetModules()
    const firstImport = Promise.withResolvers<void>()
    let remarkImports = 0
    let katexImports = 0
    let cssImports = 0
    vi.doMock('remark-math', async () => {
      remarkImports += 1
      await firstImport.promise
      return vi.importActual<typeof import('remark-math')>('remark-math')
    })
    vi.doMock('rehype-katex', async () => {
      katexImports += 1
      return vi.importActual<typeof import('rehype-katex')>('rehype-katex')
    })
    vi.doMock('katex/dist/katex.min.css', () => {
      cssImports += 1
      return {}
    })

    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const capability = await import('../../src/components/markdown-math-plugins')
    const { MarkdownText } = await import('../../src/components/MarkdownText')
    const host = document.createElement('div')
    const root = createRoot(host)
    const plainSnapshots: MarkdownMathState[] = []
    let plainRenders = 0
    let latestMathState: MarkdownMathState | undefined
    let loadedPlugins: MarkdownMathPlugins | undefined

    function PlainProbe() {
      plainRenders += 1
      const state = capability.useMarkdownMathPlugins(false)
      plainSnapshots.push(state)
      return <MarkdownText text="Plain **text** with [a safe link](https://example.test) and `code`." />
    }
    function MathProbe() {
      latestMathState = capability.useMarkdownMathPlugins(true)
      return null
    }
    function Harness() {
      return <>
        <PlainProbe />
        <MathProbe />
        <MarkdownText text="$x^2$" />
        <MarkdownText text="$$J = \\frac{類別間}{類別內}$$" />
      </>
    }

    try {
      await act(async () => root.render(<Harness />))
      expect(latestMathState?.status).toBe('loading')
      expect(capability.readMarkdownMathPlugins()).toBeUndefined()
      expect(host.querySelector('.katex')).toBeNull()
      expect(host.textContent).toContain('$x^2$')
      expect(host.querySelector('a[href="https://example.test"]')).not.toBeNull()
      const plainRendersBeforeReady = plainRenders

      const pending = capability.preloadMarkdownMathPlugins()
      expect(capability.preloadMarkdownMathPlugins()).toBe(pending)
      expect(remarkImports).toBe(1)
      expect(katexImports).toBe(1)
      expect(cssImports).toBe(1)

      await act(async () => {
        firstImport.resolve()
        loadedPlugins = await pending
      })
      expect(latestMathState?.status).toBe('ready')
      expect(capability.readMarkdownMathPlugins()).toBe(loadedPlugins)
      expect(latestMathState?.plugins).toBe(loadedPlugins)
      expect(host.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2)
      expect(host.querySelector('.katex--cjk')).not.toBeNull()
      expect(plainRenders).toBe(plainRendersBeforeReady)
      expect(new Set(plainSnapshots).size).toBe(1)
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('does not start math imports for Markdown without dollars', async () => {
    vi.resetModules()
    let remarkImports = 0
    let katexImports = 0
    let cssImports = 0
    vi.doMock('remark-math', () => {
      remarkImports += 1
      throw new Error('plain Markdown must not load remark-math')
    })
    vi.doMock('rehype-katex', () => {
      katexImports += 1
      throw new Error('plain Markdown must not load rehype-katex')
    })
    vi.doMock('katex/dist/katex.min.css', () => {
      cssImports += 1
      throw new Error('plain Markdown must not load KaTeX CSS')
    })

    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const capability = await import('../../src/components/markdown-math-plugins')
    const { MarkdownText } = await import('../../src/components/MarkdownText')
    const host = document.createElement('div')
    const root = createRoot(host)

    try {
      await act(async () => root.render(<MarkdownText text="Plain **text** with [a safe link](https://example.test) and `code`." />))
      expect(capability.readMarkdownMathPlugins()).toBeUndefined()
      expect(host.querySelector('strong')?.textContent).toBe('text')
      expect(host.querySelector('code')?.textContent).toBe('code')
      expect(host.querySelector('a[href="https://example.test"]')).not.toBeNull()
      expect(host.querySelector('.katex')).toBeNull()
      expect(remarkImports).toBe(0)
      expect(katexImports).toBe(0)
      expect(cssImports).toBe(0)
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('preserves committed Markdown DOM when a streaming tail becomes math', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const deferred = Promise.withResolvers<void>()
    vi.doMock('remark-math', async () => {
      await deferred.promise
      return vi.importActual<typeof import('remark-math')>('remark-math')
    })
    vi.doMock('rehype-katex', async () => vi.importActual<typeof import('rehype-katex')>('rehype-katex'))
    vi.doMock('katex/dist/katex.min.css', () => ({}))

    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const capability = await import('../../src/components/markdown-math-plugins')
    const { MarkdownText } = await import('../../src/components/MarkdownText')
    const host = document.createElement('div')
    const root = createRoot(host)

    try {
      await act(async () => root.render(<MarkdownText text={'Settled **value**\n\nTail'} streaming />))
      const committed = host.querySelector('strong')
      expect(committed?.textContent).toBe('value')
      expect(capability.readMarkdownMathPlugins()).toBeUndefined()

      await act(async () => root.render(<MarkdownText text={'Settled **value**\n\nTail\n\nA plain tail'} streaming />))
      await act(async () => root.render(<MarkdownText text={'Settled **value**\n\nTail\n\nA plain tail with $x^2$'} streaming />))
      expect(host.textContent).not.toContain('$x^2$')

      await act(async () => vi.advanceTimersByTimeAsync(100))
      expect(host.textContent).toContain('A plain tail')
      expect(host.textContent).toContain('$x^2$')
      expect(host.querySelector('.katex')).toBeNull()
      expect(host.querySelector('strong')).toBe(committed)

      await act(async () => {
        deferred.resolve()
        await capability.preloadMarkdownMathPlugins()
      })
      expect(host.querySelector('.katex')).not.toBeNull()
      expect(host.querySelector('strong')).toBe(committed)
    } finally {
      await act(async () => root.unmount())
      vi.useRealTimers()
    }
  })

  it('keeps a rejected CSS load readable, cached, and free of effect retries', async () => {
    vi.resetModules()
    const failure = new Error('KaTeX stylesheet unavailable')
    let cssImports = 0
    vi.doMock('remark-math', async () => vi.importActual<typeof import('remark-math')>('remark-math'))
    vi.doMock('rehype-katex', async () => vi.importActual<typeof import('rehype-katex')>('rehype-katex'))
    vi.doMock('katex/dist/katex.min.css', async () => {
      cssImports += 1
      throw failure
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const capability = await import('../../src/components/markdown-math-plugins')
    const { MarkdownText } = await import('../../src/components/MarkdownText')
    const host = document.createElement('div')
    const root = createRoot(host)
    const mathSnapshots: MarkdownMathState[] = []

    function MathProbe() {
      mathSnapshots.push(capability.useMarkdownMathPlugins(true))
      return null
    }
    function Harness() {
      return <>
        <MathProbe />
        <MarkdownText text="Keep $x + y$ readable with `$code$` and [a safe link](https://example.test)." />
      </>
    }

    try {
      await act(async () => root.render(<Harness />))
      const rejected = capability.preloadMarkdownMathPlugins()
      expect(capability.preloadMarkdownMathPlugins()).toBe(rejected)
      await act(async () => {
        await expect(rejected).rejects.toMatchObject({ cause: failure })
      })

      expect(capability.readMarkdownMathPlugins()).toBeUndefined()
      const errorState = mathSnapshots.at(-1)
      expect(errorState?.status).toBe('error')
      if (errorState?.status !== 'error') throw new Error('Math plugin error state was not published')
      expect(errorState.error).toMatchObject({ cause: failure })
      expect(new Set(mathSnapshots.map((state) => state.plugins)).size).toBe(1)
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(consoleError).toHaveBeenCalledWith('Loading Markdown math plugins failed:', errorState.error)
      expect(host.querySelector('.katex')).toBeNull()
      expect(host.textContent).toContain('$x + y$')
      expect(host.querySelector('code')?.textContent).toBe('$code$')
      expect(host.querySelector('a[href="https://example.test"]')).not.toBeNull()

      await act(async () => root.render(null))
      await act(async () => root.render(<Harness />))
      expect(capability.preloadMarkdownMathPlugins()).toBe(rejected)
      expect(cssImports).toBe(1)
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(host.textContent).toContain('$x + y$')
    } finally {
      await act(async () => root.unmount())
    }
  })
})
