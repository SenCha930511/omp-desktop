import { createElement, memo, useEffect, useRef } from 'react'
import type { StampedPointerEvent } from '@/hooks/useAgentBrowserTabs'
import { type AgentBrowserTabRecord, BROWSER_PARTITION } from '@/types/api'

export interface AgentSlotRect {
  left: number
  top: number
  width: number
  height: number
}

type AgentWebviewElement = HTMLElement & {
  getWebContentsId(): number
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

interface AgentBrowserLayerProps {
  tabs: AgentBrowserTabRecord[]
  visibleTabId: string | null
  rect: AgentSlotRect | null
  pointerEvent: StampedPointerEvent | null
  onAttach(tabId: string, webContentsId: number): void
}

const CURSOR_EASING = 'cubic-bezier(.32,.72,.35,1)'
const CURSOR_IDLE_MS = 3_500

/**
 * Hosts one webview guest per agent browser tab, for every session. This
 * layer stays mounted at the app shell so guests survive inspector and view
 * switches while the agent drives them; unmounting a webview destroys its
 * page. It is positioned over the Browser panel's slot when that panel shows
 * an agent tab, and kept laid out but invisible otherwise (display:none would
 * tear down the guest).
 */
export function AgentBrowserLayer({ tabs, visibleTabId, rect, pointerEvent, onAttach }: AgentBrowserLayerProps) {
  const style = rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : undefined
  return (
    <div className={`agent-browser-layer ${rect ? 'is-visible' : ''}`} style={style} aria-hidden={rect ? undefined : true}>
      {tabs.map((tab) => (
        <AgentTabView
          key={tab.tabId}
          tabId={tab.tabId}
          visible={rect !== null && tab.tabId === visibleTabId}
          pointerEvent={pointerEvent?.tabId === tab.tabId ? pointerEvent : null}
          onAttach={onAttach}
        />
      ))}
    </div>
  )
}

interface AgentTabViewProps {
  tabId: string
  visible: boolean
  pointerEvent: StampedPointerEvent | null
  onAttach(tabId: string, webContentsId: number): void
}

/**
 * Synthetic cursor overlay: an arrow pointer that animates along the exact
 * path and duration the main process used for the real input glide, a trail
 * line that draws and fades behind it, and a ripple pulse on clicks. Mounted
 * over both agent tabs and the user's Preview webview.
 */
export function AgentCursorOverlay({ pointerEvent }: { pointerEvent: StampedPointerEvent | null }) {
  const cursorRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const trailRef = useRef<SVGSVGElement | null>(null)
  const idleTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const event = pointerEvent
    const cursor = cursorRef.current
    const overlay = overlayRef.current
    const trail = trailRef.current
    if (!event || !cursor || !overlay || !trail || typeof cursor.animate !== 'function') return
    const { from, to, durationMs } = event
    cursor.classList.add('is-active')
    cursor.classList.remove('is-idle')
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current)
    idleTimerRef.current = window.setTimeout(() => cursor.classList.add('is-idle'), CURSOR_IDLE_MS)
    const glide = from !== null && durationMs > 0
    if (glide) {
      cursor.animate([{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: `translate(${to.x}px, ${to.y}px)` }], { duration: durationMs, easing: CURSOR_EASING, fill: 'forwards' })
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', String(from.x))
      line.setAttribute('y1', String(from.y))
      line.setAttribute('x2', String(to.x))
      line.setAttribute('y2', String(to.y))
      line.setAttribute('class', 'agent-cursor-trail__line')
      const length = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y))
      line.style.strokeDasharray = String(length)
      trail.appendChild(line)
      line.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: durationMs, easing: CURSOR_EASING, fill: 'forwards' })
      const fade = line.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 450, delay: durationMs, fill: 'forwards' })
      fade.finished.then(
        () => line.remove(),
        () => line.remove(),
      )
    } else {
      cursor.animate(
        [
          { transform: `translate(${to.x}px, ${to.y}px)`, opacity: 0 },
          { transform: `translate(${to.x}px, ${to.y}px)`, opacity: 1 },
        ],
        { duration: 140, fill: 'forwards' },
      )
    }
    if (event.action === 'click') {
      const ripple = document.createElement('div')
      ripple.className = 'agent-cursor-ripple'
      ripple.style.left = `${to.x}px`
      ripple.style.top = `${to.y}px`
      overlay.appendChild(ripple)
      const pulse = ripple.animate(
        [
          { transform: 'translate(-50%, -50%) scale(.3)', opacity: 0.55 },
          { transform: 'translate(-50%, -50%) scale(1.6)', opacity: 0 },
        ],
        { duration: 450, delay: glide ? durationMs : 0, easing: 'ease-out', fill: 'forwards' },
      )
      pulse.finished.then(
        () => ripple.remove(),
        () => ripple.remove(),
      )
    }
  }, [pointerEvent])

  useEffect(
    () => () => {
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current)
    },
    [],
  )

  return (
    <div ref={overlayRef} className="agent-cursor-layer" aria-hidden>
      <svg ref={trailRef} className="agent-cursor-trail" aria-hidden="true" />
      <div ref={cursorRef} className="agent-cursor">
        <svg className="agent-cursor__arrow" viewBox="0 0 20 22" width="20" height="22" aria-hidden="true">
          <path d="M4 1.4 L4 17.2 L8.1 13.6 L10.7 19.6 L13.5 18.4 L10.9 12.5 L16.3 12.5 Z" />
        </svg>
      </div>
    </div>
  )
}

const AgentTabView = memo(function AgentTabView({ tabId, visible, pointerEvent, onAttach }: AgentTabViewProps) {
  const viewRef = useRef<AgentWebviewElement | null>(null)
  const reportedRef = useRef(false)
  const onAttachRef = useRef(onAttach)
  onAttachRef.current = onAttach

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    // dom-ready is the earliest point where getWebContentsId is valid; it
    // fires again per document, so report only once per mounted guest.
    const report = () => {
      if (reportedRef.current) return
      try {
        const webContentsId = view.getWebContentsId()
        reportedRef.current = true
        onAttachRef.current(tabId, webContentsId)
      } catch {
        /* guest not attached yet; a later dom-ready will report */
      }
    }
    view.addEventListener('dom-ready', report)
    return () => view.removeEventListener('dom-ready', report)
  }, [tabId])

  // src stays about:blank permanently: the main process drives all navigation,
  // and rewriting src on re-render would reload the guest.
  return (
    <div className={`agent-browser-tab ${visible ? 'is-visible' : ''}`}>
      {createElement('webview' as never, {
        ref: (node: AgentWebviewElement | null) => {
          viewRef.current = node
        },
        src: 'about:blank',
        className: 'browser-webview',
        partition: BROWSER_PARTITION,
        webpreferences: 'contextIsolation=yes,sandbox=yes,nodeIntegration=no',
      })}
      <AgentCursorOverlay pointerEvent={pointerEvent} />
    </div>
  )
})
