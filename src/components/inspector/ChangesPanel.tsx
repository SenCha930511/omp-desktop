import { ArrowDownToLine, File, FileCode2, GitBranch, LoaderCircle, RefreshCw, Sparkles, Undo2 } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { boundLines } from '@/lib/render-bounds'
import type { GitStatus } from '@/types/api'
import { EmptyState, IconButton, Modal, Segmented } from '../ui'

const MAX_RENDERED_DIFF_CHARACTERS = 2 * 1024 * 1024
const MAX_RENDERED_DIFF_LINES = 4_000

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

function generateCommitSummary(files: GitStatus['files'], t: Translate): string {
  const staged = files.filter((file) => file.staged)
  if (!staged.length) return ''
  const verbs = new Set(staged.map((file) => file.status[0]))
  const verb = verbs.size === 1 && verbs.has('A') ? t('changes.commit.verbAdd') : verbs.size === 1 && verbs.has('D') ? t('changes.commit.verbRemove') : t('changes.commit.verbUpdate')
  const names = staged.map((file) => file.path)
  const description =
    names.length === 1
      ? names[0]!
      : names.length === 2
        ? names[0]! + t('changes.commit.pair') + names[1]!
        : names.length <= 3
          ? names.slice(0, -1).join(t('changes.commit.separator')) + t('changes.commit.last') + names.at(-1)!
          : t('changes.commit.filesLabel', { count: names.length })
  return `${verb} ${description}`
}

const DiffView = memo(function DiffView({ text }: { text: string }) {
  const { t } = useI18n()
  if (!text)
    return (
      <div className="diff-placeholder">
        <FileCode2 size={22} />
        <span>{t('changes.diff.placeholder')}</span>
      </div>
    )
  const { lines, truncated } = boundLines(text, MAX_RENDERED_DIFF_CHARACTERS, MAX_RENDERED_DIFF_LINES)
  return (
    <pre className="diff-view">
      {lines.map((line, index) => (
        <span
          key={index}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'diff-line diff-line--add'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'diff-line diff-line--remove'
                : line.startsWith('@@')
                  ? 'diff-line diff-line--hunk'
                  : 'diff-line'
          }
        >
          <i>{index + 1}</i>
          <code>{line || ' '}</code>
        </span>
      ))}
      {truncated ? (
        <span className="diff-line diff-line--truncated">
          <i>…</i>
          <code>{t('changes.diff.truncated')}</code>
        </span>
      ) : null}
    </pre>
  )
})

export function ChangesPanel({
  cwd,
  git,
  readOnly = false,
  onGrantProject,
  onRefreshGit,
}: {
  cwd?: string
  git: GitStatus
  readOnly?: boolean
  onGrantProject?(): Promise<void> | void
  onRefreshGit(): Promise<void> | void
}) {
  const { t } = useI18n()
  const [scope, setScope] = useState<'unstaged' | 'staged'>('unstaged')
  const [selectedPath, setSelectedPath] = useState<string | undefined>(git.files[0]?.path)
  const [diff, setDiff] = useState('')
  const [loading, setLoading] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [confirmUndo, setConfirmUndo] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const visibleFiles = git.files.filter((file) => (scope === 'staged' ? file.staged : !file.staged))
  const activeSelectedPath = visibleFiles.some((file) => file.path === selectedPath) ? selectedPath : undefined

  useEffect(() => {
    if (!visibleFiles.some((file) => file.path === selectedPath)) setSelectedPath(visibleFiles[0]?.path)
  }, [git.files, scope, selectedPath])

  useEffect(() => {
    if (!cwd || !activeSelectedPath || !window.desktop) {
      setDiff(
        activeSelectedPath
          ? `diff --git a/${activeSelectedPath} b/${activeSelectedPath}
--- a/${activeSelectedPath}
+++ b/${activeSelectedPath}
@@ -18,3 +18,6 @@
 const workspace = createWorkspace()
+workspace.open()
+workspace.focus()
 return workspace`
          : '',
      )
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    window.desktop.git
      .diff(cwd, activeSelectedPath, scope === 'staged')
      .then((value) => {
        if (!cancelled) setDiff(value.text)
      })
      .catch(() => {
        if (!cancelled) setDiff(t('changes.diff.unavailable'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, activeSelectedPath, scope])

  const mutate = async (kind: 'stage' | 'unstage' | 'restore', paths: string[]): Promise<boolean> => {
    if (readOnly || !cwd || !window.desktop) return false
    setActionError('')
    try {
      const ok = kind === 'stage' ? await window.desktop.git.stage(cwd, paths) : kind === 'unstage' ? await window.desktop.git.unstage(cwd, paths) : await window.desktop.git.restore(cwd, paths)
      if (!ok) throw new Error(t(kind === 'stage' ? 'changes.error.stage' : kind === 'unstage' ? 'changes.error.unstage' : 'changes.error.restore', { count: paths.length }))
      await onRefreshGit()
      return true
    } catch (error) {
      setActionError(errorMessage(error))
      return false
    }
  }

  const fillCommitSummary = () => {
    setActionError('')
    setCommitMessage(generateCommitSummary(git.files, t))
  }

  const commit = async () => {
    if (readOnly || !cwd || !commitMessage.trim() || !window.desktop) return
    setActionError('')
    try {
      const result = await window.desktop.git.commit(cwd, commitMessage.trim())
      if (!result.ok) throw new Error(result.output || t('changes.error.commit'))
      setCommitOpen(false)
      setCommitMessage('')
      await onRefreshGit()
    } catch (error) {
      setActionError(errorMessage(error))
    }
  }

  if (!git.isRepo)
    return (
      <EmptyState icon={<GitBranch size={24} />} title={t('changes.empty.title')}>
        {t('changes.empty.body')}
      </EmptyState>
    )
  if (git.error) {
    return (
      <EmptyState
        icon={<GitBranch size={24} />}
        title={t('changes.errorTitle')}
        action={
          <button type="button" className="button" onClick={() => void onRefreshGit()}>
            <RefreshCw size={13} /> {t('changes.tryAgain')}
          </button>
        }
      >
        {git.error}
      </EmptyState>
    )
  }
  return (
    <div className="changes-panel">
      <div className="changes-toolbar">
        <div>
          <strong>
            <GitBranch size={13} /> {git.branch ?? t('changes.repository')}
          </strong>
          {git.ahead ? <small>{t('changes.ahead', { count: git.ahead })}</small> : null}
        </div>
        <IconButton label={t('changes.refresh')} onClick={() => void onRefreshGit()}>
          <RefreshCw size={14} />
        </IconButton>
      </div>
      {readOnly ? (
        <div className="changes-read-only" role="note">
          <span>{t('changes.readOnly')}</span>
          {onGrantProject ? (
            <button type="button" className="button button--compact" onClick={() => void onGrantProject()}>
              {t('changes.addProject')}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="changes-scopes">
        <Segmented
          value={scope}
          label={t('changes.scope.label')}
          options={[
            { value: 'unstaged', label: t('changes.scope.unstaged') },
            { value: 'staged', label: t('changes.scope.staged') },
          ]}
          onChange={(value) => {
            setActionError('')
            setScope(value as 'unstaged' | 'staged')
          }}
        />
        <button type="button" className="button button--compact" disabled={readOnly || !git.files.some((file) => file.staged)} onClick={() => setCommitOpen(true)}>
          {t('changes.commit')}
        </button>
      </div>
      {actionError ? (
        <p className="changes-error" role="alert">
          {actionError}
        </p>
      ) : null}
      <div className="changes-body">
        <div className="file-changes scroll-area">
          <div className="file-changes__header">
            <span>{t('changes.fileCount', { count: visibleFiles.length })}</span>
            {visibleFiles.length ? (
              <button
                type="button"
                disabled={readOnly}
                onClick={() =>
                  void mutate(
                    scope === 'staged' ? 'unstage' : 'stage',
                    visibleFiles.map((file) => file.path),
                  )
                }
              >
                {scope === 'staged' ? t('changes.unstageAll') : t('changes.stageAll')}
              </button>
            ) : null}
          </div>
          {visibleFiles.map((file) => (
            <button type="button" key={file.path} className={selectedPath === file.path ? 'is-selected' : ''} onClick={() => setSelectedPath(file.path)}>
              <File size={13} />
              <span title={file.path}>{file.path}</span>
              <small className="additions">+{file.additions}</small>
              <small className="deletions">−{file.deletions}</small>
              <span className="file-status">{file.status}</span>
            </button>
          ))}
          {visibleFiles.length === 0 ? <p className="file-changes__empty">{scope === 'staged' ? t('changes.emptyStaged') : t('changes.emptyUnstaged')}</p> : null}
        </div>
        <div className="diff-pane scroll-area">
          {selectedPath ? (
            <div className="diff-header">
              <div>
                <FileCode2 size={13} />
                <span>{selectedPath}</span>
              </div>
              <div>
                {scope === 'unstaged' ? (
                  <button type="button" disabled={readOnly} onClick={() => void mutate('stage', [selectedPath])}>
                    <ArrowDownToLine size={12} /> {t('changes.stage')}
                  </button>
                ) : (
                  <button type="button" disabled={readOnly} onClick={() => void mutate('unstage', [selectedPath])}>
                    <Undo2 size={12} /> {t('changes.unstage')}
                  </button>
                )}
                <button type="button" className="danger-action" disabled={readOnly} onClick={() => setConfirmUndo(selectedPath)}>
                  <Undo2 size={12} /> {t('changes.undo')}
                </button>
              </div>
            </div>
          ) : null}
          {loading ? (
            <div className="diff-loading">
              <LoaderCircle className="spin" size={15} /> {t('changes.loading')}
            </div>
          ) : (
            <DiffView text={diff} />
          )}
        </div>
      </div>
      {commitOpen ? (
        <Modal
          title={t('changes.commit.title')}
          onClose={() => setCommitOpen(false)}
          footer={
            <>
              <button className="button" type="button" onClick={() => setCommitOpen(false)}>
                {t('changes.cancel')}
              </button>
              <button className="button button--primary" type="button" disabled={readOnly || !commitMessage.trim()} onClick={() => void commit()}>
                {t('changes.commit.button')}
              </button>
            </>
          }
        >
          <label className="field">
            <span>{t('changes.commit.messageLabel')}</span>
            <div className="commit-message-input">
              <input autoFocus value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder={t('changes.commit.placeholder')} />
              <button type="button" className="button button--compact" onClick={fillCommitSummary} title={t('changes.commit.generateTitle')}>
                <Sparkles size={13} /> {t('changes.commit.generate')}
              </button>
            </div>
          </label>
          <p className="muted-copy">
            {t('changes.commit.confirmPrefix')}
            <code>{git.branch}</code>
            {t('changes.commit.confirmSuffix')}
          </p>
        </Modal>
      ) : null}
      {confirmUndo ? (
        <Modal
          title={t('changes.undo.title')}
          onClose={() => setConfirmUndo(null)}
          footer={
            <>
              <button className="button" type="button" onClick={() => setConfirmUndo(null)}>
                {t('changes.cancel')}
              </button>
              <button
                className="button button--danger"
                type="button"
                disabled={readOnly}
                onClick={() => {
                  const path = confirmUndo
                  void mutate('restore', [path]).then((ok) => {
                    if (ok) setConfirmUndo(null)
                  })
                }}
              >
                {t('changes.undo')}
              </button>
            </>
          }
        >
          <p>
            {t('changes.undo.confirmPrefix')}
            <code>{confirmUndo}</code>
            {t('changes.undo.confirmSuffix')}
          </p>
        </Modal>
      ) : null}
    </div>
  )
}
