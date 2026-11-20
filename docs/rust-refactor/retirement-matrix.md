# Rust v2 retirement matrix

The Rust application is the shipping desktop application. The Electron
application is retired from the release path: it stays in the repository as
legacy source with its own pull-request CI (conformance, hermetic E2E, and
packaging smoke), and it is only packaged for a release when a maintainer opts
back into the legacy build.

The retirement gate is the curated 88-scenario matrix in `tests/e2e/app.spec.ts`.
`rust/crates/omp-desktop/tests/e2e_parity.rs` drives the real `Workspace` view
through 96 parity tests that cover those scenarios; several tests are variants
of the same scenario, so the distinct-scenario count is about 88, not 96. The
Electron Playwright suite remains as source-only coverage for the legacy tree.

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
| Live voice | `app.rs` live-event helper tests, pane render test; dictation over RPC |
| Updater feed | `prepare-rust-update-feed.mjs` validation tests; `release.yml` builds, signs, and uploads `updates.json` on every release |
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
| Plugin install | Source field, background install, catalog refresh |
| Session mention | Bounded recent-session menu inserts an @path |
| Math segments | Inline/display chips with an unchanged copy path |
| Responsive layout | Right pane collapses behind a Details overlay under 1100px |
| Terminal context | `Send selection` quotes the last visible line |
| Notifications | Unread badge clears on open and persists the read marks |
| Parity harness | `tests/e2e_parity.rs`, 96 tests mapping to about 88 distinct scenarios; 3 browser UI tests are gated off Linux |
| Updater | `updates.rs` state tests, Settings row render test |
| Packaging | macOS `.app`, Linux AppImage, Windows NSIS release packages built and signed on every release; `.deb` and NSIS packaged-smoke CI jobs |
| Conformance | 10 files, 21 tests against the Rust adapter on macOS, Linux, and Windows |

## Closed gates

- **Electron cutover: closed.** The Rust app is the shipping desktop
  application. `release.yml` builds and cargo-packager-signs the macOS
  (arm64 and x86_64), Linux x86_64, and Windows x86_64 packages on every
  release, publishes them with `SHA256SUMS.txt`, and attaches `updates.json`.
- **Updater feed: closed.** `rust-update-feed` runs after publication and
  uploads the signed feed. A release without `RUST_UPDATER_SIGNING_KEY` is not
  publishable: signing skips with a notice and the aggregate release gate fails
  closed.

## Legacy-only surface

- The Electron `package`, `package-linux`, and `package-windows` release jobs
  are opt-in (`include_legacy_electron` on manual dispatch or the
  `RELEASE_ELECTRON_ENABLED` repository variable) and are off by default.
- The Electron tree keeps its pull-request CI unchanged: conformance,
  hermetic E2E, and packaging smoke. Those jobs validate the legacy source; they
  are not part of the default release.
