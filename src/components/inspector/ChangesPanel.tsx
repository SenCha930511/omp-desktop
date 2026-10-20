import { ArrowDownToLine, Check, Columns2, Copy, File, FileCode2, GitBranch, LoaderCircle, RefreshCw, Rows2, Sparkles, Undo2 } from 'lucide-react'
import { memo, useEffect, useMemo, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { boundLines } from '@/lib/render-bounds'
import type { GitStatus } from '@/types/api'
import { EmptyState, IconButton, Modal, Segmented } from '../ui'

const MAX_RENDERED_DIFF_CHARACTERS = 2 * 1024 * 1024
const MAX_RENDERED_DIFF_LINES = 4_000

type DiffMode = 'unified' | 'split'

interface ParsedDiffLine {
  kind: 'meta' | 'hunk' | 'context' | 'add' | 'remove'
  oldNo: number | null
  newNo: number | null
  text: string
}

interface SplitDiffRow {
  kind: 'meta' | 'hunk' | 'pair'
  text?: string
  left?: { lineNo: number | null; text: string; kind: 'context' | 'remove' | 'empty' }
  right?: { lineNo: number | null; text: string; kind: 'context' | 'add' | 'empty' }
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/

function parseDiffLines(lines: readonly string[]): ParsedDiffLine[] {
  const hasHunks = lines.some((line) => HUNK_HEADER_RE.test(line))
  if (!hasHunks) {
    return lines.map((line, index) => ({
      kind: line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'remove' : 'context',
      oldNo: null,
      newNo: index + 1,
      text: line,
    }))
  }
  const result: ParsedDiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const line of lines) {
    const hunkMatch = HUNK_HEADER_RE.exec(line)
    if (hunkMatch) {
      oldNo = Number.parseInt(hunkMatch[1]!, 10)
      newNo = Number.parseInt(hunkMatch[2]!, 10)
      inHunk = true
      result.push({ kind: 'hunk', oldNo: null, newNo: null, text: line })
      continue
    }
    if (!inHunk || line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      result.push({ kind: 'meta', oldNo: null, newNo: null, text: line })
      continue
    }
    if (line.startsWith('+')) {
      result.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line })
    } else if (line.startsWith('-')) {
      result.push({ kind: 'remove', oldNo: oldNo++, newNo: null, text: line })
    } else {
      result.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: line })
    }
  }
  return result
}

function buildSplitRows(parsed: readonly ParsedDiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = []
  let index = 0
  while (index < parsed.length) {
    const item = parsed[index]!
    if (item.kind === 'meta' || item.kind === 'hunk') {
      rows.push({ kind: item.kind, text: item.text })
      index += 1
      continue
    }
    if (item.kind === 'context') {
      rows.push({
        kind: 'pair',
        left: { lineNo: item.oldNo, text: item.text, kind: 'context' },
        right: { lineNo: item.newNo, text: item.text, kind: 'context' },
      })
      index += 1
      continue
    }
    const removals: ParsedDiffLine[] = []
    const additions: ParsedDiffLine[] = []
    while (index < parsed.length && parsed[index]!.kind === 'remove') {
      removals.push(parsed[index]!)
      index += 1
    }
    while (index < parsed.length && parsed[index]!.kind === 'add') {
      additions.push(parsed[index]!)
      index += 1
    }
    const pairCount = Math.max(removals.length, additions.length)
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const rem = removals[pairIndex]
      const add = additions[pairIndex]
      rows.push({
        kind: 'pair',
        left: rem ? { lineNo: rem.oldNo, text: rem.text, kind: 'remove' } : { lineNo: null, text: '', kind: 'empty' },
        right: add ? { lineNo: add.newNo, text: add.text, kind: 'add' } : { lineNo: null, text: '', kind: 'empty' },
      })
    }
  }
  return rows
}

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

const DiffView = memo(function DiffView({ text, mode = 'unified' }: { text: string; mode?: DiffMode }) {
  const { t } = useI18n()
  const { lines, truncated } = useMemo(() => (text ? boundLines(text, MAX_RENDERED_DIFF_CHARACTERS, MAX_RENDERED_DIFF_LINES) : { lines: [], truncated: false }), [text])
  const parsed = useMemo(() => parseDiffLines(lines), [lines])
  const splitRows = useMemo(() => (mode === 'split' ? buildSplitRows(parsed) : []), [mode, parsed])

  if (!text)
    return (
      <div className="diff-placeholder">
        <FileCode2 size={22} />
        <span>{t('changes.diff.placeholder')}</span>
      </div>
    )

  if (mode === 'split') {
    return (
      <pre className="diff-view diff-view--split">
        {splitRows.map((row, index) =>
          row.kind !== 'pair' ? (
            <span key={index} className={`diff-line ${row.kind === 'hunk' ? 'diff-line--hunk' : 'diff-line--meta'}`}>
              <i>{''}</i>
              <i>{''}</i>
              <code>{row.text || ' '}</code>
            </span>
          ) : (
            <span key={index} className="diff-split-row">
              <i className={row.left?.kind === 'remove' ? 'diff-split-cell--remove' : row.left?.kind === 'empty' ? 'diff-split-cell--empty' : ''}>{row.left?.lineNo ?? ''}</i>
              <code className={row.left?.kind === 'remove' ? 'diff-split-cell--remove' : row.left?.kind === 'empty' ? 'diff-split-cell--empty' : ''}>{row.left?.text || ' '}</code>
              <i className={row.right?.kind === 'add' ? 'diff-split-cell--add' : row.right?.kind === 'empty' ? 'diff-split-cell--empty' : ''}>{row.right?.lineNo ?? ''}</i>
              <code className={row.right?.kind === 'add' ? 'diff-split-cell--add' : row.right?.kind === 'empty' ? 'diff-split-cell--empty' : ''}>{row.right?.text || ' '}</code>
            </span>
          ),
        )}
        {truncated ? (
          <span className="diff-line diff-line--truncated">
            <i>…</i>
            <i>{''}</i>
            <code>{t('changes.diff.truncated')}</code>
          </span>
        ) : null}
      </pre>
    )
  }

  return (
    <pre className="diff-view">
      {parsed.map((line, index) => (
        <span
          key={index}
          className={
            line.kind === 'add'
              ? 'diff-line diff-line--add'
              : line.kind === 'remove'
                ? 'diff-line diff-line--remove'
                : line.kind === 'hunk'
                  ? 'diff-line diff-line--hunk'
                  : line.kind === 'meta'
                    ? 'diff-line diff-line--meta'
                    : 'diff-line'
          }
        >
          <i>{line.oldNo ?? ''}</i>
          <i>{line.newNo ?? ''}</i>
          <code>{line.text || ' '}</code>
        </span>
      ))}
      {truncated ? (
        <span className="diff-line diff-line--truncated">
          <i>…</i>
          <i>{''}</i>
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
  const [diffMode, setDiffMode] = useState<DiffMode>('unified')
  const [copiedDiff, setCopiedDiff] = useState(false)
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
                <button
                  type="button"
                  className={diffMode === 'split' ? 'is-active' : ''}
                  aria-pressed={diffMode === 'split'}
                  title={diffMode === 'split' ? 'Unified diff view' : 'Split diff view'}
                  onClick={() => setDiffMode((current) => (current === 'unified' ? 'split' : 'unified'))}
                >
                  {diffMode === 'split' ? <Rows2 size={12} /> : <Columns2 size={12} />}
                </button>
                <button
                  type="button"
                  disabled={!diff}
                  title="Copy diff"
                  onClick={() => {
                    if (!diff) return
                    void navigator.clipboard?.writeText(diff)
                    setCopiedDiff(true)
                    window.setTimeout(() => setCopiedDiff(false), 1600)
                  }}
                >
                  {copiedDiff ? <Check size={12} /> : <Copy size={12} />}
                </button>
                <span className="diff-header__divider" aria-hidden="true" />
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
            <DiffView text={diff} mode={diffMode} />
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
