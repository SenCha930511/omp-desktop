# Security model

OMP Desktop is a native Rust application (`rust/crates/omp-desktop`, built on GPUI).
There is no JavaScript renderer, no Node integration surface, and no bundled
web application: the UI is drawn natively, and the only web engine in the
product is the Browser pane's embedded webview.

For vulnerability intake and response expectations, follow the repository's
[vulnerability reporting policy](../.github/SECURITY.md). Do not put suspected
vulnerability details in a public issue, discussion, or pull request.

## Agent execution

- OMP runs out of process over strict-LF JSONL RPC on stdio. Credentials and
  provider authentication remain owned by OMP; the desktop reads the model
  catalog and visible provider toggles, never OMP's credential storage.
- The RPC client validates commands and response correlations, and caps
  runtimes, in-flight bytes, record sizes, event counts, per-envelope bytes, and
  aggregate event bytes. A malformed frame fails the runtime instead of growing
  unbounded.
- The `!` composer shorthand sends the user's own `bash`/`abort_bash` command to
  OMP. It is a direct shell channel: it runs with the user's OS permissions in
  the session's working directory and bypasses the model, exactly like a command
  the user types in a terminal. Validation is structural only (a non-empty
  string with a size cap); shell content is passed through unchanged because
  filtering shell syntax would only simulate safety.
- Provider login/logout stays in OMP. The app issues the documented RPC
  commands and renders OMP's own dialog surfaces; no token, refresh material, or
  secret prompt crosses into the desktop process.
- Quitting stops the app's RPC runtimes and terminal children before the state
  store takes its final snapshot.

## Local capabilities

- Projects are explicit grants. Only canonical, explicitly granted roots can be
  opened, listed, diffed, or used as an agent working directory. Session-derived
  folders receive a read-only grant for inspection; agent execution, terminals,
  mutating Git operations, worktrees, plugins, and configuration require an
  explicit persisted grant. Removal revokes access immediately.
- Paths are canonicalized before use, and project configuration and file trees
  cannot escape a granted root. Git and package operations use validated fixed
  executables and argv arrays, never shell interpolation.
- The bottom terminal is a real pseudo terminal (`portable-pty`) owned by the
  app. Closing the panel kills the shell; nothing in the terminal touches the
  persisted state store.
- Durable schedules are owned by the app and stored in the same bounded state
  store. Every execution revalidates its granted project (and canonical session
  path) before launching OMP, and concurrent writes to one thread are
  serialized.
- App-owned tools reach the desktop through random-token loopback brokers. The
  token is injected only into that runtime's environment, every request is
  size- and content-type-bounded, and the operation is constrained to the
  runtime's authorized project and session. Brokers shut down with the runtime.

## Browser pane

- Each tab owns a native webview with its own isolated profile directory (a
  per-tab data store on macOS), so cookies and storage never cross tabs.
- Page URLs go through one policy: HTTP(S) only, no embedded credentials, no
  non-web schemes. Loopback and private hosts are only allowed where the product
  intentionally targets a local broker or dev server.
- Page content is never trusted as app input. The desktop does not expose a
  scriptable bridge from the page into the application, and agent-driven
  navigation is limited to credential-free HTTP(S).

## Persisted state

- Authority lives in `omp-desktop-state-v4.json`, written atomically and
  fsynced. Unknown JSON fields survive round-trips, so a newer build's data is
  not silently destroyed by an older one.
- Migration from the legacy v1-v3 layout and the Windows tombstone protocol is
  implemented in `omp-core` and replayed by its tests: byte-exact backups,
  directory fsyncs, retryable pending markers, and fail-closed handling of a
  completed marker with a missing or corrupt v4 file.
- A state version newer than the running build, or a file too large to classify
  safely, is opened read-only and left byte-for-byte unchanged. Startup fails
  rather than rewriting authority the build does not understand.
- The first launch after the GooeyPi rename copies app-owned files from the
  legacy application-data directory without overwriting existing files and
  leaves the legacy directory untouched.
- Transcripts are read-only. The app never rewrites session JSONL; file paths,
  sizes, record counts, and catalog sizes are bounded.

## Packaging and updates

- Release packages are built by cargo-packager on native runners: macOS `.app`,
  Linux `.deb`/AppImage, and a Windows NSIS installer. There is no app-integrity
  container, no runtime hardening fuse set, and no Developer ID or Authenticode
  requirement in this repository's release path.
- Every published artifact is minisign-signed. `RUST_UPDATER_SIGNING_KEY` signs
  each platform package, the release aggregate fails closed unless every
  platform produced a `.sig`, and the updater feed is only generated from signed
  artifacts.
- The updater is check-and-notify only: the app fetches the HTTPS feed, verifies
  its signature with the `OMP_UPDATER_PUBKEY` baked in at build time, and shows
  the available version. Nothing is downloaded or installed. A build without a
  baked-in key reports "not configured" and never opens a socket.
- Packaged builds accept one documented diagnostic argument,
  `--packaged-smoke=<absolute marker path>`. It grants no capability and adds no
  command surface: the app starts normally and, after the first frame is drawn,
  writes a size-capped JSON marker and quits. CI uses it to prove that a
  packaged binary really boots.

## Dependency pinning and supply chain

The release toolchain bootstraps the `packageManager`-pinned npm from the exact
official archive checked into `vendor/`. Before invoking npm's installer,
`scripts/release/bootstrap-npm.mjs` requires the version-derived repository path
to be a regular non-symlink file and verifies its exact byte size and SHA-512
against `scripts/release/dependency-pins.json`. Every bootstrap then installs
that absolute local archive with `--offline`, `--ignore-scripts`, `--no-audit`,
and `--no-fund`; verifies the expected CLI, shim, and exact version; and only
then publishes its shim directory to later GitHub Actions steps. The archive is
a build-time tool and is never shipped inside a desktop package.

This check authenticates the archive bytes against the reviewed Git history; it
does not independently authenticate the extracted installation tree. The
checked-out bootstrap code, invoking Node.js/npm processes, configured writable
prefix, and local filesystem remain trusted. An attacker controlling any of
those inputs can subvert installation or mutate files after verification. The
provenance record in `vendor/npm-12.0.2.md` binds the vendored bytes to the npm
registry metadata and upstream release tag. An npm upgrade must update the
repository toolchain metadata, archive, provenance record, and artifact pin
together under security-sensitive review.

Rust dependencies are pinned by `rust/Cargo.lock` and audited by
`cargo deny check` (advisories, licenses, and sources) in CI. Accepted
advisories and their reasons live in `rust/deny.toml`.

The npm dependency tree contains only development tooling (Vitest, Biome,
TypeScript, `js-yaml`); there are no runtime npm dependencies, so the desktop
application itself ships no JavaScript.

## Out of scope

OMP packages, tools, terminals, configured MCP servers, and the optional
computer-use driver execute with the user's OS permissions. The desktop boundary
protects the app's own state and the Browser pane; it is not an OS sandbox for
capabilities the user deliberately launches. Review projects, commands, and
third-party integrations before granting access.
