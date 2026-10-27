import type { ReactNode } from 'react'
import { commandOutputText } from '@/lib/command-output'
import type { ExtensionUiCapabilityNotice } from '@/lib/extension-capabilities'
import { useI18n } from '@/lib/i18n'

export interface ExtensionPresentationStatus {
  key: string
  text: string
}

export interface ExtensionPresentationWidget {
  key: string
  lines: string[]
  placement?: 'aboveEditor' | 'belowEditor'
}

export interface ExtensionPresentationEditorText {
  runtimeId: string
  text: string
}

export interface ExtensionPresentationOpenUrl {
  runtimeId: string
  url: string
  launchUrl?: string
  instructions?: string
}

interface ExtensionUiPresentationProps {
  status?: ExtensionPresentationStatus[]
  widgets?: ExtensionPresentationWidget[]
  editorText?: ExtensionPresentationEditorText | null
  openUrl?: ExtensionPresentationOpenUrl | null
  capabilityNotices?: ExtensionUiCapabilityNotice[]
  composerDraft?: string
  activeRuntimeId?: string
  onApplyEditorText?(text: string): void
  onDismissEditorText?(): void
  onOpenUrl?(url: string): void
  onDismissOpenUrl?(): void
  onDismissCapabilityNotice?(noticeId: string): void
  children?: ReactNode
}

/**
 * Renders extension presentation state around the composer: status entries,
 * widgets (above/below the editor per their placement), an explicit
 * apply/dismiss prompt for pending editor text (never a silent overwrite of
 * what the user typed), and a safe open-url prompt that only acts on explicit
 * user action. All content is rendered as text — never raw HTML.
 */
export function ExtensionUiPresentation({
  status = [],
  widgets = [],
  editorText = null,
  openUrl = null,
  capabilityNotices = [],
  composerDraft = '',
  activeRuntimeId,
  onApplyEditorText,
  onDismissEditorText,
  onOpenUrl,
  onDismissOpenUrl,
  onDismissCapabilityNotice,
  children,
}: ExtensionUiPresentationProps) {
  const { t } = useI18n()
  // Stale runtime guard: updates scoped to another runtime never render, so a
  // session switch cannot surface (or apply) another session's pending state.
  const editorTextCurrent = editorText && (activeRuntimeId === undefined || editorText.runtimeId === activeRuntimeId) ? editorText : null
  const openUrlCurrent = openUrl && (activeRuntimeId === undefined || openUrl.runtimeId === activeRuntimeId) ? openUrl : null
  const aboveWidgets = widgets.filter((widget) => widget.placement !== 'belowEditor')
  const belowWidgets = widgets.filter((widget) => widget.placement === 'belowEditor')
  const showAbove = status.length > 0 || aboveWidgets.length > 0 || editorTextCurrent !== null || openUrlCurrent !== null || capabilityNotices.length > 0

  return (
    <>
      {showAbove ? (
        <div className="extension-presentation extension-presentation--above">
          {capabilityNotices.length > 0 ? (
            <div className="extension-presentation__notices" role="status">
              {capabilityNotices.map((notice) => (
                <span className="extension-presentation__notice" key={notice.id}>
                  <span>{notice.kind === 'unknown'
                    ? t('extensionCapability.unknown', { method: notice.method })
                    : t('extensionCapability.unsupported', { method: notice.method })}</span>
                  <button
                    type="button"
                    className="extension-presentation__notice-dismiss"
                    aria-label={t('extensionCapability.dismiss')}
                    onClick={() => onDismissCapabilityNotice?.(notice.id)}
                  >×</button>
                </span>
              ))}
            </div>
          ) : null}
          {status.length > 0 ? (
            <div className="extension-presentation__status" role="status">
              {status.map((item) => (
                <span className="extension-presentation__status-item" key={item.key}>
                  <strong>{commandOutputText(item.key)}</strong>
                  <span>{commandOutputText(item.text)}</span>
                </span>
              ))}
            </div>
          ) : null}
          {aboveWidgets.map((widget) => (
            <div className="extension-presentation__widget" key={widget.key}>
              {widget.lines.map((line, index) => (
                <span className="extension-presentation__widget-line" key={`${widget.key}-${index}`}>{commandOutputText(line)}</span>
              ))}
            </div>
          ))}
          {editorTextCurrent ? (
            <div className="extension-presentation__editor" role="region">
              <span className="extension-presentation__editor-title">{t('extensionUi.editorTextTitle')}</span>
              {composerDraft.trim() ? <span className="extension-presentation__editor-conflict">{t('extensionUi.editorTextConflict')}</span> : null}
              <pre className="extension-presentation__editor-preview">{commandOutputText(editorTextCurrent.text)}</pre>
              <div className="extension-presentation__editor-actions">
                <button type="button" className="button button--primary" onClick={() => onApplyEditorText?.(editorTextCurrent.text)}>{t('extensionUi.apply')}</button>
                <button type="button" className="button" onClick={() => onDismissEditorText?.()}>{t('extensionUi.dismiss')}</button>
              </div>
            </div>
          ) : null}
          {openUrlCurrent ? (
            <div className="extension-presentation__open-url" role="region">
              <span className="extension-presentation__open-url-title">{t('extensionUi.openUrlTitle')}</span>
              <span className="extension-presentation__open-url-url">{openUrlCurrent.url}</span>
              {openUrlCurrent.launchUrl ? <span className="extension-presentation__open-url-launch">{openUrlCurrent.launchUrl}</span> : null}
              {openUrlCurrent.instructions ? <p className="extension-presentation__open-url-instructions">{commandOutputText(openUrlCurrent.instructions)}</p> : null}
              <div className="extension-presentation__open-url-actions">
                <button type="button" className="button button--primary" onClick={() => onOpenUrl?.(openUrlCurrent.url)}>{t('extensionUi.openUrl')}</button>
                <button type="button" className="button" onClick={() => onDismissOpenUrl?.()}>{t('extensionUi.dismiss')}</button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
      {belowWidgets.length > 0 ? (
        <div className="extension-presentation extension-presentation--below">
          {belowWidgets.map((widget) => (
            <div className="extension-presentation__widget" key={widget.key}>
              {widget.lines.map((line, index) => (
                <span className="extension-presentation__widget-line" key={`${widget.key}-${index}`}>{commandOutputText(line)}</span>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}
