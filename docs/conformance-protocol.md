# Conformance & Black-Box Parity Protocol (v1)

This specification defines the language- and UI-framework-agnostic test contract for OMP Desktop so the exact same validation suite runs against the current Electron/Node backend today and against a pure Rust native GUI implementation during and after rewrite.

## Architecture Overview

The harness decouples behavioral verification from Electron and React via two black-box interfaces:

1. **Stdio JSON-RPC Conformance Adapter Protocol v1** (`tests/conformance/`):
   - Tests spawn an adapter executable over stdio (`stdin`/`stdout`, strict LF-delimited JSONL).
   - Default adapter: `out/conformance/node-adapter.mjs` (built by `npm run conformance:build-adapter` from [`tests/conformance/adapters/node-adapter.ts`](../tests/conformance/adapters/node-adapter.ts)).
   - Custom / Rust adapter override:
     - `OMP_CONFORMANCE_ADAPTER_CMD="/path/to/omp-desktop-conformance --flag"`
     - or `OMP_CONFORMANCE_ADAPTER_ARGV='["cargo","run","--quiet","-p","omp-conformance"]'`
   - Incremental bring-up mode: set `OMP_CONFORMANCE_PARTIAL=1` to skip capabilities not yet listed by `adapter.info` instead of failing immediately. In CI (`OMP_CONFORMANCE_PARTIAL` unset), every capability is mandatory.

2. **Black-Box Compiled Binary Launch Smoke Contract** (`scripts/release/smoke-packaged-app.mjs` & `OMP_SMOKE_EXECUTABLE`):
   - Launches the real packaged Electron binary or compiled Rust GUI executable with:
     `--packaged-smoke=<absolute-marker-path> --user-data-dir=<isolated-dir>`
   - Requires exit code `0` within `45s` and a UTF-8 JSON marker (`<= 4096` bytes):
     ```json
     {"event":"gooeypi-packaged-smoke-ready","url":"omp-desktop://app/index.html","version":"1.3.17"}
     ```
     (Pure Rust native GUIs may report `"url": "omp-desktop://native/main"` or any valid URL.)

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
  "implementation": "electron-node",
  "platform": "darwin",
  "capabilities": ["state", "projects", "sessions", "models", "agent", "git", "checkouts", "plugins", "schedules", "collaboration", "terminal"]
}
```

---

## Feature Parity Checklist for the Rust Rewrite

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
| PTY create/input/output/resize/kill, standalone `omp-fixture`, binary `--packaged-smoke` | [`terminal-and-blackbox.conformance.test.ts`](../tests/conformance/terminal-and-blackbox.conformance.test.ts) | Embedded browser webview, native theme/i18n/CJK IME, STT voice |

---

## Developer Workflow

### Local Verification
```bash
# Build reference Node adapter and run full conformance suite:
npm run conformance:build-adapter
npm run test:conformance

# Point the conformance suite at a Rust adapter binary during rewrite:
OMP_CONFORMANCE_ADAPTER_CMD="/path/to/target/debug/omp-conformance" \
OMP_CONFORMANCE_PARTIAL=1 \
npx vitest run --config vitest.conformance.config.ts tests/conformance/state-migration.conformance.test.ts

# Smoke-test a compiled native executable:
OMP_SMOKE_EXECUTABLE="/path/to/omp-desktop" node scripts/release/smoke-packaged-app.mjs
```

### GitHub Actions CI/CD
- Every PR and push to `main` runs the `conformance` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) across `macos-14`, `ubuntu-22.04`, and `windows-2022`.
- Manual `workflow_dispatch` accepts an optional `adapter_cmd` input (or repository variable `OMP_CONFORMANCE_ADAPTER_CMD`) to validate an alternate adapter on all three operating systems in CI.
- Public releases in [`.github/workflows/release.yml`](../.github/workflows/release.yml) gate all 5 native distribution legs (`macOS arm64`, `macOS x64`, `Linux arm64`, `Linux x64`, `Windows x64`) behind `conformance`.
