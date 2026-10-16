# OMP integration design

This document is OMP Desktop's integration spec for its single agent harness: OMP (`omp`, [omp.sh](https://omp.sh/), [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)). It records the verified protocol, argv, event, path, and discovery facts the app depends on. Historical note: OMP Desktop (formerly GooeyPi) previously supported Prime Agent and Pi harnesses alongside OMP; that multi-harness support and its switcher were removed, and only the OMP adapter remains.

## Product behavior

- The product is **OMP Desktop** and the agent is **OMP**. Granted projects, the session catalog, the model catalog, and runtimes all belong to the single harness.
- Streaming transcripts, steering/follow-ups, abort, model + thinking selection, compaction, session resume/switch/rename/fork(branch), and extension-UI dialogs (which is also how OMP surfaces **tool approval prompts**) run over the OMP RPC transport. The browser, git, and terminal capabilities are harness-agnostic surfaces around it.
- Scheduled tasks run through OMP Desktop's local schedule service and executor. OMP scheduled tasks do not use heartbeat RPC commands: the injected extension calls a harness-scoped loopback broker, and due work is executed through OMP's normal prompt lifecycle.
- OMP credentials remain CLI-owned. The desktop keeps only provider/model visibility toggles in its own state; they control which providers appear in the model picker and never change OMP's own configuration or authentication.
- Capabilities use OMP's native plugin manager (`omp plugin install`), user/project plugin roots, `.omp/skills` plus shared `.agents/skills`, and OMP-native `mcp.json`.

## OMP facts (verified on this machine, omp 17.2.11)

- Binary: `omp` (searched: `$OMP_BINARY`, PATH, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, plus shared package-manager locations — see `docs/harness-discovery.md`).
- Spawn for embedding: `omp --mode rpc --cwd <dir>` plus:
  - resume: `--resume <sessionPath>` (also accepts id prefixes; we always pass validated absolute paths)
  - model: `--model <provider>/<modelId>` (single flag)
  - thinking: `--thinking <off|minimal|low|medium|high|xhigh|max>`
  - approvals: `--approval-mode <always-ask|write|yolo>` — only passed when the user overrides the default in settings; otherwise OMP's own `~/.omp/agent/config.yml` governs.
  - extensions: `-e <path>` for each injected capability extension. OMP Desktop injects scheduled-task, browser, and session-collaboration extensions, plus the ask-user extension when the universal **Ask user** capability is enabled. No `--skill <path>` flag exists; skills are discovery-based, so the browser *skill* is not injected — the OMP browser *extension* carries the tool surface. The bundled computer-use skill is delivered through the computer-use capability's own env contract (`GOOEYPI_CUA_DRIVER_PATH`, `GOOEYPI_COMPUTER_USE_SKILL_PATH`) instead.
- Paths: agent dir `~/.omp/agent/`; sessions `~/.omp/agent/sessions/<bucket>/<ISO-timestamp>_<uuid>.jsonl` (bucket = scope-basename-hash of cwd); settings `~/.omp/agent/config.yml`; extensions `~/.omp/agent/extensions/`; auth in `~/.omp/agent/agent.db` (SQLite — never read by OMP Desktop).
- Plugins: `omp plugin install <target> --json` installs user-scoped packages under `~/.omp/plugins` by default; project packages live under `<project>/.omp/plugins`. Native skills are discovered from `~/.omp/skills`, project `.omp/skills`, and shared `.agents/skills`. Native MCP files are `~/.omp/agent/mcp.json` and project `.omp/mcp.json`.
- Model catalog: `omp models --json` → `{ models: [{ provider, id, selector, name, contextWindow, maxTokens, reasoning, thinking: string[]|null, input: string[], cost }] }`. The CLI carries no per-model fast-mode metadata, so fast-mode support is derived from the model identity itself: OMP's `set_fast_mode` maps to OpenAI Codex service tiers, which exist for the `openai-codex` GPT-5.4/5.5/5.6 families.
- The argv contract (`--mode rpc`, `--cwd`, `--resume`, `--model`, `--thinking`, `--approval-mode`, `--extension`) was verified live against omp 17.2.11: `omp --help` lists every long form, and the in-app validation run spawned a runtime with all of them accepted.

## Protocol: JSONL framing

OMP RPC is newline-delimited JSON over stdio with a request/response envelope: requests carry `id`, responses are `{type:'response', id, command, success, data|error}`. `FramedRpcTransport`, `StrictJsonlDecoder`, write budgeting, correlation rules, and `AgentEventForwarder` implement it.

An OMP adapter inside `electron/main/agent-rpc/` owns everything harness-specific:

### Handshake
1. On start OMP pushes `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],...}`.
2. We send `negotiate_protocol { protocolVersion: 2 }`.
3. In v2, oversized frames arrive as base64 `rpc_chunk` sequences (`chunkId`, `index`, `count`, `data`); the OMP runtime reassembles them (bounded by the existing 16 MiB read limit) before normal dispatch.
4. Then the shared handshake continues: `get_state` → `updateFromState` → `get_session_stats`.
5. OMP also pushes `available_commands_update` (slash commands with metadata); forwarded to the renderer for future palette use, ignored by the reducer.

### Command mapping (renderer keeps speaking the existing vocabulary)

The renderer sends command objects validated against the fixed allowlist; the adapter translates where names differ:

| Renderer sends | OMP receives |
|---|---|
| `fork {entryId}` | `branch {entryId}` |
| `get_fork_messages` | `get_branch_messages` |
| `set_service_tier {serviceTier}` | `set_fast_mode {enabled: serviceTier === 'priority'}` |
| everything else | unchanged (`prompt`, `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `set_model`, `set_thinking_level`, `switch_session`, `compact`, `set_auto_compaction`, `set_auto_retry`, `set_session_name`, `set_steering_mode`, `set_follow_up_mode`, `get_*`, `extension_ui_response`) |

Commands inherited from the removed Prime harness (`send_message`, the heartbeat family, `clone`) are rejected by the command schema with a clear error. `prompt` responses may carry `data.agentInvoked === false` (local slash command, no agent turn) and OMP may later push a standalone `prompt_result` frame. No dedicated renderer handling exists or is needed: interactive prompts never block on per-prompt turn completion, so a local-only prompt simply completes its request/response cycle, and `prompt_result` frames are forwarded as unknown events the reducer ignores.

### Event normalization (main process, before forwarding)

| OMP emits | Forwarded as |
|---|---|
| `auto_compaction_start` / `auto_compaction_end` | `compaction_start` / `compaction_end` |
| `agent_end` with `isTerminal === false` | swallowed as a turn boundary (not finalized) |
| `retry_fallback_applied` / `retry_fallback_succeeded` | unchanged; renderer renders a transcript notice from `applied` and a composer "Running on" chip from both; the persisted counterpart is the JSONL `model_change` entry with `resolvedModelIsFallback: true` |
| `ready`, `available_commands_update`, `config_update`, `session_info_update`, `notice`, etc. | passed through (renderer reducer ignores unknown types) |
| everything else (`agent_start`, `turn_*`, `message_*`, `tool_execution_*`, `extension_ui_request`, `auto_retry_*`, `model_changed`, ...) | unchanged |

Approvals: OMP has no permission frame; approval prompts arrive as `extension_ui_request` `select` dialogs ("Allow tool: …" with Approve/Deny) and are answered with the existing fire-and-forget `extension_ui_response`. The existing ask-user modal covers this; field shapes must be verified against `src/lib/extension-ui.ts` and normalized in the adapter if they drift.

## Architecture

### Harness descriptor (`electron/main/harness.ts`)

```
HarnessId = 'omp'
HarnessDescriptor {
  id, productName ('OMP Desktop'), agentName ('OMP'),
  executableName, binaryEnvVar ('OMP_BINARY'), candidateDirs,
  agentDir (~/.omp/agent), sessionRoot,
}
```
Discovery lives in `process-utils.ts` (`harnessExecutableCandidates`/`findHarnessExecutable`); see `docs/harness-discovery.md`. Persisted project/schedule records carry `harness: 'omp'`; legacy `'prime'`/`'pi'` markers map to `'omp'` on load.

### Services

- `AgentRpcManager` constructs the OMP adapter's argv builder, handshake steps, command schema, and event normalizer; `RuntimeInfo` carries `harness: 'omp'`.
- `SessionService`: OMP-specific `catalogIo`/metadata/transcript readers (v3 JSONL: 256-byte `title` slot line, `session` header v3, entries with `id`/`parentId` forming a tree, `model_change.model` as a single `provider/id` string, entry types `message | model_change | thinking_level_change | compaction | branch_summary | custom_message | label | title_change | session_init | mode_change | ...`). Catalog scans one bucket level deep; ordering comes from the filename ISO-timestamp prefix instead of UUIDv7. No live-CLI overlay (OMP has no `list --json`); rename is done via RPC `set_session_name` when a runtime is live, else session files stay read-only and sidebar rename is disabled for offline sessions.
- Model catalog: `OmpModelCatalogService` shells out to `omp models --json` (single-flight, TTL, byte-bounded) with every field validated; untrusted CLI output never reaches the renderer directly. Thinking levels mirror OMP's reported vocabulary (`off` implicit); fast-mode support is derived from the model identity (openai-codex GPT-5.4/5.5/5.6 families).
- Providers: desktop-owned visibility toggles (disabled provider/model sets in desktop state) filter the catalog; authentication stays with the omp CLI.
- Plugins: one `PluginService` routes discovery, installation, MCP paths, and reveal authorization through OMP. OMP package installs go through `omp plugin`; catalog discovery includes OMP-native skill/extension roots and enabled package trees. OMP Desktop writes only local stdio definitions using OMP's upstream schema and the same pinned-directory, cooperative-lock, fingerprint-retry, atomic-replacement, and rollback safeguards; this is not filesystem compare-and-swap, so a same-user writer that ignores the lock can race the final fingerprint check and rename. Network definitions remain visible but externally managed and read-only.
- Capability bridges: the browser `CapabilityBridge` is reused; `assets/extensions/omp-work-browser.ts` speaks OMP's extension API (default export `(pi) => void`, `pi.registerTool`) against the same loopback broker env contract (`OMP_DESKTOP_BROWSER_URL`/`OMP_DESKTOP_BROWSER_TOKEN`). `assets/extensions/omp-work-schedules.ts` exposes list/create/update/manage tools through a separate scoped broker (`OMP_DESKTOP_SCHEDULE_URL`/`OMP_DESKTOP_SCHEDULE_TOKEN`). `assets/extensions/omp-work-collaboration.ts` provides app-owned bounded list/models/create/read/send/wait tools for same-working-directory top-level sessions (broker env keeps the compatibility names `GOOEYPI_COLLABORATION_URL`/`GOOEYPI_COLLABORATION_TOKEN`/`GOOEYPI_COLLABORATION_EXTENSION_PATH`, and the tool names remain `gooeypi_session_*`). When the universal capability is enabled, `assets/extensions/omp-work-ask-user.ts` asks focused multiple-choice questions in the app. Extension injection uses `OMP_DESKTOP_SCHEDULE_EXTENSION_PATH`, `OMP_DESKTOP_BROWSER_EXTENSION_PATH`, and `OMP_DESKTOP_ASK_USER_EXTENSION_PATH`; `GOOEYPI_MANAGES_ASK_USER` marks ask-user ownership.

### Renderer

- `App.tsx` scopes workspaces, sessions, projects, and the model catalog to the single harness. Title strings and the settings harness card follow it.
- Settings: the Agent section shows the OMP status card and an "Approval mode" select (Inherit config / Always ask / Write / YOLO → argv flag only when not Inherit). The Providers section lists OMP providers with desktop-owned visibility toggles that never touch OMP's own configuration; authentication remains owned by the omp CLI.

## Security invariants

Same rules as `docs/security.md`: argv arrays only, sanitized child env, path canonicalization + containment for the OMP session root, session JSONL read-only, stderr swallowed, all transport/event limits identical, `~/.omp/agent/agent.db` (credentials) never read, IPC allowlist stays fixed and narrow with `harness` validated as the `'omp'` enum value.

## Non-goals

- An OMP Desktop-owned OMP credential store or app-driven MCP OAuth. HTTP/SSE definitions remain direct OMP operations outside the app; OMP Desktop intercepts rather than forwards `/mcp reauth`, so authentication must be run in OMP itself; OMP keeps ownership of profile-scoped credentials.
- Host tools / host URI schemes, subagent transcript streaming, native OMP relay-room UI, and handoff. App-owned top-level session collaboration is documented separately in `docs/session-collaboration.md`.
- Session import from other CLIs (`--from-claude`/`--from-codex` style); that remains an OMP-side operation.
