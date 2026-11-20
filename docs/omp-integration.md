# OMP integration design

This document is OMP Desktop's integration spec for its single agent harness: OMP (`omp`, [omp.sh](https://omp.sh/), [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)). It records the verified protocol, argv, event, path, and discovery facts the app depends on. Historical note: OMP Desktop (formerly GooeyPi) previously supported Prime Agent and Pi harnesses alongside OMP; that multi-harness support and its switcher were removed, and only the OMP adapter remains.

## Product behavior

- The product is **OMP Desktop** and the agent is **OMP**. Granted projects, the session catalog, the model catalog, and runtimes all belong to the single harness.
- Streaming transcripts, steering/follow-ups, abort, model + thinking selection, compaction, session resume/switch/rename/fork(branch), and extension-UI dialogs (which is also how OMP surfaces **tool approval prompts**) run over the OMP RPC transport.
- Scheduled tasks run through OMP Desktop's own scheduler in `omp-core` and execute through OMP's normal prompt lifecycle.
- OMP credentials remain CLI-owned. The desktop keeps only provider/model visibility toggles in its own state; they control which providers appear in the model picker and never change OMP's own configuration or authentication.
- Capabilities use OMP's native plugin manager (`omp plugin install`), user/project plugin roots, `.omp/skills` plus shared `.agents/skills`, and OMP-native `mcp.json`.

## OMP facts (verified on this machine, omp 17.2.11)

- Binary: `omp` (searched: `$OMP_BINARY`, PATH, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, plus shared package-manager locations — see `docs/harness-discovery.md`).
- Spawn for embedding: `omp --mode rpc --cwd <dir>` plus:
  - resume: `--resume <sessionPath>` (also accepts id prefixes; we always pass validated absolute paths)
  - model: `--model <provider>/<modelId>` (single flag)
  - thinking: `--thinking <off|minimal|low|medium|high|xhigh|max>`
  - approvals: `--approval-mode <always-ask|write|yolo>` — only passed when the user overrides the default in settings; otherwise OMP's own `~/.omp/agent/config.yml` governs.
  - The Rust application does not pass `-e/--extension`: it ships no JavaScript extension files. Ask-user dialogs are enabled with `set_ask_dialog`, and app-owned surfaces (browser pane, terminal panel, schedules) stay in the app.
- Paths: agent dir `~/.omp/agent/`; sessions `~/.omp/agent/sessions/<bucket>/<ISO-timestamp>_<uuid>.jsonl` (bucket = scope-basename-hash of cwd); settings `~/.omp/agent/config.yml`; extensions `~/.omp/agent/extensions/`; auth in `~/.omp/agent/agent.db` (SQLite — never read by OMP Desktop).
- Plugins: `omp plugin install <target> --json` installs user-scoped packages under `~/.omp/plugins` by default; project packages live under `<project>/.omp/plugins`. Native skills are discovered from `~/.omp/skills`, project `.omp/skills`, and shared `.agents/skills`. Native MCP files are `~/.omp/agent/mcp.json` and project `.omp/mcp.json`.
- Model catalog: `omp models --json` → `{ models: [{ provider, id, selector, name, contextWindow, maxTokens, reasoning, thinking: string[]|null, input: string[], cost }] }`. The CLI carries no per-model fast-mode metadata, so fast-mode support is derived from the model identity itself: OMP's `set_fast_mode` maps to OpenAI Codex service tiers, which exist for the `openai-codex` GPT-5.4/5.5/5.6 families.
- The argv contract (`--mode rpc`, `--cwd`, `--resume`, `--model`, `--thinking`, `--approval-mode`, `--extension`) was verified live against omp 17.2.11: `omp --help` lists every long form.

## Protocol: JSONL framing

OMP RPC is newline-delimited JSON over stdio with a request/response envelope: requests carry `id`, responses are `{type:'response', id, command, success, data|error}`. `rust/crates/omp-rpc` implements the transport: a strict LF JSONL decoder with a 16 MiB per-line bound, write budgeting, request/response correlation with per-command timeouts, event draining, and a bounded stderr tail for diagnostics.

The OMP adapter lives in `rust/crates/omp-core/src/agent.rs` and owns everything harness-specific.

### Handshake

1. On start OMP pushes `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],...}`.
2. The app sends `negotiate_protocol { protocolVersion: 2 }` and requires `success: true`.
3. In v2, oversized frames arrive as base64 `rpc_chunk` sequences (`chunkId`, `index`, `count`, `data`); `omp-rpc` reassembles them (bounded by the existing 16 MiB read limit and chunk-count caps) before normal dispatch.
4. When the session requested Fast mode, the app sends `set_fast_mode { enabled: true }`.
5. When the universal Ask user setting is on, the app sends `set_ask_dialog { enabled: true }`.
6. OMP then pushes state, session stats, and `available_commands_update` (slash commands with metadata); the workspace uses the command catalog for its palette.

### Command schema and mapping

Every command object is validated against a fixed allowlist before it is sent. Names inherited from the removed Prime harness (`send_message`, the heartbeat family, `clone`, `observe`) are rejected with a clear error, and an unknown type is rejected rather than forwarded.

| App sends | OMP receives |
|---|---|
| `fork {entryId}` | `branch {entryId}` |
| `get_fork_messages` | `get_branch_messages` |
| `side_question {topicId}` | `btw {recordId}` |
| `side_question_cancel {topicId}` | `btw_cancel {recordId}` |
| `side_question_history {topicId}` | `get_btw_history {recordId}` |
| everything else | unchanged (`prompt`, `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `set_model`, `set_thinking_level`, `switch_session`, `compact`, `set_session_name`, `extension_ui_response`, …) |

- `switch_session` and `new_session` paths are authorized against the OMP session root before the command is sent.
- `prompt`, `steer`, and `follow_up` messages are rejected when they carry an MCP authentication command, so the app cannot be used to drive a provider login through a prompt.
- User-driven shell execution rides `bash {command}` (non-empty string, size-capped) and `abort_bash {}`; the composer `!` shorthand routes here. The response is OMP's `BashResult` (`output`, `cancelled`, `truncated`, `exitCode?`, `timedOut?`, `images?`). `bash` runs on the upstream side channel, so it also works mid-turn, and its client timeout is ten minutes because the response lands only when the command finishes.
- `extension_ui_response` answers OMP dialogs; question, option, title, message, and timeout fields are bounded before they are accepted.

### Event normalization (in the app, before folding into the transcript)

| OMP emits | Forwarded as |
|---|---|
| `auto_compaction_start` / `auto_compaction_end` | `compaction_start` / `compaction_end` |
| `agent_end` with `isTerminal !== true` | swallowed as a turn boundary (not finalized) |
| `retry_fallback_applied` / `retry_fallback_succeeded` | unchanged; the workspace renders a transcript notice from `applied` and a "Running on" chip from both; the persisted counterpart is the JSONL `model_change` entry with `resolvedModelIsFallback: true` |
| `ready`, `available_commands_update`, `config_update`, `session_info_update`, `notice`, etc. | passed through (the workspace ignores unknown types) |
| `live_phase` / `live_levels` / `live_transcript` / `live_end` | whitelist-validated, forwarded unchanged (values clamped/validated); consumed by the live-voice panel only, never the transcript |
| everything else (`agent_start`, `turn_*`, `message_*`, `tool_execution_*`, `extension_ui_request`, `auto_retry_*`, `model_changed`, …) | unchanged |

Approvals: OMP has no permission frame; approval prompts arrive as `extension_ui_request` `select` dialogs ("Allow tool: …" with Approve/Deny) and are answered with the existing fire-and-forget `extension_ui_response`. The ask-user modal covers this, and the dialog shapes are bounded in `omp-core::agent`.

## Architecture

### Crates

| Crate | Responsibility |
|---|---|
| `omp-core` | State store, settings, projects/grants, sessions, Git and checkouts, model catalog, plugins/MCP, schedules, collaboration envelopes, loopback brokers, URL policy, and the OMP adapter (`agent.rs`) |
| `omp-rpc` | Blocking stdio JSON-RPC client, strict JSONL framing, v2 chunk reassembly |
| `omp-conformance` | Conformance Protocol v1 adapter |
| `omp-desktop` | GPUI shell: workspace view, terminal, browser, tray, updater, packaged smoke |

### Discovery

`main` resolves the harness executable from the settings override, `OMP_BINARY`, and the PATH snapshot (see `docs/harness-discovery.md`). Persisted project/schedule records carry `harness: 'omp'`; legacy `'prime'`/`'pi'` markers map to `'omp'` on load.

### Services

- Sessions: `omp-core::sessions` reads OMP's v3 JSONL (256-byte `title` slot line, `session` header v3, entries with `id`/`parentId` forming a tree, `model_change.model` as a single `provider/id` string, entry types `message | model_change | thinking_level_change | compaction | branch_summary | custom_message | label | title_change | session_init | mode_change | …`). Catalog scans one bucket level deep; ordering comes from the filename ISO-timestamp prefix. No live-CLI overlay (OMP has no `list --json`); rename uses RPC `set_session_name` when a runtime is live, and offline session files stay read-only.
- Model catalog: `omp-core::models` shells out to `omp models --json` (single-flight, TTL, byte-bounded) with every field validated. Thinking levels mirror OMP's reported vocabulary (`off` implicit); fast-mode support is derived from the model identity (openai-codex GPT-5.4/5.5/5.6 families).
- Providers: desktop-owned visibility toggles (disabled provider/model sets in desktop state) filter the catalog. Provider OAuth login/logout is driven through OMP's `login` / `get_login_providers` / `get_logout_accounts` / `logout` RPC, while token custody stays entirely with OMP's own auth storage; the app never receives, stores, or logs credentials (see `docs/security.md`).
- Plugins: `omp-core::plugins` routes discovery, installation, MCP paths, and reveal authorization through OMP. OMP package installs go through `omp plugin`; catalog discovery includes OMP-native skill/extension roots and enabled package trees. OMP Desktop edits OMP's native `mcp.json` (user `~/.omp/agent/mcp.json`, project `.omp/mcp.json`) with a structured editor validated against OMP's upstream mcp-schema (stdio ↔ command, http/sse ↔ URL, mutually exclusive) and pinned-directory, cooperative-lock, fingerprint-retry, atomic-replacement, and rollback safeguards. Network definitions are HTTPS by default (plain HTTP only for loopback hosts).
- Schedules: `omp-core::schedules` and `scheduler` persist durable automations in the app state store, revalidate the granted project (and canonical session path) on every run, and record missed occurrences as skipped rather than replaying them.
- Collaboration: `omp-core::collaboration` implements the signed peer envelope and bounded peer reads; see `docs/session-collaboration.md`.

### Workspace

- `rust/crates/omp-desktop/src/app.rs` scopes workspaces, sessions, projects, the model catalog, and every page to the single harness: Workspace, Schedules, Browser, Files, Subagents, Side Question, Settings, Extensions, Review, Summary.
- Settings: the Agent section shows the OMP status card and an "Approval mode" select (Inherit config / Always ask / Write / YOLO → argv flag only when not Inherit). The Providers section lists OMP providers with desktop-owned visibility toggles that never touch OMP's own configuration; authentication remains owned by the omp CLI.

## Security invariants

Same rules as `docs/security.md`: argv arrays only, sanitized child env, path canonicalization + containment for the OMP session root, session JSONL read-only, stderr swallowed, all transport/event limits identical, `~/.omp/agent/agent.db` (credentials) never read, and the command allowlist stays fixed and narrow with `harness` validated as the `'omp'` value.

## Non-goals

- An OMP Desktop-owned OMP credential store or app-driven MCP OAuth. Definition metadata in mcp.json is edited in the app (HTTP/SSE included), but authentication never is: OMP Desktop intercepts rather than forwards `/mcp reauth`, so authentication must be run in OMP itself; OMP keeps ownership of profile-scoped credentials.
- Host tools / host URI schemes, subagent transcript streaming, native OMP relay-room UI, and handoff. App-owned top-level session collaboration is documented separately in `docs/session-collaboration.md`.
- Session import from other CLIs (`--from-claude`/`--from-codex` style); that remains an OMP-side operation.
