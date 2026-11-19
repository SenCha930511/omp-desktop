# Rust v2 retirement matrix

The 88 Playwright scenarios in `tests/e2e/app.spec.ts` remain the Electron
retirement gate. They run against the Electron application today. The Rust app
does not yet have an equivalent Playwright harness, so the gate is **not closed**
by the Rust unit and smoke tests below.

## Rust evidence that exists

| Surface | Rust evidence |
|---|---|
| First frame, docked panes, persisted geometry | `rust/crates/omp-desktop/tests/workspace.rs`, `--dump-layout`, packaged-smoke |
| IME composition guard | `rust/crates/omp-desktop/src/ime.rs` tests |
| Turn-only diff card | `rust/crates/omp-core/src/turn_changes.rs` tests |
| Sessions, pin/archive/delete, transcript reads | `omp-core` session tests, `Workspace` pane tests |
| Settings, Extensions, Review, Summary | `Workspace` pane tests, `omp-core` settings/plugins/git tests |
| Schedules | `omp-core` scheduler tests (15), Schedules pane test |
| Browser | `browser.rs` URL tests, live WKWebView runtime smoke |
| Files, Subagents, Side Question | `Workspace` pane tests, `omp-core` project-file tests |
| Tray | `tray.rs` tests, `--tray-smoke` on macOS; Linux tray construction |
| Updater | `updates.rs` state tests, Settings row render test |
| Packaging | macOS `.app`, Linux `.deb`, Windows NSIS packaged-smoke CI jobs |
| Conformance | 10 files, 20 tests against the Rust adapter on macOS, Linux, and Windows |

## Groups that remain unclosed

- Terminal and voice surfaces.
- The updater release feed and signing pipeline.
- The full 88-scenario Playwright run against the Rust app, including browser
  annotation capture, agent-driven browser tabs, terminal panel behavior, voice,
  and the remaining workspace interactions.
- The final Electron cutover gate.

Until the Playwright matrix runs against the Rust app and the terminal/voice
surfaces exist, the Electron app remains the shipping desktop application.
