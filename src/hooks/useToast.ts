import { type SetStateAction, useCallback, useEffect, useState } from 'react'

export const TOAST_DURATION_MS = 2_500
export const TOAST_ERROR_DURATION_MS = 5_000
export type ToastTone = 'info' | 'error' | 'warning'

const ERROR_TOAST_PATTERN = /\b(fail|failed|error|unable|denied|invalid|could not|cannot)\b|失敗|錯誤|無法/i

function inferToastTone(message: string): ToastTone {
  return ERROR_TOAST_PATTERN.test(message) ? 'error' : 'info'
}

export function useToast() {
  const [toast, setToastMessage] = useState<string | null>(null)
  const [toastTone, setToastTone] = useState<ToastTone>('info')
  const [toastHovered, setToastHovered] = useState(false)

  const setToast = useCallback((next: SetStateAction<string | null>, tone?: ToastTone) => {
    setToastMessage((previous) => {
      const resolved = typeof next === 'function' ? next(previous) : next
      if (resolved === null) {
        setToastTone('info')
        setToastHovered(false)
      } else {
        setToastTone(tone ?? inferToastTone(resolved))
      }
      return resolved
    })
  }, [])

  useEffect(() => {
    if (!toast || toastHovered) return
    const duration = toastTone === 'error' ? TOAST_ERROR_DURATION_MS : TOAST_DURATION_MS
    const timer = window.setTimeout(() => {
      setToastMessage(null)
      setToastTone('info')
      setToastHovered(false)
    }, duration)
    return () => window.clearTimeout(timer)
  }, [toast, toastTone, toastHovered])

  return { toast, toastTone, setToast, setToastHovered }
}
