# Repository Guidelines

Guidance for AI coding assistants working in this repository. OMP Desktop is an Electron+React desktop workspace for the [OMP](https://github.com/can1357/oh-my-pi) coding-agent harness, forked from GooeyPi (see `README.md` → Attribution). It is a GUI app with no background services; there is nothing to auto-start.

## Project Overview

A cross-platform (macOS/Linux/Windows) desktop shell that gives the `omp` CLI a native UI: projects, persistent sessions, live transcripts, model/provider pickers, schedules, terminals, an agent-driven browser, and a Git/inspector workspace. The harness owns models, logins, and session files; this app owns the chrome. Single harness only — `requireHarness` accepts exactly `'omp'`.

## Architecture & Data Flow

Two-process Electron app built with electron-vite; the renderer has **no direct Node access**:

```
React renderer (src/) ── window.desktop (frozen DesktopApi, contextBridge)
                       └─ ipcRenderer.invoke('domain:action') + push subscriptions
preload (electron/preload/index.ts) ── wraps each channel, Object.freeze per domain
main (electron/main/*) ── registerIpc() wires every handler with sender verification
                       └─ services: store, sessions, agent-rpc, git, terminal, voice, …
```

- **`src/types/api.ts` is the shared contract for all three processes** — record types, the `DesktopApi` interface, and `declare global { Window.desktop }`. Editing it changes main, preload, and renderer at once; channel names in `electron/main/ipc.ts` and preload wrappers must be kept in sync manually.
- **IPC security is fail-closed**: every handler verifies the sender's WebContents and exact renderer URL (`isTrustedRendererUrl`) and validates args with hand-rolled guards in `electron/main/validation.ts` (`requireString`, `requireRecord`, `requireWebUrl`, …). Adding an IPC surface means: handler in `ipc.ts` + preload wrapper + `DesktopApi` member — all three or the security tests fail.
- **Data flow**: hooks (`useBootstrap`, `useWorkspaceRuntime`) fetch via bridge, then subscribe to push channels (`sessions:onChanged`, `agent:onEvent`, …). Agent events (`PrimeEventEnvelope`) are folded into `TranscriptMessage[]` by the pure, perf-critical reducer `replayPrimeEvents` (`src/lib/events/reduce.ts`) — don't make it allocate per event.
- **Persistence**: one JSON state file (`omp-desktop-state-v4.json`) via `JsonStateStore` (`electron/main/store.ts`) with versioned schema migration and byte-exact backups. Session content belongs to OMP's own `.jsonl` files — this app only reads them.
- **Harness integration**: `AgentRpcManager` (`electron/main/agent-rpc/manager.ts`) spawns `omp` per session, framed JSON-RPC over stdio; `harness-adapter.ts` is the single seam translating app vocabulary ↔ omp protocol.
- **Renderer fallback**: without `window.desktop` (plain browser dev) the app seeds sample data — every bridge call must guard with `hasBridge()`.

## Key Directories

| Path | Purpose |
|---|---|
| `src/` | React renderer: `App.tsx` composition root (no router), `pages/` full views, `components/` workspace widgets, `hooks/` domain logic, `lib/` pure logic |
| `src/i18n/keys/` | Locale catalog fragments (`core`, `sidebar`, `workbench`, `transcript`, `settings`, `panels`) — one file per surface so parallel edits never conflict |
| `src/types/api.ts` | The cross-process contract (see above) |
| `electron/main/` | Main-process services, IPC wiring, validation, agent RPC, store |
| `electron/preload/` | The contextBridge surface |
| `assets/` | Icons, skills, extensions; `assets/extensions/*.ts` typechecked by `tsconfig.extensions.json` |
| `scripts/release/` | Packaging/verification toolchain (see below) |
| `tests/` | `backend/` main-process units, `frontend/` React tests, `unit/`, `e2e/app.spec.ts` |
| `docs/` | `validation.md` (canonical commands), `security.md` (threat model) |

## Development Commands

```
npm run dev                 # electron-vite dev (launch the app)
npm run build               # typecheck (5 tsc projects) + electron-vite build → out/
npm run typecheck           # tsc --noEmit for node/web/tests/scripts/extensions configs
npm run check               # biome lint + format:check
npm test                    # vitest run (all unit/frontend/backend)
npx vitest run tests/frontend/toast.test.tsx   # single file
npm run test:coverage       # vitest + v8 coverage with thresholds
npm run test:e2e            # build + hermetic Playwright Electron e2e
npm run test:e2e:hermetic   # playwright only (skip rebuild)
npm run release:verify:package   # toolchain + typecheck + check + coverage + bundle + size
npm run release:verify           # the above + hermetic e2e (pre-push aggregate)
npm run package:mac|linux|win    # electron-builder packaging (see scripts/release/package.mjs)
```

On Linux CI/Cloud-Agent VMs, wrap GUI commands with `xvfb-run -a` (e.g. `xvfb-run -a npm run test:e2e:hermetic`); on macOS the e2e suite hides windows via `OMP_DESKTOP_E2E_HIDE_WINDOWS=1` instead.

## Code Conventions & Common Patterns

- **Formatting** (biome, `scripts/release/biome.json`): single quotes, no semicolons, 2-space indent, lineWidth 200. `npm run lint` covers all source; `format:check` only covers `scripts/release` + root configs + `tests/release-scripts.test.ts` — pass `--config-path=scripts/release/biome.json` when formatting manually.
- **No state library**: plain hooks + prop drilling; context only for i18n and toasts. `useStableCallback` for latest-closure dispatch into memoized children; generation/request counters to discard stale async results.
- **Dependency injection in main-process services**: constructors take collaborators and injectable seams (`watchDirectory`, `catalogIo`, fake fs/executable) — check `tests/backend/` before assuming a service needs a real Electron runtime.
- **Error handling**: renderer errors go through `reportError`/toasts; subprocess ops return `ProcessOutcome { ok, output, reason }` instead of throwing; fire-and-forget is `void promise.catch(reportError)`.
- **i18n**: user-facing strings go through `useI18n().t('key')` with keys in the per-surface fragments. The `en` catalog is the complete source of truth and its values are **exact** — tests assert them byte-for-byte; `zh-TW`/`zh-CN` are partial overlays falling back per key. Interpolation is `t('key', { name })` with `{name}` placeholders.
- **File size**: keep handwritten production files ≤750 lines when practical (review threshold, not a hard rule); tests, generated, and vendored files are exempt.
- **Naming**: PascalCase components/services, `useX` hooks, kebab-case files for non-component modules. The `Prime*` type prefix and state keys like `gooeyPiV4Migration` are deliberate pre-rebrand compatibility surfaces — don't rename them.
- **Doc comments state invariants and rationale** on security gates, revision semantics, and perf-sensitive code — read them before touching.

## Important Files

- `src/App.tsx` — composition root (view state, lazy pages, terminal mounts)
- `src/types/api.ts` — the cross-process contract
- `electron/main/index.ts` — window lifecycle, `omp-desktop://` protocol with CSP, single-instance lock, service bootstrap
- `electron/main/ipc.ts` — every IPC channel + sender authorization
- `electron/main/store.ts` — persisted state, schema migration, `defaultSettings()`
- `src/lib/events/reduce.ts` — agent-event → transcript reducer
- `electron.vite.config.ts` — main/preload/renderer build (manual vendor chunks)
- `scripts/release/biome.json` — the effective lint/format config
- `docs/validation.md` — canonical command reference (don't restate versions elsewhere)

## Runtime/Tooling Preferences

- **Node ≥24.15.0, npm ≥12.0.2** (`.nvmrc` pins 24.15.0; `engines` + `packageManager` must agree — `scripts/release/preflight.mjs` enforces this).
- **npm only**, and the repo-pinned npm: run `npm run toolchain:bootstrap` (installs npm from the checksum-verified `vendor/` archive) before `npm ci` on a fresh machine.
- A harness shell can be shadowed by another `node` on `PATH`; if `node -v` isn't `v24.15.0`: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use >/dev/null`.
- **Runtime deps are deliberately minimal** (only `electron-updater`, `js-yaml`, `node-pty`, `rrule`); everything else is devDependencies. New runtime deps need audit/size-budget review (`audit:production`, `release:bundle-size`).
- `postinstall` runs `install-app-deps.mjs` (native rebuild) and `brand-dev-electron.mjs` (rebrands the dev Electron bundle as "OMP Desktop": name, unique bundle id, icon, ad-hoc re-sign, LaunchServices refresh). Don't rename the executable inside `node_modules/electron/dist/Electron.app` — `path.txt` and Electron's resource lookup depend on it.
- Git remotes: `origin` = `SenCha930511/omp-desktop`, `upstream` = `am-will/gooey-pi`.

## Testing & QA

- **Vitest** for unit/frontend/backend (one config, `environment: node`); frontend files opt into jsdom with a first-line `// @vitest-environment jsdom` comment — omitting it silently fails. Frontend tests hand-roll `createRoot` + `act()` (no Testing Library) and mock the bridge via `Object.defineProperty(window, 'desktop', …)` or a `bridge` prop cast `as unknown as DesktopApi`.
- **Backend tests** use real temp dirs (`mkdtempSync`) and inject fake fs/executable seams; IPC-security and preload-contract tests pin the exact channel surface.
- **Tests assert exact UI English strings** — never reword `en` catalog values or visible copy without updating the tests. zh-TW uses Taiwan-standard terminology (專案/工作階段/設定/終端機/支援).
- **Playwright Electron e2e** (`tests/e2e/app.spec.ts`): hermetic (temp `HOME`, fixture `OMP_BINARY`), serial (`workers: 1`), 75s timeout, retries 1 for the known macOS first-window flake. It fails on any renderer `pageerror`. Two known-flaky scenarios (`local OMP MCP servers`, `tray Quit`) pass on retry.
- **Coverage**: `npm run test:coverage` enforces global thresholds plus per-family requirements from `scripts/release/coverage-inventory` (safety-critical modules like `ipc.ts`, `store.ts`, `preload/index.ts` must stay covered).
- **CI gates** (`.github/workflows/ci.yml`): production audit, quality (typecheck+check+coverage+bundle+size), hermetic e2e (macOS), Windows state-migration, packaging smoke. All run `toolchain:bootstrap` + toolchain preflight + `npm ci`.
- **Release verification is fail-closed**: `verify-package.mjs` (signing/entitlements/notarization/fuses/ASAR allowlist), `smoke-packaged-app.mjs` (packaged boot marker), `audit-production.mjs` (advisories; exceptions need reason + expiry). Adding an audit exception is a security-sensitive change.
