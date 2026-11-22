import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentBrowserActivityEvent, AgentBrowserPointerEvent, AgentBrowserTabRecord, DesktopApi } from '@/types/api'

interface UseAgentBrowserTabsOptions {
  bridge: DesktopApi | null
  reportError(error: unknown): void
}

/** Pointer event stamped with a sequence number so identical coordinates still retrigger animations. */
export type StampedPointerEvent = AgentBrowserPointerEvent & { seq: number }

/** Activity event stamped with a sequence number so repeated actions on one tab still retrigger effects. */
export type StampedActivityEvent = AgentBrowserActivityEvent & { seq: number }

export interface AgentBrowserApi {
  /** Every agent tab across all sessions; the layer must host them all so background threads keep browsing. */
  tabs: AgentBrowserTabRecord[]
  /** Latest agent pointer movement, for the synthetic cursor overlay. */
  pointerEvent: StampedPointerEvent | null
  /** Latest agent browser action, for surfacing the Browser panel. */
  activityEvent: StampedActivityEvent | null
  /** Per-tab activity sequence; the idle layer resets every changed tab's clock. */
  activityByTab: ReadonlyMap<string, number>
  attach(tabId: string, webContentsId: number): void
  select(tabId: string): void
  close(tabId: string): void
}

/**
 * Mirrors the main process's agent browser tab registry. Main owns the state;
 * the renderer reports webview attachment and user tab actions back to it.
 */
export function useAgentBrowserTabs({ bridge, reportError }: UseAgentBrowserTabsOptions): AgentBrowserApi {
  const [tabs, setTabs] = useState<AgentBrowserTabRecord[]>([])
  const [pointerEvent, setPointerEvent] = useState<StampedPointerEvent | null>(null)
  const [activityEvent, setActivityEvent] = useState<StampedActivityEvent | null>(null)
  const [activityByTab, setActivityByTab] = useState<ReadonlyMap<string, number>>(() => new Map())
  const pointerSeqRef = useRef(0)

  useEffect(() => {
    if (!bridge) return
    let live = true
    void bridge.browser.state()
      .then((state) => { if (live) setTabs(state.tabs) })
      .catch((error: unknown) => { if (live) reportError(error) })
    const unsubscribe = bridge.browser.onChanged((state) => setTabs(state.tabs))
    const unsubscribePointer = bridge.browser.onPointer((event) => {
      pointerSeqRef.current += 1
      setPointerEvent({ ...event, seq: pointerSeqRef.current })
    })
    const unsubscribeActivity = bridge.browser.onActivity((event) => {
      pointerSeqRef.current += 1
      const seq = pointerSeqRef.current
      setActivityEvent({ ...event, seq })
      setActivityByTab((current) => {
        const next = new Map(current)
        next.set(event.tabId, seq)
        return next
      })
    })
    return () => { live = false; unsubscribe(); unsubscribePointer(); unsubscribeActivity() }
  }, [bridge, reportError])

  // Attach races (a tab closed while the webview was mounting) are expected; they resolve on the next snapshot.
  const attach = useCallback((tabId: string, webContentsId: number) => {
    if (bridge) void bridge.browser.attachTab(tabId, webContentsId).catch(() => undefined)
  }, [bridge])
  // Selecting and closing are deliberate clicks, so a rejection is a real
  // failure the user needs to see rather than a mount-order race.
  const select = useCallback((tabId: string) => {
    if (bridge) void bridge.browser.selectTab(tabId).catch(reportError)
  }, [bridge, reportError])
  const close = useCallback((tabId: string) => {
    if (bridge) void bridge.browser.closeTab(tabId).catch(reportError)
  }, [bridge, reportError])

  return { tabs, pointerEvent, activityEvent, activityByTab, attach, select, close }
}
