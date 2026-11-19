# Rust v2 retirement matrix

The 88 Playwright scenarios in `tests/e2e/app.spec.ts` remain the Electron
retirement gate. They run against the Electron application today. The Rust app
does not yet have an equivalent Playwright harness, so the gate is **not closed**
by the Rust unit and smoke tests below. The 60 Rust parity tests include several
variants of the same Electron scenario, so the distinct-scenario count is about
55, not 60.

## Rust evidence that exists

| Surface | Rust evidence |
|---|---|
| First frame, docked panes, persisted geometry | `rust/crates/omp-desktop/tests/workspace.rs`, `--dump-layout`, packaged-smoke |
| IME composition guard | `rust/crates/omp-desktop/src/ime.rs` tests |
| Turn-only diff card | `rust/crates/omp-core/src/turn_changes.rs` tests |
| Sessions, pin/archive/delete, transcript reads | `omp-core` session tests, `Workspace` pane tests |
| Settings, Extensions, Review, Summary | `Workspace` pane tests, `omp-core` settings/plugins/git tests |
| Schedules | `omp-core` scheduler tests (15), Schedules pane test |
| Browser | `browser.rs` URL tests, live WKWebView runtime smoke, annotations, tabs, per-tab profiles |
| Files, Subagents, Side Question | `Workspace` pane tests, `omp-core` project-file tests |
| Tray | `tray.rs` tests, `--tray-smoke` on macOS; Linux tray construction |
| Terminal | `terminal.rs` PTY helpers, tabs, per-session restore, panel render test |
| Live voice | `app.rs` live-event helper tests, pane render test; dictation is not implemented |
| Updater feed | `prepare-rust-update-feed.mjs` validation tests; release.yml is not wired |
| Ask user | `extension_ui_request` normalization, Ask pane, answer/cancel tests |
| Capture | `render_to_image`, PNG save, status row, unit/parity tests |
| Close confirmation | CloseGuard, window/tray routes, overlay tests |
| Context usage | `get_session_stats` parsing and compact dial |
| Composer queue | Running sends become `follow_up` with a queued row |
| Transcript tail | Auto-follow only when pinned; jump-to-latest control |
| Model picker | Lazy catalog, persisted default, and live set_model |
| Session fork | Menu action, one command, refresh and follow the newest |
| Extension toggles | MCP and package enable/disable persist and refresh |
| Composer image | One magic-checked attachment with prompt/follow-up |
| External append | 2s stat watch reloads the file and preserves scroll |
| Message fork | Row action sends the entryId through the fork path |
| Provider filter | Chips narrow the model list and keep the selection |
| Parity harness | `tests/e2e_parity.rs`, 90 tests mapping to about 82 distinct scenarios; 3 browser UI tests are gated off Linux |
| Updater | `updates.rs` state tests, Settings row render test |
| Packaging | macOS `.app`, Linux `.deb`, Windows NSIS packaged-smoke CI jobs |
| Conformance | 10 files, 20 tests against the Rust adapter on macOS, Linux, and Windows |

## Groups that remain unclosed

- Wiring the updater feed and signatures into `release.yml`.
- The remaining 6 Playwright scenarios, including settings plugin,
  notification capture, terminal selection context, and the responsive workspace.
- The final Electron cutover gate.

Until the remaining Playwright matrix runs against the Rust app, the Electron
app remains the shipping desktop application.
