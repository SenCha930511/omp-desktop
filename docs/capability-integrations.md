# Packages, extensions, skills, and MCP

OMP Desktop presents one capability directory for the OMP harness. This
document defines the product contract for that surface.

## Shared vocabulary

- An OMP **plugin** is an OMP-native distribution bundle that can provide
  skills, commands, agents, hooks, tools, MCP servers, LSP servers, and
  extension modules.
- An **extension** is executable JavaScript or TypeScript loaded into the
  agent host. Installing an extension means installing its plugin or placing
  its file in a harness-native extension directory.
- A **skill** is model-facing guidance, discovered from OMP's native skill
  roots.
- An **MCP server** is a connection definition. It is not itself a plugin,
  extension, or skill, although a plugin may provide one or more of those
  resources and may declare MCP servers.

## Harness contract

| Harness | Installable bundle | Standalone extension | MCP runtime | MCP actions available in OMP Desktop | Network MCP and authentication |
| --- | --- | --- | --- | --- | --- |
| OMP | `omp plugin install <target> --json` | Copy one local module into user `~/.omp/agent/extensions/` or project `.omp/extensions/` | Native | Create, enable, disable, or remove local stdio definitions in user `~/.omp/agent/mcp.json` or project `.omp/mcp.json` | Configure HTTP/SSE and authenticate directly in OMP, outside OMP Desktop |

The app labels this surface **Capabilities**. Its Add button first opens a
capability-type chooser, then a type-specific form: **Add MCP**, **Add
Plugin**, and **Add Extension**. Local stdio input is the only offered MCP
form. The initial Add chooser warns that third-party code may use CLI-only
APIs and links directly to the GitHub issue form for failures; the base
Capabilities screen and the follow-up forms do not repeat that notice.

## Product behavior

OMP has native MCP support. OMP Desktop writes only local stdio entries to
OMP-native MCP files and installs plugins only through `omp plugin`. It rejects
HTTP, SSE, and any URL-bearing definition, including loopback URLs, and never
forwards `/mcp reauth` from an app prompt. Network configuration and
authentication must be run directly in OMP outside the app. Externally
configured network entries remain visible but are read-only in OMP Desktop;
bounded definition-only removal remains available for cleanup. Local
definitions whose exact harness key cannot pass the app's bounded state API
remain visible but have no Enable or Disable control; their state must be
managed directly in OMP. Bounded exact-definition removal remains available.

Repository, local-path, and registry targets remain accepted where the OMP
CLI accepts them.

### App-owned capabilities

The catalog additionally lists the app-owned system capabilities. The Rust
application does not inject JavaScript extension files into OMP runtimes; these
surfaces are implemented by the app itself:

- **Scheduled tasks** — owned by the app's scheduler (`omp-core`), always
  enabled, and executed through OMP's normal prompt lifecycle.
- **Browser** — the app's own webview pane; enabled with the desktop browser
  setting. Agent-driven navigation is limited to credential-free HTTP(S).
- **Ask user** — an RPC dialog surface (`set_ask_dialog` plus
  `extension_ui_request` questions) shown as a native modal; enabled with the
  universal Ask user setting.
- **Computer Use | TryCUA** — drives native apps through a separately installed
  TryCUA driver. It is disabled by default, requires a runnable `cua-driver`
  before it can be enabled, and never writes MCP configuration.
- **Skills** — model-facing guidance discovered from OMP's native skill roots
  and from the bundled `assets/skills/` directory.

Historical note: the app previously carried Prime Agent capability
integrations (including a bundled supabase package) and Pi adapter-based MCP
admission; both were removed with those harnesses.

## Security boundaries

- Every install/remove command uses the detected fixed harness executable and
  an argv array; no shell interpolation is permitted.
- Package, plugin, server, command, and argument inputs are bounded and
  validated in `omp-core` before any harness call.
- Standalone extensions must be absolute local JavaScript or TypeScript files.
  Project installs are re-authorized and their destination directories remain
  pinned against symlink replacement; existing OMP extension files are never
  overwritten.
- Network MCP definitions fail closed at the service admission and settings
  writer boundaries. State mutation also rejects externally configured network
  entries. The local stdio settings path uses the cooperative lock,
  fingerprint-based conflict retries, project-directory pinning, atomic
  replacement, and rollback protections; definition removal re-verifies the
  project directory immediately before and after reading each update snapshot.
  This is not a filesystem compare-and-swap: a same-user writer that ignores
  the lock can replace the file after the final fingerprint check and race the
  rename, so that writer's update may be overwritten.
- The RPC adapter (`omp-core::agent`) rejects harness authentication commands
  for prompt, steer, and follow-up delivery, including every resume request.
  Scheduled prompts are checked at create, update, resume, and run-now
  admission before project validation or queuing; startup blocks forbidden
  persisted active schedules before missed-run recovery and timer arming,
  while paused records remain available for cleanup and are checked if
  resumed. The executor repeats the check as defense in depth. Voice task
  launch, collaboration creation, and peer delivery preflight the same shared
  policy before queuing, wake-up, delivery, or runtime start.
- MCP rows use an independent 2,500-definition-per-settings-file discovery
  budget. Unrelated catalog records cannot consume it, and exceeding it emits
  an explicit scope-and-path warning.
- The app never requests or mutates `mcp:*` credentials in OMP's `agent.db`;
  definition removal does not inspect or change authorization, and
  authorization cleanup stays with the harness because the app cannot prove
  credential provenance.
- The app does not claim to prevent OMP from loading network MCP entries
  configured outside it. Its guarantee is narrower: it does not create,
  enable, disable, mutate, or authenticate those entries.
