import { createElement, memo, useEffect, useMemo, useRef, useState } from 'react'
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
  /** Session keys the user is currently looking at; their guests are never released. */
  activeSessionFiles?: readonly string[]
  /** Per-tab activity sequence; every changed tab wakes and restarts its idle clock. */
  activityByTab?: ReadonlyMap<string, number>
  /** How long a background session's tab may sit idle before its guest is released. */
  idleUnloadMs?: number
}

const CURSOR_EASING = 'cubic-bezier(.32,.72,.35,1)'
const CURSOR_IDLE_MS = 3_500
/** A background session's webview is torn down after this much agent inactivity. */
export const DEFAULT_IDLE_UNLOAD_MS = 5 * 60_000

interface ScheduledUnload {
  timer: number
  /** The activity timestamp this deadline was computed from. */
  since: number
}

/**
 * Hosts one webview guest per agent browser tab, for every session. This
 * layer stays mounted at the app shell so guests survive inspector and view
 * switches while the agent drives them; unmounting a webview destroys its
 * page. It is positioned over the Browser panel's slot when that panel shows
 * an agent tab, and kept laid out but invisible otherwise (display:none would
 * tear down the guest).
 *
 * Guests are expensive (renderer process, timers, media), so a tab that
 * belongs to a session the user is not looking at — and that no agent has
 * touched for the idle window — is released by unmounting its webview. The
 * main process keeps the tab record and its last url/title, so returning to
 * the session or the next agent action remounts the guest and the existing
 * attach path reloads that url.
 */
export function AgentBrowserLayer({
  tabs,
  visibleTabId,
  rect,
  pointerEvent,
  onAttach,
  activeSessionFiles,
  activityByTab,
  idleUnloadMs = DEFAULT_IDLE_UNLOAD_MS,
}: AgentBrowserLayerProps) {
  const style = rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : undefined
  const [unloaded, setUnloaded] = useState<ReadonlySet<string>>(() => new Set())
  const activeSessions = useMemo(() => new Set(activeSessionFiles ?? []), [activeSessionFiles])
  const lastActivityRef = useRef(new Map<string, number>())
  const unloadTimersRef = useRef(new Map<string, ScheduledUnload>())
  const lastActivitySeqRef = useRef(new Map<string, number>())

  useEffect(() => {
    const timers = unloadTimersRef.current
    const activity = lastActivityRef.current
    const now = Date.now()
    let wake: string | null = null
    if (activityByTab) {
      for (const [tabId, seq] of activityByTab) {
        if (lastActivitySeqRef.current.get(tabId) === seq) continue
        lastActivitySeqRef.current.set(tabId, seq)
        activity.set(tabId, now)
        wake = tabId
      }
    }
    const live = new Set(tabs.map((tab) => tab.tabId))
    for (const [tabId, scheduled] of [...timers]) {
      if (live.has(tabId)) continue
      window.clearTimeout(scheduled.timer)
      timers.delete(tabId)
    }
    for (const tabId of [...activity.keys()]) if (!live.has(tabId)) activity.delete(tabId)
    const reattach: string[] = []
    for (const tab of tabs) {
      const keepLoaded = tab.tabId === visibleTabId || activeSessions.has(tab.sessionFile)
      if (keepLoaded) {
        // The clock only matters once the session stops being the active one.
        activity.set(tab.tabId, now)
        const scheduled = timers.get(tab.tabId)
        if (scheduled) {
          window.clearTimeout(scheduled.timer)
          timers.delete(tab.tabId)
        }
        if (unloaded.has(tab.tabId)) reattach.push(tab.tabId)
        continue
      }
      if (unloaded.has(tab.tabId)) {
        if (tab.tabId === wake) reattach.push(tab.tabId)
        continue
      }
      if (!activity.has(tab.tabId)) activity.set(tab.tabId, now)
      const since = activity.get(tab.tabId) as number
      const scheduled = timers.get(tab.tabId)
      if (scheduled && scheduled.since === since) continue
      if (scheduled) window.clearTimeout(scheduled.timer)
      const tabId = tab.tabId
      const timer = window.setTimeout(() => {
        if (timers.get(tabId)?.timer !== timer) return
        timers.delete(tabId)
        setUnloaded((current) => {
          if (current.has(tabId)) return current
          const next = new Set(current)
          next.add(tabId)
          return next
        })
      }, Math.max(0, since + idleUnloadMs - now))
      timers.set(tabId, { timer, since })
    }
    if (reattach.length) {
      setUnloaded((current) => {
        const next = new Set(current)
        for (const tabId of reattach) next.delete(tabId)
        return next
      })
    }
  }, [tabs, visibleTabId, activeSessions, idleUnloadMs, unloaded, activityByTab])

  useEffect(
    () => () => {
      for (const scheduled of unloadTimersRef.current.values()) window.clearTimeout(scheduled.timer)
      unloadTimersRef.current.clear()
    },
    [],
  )

  return (
    <div className={`agent-browser-layer ${rect ? 'is-visible' : ''}`} style={style} aria-hidden={rect ? undefined : true}>
      {tabs.map((tab) =>
        unloaded.has(tab.tabId) ? null : (
          <AgentTabView
            key={tab.tabId}
            tabId={tab.tabId}
            visible={rect !== null && tab.tabId === visibleTabId}
            pointerEvent={pointerEvent?.tabId === tab.tabId ? pointerEvent : null}
            onAttach={onAttach}
          />
        ),
      )}
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
    <div className={`agent-browser-tab ${visible ? 'is-visible' : ''}`} data-tab-id={tabId}>
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
