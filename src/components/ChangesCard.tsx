import { ChevronRight, FilePlus2, Undo2, X } from 'lucide-react'
import { useState } from 'react'
import { useI18n } from '@/lib/i18n'
import type { GitStatus } from '@/types/api'

interface ChangesCardProps {
  git: GitStatus
  onOpenChanges(): void
  onClose?(): void
  /** Restores every listed file to its last commit; shown with an inline confirmation. */
  onUndo?(): void
}

/** Codex-style turn footer: edited-file identity, diff totals, and undo / review actions. */
export function ChangesCard({ git, onOpenChanges, onClose, onUndo }: ChangesCardProps) {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState(false)
  const additions = git.files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = git.files.reduce((sum, file) => sum + file.deletions, 0)
  return (
    <div className="changes-card">
      <div className="changes-card__row">
        <span className="changes-card__icon">
          <FilePlus2 size={15} />
        </span>
        <span className="changes-card__text">
          <strong className="truncate">
            {git.files.length === 1
              ? t('changes.card.editedFile', { file: git.files[0].path })
              : t('changes.card.count', { count: git.files.length })}
          </strong>
          <small className="changes-card__stats">
            <span className="diff-count diff-count--add">+{additions}</span>
            <span className="diff-count diff-count--remove">−{deletions}</span>
          </small>
        </span>
        <span className="changes-card__actions">
          {onUndo
            ? confirming
              ? (
                  <span className="changes-card__confirm">
                    <span className="changes-card__confirm-text">{t('changes.card.undoConfirm', { count: git.files.length })}</span>
                    <button
                      type="button"
                      className="changes-card__undo is-confirming"
                      onClick={() => {
                        setConfirming(false)
                        onUndo()
                      }}
                    >
                      <Undo2 size={13} /> {t('changes.card.undo')}
                    </button>
                    <button type="button" className="changes-card__cancel" onClick={() => setConfirming(false)}>
                      {t('changes.cancel')}
                    </button>
                  </span>
                )
              : (
                  <button type="button" className="changes-card__undo" onClick={() => setConfirming(true)}>
                    <Undo2 size={13} /> {t('changes.card.undo')}
                  </button>
                )
            : null}
          <button type="button" className="changes-card__review" onClick={onOpenChanges}>
            {t('changes.card.reviewShort')} <ChevronRight size={12} />
          </button>
        </span>
        {onClose ? (
          <button type="button" className="changes-card__close" aria-label={t('changes.card.dismiss')} title={t('changes.card.dismiss')} onClick={onClose}>
            <X size={14} />
          </button>
        ) : null}
      </div>
    </div>
  )
}
