import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import './reasoning-disclosure.css'

export const ReasoningExpandedContext = createContext(false)

export function ReasoningDisclosure({ children, className = '' }: { children: ReactNode; className?: string }) {
  const { t } = useI18n()
  const defaultExpanded = useContext(ReasoningExpandedContext)
  const [open, setOpen] = useState(defaultExpanded)
  useEffect(() => setOpen(defaultExpanded), [defaultExpanded])
  return <details className={`reasoning-disclosure ${className}`.trim()} open={open}>
    <summary onClick={(event) => { event.preventDefault(); setOpen((value) => !value) }} aria-expanded={open}><ChevronRight size={14} aria-hidden="true" /><span>{t('agents.thinking')}</span></summary>
    <div>{children}</div>
  </details>
}
