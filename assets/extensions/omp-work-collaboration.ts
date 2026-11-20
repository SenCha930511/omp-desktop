/**
 * GooeyPi session collaboration used to register its six `gooeypi_session_*`
 * tools here. They are OMP v19 host tools now:
 * `electron/main/collaboration/host-tools.ts` defines them and the runtime
 * manager advertises them per session, so this shipped extension registers no
 * tools. The scoped broker environment
 * (`GOOEYPI_COLLABORATION_URL`/`GOOEYPI_COLLABORATION_TOKEN`) still backs the
 * capability claim those host tools resolve.
 */
export default function ompWorkCollaboration(): void {
  // Session tools live in the main process; nothing to register in the child.
}
