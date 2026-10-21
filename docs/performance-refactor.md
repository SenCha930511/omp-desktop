# Performance refactor

The refactor keeps OMP session files authoritative and preserves IPC sender/path authorization, atomic state persistence, and background terminal/browser ownership.

## Verification units

- [x] Enable streaming Markdown at its actual callers and defer collapsed reasoning bodies.
- [x] Share linear JSONL line assembly between RPC, transcripts, and incremental metadata. Bound retained metadata payload, including accumulator strings.
- [x] Preserve completed assistant group identities; memoize unchanged syntax/tool content; stop inactive search and subagent polling; bound mounted subagent views.
- [x] Define fixed IPC channel names once and centralize trusted broadcasts. Read only the required state fields.
- [x] Own Git reads in one hook, share overlapping reads, and reject stale workspace results.
- [x] Exchange coherent session snapshots/deltas, preserving lifecycle provenance and per-file sync revisions.
- [x] Subscribe to full transcript frames inside conversation/summary views; notify the app shell only on semantic changes.
- [x] Bound frame and read-replay payloads and recover overflow from a fresh authoritative read.
- [x] Retain one warm idle OMP runtime, reclaim excess idle children after a grace period, and protect admitted commands.
- [x] Stop idle compaction watchdog wakeups; resume on commands/events.
- [x] Restore host-wide browser background throttling after automation activity settles.
- [x] Pause PTY output above its outstanding-output budget; acknowledge only after xterm consumes it.
- [x] Complete regression, coverage, production build, bundle-size and hermetic Electron verification.

Aggregate run 2026-10-21 (Node v24.22.0, npm 12.0.2 via `/opt/homebrew/opt/node@24/bin`, `NODE_OPTIONS=--no-experimental-webstorage`): `typecheck` exit 0; `check` exit 0 (only pre-existing warnings in `updates.ts`/`AppearanceSettings.tsx`/`model-picker.test.tsx`); `test:coverage` exit 0 — 179 files, 1827 passed, 1 skipped, per-family thresholds held (79.33% stmt / 72.9% branch / 80.77% fn / 84.8% lines); `build:bundle` exit 0; `release:bundle-size` preflight + budgets passed (initial renderer 0.84 MiB, total renderer JS/CSS 1.52 MiB). Hermetic E2E (`OMP_DESKTOP_E2E_HIDE_WINDOWS=1`): 78 passed, zero renderer pageerrors; `reflects an external JSONL append` was adapted to deferred reasoning mounts (collapses now render bodies only after the row is opened, matching the subagent/search flows). Two deviations are non-blocking: `steers the active turn` fails with the same queue-chip signature on pre-refactor `97b89f2` (environmental, bisected) and `tray Quit` passes on retry (documented flake). No thresholds or budgets were lowered.

## Repeatable checks

`node scripts/performance/jsonl-copy-budget.mjs` bundles the production buffer in memory and checks assembly copies for 1/4/8 MiB records in 64 KiB chunks. It writes no fixture or build files. The original metadata path copied about 9.44/133.94/523.94 MiB through Buffer.concat; the shared buffer copies 1/4/8 MiB. This is a copy-volume result, not an application CPU/RSS claim.

`tests/frontend/transcript-subscription.test.tsx` checks that streamed frames update the real conversation while its workspace owner does not rerender, and that execution semantics still notify the shell.

`tests/backend/session-catalog-sync.test.ts` checks changed-record traffic at 5,000 sessions, missed-revision recovery and overlapping stale reads. Main still rebuilds a bounded catalog view; the delta protocol primarily reduces transport and renderer work.

`tests/backend/runtime-retention.test.ts` checks validation/retirement and changing warm membership. `tests/backend/agent-rpc.test.ts` also exercises actual fixture child processes.

`tests/backend/terminal.test.ts` runs a real PTY producer, delays consumption, then verifies complete 2 MiB output and acknowledgement ownership. Early renderer attachment is covered separately by frontend tests.

Use the canonical aggregate commands in [validation.md](validation.md). Full application CPU, process memory and energy comparisons require paired runs of the same workload; unit checks do not establish those improvements.
