import { Copy, RotateCcw, SquarePen } from 'lucide-react'
import { useState } from 'react'
import { writeClipboardText } from '@/lib/clipboard'
import { useI18n } from '@/lib/i18n'
import type { TranscriptMessage } from '@/types/api'

export function failedTurn(messages: TranscriptMessage[]): { error: string; prompt: string } | undefined {
  const last = messages.at(-1)
  if (!last || !((last.role === 'system' && /^error[-:]/.test(last.id)) || last.outcome === 'failed')) return
  const user = [...messages].reverse().find((message) => message.role === 'user')
  return { error: last.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n'), prompt: user?.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') ?? '' }
}

export function TurnRecovery({ turn, busy, onRetry, onRestore }: { turn: { error: string; prompt: string }; busy: boolean; onRetry(): Promise<void>; onRestore(prompt: string): void }) {
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const retry = async () => {
    setPending(true); setNotice('')
    try { await onRetry() } catch { setNotice(t('conversation.recovery.retryFailed')) } finally { setPending(false) }
  }
  const copy = async () => {
    try { await writeClipboardText(turn.error); setNotice(t('conversation.recovery.copied')) } catch { setNotice(t('conversation.recovery.copyFailed')) }
  }
  return <section className="turn-recovery" aria-label={t('conversation.recovery.title')}>
    <span className="turn-recovery__title">{t('conversation.recovery.title')}</span>
    <button type="button" disabled={busy || pending} onClick={() => void retry()}><RotateCcw size={13} />{t('conversation.recovery.retry')}</button>
    <button type="button" disabled={!turn.prompt} onClick={() => onRestore(turn.prompt)}><SquarePen size={13} />{t('conversation.recovery.restore')}</button>
    <button type="button" onClick={() => void copy()}><Copy size={13} />{t('conversation.recovery.copy')}</button>
    {notice && <span role="status">{notice}</span>}
  </section>
}
