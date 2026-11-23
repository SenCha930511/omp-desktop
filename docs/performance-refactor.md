# Performance refactor

The refactor keeps OMP session files authoritative and preserves IPC sender/path authorization, atomic state persistence, and background project-script/browser ownership.

## Fast-anything pass (2026-11-23)

The measured pass covers streaming trajectory previews, Markdown block commits, search indexing, todo caching, main-process sorting and transcript assembly, KaTeX font trimming, and the Rust/WASM OMP metadata cold scan. See [performance-fast-anything.md](performance-fast-anything.md) for the baseline, final numbers, and deferred work.

## CPU and memory pass (2026-11-24)

This pass reduces repeated catalog work in the main process and defers KaTeX for ordinary Markdown. It preserves caller-owned `SessionRecord` objects, session lineage, renderer behavior, and the existing Rust/WASM metadata reader.

`SessionService` caches normalized file and project paths by `SessionMetadata` identity. `list()` reuses normalized paths without changing output ownership. A caller that adds a mutable metadata reader must preserve the same invariant: objects stay unchanged after catalog publication, and a content change produces a fresh object. The cache deliberately uses weak keys instead of retaining historical sessions.

KaTeX plugins and their stylesheet load after a normalized Markdown block sees a dollar delimiter. Ordinary Markdown gets a stable GFM-only configuration. Math, CJK annotations, syntax-error colors, inline code and URL security rules retain the original pipeline. A first uncached math block can show normalized Markdown before the plugin request and stylesheet finish. A load failure leaves readable Markdown, logs once, and does not retry. The shared ready cache stays alive for the renderer lifetime; it does not retain a separate parser per block.

Focused headless results, using Node v24.22.3 under `scripts/performance/cpu-memory-budget.mjs`:

| Workload | Before | After | Difference |
|---|---:|---:|---:|
| 5,000 sessions, 100 identical `SessionService.sync` calls | 679.722 ms | 394.152 ms | 42.0% less CPU |
| Retained heap after that workload | 6,606,744 B | 6,887,872 B | 281,128 B additional |

The identity cache costs bounded memory to reduce normalization CPU. These are medians from a synthetic workload, not whole-app measurements.

Two paired eager/lazy Electron runs measured the ordinary-text fixture once per arm. After eight session switches, lazy KaTeX used 0.83–0.85 MiB less `JSHeapUsedSize`, and 3.5–6.6 MiB less renderer working set. Another run put one formula through the app and observed one `.katex` root, the lazy JavaScript and stylesheet, the expected WOFF2 fonts, and no renderer page errors. Ordinary text had no KaTeX resources. These runs cover the fixture, not every possible document or host.

The final production build has `initialRendererBytes=1,026,840`, down from 1,307,421 bytes. The initial HTML has no eager KaTeX JavaScript or stylesheet references. The lazy build retains the same features otherwise; it is a load-timing change, not deletion of math support. See [Focused resource measurements](validation.md#focused-resource-measurements) for reproduction commands and metric definitions.

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
- [x] Complete regression, coverage, production build, bundle-size and hermetic Electron verification.

Aggregate run 2026-10-21 (Node v24.22.0, npm 12.0.2 via `/opt/homebrew/opt/node@24/bin`, `NODE_OPTIONS=--no-experimental-webstorage`): `typecheck` exit 0; `check` exit 0 (only pre-existing warnings in `updates.ts`/`AppearanceSettings.tsx`/`model-picker.test.tsx`); `test:coverage` exit 0 — 179 files, 1827 passed, 1 skipped, per-family thresholds held (79.33% stmt / 72.9% branch / 80.77% fn / 84.8% lines); `build:bundle` exit 0; `release:bundle-size` preflight + budgets passed (initial renderer 0.84 MiB, total renderer JS/CSS 1.52 MiB). Hermetic E2E (`OMP_DESKTOP_E2E_HIDE_WINDOWS=1`): 78 passed, zero renderer pageerrors; `reflects an external JSONL append` was adapted to deferred reasoning mounts (collapses now render bodies only after the row is opened, matching the subagent/search flows). Two deviations are non-blocking: `steers the active turn` fails with the same queue-chip signature on pre-refactor `97b89f2` (environmental, bisected) and `tray Quit` passes on retry (documented flake). No thresholds or budgets were lowered.

## Repeatable checks

`node scripts/performance/jsonl-copy-budget.mjs` bundles the production buffer in memory and checks assembly copies for 1/4/8 MiB records in 64 KiB chunks. It writes no fixture or build files. The original metadata path copied about 9.44/133.94/523.94 MiB through Buffer.concat; the shared buffer copies 1/4/8 MiB. This is a copy-volume result, not an application CPU/RSS claim.

`tests/frontend/transcript-subscription.test.tsx` checks that streamed frames update the real conversation while its workspace owner does not rerender, and that execution semantics still notify the shell.

`tests/backend/session-catalog-sync.test.ts` checks changed-record traffic at 5,000 sessions, missed-revision recovery and overlapping stale reads. Main still rebuilds a bounded catalog view; the delta protocol primarily reduces transport and renderer work.

`tests/backend/runtime-retention.test.ts` checks validation/retirement and changing warm membership. `tests/backend/agent-rpc.test.ts` also exercises actual fixture child processes.

`tests/backend/project-scripts.test.ts` exercises the headless runner: exit-code reporting, bounded output with a single truncation notice, one run per project and kind, process-tree kill on stop, the held `RepositoryUseGate` lease, refusal of an unauthorized cwd, and cleanup for deleted sessions or evicted project folders.

Use the canonical aggregate commands in [validation.md](validation.md). Full application CPU, process memory and energy comparisons require paired runs of the same workload; unit checks do not establish those improvements.
