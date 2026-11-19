# OMP Desktop Rust workspace

The v2 desktop application is moving from Electron/React to Rust. This workspace is the core of that move. It does not replace the Electron app yet; both trees live in the repository until the Phase 5 cutover gate passes.

## Crates

| Crate | Responsibility |
|---|---|
| `omp-core` | Persisted state, settings, projects, sessions, git and checkouts, model catalog, plugins/MCP, schedules, collaboration envelopes, loopback brokers |
| `omp-rpc` | Blocking stdio JSON-RPC client for the `omp` CLI, including protocol v2 base64 chunk reassembly |
| `omp-conformance` | Conformance Protocol v1 adapter used by `tests/conformance/` |
| `omp-desktop` | GPUI + `gpui-kit` native shell: first-frame geometry, three-pane workspace, toolbar, right-pane launcher, turn-only diff card, IME guard, packaged-smoke marker |

The GPUI shell is intentionally narrow today. It proves the native window, persisted geometry, and first-frame paint while the full page set is ported.

## Verification

```bash
cd rust
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build -p omp-conformance --locked
```

The executable spec is the existing cross-language suite. From the repository root:

```bash
OMP_CONFORMANCE_PARTIAL=1 \
OMP_CONFORMANCE_REQUIRED_CAPABILITIES=state,projects,sessions,models,agent,git,checkouts,plugins,schedules,collaboration \
OMP_CONFORMANCE_ADAPTER_CMD="$PWD/rust/target/debug/omp-conformance" \
npm run test:conformance
```

`terminal` is deliberately absent: v2 removes the built-in PTY. Partial mode may skip capabilities outside the required set, but a required capability is never skipped.

## State compatibility

Every persisted struct keeps unknown JSON fields through `#[serde(flatten)]`. The state store preserves the Electron migration rules: v1-v3 migration, POSIX legacy retirement, Windows tombstones, downgrade quarantine, and byte-exact backups. `agent-message-signing.key` stays at the same path and the HMAC envelope keeps the Node field order; the Rust tests verify Node-generated v1/v2/v3 fixtures.

## Native smoke and geometry checks

```bash
cd rust
cargo run -p omp-desktop -- --packaged-smoke=/tmp/smoke.json --user-data-dir=/tmp/omp-rust
cat /tmp/smoke.json
```

The marker is written from `Window::on_next_frame`, so it proves a real GPUI window drew a frame. To inspect the first-frame geometry without opening the UI by hand:

```bash
mkdir -p /tmp/omp-rust
printf '%s
' '{"windowBounds":{"x":80,"y":80,"width":1440,"height":900,"maximized":false},"sidebarOpen":true,"sidebarWidth":300,"rightPaneOpen":true,"rightPaneWidth":400}' > /tmp/omp-rust/ui-geometry.json
cargo run -p omp-desktop -- --dump-layout=/tmp/layout.json --user-data-dir=/tmp/omp-rust
cat /tmp/layout.json
```

`sidebarWidth` and `rightPaneWidth` must match the persisted values in the first frame; bootstrap data never changes them.

## Packaging

```bash
cd rust
cargo build -p omp-desktop --locked
cd crates/omp-desktop
cargo packager --formats app
"../../dist/OMP Desktop.app/Contents/MacOS/omp-desktop" \
  --packaged-smoke=/tmp/smoke.json --user-data-dir=/tmp/omp-rust-packaged
```

The packaged binary writes the same first-frame marker as the development build. The CI `Rust packaged smoke` job repeats this on macOS.

## Remaining work

- Full page set: Schedules and Browser remain; Settings, Extensions, Review, and Summary are present.
- A due-task scheduler that executes persisted schedules; the core currently stores and validates them only.
- Real worktree checkout creation; worktree requests return a typed refusal instead of switching the main branch.
- The 88-scenario UI retirement matrix beyond the current layout, IME, and turn-diff tests.
- Tray, updater, packaging, and the final Electron cutover gate.
