import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import './reasoning-disclosure.css'
import { SearchRevealContext } from './TranscriptSearch'

export const ReasoningExpandedContext = createContext(false)

export function ReasoningDisclosure({ children, className = '', preview, streaming = false }: { children: ReactNode; className?: string; preview?: string; streaming?: boolean }) {
  const { t } = useI18n()
  const defaultExpanded = useContext(ReasoningExpandedContext)
  const [manualOpen, setOpen] = useState(defaultExpanded)
  const reveal = useContext(SearchRevealContext)
  const open = manualOpen || reveal
  useEffect(() => setOpen(defaultExpanded), [defaultExpanded])
  return <details className={`reasoning-disclosure ${className}`.trim()} open={open}>
    <summary onClick={(event) => { event.preventDefault(); setOpen((value) => !value) }} aria-expanded={open}><ChevronRight size={14} aria-hidden="true" /><span className="reasoning-disclosure__label">{t('agents.thinking')}</span>{preview ? <span className="reasoning-disclosure__preview" title={preview} data-streaming={streaming || undefined}>{preview}</span> : null}</summary>
    {open ? <div>{children}</div> : null}
  </details>
}
