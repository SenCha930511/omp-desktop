import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** Reserve the real dock height, including attachments, queues and command output. */
export function ConversationDock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const dock = ref.current
    const pane = dock?.parentElement
    if (!dock || !pane) return
    const measure = () => pane.style.setProperty('--conversation-dock-height', `${dock.offsetHeight + 24}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(dock)
    return () => { observer.disconnect(); pane.style.removeProperty('--conversation-dock-height') }
  }, [])
  return <div ref={ref} className="conversation-bottom-dock">{children}</div>
}
