# Fast-anything performance pass

This pass follows the `fast-anything` rule. Measure first, port only the work that stays hot, and keep the zero-native packaging gates. The branch is `perf/fast-anything-plan`, cut from `origin/main` at `465cccd`.

## Scope

Included:

- Streaming renderer work in the transcript trajectory, Markdown, search, and todo HUD.
- Main-process session sorting, transcript assembly, catalog sync, title-slot reads, and project file listing.
- Bundle work that removes duplicate KaTeX font formats and keeps the main entry under its release budget.

Excluded:

- Native `.node` modules. They would require `app.asar.unpacked` and break `verify-package.mjs`.
- Renderer WASM. It would need a CSP change and a second Markdown or transcript parser.
- Release, merge, or tag changes.

## Measurement

The harness runs two commands under Node `v24.22.3`:

```
node scripts/performance/fast-anything-budget.mjs
node scripts/performance/transcript-parse-budget.mjs
```

Baseline numbers are in `scripts/performance/baseline-2026-11-23.json`. Final numbers are in `scripts/performance/results-2026-11-23.json`. The transcript benchmark now takes the median of three runs for each fixture.

| Workload | Baseline | Final | Change |
|---|---:|---:|---:|
| 500 streaming frames over 400 messages | 2,502.4 ms | 7.8 ms | 322x faster |
| 200 searches over 1,000 messages with 128 KiB tool args | 18.8 ms | 7.8 ms | 2.4x faster |
| 100 syntax scans of a 200 KB tool output | 301.4 ms | 94.1 ms | 3.2x faster |
| 100 recent-session selections over 5,000 sessions | 113.5 ms | 59.4 ms | 1.9x faster |
| 100 catalog sorts over 5,000 file names | 292.1 ms | 157.8 ms | 1.85x faster |
| 1,000 todo HUD scans over 400 messages | 16.7 ms | 3.5 ms | 4.8x faster |
| Cold open of a 50 MiB JSONL session | 107.2 ms | 100.6 ms | 1.07x faster |
| Parse of 2,000 tool results in one assistant turn | 56.7 ms | 21.3 ms | 2.65x faster |

The 50 MiB case is dominated by file I/O and `JSON.parse`. The linked-list insertion change is visible in the 2,000 tool-result case. Both numbers matter, and neither is extrapolated to whole-app CPU.

## Renderer changes

`TranscriptTrajectory` caches a preview per message object and reuses unchanged turn objects. It also reads only the first 4 KiB of a long message for the preview regexes. The scroll effect now depends on the turn count, not on a new turns array for every streamed token. This removes the repeated layout reads during streaming.

`MarkdownText` splits a streaming reply at safe blank lines. Committed blocks keep their parsed React tree, and only the live tail re-parses. The splitter refuses boundaries inside fences, display math, lists, blockquotes, tables, indented continuations, and link or footnote definitions. A settled message still renders as one Markdown tree.

`transcript-search` caches the normalized text of each message part. A 128 KiB tool argument is serialized once, not on every query. The highlight observer watches the matched row after it mounts instead of the whole transcript. Highlight ranges use a prefix-offset binary search.

`TranscriptHud` caches parsed todo phases by tool-result part. An unchanged plan returns the same array, so `TodoHud` does not re-render on every streaming frame.

## Main-process changes

Session name timestamps and session record timestamps are computed once before sorting. The recent sidebar list uses a top-8 pass instead of sorting all 5,000 rows. `FilesPanel` shares one `Intl.Collator`.

The transcript assembler builds the active assistant parts as a linked draft. A tool result inserts after its call in constant time, and the draft materializes once when the turn closes. The previous array splice shifted every later part and rewrote the index map on each result.

`SessionCatalogSync` compares array fields by value. A rescan that rebuilds `lastUserTexts` with the same strings no longer publishes a false delta.

The OMP title slot uses one `open` and `read` through a new `readPrefix` seam. Injected readers without the seam keep the stream fallback.

## Bundle changes

The renderer keeps only WOFF2 KaTeX fonts. The build removes 39 WOFF and TTF files, and `release:bundle-size` fails if they return.

The project service is split out of the main entry. The entry is 488,759 bytes against a 557,056-byte budget. The project chunk is 74,885 bytes. This is a measurement split, not a reduction in total main-process JavaScript.

| Metric | Baseline | Final | Budget |
|---|---:|---:|---:|
| Main entry | 556,078 B | 488,759 B | 557,056 B |
| Initial renderer | 1,305,388 B | 1,307,421 B | 1,351,680 B |
| Largest renderer chunk | 350,226 B | 352,259 B | 655,360 B |
| Renderer JS and CSS | 1,899,784 B | 1,900,535 B | 2,375,680 B |

The 656,910-byte largest chunk in the planning note came from an older build. The current main already lazy-loads the transcript, composer, inspector, and settings pages.

## Rust/WASM core

The OMP metadata cold scan is ported to Rust in `crates/omp-jsonl-core`. The crate parses the JSONL tail with `serde_json`, mirrors the bucketed accumulator fields, and returns one accumulator object. It does not use `wasm-bindgen` or a native addon. The raw ABI copies the input bytes and three default strings into linear memory and reads one JSON result.

`createOmpSessionMetadataReader` uses the core for the first read of an OMP session file up to 4 MiB. It parses the 256-byte title slot inside the same call, so the fast path reads the file once. Appends and rewrites use the existing incremental TS reader. A fallback result, a missing wasm, a disabled flag, or any unsupported timestamp shape returns to the TS path. `OMP_DESKTOP_DISABLE_WASM=1` forces the TS path.

The artifact is `assets/wasm/omp-jsonl-core.wasm` (86,271 bytes), and `npm run build:bundle` copies it to `out/main/omp-jsonl-core.wasm`. It stays inside `app.asar`, with no `app.asar.unpacked` entry and no Electron fuse change. `scripts/release/lib.mjs` requires the wasm in the packaged ASAR.

| Workload | TS | WASM | Change |
|---|---:|---:|---:|
| 1,000 cold OMP session files | 150.9 ms | 94.6 ms | 1.59x faster |
| 58 real OMP sessions | n/a | n/a | 58 fast path, 0 mismatches |
| 500 local JSONL files | n/a | n/a | 474 fast path, 26 fallback, 0 mismatches |

Repeat runs on the same host ranged from 1.55x to 1.81x; the table shows one representative run. The small-file win comes from one read per file and a single JSONL pass. Above 4 MiB the streaming TS reader stays in use, because a local size sweep showed the core is even or slightly slower there. The fast path is on by default because the cold catalog scan is the target workload.

## Deferred work

Parallel project listing stays out. A bounded breadth-first scan changed which entries survive the 5,000-entry cap, so the review reverted it. A depth-first frontier needs its own cap test and a measured large-repository trace.

Dynamic KaTeX loading stays out. The math tests render synchronously with `renderToStaticMarkup`. The initial renderer is about 43 KiB under budget, so the change would buy little today and require an async test contract.

Diff virtualization stays out. The diff is capped at 4,000 lines. `content-visibility` on grid rows can change the `min-width: max-content` measurement and cause horizontal scrollbar jumps. A UI trace should decide the chunk size before changing the DOM.

Removing the `structuredClone` on a transcript cache hit stays out. `SessionService.read` shares one result across coalesced callers, and no read-only guarantee covers every internal caller. The defensive copy stays.

## Verification

Canonical commands are in [validation.md](validation.md). The final branch run is recorded in the pull request checks: typecheck, lint, format, the WASM equivalence benchmark, coverage, bundle size, hermetic Electron end-to-end, Windows state migration, and packaging smoke.
