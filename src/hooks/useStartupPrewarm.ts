import { useEffect, useRef } from 'react'
import type { DesktopApi, HarnessId, RuntimeInfo, SessionRecord } from '@/types/api'

export interface StartupPrewarmInput {
  bridge: DesktopApi | null
  /** True once useBootstrap finished selecting and activating the startup workspace. */
  initialized: boolean
  harness: HarnessId
  /** The bootstrap-selected durable session, if any. */
  session: SessionRecord | undefined
  cwd: string | undefined
  /** Inferred projects are display-only until the user grants them. */
  projectInferred?: boolean
  /** Already attached runtime; a runtime for the same session needs no warm-up. */
  attachedRuntime: RuntimeInfo | null | undefined
}

/**
 * One post-paint launch of the startup session, so the first prompt does not
 * pay the whole local resume cost.
 *
 * Deliberately minimal: it sends only cwd/sessionPath/harness (no model,
 * thinking, or fast — the child resumes with the session's own persisted
 * configuration), never attaches a runtime, never sends a prompt, and
 * swallows failures so startup is never interrupted. The first prompt aligns
 * the live runtime with the composer's latest selection instead.
 */
export function useStartupPrewarm({ bridge, initialized, harness, session, cwd, projectInferred, attachedRuntime }: StartupPrewarmInput): void {
  // Latched on the first initialized render — the same commit that applied the
  // startup selection — so a later session can never trigger a second launch
  // and StrictMode's double effect reaches the same latch.
  const decidedRef = useRef(false)
  useEffect(() => {
    if (!initialized || decidedRef.current) return
    decidedRef.current = true
    if (!bridge) return
    const sessionPath = session?.filePath
    if (!sessionPath || !cwd) return
    if (projectInferred) return
    if (session?.status === 'running' || session?.status === 'waiting') return
    if (attachedRuntime?.sessionFile === sessionPath) return
    void bridge.agent.start({ cwd, sessionPath, harness }).catch(() => undefined)
  }, [attachedRuntime, bridge, cwd, harness, initialized, projectInferred, session])
}
