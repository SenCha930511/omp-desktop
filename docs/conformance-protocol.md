# Conformance & Black-Box Parity Protocol (v1)

This specification defines the language- and UI-framework-agnostic test contract for OMP Desktop. The suite in `tests/conformance/` is the executable spec for the Rust application: any adapter that speaks this protocol is validated against the same behavioral requirements.

## Architecture Overview

The harness decouples behavioral verification from the native UI through three black-box interfaces:

1. **Stdio JSON-RPC Conformance Adapter Protocol v1** (`tests/conformance/`):
   - Tests spawn an adapter executable over stdio (`stdin`/`stdout`, strict LF-delimited JSONL).
   - Default adapter: the Rust binary at `rust/target/debug/omp-conformance` (or `omp-conformance.exe` on Windows), built with `cargo build -p omp-conformance --locked`.
   - Adapter override:
     - `OMP_CONFORMANCE_ADAPTER_CMD="/path/to/omp-desktop-conformance --flag"`
     - or `OMP_CONFORMANCE_ADAPTER_ARGV='["cargo","run","--quiet","-p","omp-conformance"]'`
   - Incremental bring-up mode: set `OMP_CONFORMANCE_PARTIAL=1` to skip capabilities not yet listed by `adapter.info` instead of failing immediately. In CI (`OMP_CONFORMANCE_PARTIAL` unset), every capability is mandatory.

2. **Black-Box Compiled Binary Launch Smoke Contract**:
   - Launches the packaged binary with:
     `--packaged-smoke=<absolute-marker-path> --user-data-dir=<isolated-dir>`
   - Requires exit code `0` within `45s` and a UTF-8 JSON marker (`<= 4096` bytes):
     ```json
     {"event":"gooeypi-packaged-smoke-ready","url":"omp-desktop://app/index.html","version":"2.0.0"}
     ```
   - The marker is written only after the first real frame is drawn, so it proves the window rendered. CI runs this for the macOS `.app`, the Linux `.deb` under Xvfb, and the silently installed Windows NSIS package.

3. **Standalone Cross-Platform `omp` CLI Fixture** (`tests/conformance/fixtures/omp-fixture.mjs`):
   - Self-contained Node script wrapped by [`tests/conformance/fixtures/launcher.ts`](../tests/conformance/fixtures/launcher.ts) into a native `shell: false`-spawnable binary on macOS, Linux, and Windows (native `.exe` compiled via `csc.exe` on Windows).
   - Emulates `omp --version`, `omp models --json`, `omp config get modelRoles`, `omp update`, `omp plugin`, and `omp --mode rpc` (handshake v2, `rpc_chunk`, `auto_compaction_*`, `isTerminal`, `btw`, `live_*`, `bash`, `compact`).

---

## Adapter Wire Protocol v1

All stdout lines MUST be valid JSONL (`\n`-terminated). Any diagnostic logging MUST go to `stderr`.

### Request / Response Envelope

Request:
```json
{"id": 1, "method": "adapter.info", "params": {}}
```

Success response:
```json
{"id": 1, "ok": true, "result": {}}
```

Error response:
```json
{"id": 1, "ok": false, "error": {"code": "TypeError", "message": "Human-readable reason"}}
```

### Required Methods by Capability

| Capability | Methods |
|---|---|
| Core lifecycle (always required) | `adapter.info`, `workspace.reset`, `workspace.shutdown` |
| `state` | `state.migrateUserData`, `state.open`, `state.getSnapshot`, `state.getSettings`, `state.updateSettings`, `state.close` |
| `projects` | `projects.grant`, `projects.list`, `projects.listFiles`, `projects.remove` |
| `sessions` | `sessions.list`, `sessions.sync`, `sessions.read`, `sessions.setPinned`, `sessions.archive`, `sessions.delete` |
| `models` | `models.catalog`, `models.presets` |
| `agent` | `agent.start`, `agent.command`, `agent.drainEvents`, `agent.list`, `agent.stop` |
| `git` | `git.status`, `git.diff`, `git.stage`, `git.unstage`, `git.restore`, `git.commit` |
| `checkouts` | `checkouts.list`, `checkouts.execute` |
| `plugins` | `plugins.list`, `plugins.connectMcp`, `plugins.setMcpEnabled`, `plugins.mutateCapability`, `plugins.install` |
| `schedules` | `schedules.preview`, `schedules.create`, `schedules.list`, `schedules.update`, `schedules.pause`, `schedules.resume`, `schedules.delete`, `schedules.brokerInfo` |
| `collaboration` | `collaboration.encodeEnvelope`, `collaboration.verifyEnvelope`, `collaboration.brokerInfo` |
| `terminal` | `terminal.create`, `terminal.input`, `terminal.readOutput`, `terminal.resize`, `terminal.kill` |

`adapter.info` returns:
```json
{
  "protocolVersion": 1,
  "implementation": "rust-native",
  "platform": "darwin",
  "capabilities": ["state", "projects", "sessions", "models", "agent", "git", "checkouts", "plugins", "schedules", "collaboration", "terminal"]
}
```

---

## Feature Coverage Checklist

| App Feature Area | Conformance Suite | Native/UI-Only Verification |
|---|---|---|
| State v4 persistence, schema guard, POSIX & Windows tombstones, GooeyPi migration | [`state-migration.conformance.test.ts`](../tests/conformance/state-migration.conformance.test.ts) | Startup error dialog |
| Project grants, broad-root blocking, symlink containment, removal revocation | [`projects-security.conformance.test.ts`](../tests/conformance/projects-security.conformance.test.ts) | Native folder picker dialog |
| OMP v3 JSONL discovery, 256-byte title slot, read-only transcript, incremental sync, pin/archive/delete | [`sessions-jsonl.conformance.test.ts`](../tests/conformance/sessions-jsonl.conformance.test.ts) | Virtualized conversation UI, search highlight |
| Model catalog validation, presets, fast-mode derivation, OMP RPC v2 framing/translation/chunking/reaping | [`models-and-rpc.conformance.test.ts`](../tests/conformance/models-and-rpc.conformance.test.ts) | Model picker, thinking accordion, side-chat UI |
| Git status/diff/stage/unstage/restore/commit, branch & worktree checkout safety | [`git-and-checkouts.conformance.test.ts`](../tests/conformance/git-and-checkouts.conformance.test.ts) | Split diff viewer & turn changes card |
| Skills/extensions/broken MCP discovery, `mcp.json` policy/locks/replace preservation, `omp plugin` | [`plugins-mcp.conformance.test.ts`](../tests/conformance/plugins-mcp.conformance.test.ts) | Capabilities UI, OAuth & ask-user modal |
| RRULE schedule preview, CRUD, `/mcp reauth` blocking, loopback broker bearer + Origin gate | [`schedules-and-brokers.conformance.test.ts`](../tests/conformance/schedules-and-brokers.conformance.test.ts) | Tray/background menu-bar mode, `--background` |
| HMAC peer message envelopes, same-cwd loopback collaboration broker | [`collaboration.conformance.test.ts`](../tests/conformance/collaboration.conformance.test.ts) | `@session` composer autocomplete |
| PTY adapter capability (not required by the Rust app), standalone `omp-fixture`, binary `--packaged-smoke` | [`terminal-and-blackbox.conformance.test.ts`](../tests/conformance/terminal-and-blackbox.conformance.test.ts) | Embedded browser webview, native theme/i18n/CJK IME, STT voice |

---

## Developer Workflow

### Local Verification
```bash
# Build the Rust adapter and run the full conformance suite:
(cd rust && cargo build -p omp-conformance --locked)
npm run test:conformance

# Run one suite against an explicit adapter binary:
OMP_CONFORMANCE_ADAPTER_ARGV='["rust/target/debug/omp-conformance"]' \
OMP_CONFORMANCE_PARTIAL=1 \
npx vitest run --config vitest.conformance.config.ts tests/conformance/state-migration.conformance.test.ts

# Smoke-test a compiled native executable:
"rust/dist/OMP Desktop.app/Contents/MacOS/omp-desktop" \
  --packaged-smoke=/tmp/smoke.json --user-data-dir=/tmp/omp-rust
```

### GitHub Actions CI/CD
- Every PR and push to `main` runs the `rust-conformance` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) across `macos-15`, `ubuntu-22.04`, and `windows-2022`. It builds the Rust adapter and sets `OMP_CONFORMANCE_ADAPTER_ARGV` for the runner's executable.
- The job runs in partial mode with an explicit required capability set (`state,projects,sessions,models,agent,git,checkouts,plugins,schedules,collaboration`); a required capability is never skipped. `terminal` is not required because the Rust app has no built-in PTY.
- Public releases in [`.github/workflows/release.yml`](../.github/workflows/release.yml) build the Rust packages on four native legs (`macOS arm64`, `macOS x86_64`, `Linux x86_64`, `Windows x86_64`). The release workflow validates the tag and re-runs the release-tooling checks; the conformance gates run in CI for the same commit.
