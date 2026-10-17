import { Terminal, X } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import './command-output.css'

export function CommandOutputPanel({ text, onClose }: { text: string; onClose(): void }) {
  const { t } = useI18n()
  if (!text) return null
  return <section className="command-output" aria-label={t('slash.output.title')}>
    <header><span><Terminal size={14} />{t('slash.output.title')}</span><button type="button" aria-label={t('slash.output.close')} title={t('slash.output.close')} onClick={onClose}><X size={15} /></button></header>
    <pre>{text}</pre>
  </section>
}
