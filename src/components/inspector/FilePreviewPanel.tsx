import { Check, Code2, Copy, Eye, FolderOpen, RefreshCw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { basename } from '@/lib/data'
import { writeClipboardText } from '@/lib/clipboard'
import { errorMessage } from '@/lib/errors'
import { useI18n } from '@/lib/i18n'
import { MarkdownWorkspaceProvider } from '@/lib/markdown-workspace'
import type { FilePreviewPayload } from '@/types/api'
import { MarkdownText } from '../MarkdownText'
import { tokenizeSyntaxLine } from '../transcript/syntax'
import { EmptyState, IconButton } from '../ui'

export interface FilePreviewPanelProps {
  files: string[]
  activeFile: string | null
  onSelectFile(path: string): void
  onCloseFile(path: string): void
  onOpenFile(path: string): void
  onReveal(path: string): void
}

const MAX_SYNTAX_HIGHLIGHT_LINES = 4_000
const MIN_IMAGE_ZOOM = 25
const MAX_IMAGE_ZOOM = 400

function parentDirectory(filePath: string): string | undefined {
  if (filePath.startsWith('file://')) return undefined
  const slashIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (slashIndex <= 0) return undefined
  return filePath.slice(0, slashIndex)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function decodeBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function FilePreviewPanel({
  files,
  activeFile,
  onSelectFile,
  onCloseFile,
  onOpenFile,
  onReveal,
}: FilePreviewPanelProps) {
  const { t } = useI18n()
  const [payload, setPayload] = useState<FilePreviewPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [markdownRaw, setMarkdownRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const [imageZoom, setImageZoom] = useState<number | 'fit'>('fit')
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null)
  const loadSeqRef = useRef(0)
  const copyTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(copyTimerRef.current), [])

  const loadFile = useCallback(async (targetPath: string | null) => {
    const seq = ++loadSeqRef.current
    setError('')
    setCopied(false)
    setImageZoom('fit')
    if (!targetPath) {
      setPayload(null)
      setLoading(false)
      return
    }
    if (typeof window === 'undefined' || !window.desktop?.files?.read) {
      setPayload(null)
      setLoading(false)
      setError(t('filePreview.desktopRequired'))
      return
    }
    setLoading(true)
    try {
      const next = await window.desktop.files.read(targetPath)
      if (loadSeqRef.current !== seq) return
      setPayload(next)
      setMarkdownRaw(false)
    } catch (reason) {
      if (loadSeqRef.current !== seq) return
      setPayload(null)
      setError(errorMessage(reason))
    } finally {
      if (loadSeqRef.current === seq) setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadFile(activeFile)
  }, [activeFile, loadFile])

  useEffect(() => {
    if (payload?.kind !== 'pdf' || typeof URL.createObjectURL !== 'function') {
      setPdfBlobUrl(null)
      return
    }
    const bytes = decodeBase64ToBytes(payload.base64)
    const blob = new Blob([bytes], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    setPdfBlobUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [payload])

  const pickAndOpenFile = async () => {
    if (!window.desktop?.files?.pick) return
    try {
      const picked = await window.desktop.files.pick()
      if (picked) onOpenFile(picked.path)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  const textLines = useMemo(() => {
    if (!payload || (payload.kind !== 'text' && payload.kind !== 'markdown')) return []
    return payload.content.split('\n')
  }, [payload])

  const highlightLines = textLines.length <= MAX_SYNTAX_HIGHLIGHT_LINES

  const copyContent = async () => {
    if (!payload || (payload.kind !== 'text' && payload.kind !== 'markdown')) return
    try {
      await writeClipboardText(payload.content)
      setCopied(true)
      window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="file-preview">
      <div className="file-preview__header">
        <div className="file-preview__tabs" role="tablist" aria-label={t('filePreview.tabsAria')}>
          {files.map((filePath) => {
            const active = filePath === activeFile
            const name = basename(filePath) || filePath
            return (
              <div key={filePath} className={`file-preview__tab${active ? ' is-active' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={filePath}
                  className="file-preview__tab-button"
                  onClick={() => onSelectFile(filePath)}
                >
                  <span>{name}</span>
                </button>
                <button
                  type="button"
                  className="file-preview__tab-close"
                  aria-label={t('filePreview.closeFile', { name })}
                  onClick={() => onCloseFile(filePath)}
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
        </div>
        <div className="file-preview__actions">
          <button type="button" className="file-preview__open-btn" onClick={() => void pickAndOpenFile()}>
            <FolderOpen size={13} />
            <span>{t('filePreview.openFile')}</span>
          </button>
          {payload?.kind === 'markdown' ? (
            <IconButton
              size="small"
              label={markdownRaw ? t('filePreview.showRendered') : t('filePreview.showRaw')}
              onClick={() => setMarkdownRaw((value) => !value)}
            >
              {markdownRaw ? <Eye size={13} /> : <Code2 size={13} />}
            </IconButton>
          ) : null}
          {payload && (payload.kind === 'text' || payload.kind === 'markdown') ? (
            <IconButton size="small" label={copied ? t('transcript.copied.label') : t('transcript.copy.label')} onClick={() => void copyContent()}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </IconButton>
          ) : null}
          {activeFile ? (
            <>
              <IconButton size="small" label={t('filePreview.reload')} onClick={() => void loadFile(activeFile)}>
                <RefreshCw className={loading ? 'spin' : ''} size={13} />
              </IconButton>
              <IconButton size="small" label={t('filePreview.reveal')} onClick={() => onReveal(activeFile)}>
                <FolderOpen size={13} />
              </IconButton>
            </>
          ) : null}
        </div>
      </div>

      <div className="file-preview__body scroll-area">
        {!activeFile ? (
          <EmptyState
            icon={<Eye size={24} />}
            title={t('filePreview.empty.title')}
            action={
              <button type="button" className="button button--secondary" onClick={() => void pickAndOpenFile()}>
                {t('filePreview.openFile')}
              </button>
            }
          >
            {t('filePreview.empty.body')}
          </EmptyState>
        ) : loading ? (
          <p className="file-preview__status">{t('filePreview.loading')}</p>
        ) : error ? (
          <div className="file-preview__notice">
            <p>{t('filePreview.error', { error })}</p>
            <button type="button" className="button button--secondary" onClick={() => onReveal(activeFile)}>
              {t('filePreview.reveal')}
            </button>
          </div>
        ) : payload?.kind === 'markdown' && !markdownRaw ? (
          <div className="file-preview__markdown">
            {payload.truncated ? <p className="file-preview__truncated">{t('filePreview.truncated')}</p> : null}
            <MarkdownWorkspaceProvider cwd={parentDirectory(payload.path)} onOpenFile={onOpenFile}>
              <MarkdownText text={payload.content} />
            </MarkdownWorkspaceProvider>
          </div>
        ) : payload?.kind === 'text' || (payload?.kind === 'markdown' && markdownRaw) ? (
          <div className="file-preview__code-wrap">
            {payload.truncated ? <p className="file-preview__truncated">{t('filePreview.truncated')}</p> : null}
            <pre className="file-preview__code" dir="ltr">
              <code>
                {textLines.map((line, index) => (
                  <div className="file-preview__code-line" key={index}>
                    <span className="file-preview__line-number" aria-hidden="true">{index + 1}</span>
                    <span className="file-preview__line-text">
                      {highlightLines
                        ? tokenizeSyntaxLine(line).map((token, tokenIndex) =>
                            token.kind === 'plain' ? (
                              <Fragment key={tokenIndex}>{token.text}</Fragment>
                            ) : (
                              <span className={`syntax-${token.kind}`} key={tokenIndex}>
                                {token.text}
                              </span>
                            ),
                          )
                        : line}
                      {line === '' ? '\u00A0' : null}
                    </span>
                  </div>
                ))}
              </code>
            </pre>
          </div>
        ) : payload?.kind === 'image' ? (
          <div className="file-preview__image-wrap">
            <div className="file-preview__image-toolbar">
              <IconButton
                size="small"
                label={t('filePreview.zoomOut')}
                onClick={() => setImageZoom((current) => Math.max(MIN_IMAGE_ZOOM, (current === 'fit' ? 100 : current) - 25))}
              >
                <ZoomOut size={13} />
              </IconButton>
              <button type="button" className="file-preview__zoom-reset" onClick={() => setImageZoom((current) => (current === 'fit' ? 100 : 'fit'))}>
                {imageZoom === 'fit' ? t('filePreview.zoomFit') : `${imageZoom}%`}
              </button>
              <IconButton
                size="small"
                label={t('filePreview.zoomIn')}
                onClick={() => setImageZoom((current) => Math.min(MAX_IMAGE_ZOOM, (current === 'fit' ? 100 : current) + 25))}
              >
                <ZoomIn size={13} />
              </IconButton>
            </div>
            <div className="file-preview__image-stage">
              <img
                className={`file-preview__image${imageZoom === 'fit' ? ' is-fit' : ''}`}
                style={imageZoom === 'fit' ? undefined : { width: `${imageZoom}%` }}
                src={`data:${payload.mimeType};base64,${payload.base64}`}
                alt={payload.name}
              />
            </div>
          </div>
        ) : payload?.kind === 'pdf' ? (
          pdfBlobUrl ? (
            <iframe className="file-preview__pdf" src={pdfBlobUrl} title={payload.name} />
          ) : (
            <p className="file-preview__status">{t('filePreview.loading')}</p>
          )
        ) : payload?.kind === 'too-large' ? (
          <div className="file-preview__notice">
            <p>{t('filePreview.tooLarge', { name: payload.name, size: formatBytes(payload.sizeBytes), max: formatBytes(payload.maxBytes) })}</p>
            <button type="button" className="button button--secondary" onClick={() => onReveal(payload.path)}>
              {t('filePreview.reveal')}
            </button>
          </div>
        ) : payload?.kind === 'unsupported' ? (
          <div className="file-preview__notice">
            <p>{t('filePreview.unsupported', { name: payload.name, size: formatBytes(payload.sizeBytes) })}</p>
            <button type="button" className="button button--secondary" onClick={() => onReveal(payload.path)}>
              {t('filePreview.reveal')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
