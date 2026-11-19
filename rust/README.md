# OMP Desktop Rust workspace

The v2 desktop application is moving from Electron/React to Rust. This workspace is the core of that move. It does not replace the Electron app yet; both trees live in the repository until the Phase 5 cutover gate passes.

## Crates

| Crate | Responsibility |
|---|---|
| `omp-core` | Persisted state, settings, projects, sessions, git and checkouts, model catalog, plugins/MCP, schedules, collaboration envelopes, loopback brokers |
| `omp-rpc` | Blocking stdio JSON-RPC client for the `omp` CLI, including protocol v2 base64 chunk reassembly |
| `omp-conformance` | Conformance Protocol v1 adapter used by `tests/conformance/` |

The GPUI application crate (`omp-desktop`) is not present yet. The core and adapter land first because every screen depends on them.

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

## Remaining work

- GPUI shell and the five UI revisions.
- `omp-desktop` UI tests against the 88-scenario retirement matrix.
- Packaging, updater, and the final Electron cutover gate.
