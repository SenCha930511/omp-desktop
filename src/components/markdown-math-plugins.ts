import { useEffect, useSyncExternalStore } from 'react'
import remarkGfm from 'remark-gfm'
import type { PluggableList } from 'unified'
import { rehypeKatexCjkClass } from '@/lib/katex-cjk'

export interface MarkdownPluginSet {
  readonly remarkPlugins: PluggableList
  readonly rehypePlugins: PluggableList
}

export interface MarkdownMathPlugins extends MarkdownPluginSet {}

export type MarkdownMathState =
  | Readonly<{ status: 'not-needed' | 'idle' | 'loading'; plugins: MarkdownPluginSet; error?: never }>
  | Readonly<{ status: 'ready'; plugins: MarkdownMathPlugins; error?: never }>
  | Readonly<{ status: 'error'; plugins: MarkdownPluginSet; error: Error }>

const plainPlugins: MarkdownPluginSet = {
  remarkPlugins: [[remarkGfm, { singleTilde: false }]],
  rehypePlugins: [],
}

/** Theme-matched KaTeX rendering: errors reuse the danger color, and unusual
 *  Unicode input stays silent instead of spamming the console. */
const katexOptions = { errorColor: 'var(--danger)', strict: false } as const

const notNeededSnapshot: MarkdownMathState = { status: 'not-needed', plugins: plainPlugins }
const idleSnapshot: MarkdownMathState = { status: 'idle', plugins: plainPlugins }
const loadingSnapshot: MarkdownMathState = { status: 'loading', plugins: plainPlugins }
let snapshot: MarkdownMathState = idleSnapshot
let sharedPlugins: MarkdownMathPlugins | undefined
let sharedLoad: Promise<MarkdownMathPlugins> | undefined
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function noop(): void {}

function subscribeToNothing(): () => void {
  return noop
}

function getSnapshot(): MarkdownMathState {
  return snapshot
}

function getNotNeededSnapshot(): MarkdownMathState {
  return notNeededSnapshot
}

function publish(next: MarkdownMathState): void {
  snapshot = next
  for (const listener of listeners) listener()
}

/** Read only the module cache; calling this never starts an import. */
export function readMarkdownMathPlugins(): MarkdownMathPlugins | undefined {
  return sharedPlugins
}

export function preloadMarkdownMathPlugins(): Promise<MarkdownMathPlugins> {
  if (sharedLoad) return sharedLoad
  publish(loadingSnapshot)
  sharedLoad = (async () => {
    try {
      // The omp-desktop:// route serves KaTeX's local WOFF2 assets with the right MIME type.
      const [math, katex] = await Promise.all([
        import('remark-math'),
        import('rehype-katex'),
        import('katex/dist/katex.min.css'),
      ])
      const plugins: MarkdownMathPlugins = {
        remarkPlugins: [[remarkGfm, { singleTilde: false }], math.default],
        rehypePlugins: [[katex.default, katexOptions], rehypeKatexCjkClass],
      }
      sharedPlugins = plugins
      publish({ status: 'ready', plugins })
      return plugins
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause), { cause })
      publish({ status: 'error', plugins: plainPlugins, error })
      console.error('Loading Markdown math plugins failed:', error)
      throw error
    }
  })()
  return sharedLoad
}

export function useMarkdownMathPlugins(required: boolean): MarkdownMathState {
  const state = useSyncExternalStore(
    required ? subscribe : subscribeToNothing,
    required ? getSnapshot : getNotNeededSnapshot,
    required ? getSnapshot : getNotNeededSnapshot,
  )
  useEffect(() => {
    // Rejected loads stay cached; math blocks keep rendering safe plain Markdown.
    if (required && snapshot.status === 'idle') void preloadMarkdownMathPlugins().catch(noop)
  }, [required])
  return state
}
