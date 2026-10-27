import { X } from 'lucide-react'
import { type ButtonHTMLAttributes, type ReactNode, type RefObject, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '@/lib/i18n'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: 'small' | 'regular'
}

export function IconButton({ label, size = 'regular', className = '', children, ...props }: IconButtonProps) {
  return (
    <button type="button" className={`icon-button icon-button--${size} ${className}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  )
}

export function BrowserGlobe({ size = 18 }: { size?: number }) {
  return (
    <svg className="browser-globe" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="3.65" ry="9" />
      <path d="M3 12h18" />
    </svg>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange(value: T): void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button type="button" key={option.value} className={value === option.value ? 'is-active' : ''} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state__icon">{icon}</div> : null}
      <h2>{title}</h2>
      <p>{children}</p>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  )
}

const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useFocusTrap<T extends HTMLElement>(active: boolean, onEscape?: () => void): RefObject<T | null> {
  const containerRef = useRef<T>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape
  useEffect(() => {
    if (!active || !containerRef.current) return
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const container = containerRef.current
    const focusInitial = () => {
      const preferred = container.querySelector<HTMLElement>('[autofocus]')
      const first = preferred ?? container.querySelector<HTMLElement>(focusableSelector)
      first?.focus()
    }
    const frame = requestAnimationFrame(focusInitial)
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.target instanceof Node) || !container.contains(event.target)) return
      if (event.key === 'Escape' && escapeRef.current) {
        event.preventDefault()
        escapeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter((item) => !item.hidden && item.getClientRects().length > 0)
      if (!items.length) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = items[0]
      const last = items.at(-1)!
      if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)
      const restore = previousFocus.current
      requestAnimationFrame(() => {
        if (restore?.isConnected) restore.focus()
      })
    }
  }, [active])
  return containerRef
}

// Overlays (modals, the command palette) share one refcount so stacked or
// sibling overlays only toggle the app shell's inert state on 0<->1 transitions.
let appShellOverlayCount = 0

export function useAppShellOverlay(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const shell = document.querySelector<HTMLElement>('.app-shell')
    if (!shell) return
    appShellOverlayCount += 1
    if (appShellOverlayCount === 1) {
      shell.inert = true
      shell.setAttribute('aria-hidden', 'true')
    }
    return () => {
      appShellOverlayCount -= 1
      if (appShellOverlayCount === 0) {
        shell.inert = false
        shell.removeAttribute('aria-hidden')
      }
    }
  }, [active])
}

export function Modal({ title, children, onClose, footer, wide = false }: { title: string; children: ReactNode; onClose(): void; footer?: ReactNode; /** 寬版（如 session tree）：放寬欄位與可視列數，不影響其他 modal。 */ wide?: boolean }) {
  const { t } = useI18n()
  const titleId = useId()
  const modalRef = useFocusTrap<HTMLElement>(true, onClose)
  useAppShellOverlay(true)
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={modalRef} className={`modal${wide ? ' modal--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal__header">
          <h2 id={titleId}>{title}</h2>
          <IconButton label={t('modal.close')} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </section>
    </div>,
    document.body,
  )
}

export function OmpMark({ size = 24 }: { size?: number }) {
  // A desktop window tile carrying the pi symbol, matching assets/brand/omp-icon.svg.
  return (
    <span className="omp-mark" style={{ width: size, height: size }} role="img" aria-label="OMP">
      <svg viewBox="0 0 96 96" fill="none" focusable="false" aria-hidden="true">
        <rect x="6" y="6" width="84" height="84" rx="20" fill="#ffffff" />
        <rect x="24" y="21" width="48" height="8" rx="4" fill="#171716" />
        <rect x="28" y="41" width="40" height="9" rx="4" fill="#171716" />
        <rect x="33" y="41" width="10" height="33" rx="4" fill="#171716" />
        <rect x="53" y="41" width="10" height="29" rx="4" fill="#171716" />
        <circle cx="31" cy="25" r="3.4" fill="#f97316" />
      </svg>
    </span>
  )
}
