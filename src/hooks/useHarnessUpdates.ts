import { useCallback, useEffect, useState } from 'react'
import type { DesktopApi, HarnessUpdateState } from '@/types/api'

const IDLE_STATE: HarnessUpdateState = { phase: 'idle' }

/**
 * Mirrors the main-process `omp update` lifecycle. The main process runs the
 * startup check; the renderer only observes state and triggers installs.
 */
export function useHarnessUpdates(bridge: DesktopApi | null, reportError: (error: unknown) => void) {
  const [state, setState] = useState<HarnessUpdateState>(IDLE_STATE)

  useEffect(() => {
    if (!bridge) {
      setState(IDLE_STATE)
      return
    }
    let cancelled = false
    const unsubscribe = bridge.harnessUpdates.onChanged((next) => { if (!cancelled) setState(next) })
    void bridge.harnessUpdates.getState()
      .then((next) => { if (!cancelled) setState(next) })
      .catch((error) => { if (!cancelled) reportError(error) })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [bridge, reportError])

  /** Runs `omp update` and resolves with the terminal state, reporting failures. */
  const install = useCallback(async (): Promise<HarnessUpdateState | null> => {
    if (!bridge) return null
    try {
      return await bridge.harnessUpdates.install()
    } catch (error) {
      reportError(error)
      return null
    }
  }, [bridge, reportError])

  return { state, install }
}
