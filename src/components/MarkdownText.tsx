import { Check, Copy } from 'lucide-react'
import { type ComponentPropsWithoutRef, Fragment, isValidElement, type MouseEvent, memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { Components, ExtraProps } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { writeClipboardText } from '@/lib/clipboard'
import { openExternalUrl } from '@/lib/desktop-actions'
import { useI18n } from '@/lib/i18n'
import { tokenizeSyntax } from './transcript/syntax'

interface MarkdownTextProps {
  text: string
  /** Actively streaming text throttles Markdown re-parses to a coherent committed snapshot. */
  streaming?: boolean
}

function openMarkdownLink(event: MouseEvent<HTMLAnchorElement>, href?: string): void {
  if (!href) return
  event.preventDefault()
  if (href.startsWith('#')) {
    try {
      document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start' })
    } catch {
      /* malformed fragment */
    }
    return
  }
  if (!/^(https?:|mailto:)/i.test(href)) return
  if (window.desktop) {
    void openExternalUrl(window.desktop.app, href).then((failure) => {
      // Transcript links have no toast surface of their own; the refusal still
      // has to leave a trace instead of looking like a dead link.
      if (failure) console.error('Opening a transcript link failed:', failure)
    })
    return
  }
  window.open(href, '_blank', 'noopener,noreferrer')
}

function MarkdownLink({ node: _node, href, children, ...props }: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  const { t } = useI18n()
  return href && /^(https?:|mailto:|#)/i.test(href) ? (
    <a {...props} href={href} rel="noreferrer" onClick={(event) => openMarkdownLink(event, href)}>
      <bdi>{children}</bdi>
    </a>
  ) : (
    <span className="markdown-link-unsupported" title={href ? t('transcript.markdown.projectRelativeLink', { href }) : undefined}>
      {children}
    </span>
  )
}

function MarkdownImage({ alt }: ComponentPropsWithoutRef<'img'> & ExtraProps) {
  const { t } = useI18n()
  return <span className="markdown-image-placeholder">{t('transcript.markdown.image', { label: alt || t('transcript.markdown.imageFallback') })}</span>
}

export const CODE_BLOCK_COPY_RESET_MS = 2_500

function extractCodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractCodeText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return extractCodeText(node.props.children)
  return ''
}

function MarkdownCodeBlock({ node: _node, children, ...props }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(resetTimerRef.current), [])

  const codeElement = isValidElement<ComponentPropsWithoutRef<'code'> & ExtraProps>(children) ? children : null
  const codeClassName = codeElement?.props.className
  const languageMatch = typeof codeClassName === 'string' ? /language-([a-z0-9_+-]+)/i.exec(codeClassName) : null
  const language = languageMatch?.[1]?.toLowerCase() ?? 'text'
  const rawCode = extractCodeText(codeElement ? codeElement.props.children : children)
  const codeText = rawCode.replace(/\n$/, '')
  const lines = useMemo(() => codeText.split('\n'), [codeText])
  const copyLabel = t(copied ? 'transcript.copied.label' : 'transcript.copy.label')

  const handleCopy = () => {
    void writeClipboardText(codeText)
      .then(() => {
        setCopied(true)
        window.clearTimeout(resetTimerRef.current)
        resetTimerRef.current = window.setTimeout(() => setCopied(false), CODE_BLOCK_COPY_RESET_MS)
      })
      .catch(() => {
        setCopied(false)
      })
  }

  return (
    <div className="markdown-code-block" dir="ltr">
      <div className="markdown-code-block__header">
        <span className="markdown-code-block__lang" data-lang={language} />
        <button type="button" className={`markdown-code-block__copy${copied ? ' is-copied' : ''}`} aria-label={copyLabel} title={copyLabel} onClick={handleCopy}>
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        </button>
      </div>
      <pre {...props} dir="ltr">
        <code className={codeClassName} dir="ltr">
          {lines.map((line, lineIndex) => (
            <Fragment key={`${lineIndex}-${line.slice(0, 12)}`}>
              {tokenizeSyntax(line).map((token, tokenIndex) =>
                token.kind === 'plain' ? (
                  <Fragment key={`${tokenIndex}-${token.text.slice(0, 8)}`}>{token.text}</Fragment>
                ) : (
                  <span className={`syntax-${token.kind}`} key={`${tokenIndex}-${token.text.slice(0, 8)}`}>
                    {token.text}
                  </span>
                ),
              )}
              {lineIndex < lines.length - 1 ? '\n' : null}
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  )
}

const markdownPlugins = [remarkGfm]

/**
 * Each block resolves its own base direction from its first strong character.
 * The browser skips descendants that carry their own `dir`, so a paragraph
 * opening with LTR code still lays out RTL prose correctly.
 */
const markdownComponents: Components = {
  a: MarkdownLink,
  blockquote: ({ node: _node, ...props }) => <blockquote {...props} dir="auto" />,
  code: ({ node: _node, children, ...props }) => (
    <code {...props} dir="ltr">
      {children}
    </code>
  ),
  h1: ({ node: _node, ...props }) => <h1 {...props} dir="auto" />,
  h2: ({ node: _node, ...props }) => <h2 {...props} dir="auto" />,
  h3: ({ node: _node, ...props }) => <h3 {...props} dir="auto" />,
  h4: ({ node: _node, ...props }) => <h4 {...props} dir="auto" />,
  h5: ({ node: _node, ...props }) => <h5 {...props} dir="auto" />,
  h6: ({ node: _node, ...props }) => <h6 {...props} dir="auto" />,
  img: MarkdownImage,
  li: ({ node: _node, ...props }) => <li {...props} dir="auto" />,
  ol: ({ node: _node, ...props }) => <ol {...props} dir="auto" />,
  p: ({ node: _node, ...props }) => <p {...props} dir="auto" />,
  pre: MarkdownCodeBlock,
  td: ({ node: _node, ...props }) => <td {...props} dir="auto" />,
  th: ({ node: _node, ...props }) => <th {...props} dir="auto" />,
  ul: ({ node: _node, ...props }) => <ul {...props} dir="auto" />,
}

export const STREAMING_PARSE_INTERVAL_MS = 100

export interface StreamingParseState {
  /** How much of the text is committed to the Markdown parser. */
  boundary: number
  lastParseAt: number
}

/**
 * Decides how much of a streaming message to hand to the Markdown parser: the
 * boundary advances at most every STREAMING_PARSE_INTERVAL_MS, or immediately
 * when the unparsed tail crossed a newline; otherwise the caller keeps the
 * previous coherent snapshot visible and retries after `delayMs`.
 */
export function advanceStreamingParse(state: StreamingParseState, textLength: number, newlineInTail: boolean, now: number): { state: StreamingParseState; delayMs?: number } {
  if (state.boundary >= textLength) {
    return state.boundary === textLength ? { state } : { state: { boundary: textLength, lastParseAt: now } }
  }
  const elapsed = now - state.lastParseAt
  if (newlineInTail || elapsed >= STREAMING_PARSE_INTERVAL_MS) {
    return { state: { boundary: textLength, lastParseAt: now } }
  }
  return { state, delayMs: STREAMING_PARSE_INTERVAL_MS - elapsed }
}

/** Render model-authored Markdown without enabling raw HTML or remote images. */
export const MarkdownText = memo(function MarkdownText({ text, streaming = false }: MarkdownTextProps) {
  const parseStateRef = useRef<StreamingParseState>({ boundary: text.length, lastParseAt: 0 })
  const [, setParseRevision] = useState(0)

  useEffect(() => {
    if (!streaming) {
      if (parseStateRef.current.boundary !== text.length) {
        parseStateRef.current = { boundary: text.length, lastParseAt: parseStateRef.current.lastParseAt }
        setParseRevision((revision) => revision + 1)
      }
      return
    }
    const decide = (): number | undefined => {
      const current = parseStateRef.current
      const newlineInTail = text.indexOf('\n', Math.min(current.boundary, text.length)) !== -1
      const result = advanceStreamingParse(current, text.length, newlineInTail, Date.now())
      if (result.state !== current) {
        parseStateRef.current = result.state
        setParseRevision((revision) => revision + 1)
      }
      return result.delayMs
    }
    const delayMs = decide()
    if (delayMs === undefined) return
    const timer = window.setTimeout(() => {
      decide()
    }, delayMs)
    return () => window.clearTimeout(timer)
  }, [streaming, text])

  const boundary = streaming ? Math.min(parseStateRef.current.boundary, text.length) : text.length
  const parsedText = boundary === text.length ? text : text.slice(0, boundary)
  // Keep the committed Markdown subtree intact between parses. Rendering the
  // unparsed suffix as a sibling block makes punctuation and partial words
  // jump onto separate lines while tokens are still arriving.
  const markdown = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={markdownPlugins} skipHtml components={markdownComponents}>
        {parsedText}
      </ReactMarkdown>
    ),
    [parsedText],
  )
  return <div className="prose">{markdown}</div>
})
