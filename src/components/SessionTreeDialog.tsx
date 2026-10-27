import { ListTree, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import { useI18n } from '@/lib/i18n'
import { describeTreeEntry, flattenSessionTree, isBranchableEntry, parseBranchResult, parseSessionTree, treePreviewText, type SessionTreeData, type SessionTreeRow } from '@/lib/session-tree'
import { Modal } from './ui'
import './session-tree.css'

interface SessionTreeDialogProps {
  /** 目前工作區持有的 runtime；樹狀查詢與分支都針對此 runtime 工作階段。 */
  runtimeId?: string
  onClose(): void
  onToast?(text: string): void
  /** 以分支點的使用者訊息預填輸入框（上游 branch 回傳的 selectedText 語意）。 */
  onPrefillPrompt?(text: string): void
}

type SessionTreeLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; tree: SessionTreeData }

function kindLabel(description: ReturnType<typeof describeTreeEntry>, t: ReturnType<typeof useI18n>['t']): string {
  switch (description.kind) {
    case 'user': return t('tree.kind.user')
    case 'assistant': return t('tree.kind.assistant')
    case 'compaction': return t('tree.kind.compaction')
    case 'label': return t('tree.kind.label')
    case 'modelChange': return t('tree.kind.modelChange')
    case 'titleChange': return t('tree.kind.titleChange')
    case 'summary': return t('tree.kind.summary')
    case 'other': return description.entryType
  }
}

function SessionTreeRowView({ row, busy, onBranch }: { row: SessionTreeRow; busy: boolean; onBranch(entryId: string, prefill: boolean): void }) {
  const { t } = useI18n()
  const description = describeTreeEntry(row.node.entry)
  const preview = treePreviewText(description)
  const branchable = isBranchableEntry(row.node.entry)
  const timestamp = row.node.entry.timestamp
    ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(row.node.entry.timestamp))
    : ''
  return (
    <div
      className={`session-tree__row${row.onActivePath ? ' session-tree__row--active' : ''}${row.isCurrentLeaf ? ' session-tree__row--leaf' : ''}`}
      style={{ paddingLeft: `${row.depth * 18 + 10}px` }}
    >
      <span className={`session-tree__gutter${row.hasSiblings ? ' session-tree__gutter--fork' : ''}`} aria-hidden="true" />
      <span className={`session-tree__kind session-tree__kind--${description.kind}`}>
        {kindLabel(description, t)}
      </span>
      {row.node.label ? <span className="session-tree__label">{row.node.label}</span> : null}
      <span className="session-tree__preview" title={preview || undefined}>{preview}</span>
      <span className="session-tree__meta">
        {row.isCurrentLeaf ? <strong className="session-tree__current">{t('tree.current')}</strong> : null}
        {timestamp ? <time className="session-tree__time">{timestamp}</time> : null}
      </span>
      {branchable ? (
        <span className="session-tree__actions">
          <button type="button" className="button button--quiet session-tree__action" disabled={busy} onClick={() => onBranch(row.node.entry.id, true)}>
            {busy ? t('tree.branching') : t('tree.branchFromHere')}
          </button>
          <button type="button" className="button button--quiet session-tree__action" disabled={busy} onClick={() => onBranch(row.node.entry.id, false)}>
            {busy ? t('tree.branching') : t('tree.resumeFromHere')}
          </button>
        </span>
      ) : null}
    </div>
  )
}

/**
 * 工作階段樹狀檢視：顯示 get_tree 的 branch/leaf 結構，標示目前 leaf，
 * 並對可分支的 user message 節點提供「從此處分支」與「從此處繼續」。
 * 上游未提供原生 rewind RPC（navigateTree 僅 TUI 內部使用）；兩個入口
 * 都是 native branch，建立不可回復的新工作階段邊界，絕不修改原始對話。
 */
export function SessionTreeDialog({ runtimeId, onClose, onToast, onPrefillPrompt }: SessionTreeDialogProps) {
  const { t } = useI18n()
  const [load, setLoad] = useState<SessionTreeLoad>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [branchingId, setBranchingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    const desktop = window.desktop
    if (!desktop) {
      setLoad({ status: 'error', message: t('tree.error.noBridge') })
      return
    }
    if (!runtimeId) {
      setLoad({ status: 'error', message: t('tree.error.noSession') })
      return
    }
    let cancelled = false
    setLoad({ status: 'loading' })
    desktop.agent.command(runtimeId, { type: 'get_tree' })
      .then((response) => {
        if (cancelled) return
        const tree = response.success === true ? parseSessionTree(response.data) : null
        if (tree) setLoad({ status: 'ready', tree })
        else setLoad({ status: 'error', message: typeof response.error === 'string' && response.error ? response.error : t('tree.error.loadFailed') })
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: errorMessage(error) })
      })
    return () => { cancelled = true }
  }, [runtimeId, reloadToken, t])

  const branchFrom = useCallback(async (entryId: string, prefill: boolean) => {
    const desktop = window.desktop
    if (!desktop || !runtimeId || branchingId) return
    setBranchingId(entryId)
    setActionError(null)
    try {
      const response = await desktop.agent.command(runtimeId, { type: 'branch', entryId })
      if (response.success !== true) {
        throw new Error(typeof response.error === 'string' && response.error ? response.error : t('tree.branchFailed'))
      }
      const result = parseBranchResult(response.data)
      if (result?.cancelled === true) {
        setActionError(t('tree.branch.cancelled'))
        return
      }
      onToast?.(t('tree.branched'))
      if (prefill && result?.text) onPrefillPrompt?.(result.text)
      // branch 會把工作階段搬到新檔案並改寫 leaf；重新載入樹狀圖重標目前位置，
      // 工作區則透過 followOwnedRuntimeSession 自動選取新工作階段。
      setReloadToken((token) => token + 1)
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setBranchingId(null)
    }
  }, [branchingId, onPrefillPrompt, onToast, runtimeId, t])

  const rows = useMemo(() => (load.status === 'ready' ? flattenSessionTree(load.tree) : []), [load])

  return (
    <Modal
      wide
      title={t('tree.title')}
      onClose={onClose}
      footer={
        <div className="session-tree__footer">
          <span className="session-tree__hint">{t('tree.description')}</span>
          <button type="button" className="button button--quiet" disabled={load.status === 'loading' || branchingId !== null} onClick={() => setReloadToken((token) => token + 1)} aria-label={t('tree.refresh')}>
            <RefreshCw size={14} />
            {t('tree.refresh')}
          </button>
        </div>
      }
    >
      {load.status === 'loading' ? (
        <div className="session-tree__state" role="status">
          <ListTree size={20} aria-hidden="true" />
          <span>{t('tree.loading')}</span>
        </div>
      ) : null}
      {load.status === 'error' ? (
        <div className="session-tree__state session-tree__state--error" role="alert">
          <span className="session-tree__error">{load.message}</span>
          <button type="button" className="button button--quiet" onClick={() => setReloadToken((token) => token + 1)}>
            {t('tree.retry')}
          </button>
        </div>
      ) : null}
      {load.status === 'ready' ? (
        rows.length === 0 ? (
          <div className="session-tree__state">
            <ListTree size={20} aria-hidden="true" />
            <span>{t('tree.empty')}</span>
          </div>
        ) : (
          <div className="session-tree" role="list" aria-label={t('tree.title')}>
            {actionError ? (
              <div className="session-tree__state session-tree__state--error" role="alert">
                <span className="session-tree__error">{actionError}</span>
              </div>
            ) : null}
            {rows.map((row) => (
              <SessionTreeRowView key={row.node.entry.id} row={row} busy={branchingId !== null} onBranch={(entryId, prefill) => void branchFrom(entryId, prefill)} />
            ))}
          </div>
        )
      ) : null}
    </Modal>
  )
}
