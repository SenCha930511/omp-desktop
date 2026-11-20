# Repository Guidelines

Guidance for AI coding assistants working in this repository. OMP Desktop is a
native Rust desktop workspace for the [OMP](https://github.com/can1357/oh-my-pi)
coding-agent harness, forked from GooeyPi (see `README.md` → Attribution). It is
a GUI app with no background services; there is nothing to auto-start.

## Project Overview

A cross-platform (macOS/Linux/Windows) desktop shell that gives the `omp` CLI a
native UI: projects, persistent sessions, live transcripts, model/provider
pickers, schedules, a terminal panel, an agent-driven browser, and a
Git/inspector workspace. The harness owns models, logins, and session files;
this app owns the chrome. Single harness only — `omp`.

## Architecture & Data Flow

One native process (no JavaScript runtime, no web view for the app UI):

```
omp-desktop (rust/crates/omp-desktop, GPUI + gpui-kit)
  ├─ app.rs        Workspace view: pages, panes, composer, dialogs, event folding
  ├─ terminal.rs   portable-pty shell panel (vt100 screen, panel-local)
  ├─ browser.rs    wry webview tabs, one isolated profile per tab
  ├─ tray.rs       native tray icon (macOS/Windows/Linux)
  ├─ updates.rs    check-and-notify updater (minisign-verified feed)
  └─ main.rs       window lifecycle, argv handling, packaged-smoke marker
        │
        ▼  stdio JSON-RPC (strict-LF JSONL)
omp CLI (`omp --mode rpc`)  ── owns models, credentials, session .jsonl files
```

- **`omp-core`** owns everything persistent and testable without a window:
  state store (`state.rs`), settings, projects and grants, sessions, Git and
  checkouts, model catalog, plugins/MCP, schedules, collaboration, loopback
  brokers (`broker.rs`), and URL policy (`url_policy.rs`). Put logic there when
  it does not need GPUI.
- **`omp-rpc`** is the blocking stdio JSON-RPC client, including protocol v2
  base64 chunk reassembly. **`omp-conformance`** is the Conformance Protocol v1
  adapter used by `tests/conformance/`.
- **Persistence**: one JSON state file (`omp-desktop-state-v4.json`) with
  versioned migration, Windows tombstone protocol, byte-exact backups, and a
  read-only fail-closed path for unknown versions. Session content belongs to
  OMP's own `.jsonl` files — this app only reads them.
- **Capabilities**: app-owned agent tools reach the desktop through
  random-token loopback brokers, never through a shell or a file-drop protocol.

## Key Directories

| Path | Purpose |
|---|---|
| `rust/crates/omp-core/` | Persisted state, projects/grants, sessions, git, models, plugins, schedules, brokers |
| `rust/crates/omp-desktop/` | GPUI shell: `app.rs` workspace, terminal, browser, tray, updates, packaged smoke |
| `rust/crates/omp-rpc/` | stdio JSON-RPC client for `omp` |
| `rust/crates/omp-conformance/` | Conformance adapter binary |
| `rust/crates/omp-desktop/tests/e2e_parity.rs` | Parity suite that drives the real `Workspace` view |
| `tests/conformance/` | Protocol-level conformance suite (adapter-agnostic) |
| `scripts/release/` | Node release tooling: toolchain bootstrap, tag validation, updater feed |
| `scripts/rust/` | Conformance summarizer and HMAC fixture generator |
| `docs/` | `validation.md` (canonical commands + CI contract), `security.md` (threat model) |
| `assets/` | App icons used by cargo-packager and the tray |

## Development Commands

Rust application (from `rust/`):

```
cargo build -p omp-desktop --locked   # build the app
cargo run -p omp-desktop             # run it
cargo fmt --all --check              # formatting gate
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked      # all crate + parity tests
cargo deny check                     # advisories/licenses/sources
```

Node tooling (from the repository root; release scripts, conformance harness,
documentation guards):

```
npm ci
npm run typecheck        # tsc --noEmit for tests + scripts
npm run check            # biome lint + format:check
npm test                 # vitest: release scripts, docs guards, parity script
npm run test:conformance # conformance suite (needs the Rust adapter)
npm run release:rust-update-feed
```

On Linux CI/Cloud-Agent VMs, wrap GUI test runs with `xvfb-run -a`.

## Code Conventions & Common Patterns

- **Rust style**: `cargo fmt` is authoritative. Keep handwritten files ≤750
  lines when practical (review threshold, not a hard rule); tests, generated,
  and vendored files are exempt.
- **Doc comments state invariants and rationale** on security gates, migration
  steps, and perf-sensitive code — read them before touching the code.
- **Unknown JSON fields survive**: persisted structs use `#[serde(flatten)]` so
  a newer build's data is not destroyed by an older one. Never drop fields
  silently during migration.
- **Compatibility names are deliberate**: `gooeyPiV4Migration`, the
  `gooeypi-packaged-smoke-ready` marker event, `gooeypi_session_*` tool names,
  and the `GOOEYPI_*` broker env vars are pre-rebrand contracts. Do not rename
  them.
- **JS/TS formatting** (biome, `scripts/release/biome.json`): single quotes, no
  semicolons, 2-space indent, lineWidth 200. Pass
  `--config-path=scripts/release/biome.json` when formatting manually.
- **Release scripts** must stay dependency-free apart from Node builtins: they
  run in jobs that install nothing (`js-yaml` is only used by tests).

## Important Files

- `rust/crates/omp-desktop/src/app.rs` — the workspace view; page state, event
  folding, dialogs, and the turn-changes card
- `rust/crates/omp-desktop/src/main.rs` — window lifecycle, argv, smoke marker
- `rust/crates/omp-core/src/state.rs` — persisted state, migration, backups
- `rust/crates/omp-core/src/projects.rs` — project grants and cwd checks
- `rust/crates/omp-core/src/broker.rs` — loopback broker tokens
- `rust/crates/omp-desktop/src/updates.rs` — updater feed verification
- `scripts/release/bootstrap-npm.mjs` — pinned npm bootstrap
- `scripts/release/prepare-rust-update-feed.mjs` — updater feed
- `docs/validation.md` — canonical command reference (don't restate versions
  elsewhere)
- `scripts/release/biome.json` — the effective lint/format config

## Runtime/Tooling Preferences

- **Rust 1.100.0** (`rust-toolchain.toml`); CI installs it explicitly.
- **Node ≥24.15.0, npm ≥12.0.2** (`.nvmrc` pins 24.15.0; `engines` +
  `packageManager` must agree — `scripts/release/preflight.mjs` enforces this).
- **npm only**, and the repo-pinned npm: run `npm run toolchain:bootstrap`
  (installs npm from the checksum-verified `vendor/` archive) before `npm ci`
  on a fresh machine.
- **No runtime npm dependencies**: the desktop app ships no JavaScript. The npm
  tree is development tooling only (Vitest, Biome, TypeScript, `js-yaml`).
- Git remotes: `origin` = `SenCha930511/omp-desktop`, `upstream` =
  `am-will/gooey-pi`.

## Testing & QA

- **Rust tests** cover each crate plus the parity suite; state-migration tests
  replay the Windows tombstone/quarantine protocol and the Node-generated
  v1/v2/v3 fixtures. Run `cargo test --workspace --locked`.
- **Conformance**: `tests/conformance/` drives whichever adapter
  `OMP_CONFORMANCE_ADAPTER_ARGV` / `OMP_CONFORMANCE_ADAPTER_CMD` names, or the
  Rust adapter at `rust/target/debug/omp-conformance`. `terminal` is not a
  required capability because the Rust app has no built-in PTY.
- **Node tests** guard the release scripts and documentation: links must
  resolve, `npm run` references must exist, and the CI/release job tables must
  equal the workflow job ids.
- **CI gates** (`.github/workflows/ci.yml`): `release-scripts`, `rust` (fmt,
  clippy, deny, tests on macOS/Linux/Windows), `rust-conformance`, and the three
  packaged smoke jobs. All Node jobs run `toolchain:bootstrap` + preflight.
- **Release is fail-closed**: `release-packages` fails unless every platform
  produced a minisign `.sig`, and `rust-update-feed` only publishes a feed from
  signed artifacts.
