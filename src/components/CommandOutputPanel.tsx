import { Check, ChevronDown, Copy, LoaderCircle, Terminal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { writeClipboardText } from '@/lib/clipboard'
import './command-output.css'

export function CommandOutputPanel({ text, command, status, onClose }: { text: string; command?: string; status?: 'running' | 'completed' | 'failed'; onClose(): void }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(true)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const scrollRef = useRef<HTMLPreElement>(null)
  const following = useRef(true)
  useEffect(() => {
    if (status === 'running') { setExpanded(true); following.current = true; setCopied(false); setCopyFailed(false) }
  }, [command, status])
  useEffect(() => {
    if (following.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [text, expanded])
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  if (!text && !command) return null
  const copy = async () => {
    try { await writeClipboardText(text); setCopied(true); setCopyFailed(false) } catch { setCopyFailed(true) }
  }
  return <section className={`command-output ${status === 'failed' ? 'is-failed' : ''}`} aria-label={t('slash.output.title')}>
    <header><button type="button" className="command-output__summary" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <ChevronDown size={14} className={expanded ? '' : 'is-collapsed'} /><Terminal size={14} /><span>{command ?? t('slash.output.title')}</span>
      {status && <span className="command-output__status" role="status">{status === 'running' && <LoaderCircle size={12} className="is-spinning" />}{t(`slash.output.${status}`)}</span>}
    </button><div className="command-output__actions">
      {text && <button type="button" aria-label={t(copied ? 'slash.output.copied' : 'slash.output.copy')} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>}
      <button type="button" aria-label={t('slash.output.close')} title={t('slash.output.close')} onClick={onClose}><X size={15} /></button>
    </div></header>
    {copyFailed && <p role="alert">{t('slash.output.copyFailed')}</p>}
    {expanded && <pre ref={scrollRef} onScroll={(event) => { const node = event.currentTarget; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40 }}>{text || t(status === 'running' ? 'slash.output.running' : 'slash.output.noOutput')}</pre>}
  </section>
}
