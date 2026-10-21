import { Check, ChevronDown, Gauge } from 'lucide-react'
import { memo, type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { type MessageKey, useI18n } from '@/lib/i18n'
import type { PrimeEffortSelector } from '@/types/api'

const reasoningLabelKeys = {
  auto: 'composer.reasoning.auto',
  off: 'composer.reasoning.off',
  minimal: 'composer.reasoning.minimal',
  low: 'composer.reasoning.low',
  medium: 'composer.reasoning.medium',
  high: 'composer.reasoning.high',
  xhigh: 'composer.reasoning.xhigh',
  max: 'composer.reasoning.max',
} as const satisfies Record<PrimeEffortSelector, MessageKey>

interface EffortPickerProps {
  value: PrimeEffortSelector
  levels: readonly PrimeEffortSelector[]
  /** Level the harness resolved for "auto"; shown inline next to it. */
  resolvedAutoEffort?: PrimeEffortSelector | null
  onChange(value: PrimeEffortSelector): void
}

/**
 * Reasoning-effort chip styled like the model picker. It replaces a native
 * <select> whose field-sized box shrank to a sliver beside its icon, turning
 * most of the chip into dead space; a popover keeps the whole chip clickable
 * and the menu visually consistent with the other composer pickers.
 */
export const EffortPicker = memo(function EffortPicker({ value, levels, resolvedAutoEffort, onChange }: EffortPickerProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const labelFor = (level: PrimeEffortSelector) => (level === 'auto' && resolvedAutoEffort ? t('composer.reasoning.autoResolved', { level: t(reasoningLabelKeys[resolvedAutoEffort]) }) : t(reasoningLabelKeys[level]))

  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const choose = (level: PrimeEffortSelector) => {
    onChange(level)
    close(true)
  }
  const openAt = (level: PrimeEffortSelector) => {
    setActiveIndex(Math.max(0, levels.indexOf(level)))
    setOpen(true)
  }
  const moveActive = (direction: 1 | -1) => {
    if (!levels.length) return
    setActiveIndex((current) => (current + direction + levels.length) % levels.length)
  }

  useEffect(() => {
    if (open) menuRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveActive(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(-1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(levels.length - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(levels[activeIndex] ?? value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    }
  }

  return (
    <div className="effort-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="permissions-chip effort-picker__trigger"
        aria-label={t('composer.effort.title', { level: labelFor(value) })}
        title={t('composer.effort.title', { level: labelFor(value) })}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : openAt(value))}
        onKeyDown={(event) => {
          if (open) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            openAt(value)
          }
        }}
      >
        <Gauge size={14} />
        <span>{labelFor(value)}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="effort-picker__menu"
          role="listbox"
          id={listId}
          aria-label={t('composer.reasoningEffort')}
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          onBlur={(event) => {
            // Tabbing past the options must dismiss like the native select did.
            // A null relatedTarget means focus left the document entirely (app
            // switch), which keeps the menu alive.
            const next = event.relatedTarget
            if (next instanceof Node && !rootRef.current?.contains(next)) close()
          }}
        >
          {levels.map((level, index) => (
            <button
              type="button"
              key={level}
              role="option"
              aria-selected={level === value}
              className={`effort-picker__option ${index === activeIndex ? 'is-active' : ''} ${level === value ? 'is-selected' : ''}`}
              onClick={() => choose(level)}
            >
              {level === value ? <Check size={13} className="effort-picker__check" aria-hidden="true" /> : <span className="effort-picker__check" aria-hidden="true" />}
              <span>{labelFor(level)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
})
