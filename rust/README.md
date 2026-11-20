# OMP Desktop Rust workspace

The v2 desktop application moved from Electron/React to Rust. This workspace is the shipping desktop application. The Electron tree at the repository root is legacy source: it keeps its pull-request CI but is retired from the release path.

## Crates

| Crate | Responsibility |
|---|---|
| `omp-core` | Persisted state, settings, projects, sessions, git and checkouts, model catalog, plugins/MCP, schedules, collaboration envelopes, loopback brokers |
| `omp-rpc` | Blocking stdio JSON-RPC client for the `omp` CLI, including protocol v2 base64 chunk reassembly |
| `omp-conformance` | Conformance Protocol v1 adapter used by `tests/conformance/` |
| `omp-desktop` | GPUI + `gpui-kit` native shell: first-frame geometry, three-pane workspace, toolbar, right-pane launcher, turn-only diff card, IME guard, packaged-smoke marker |

The GPUI shell carries the full page set. `tests/e2e_parity.rs` drives the real `Workspace` view through 96 parity tests covering the 88 curated Electron scenarios.

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

`cargo deny check` passes with two recorded unmaintained advisories: `chrono` and `chrono-tz` are pulled by `rrule` for schedule recurrence. Migrating to `jiff`/`time` is a v2.1 follow-up; the exceptions and reasons live in `rust/deny.toml`.

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

macOS:

```bash
cd rust
cargo build -p omp-desktop --locked
cd crates/omp-desktop
cargo packager --formats app
"../../dist/OMP Desktop.app/Contents/MacOS/omp-desktop" \
  --packaged-smoke=/tmp/smoke.json --user-data-dir=/tmp/omp-rust-packaged
```

Linux:

```bash
cd rust
cargo build -p omp-desktop --locked
cd crates/omp-desktop
cargo packager --formats deb
dpkg-deb -x ../../dist/omp-desktop_2.0.0_amd64.deb /tmp/omp-rust-deb
xvfb-run -a /tmp/omp-rust-deb/usr/bin/omp-desktop \
  --packaged-smoke=/tmp/smoke.json --user-data-dir=/tmp/omp-rust-packaged
```

Windows:

```powershell
cd rust
cargo build -p omp-desktop --locked
cd crates/omp-desktop
cargo packager --formats nsis
# rust/dist/omp-desktop_2.0.0_x64-setup.exe
& ..\..\dist\omp-desktop_2.0.0_x64-setup.exe /S /NS /D=C:\omp-rust-packaged
& C:\omp-rust-packaged\omp-desktop.exe `
  --packaged-smoke=C:\omp-rust-smoke.json --user-data-dir=C:\omp-rust-user-data
```

`/S` installs silently, `/NS` skips the desktop and Start menu shortcuts, and `/D=` must be the last argument and unquoted; keep the target path free of spaces so PowerShell cannot quote it. cargo-packager 0.11.8 downloads its own pinned NSIS 3.09 toolchain on Windows, so no system NSIS install is required.

`Packager.toml` lists all three formats: `app` is macOS-only, `deb` is Linux-only, and `nsis` is Windows-only. cargo-packager still iterates every configured format instead of filtering to the host, so pass `--formats` for the package you want; CI does exactly that. The deb uses `assets/icon.png` for the hicolor icon and `assets/icon.icns` stays the macOS bundle icon. No `assets/icon.ico` is checked in, so the NSIS installer uses its default icon until that file is added and wired through `[nsis] installer_icon`.

The packaged binary writes the same first-frame marker as the development build. CI repeats this on macOS (`Rust packaged smoke`), on Ubuntu under Xvfb (`Rust packaged smoke (Linux deb)`), and on `windows-2022` from the silently installed NSIS package (`Rust packaged smoke (Windows nsis)`).

The release workflow runs these packaging steps on every release and uploads the signed artifacts plus `updates.json`; see [the validation guide](../docs/validation.md#rust-updater-feed) for the feed contract.

## Release status

- Terminal, live voice, dictation, and browser element annotations are present.
- The workspace, Schedules, Browser, Files, Subagents, Side Question, Settings, Extensions, Review, and Summary are present.
- The tray is present on macOS, Windows, and Linux; a Linux session without an AppIndicator host logs and continues.
- The Electron cutover gate is closed: 96 parity tests map to about 88 distinct UI retirement scenarios, and this workspace is the shipping desktop application.
- `release.yml` builds and cargo-packager-signs the macOS (arm64 and x86_64), Linux x86_64, and Windows x86_64 packages on every release, publishes them with `SHA256SUMS.txt`, and attaches `updates.json`. Signing requires `RUST_UPDATER_SIGNING_KEY`; the client reads `OMP_UPDATER_PUBKEY`.
- The Electron tree at the repository root is legacy source. Its release jobs are opt-in (`include_legacy_electron` or `RELEASE_ELECTRON_ENABLED`) and off by default.
