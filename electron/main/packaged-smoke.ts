import { isAbsolute } from 'node:path'

/**
 * The packaged renderer's only trusted document URL. `resolveRendererUrl` and
 * the packaged-smoke readiness marker both read it from here so the launcher
 * can never be checked against a URL the main process no longer serves.
 */
export const PACKAGED_RENDERER_URL = 'omp-desktop://app/index.html'

/**
 * Diagnostic startup check: `OMP Desktop --packaged-smoke=<absolute marker path>`
 * writes one readiness marker and exits as soon as the trusted renderer has
 * completed an authorized IPC round trip. It grants no capability, opens no new
 * IPC surface, and reports readiness only after the ordinary renderer trust
 * gate in `registerIpc` has already admitted the sender, so it stays safe in
 * shipped builds; see docs/security.md.
 */
export const PACKAGED_SMOKE_FLAG = '--packaged-smoke='
export const PACKAGED_SMOKE_READY_EVENT = 'gooeypi-packaged-smoke-ready'
export const MAX_PACKAGED_SMOKE_MARKER_BYTES = 4 * 1024

export interface PackagedSmokeMarker {
  event: typeof PACKAGED_SMOKE_READY_EVENT
  url: string
  version: string
}

/**
 * Reads the marker path out of the process's own argv. Only the first
 * instance's argv is ever parsed: a `second-instance` command line must not be
 * able to make a running application write a marker or quit.
 */
export function packagedSmokeMarkerPath(argv: readonly string[]): string | null {
  const requested = argv.filter((argument) => argument.startsWith(PACKAGED_SMOKE_FLAG))
  if (requested.length === 0) return null
  if (requested.length > 1) throw new Error(`Packaged smoke mode accepts exactly one ${PACKAGED_SMOKE_FLAG}<path> argument`)
  const path = requested[0].slice(PACKAGED_SMOKE_FLAG.length)
  if (!path || path.trim() !== path || /[\0\r\n]/.test(path) || !isAbsolute(path)) {
    throw new Error(`${PACKAGED_SMOKE_FLAG} requires an absolute single-line marker path`)
  }
  return path
}

export function packagedSmokeMarker(url: string, version: string): PackagedSmokeMarker {
  if (url !== PACKAGED_RENDERER_URL) throw new Error(`Packaged smoke mode reached an unexpected renderer URL: ${url}`)
  return { event: PACKAGED_SMOKE_READY_EVENT, url, version }
}

export function serializePackagedSmokeMarker(marker: PackagedSmokeMarker): string {
  const serialized = `${JSON.stringify(marker)}\n`
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PACKAGED_SMOKE_MARKER_BYTES) throw new Error('Packaged smoke readiness marker exceeds its byte limit')
  return serialized
}
