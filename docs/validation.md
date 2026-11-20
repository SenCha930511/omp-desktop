# Validation guide

This page explains how to reproduce and interpret OMP Desktop's validation gates. It is not a status report. A passing command or workflow is evidence only for the exact commit, runner, inputs, and credentials that produced it; do not infer that the current branch is green from this document.

## Protected `main` validation contract

The repository's `main` branch protection must require pull requests and require status checks to pass with **Require branches to be up to date before merging** enabled (`required_status_checks.strict: true`). This strict latest-main requirement prevents a PR from merging on a newer base than the integration state validated by CI.

The required checks are exactly the nineteen normal pull-request gates:

- `Production dependency audit`
- `quality`
- `hermetic-e2e`
- `windows-state-migration`
- `conformance (macos-15)`
- `conformance (ubuntu-22.04)`
- `conformance (windows-2022)`
- `Rust workspace (macos-15)`
- `Rust workspace (ubuntu-22.04)`
- `Rust workspace (windows-2022)`
- `Rust conformance (macos-15)`
- `Rust conformance (ubuntu-22.04)`
- `Rust conformance (windows-2022)`
- `Rust packaged smoke`
- `Rust packaged smoke (Linux deb)`
- `Rust packaged smoke (Windows nsis)`
- `packaging-smoke (macos-15, mac, arm64, --config.mac.identity=null)`
- `packaging-smoke (ubuntu-22.04, linux, x64)`
- `packaging-smoke (windows-2022, win, x64)`

The Rust checks are being introduced with the v2 workspace. A repository administrator must add their exact context names to the required status checks before they can block merges. Until then, run them locally with the commands below.

Do not require `local-qa-package`: it is manual local QA, runs only through `workflow_dispatch`, and is intentionally excluded from pull-request validation.

`Production dependency audit` runs the exception-aware `npm run audit:production` evaluator against the exact PR head, and the release workflow runs the same evaluator against its validated immutable SHA before any package or publication job. After the check context first appears on a pull request, a repository administrator must add this exact named context to the required status checks on `main`. The scheduled [dependency-audit workflow](../.github/workflows/audit.yml) remains for advisories disclosed after merge.

GitHub merge queues are not available to this public repository while it is owned by a personal account. Consequently, `merge_group` or a required merge queue cannot enforce this policy here; strict up-to-date branch protection is the supported latest-main control. If the repository moves to an organization, merge-queue support should be designed and tested separately before enabling it.

An authorized maintainer can verify the active legacy branch protection and exact required-context set with:

```sh
gh api repos/SenCha930511/omp-desktop/branches/main/protection \
  --jq '{strict: .required_status_checks.strict, contexts: .required_status_checks.contexts, reviews: .required_pull_request_reviews}'
```

## Sources of truth

| Concern | Authoritative definition |
|---|---|
| Pull-request, `main`, and manual CI | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| Tagged public releases | [`.github/workflows/release.yml`](../.github/workflows/release.yml) |
| Scheduled production-dependency audit | [`.github/workflows/audit.yml`](../.github/workflows/audit.yml) |
| Aggregate commands and toolchain policy | [`package.json`](../package.json) and [`.nvmrc`](../.nvmrc) |
| Resolved dependency graph | [`package-lock.json`](../package-lock.json) |
| Dependency-install lifecycle | [`package.json`](../package.json) and [`install-app-deps.mjs`](../scripts/release/install-app-deps.mjs) |
| Package and post-package guarantees | [`scripts/release/package.mjs`](../scripts/release/package.mjs), [`verify-package.mjs`](../scripts/release/verify-package.mjs), and [`verify-cross-platform-package.mjs`](../scripts/release/verify-cross-platform-package.mjs) |
| Cross-implementation conformance protocol | [`docs/conformance-protocol.md`](conformance-protocol.md) and [`vitest.conformance.config.ts`](../vitest.conformance.config.ts) |
| Audit policy and accepted risk | [`docs/security.md`](security.md), [`audit-production.mjs`](../scripts/release/audit-production.mjs), and [`audit-exceptions.json`](../scripts/release/audit-exceptions.json) |

Read these files at the commit being validated. Job names, test inventory, dependency versions, budgets, and artifact matrices can change; copying their current values into a permanent pass/fail table would create another stale snapshot.

## Reproducible setup

The repository derives its Node and npm policy from checked-in metadata. `package.json#engines`, `package.json#packageManager`, and `.nvmrc` must agree; release entry points reject unsupported, malformed, or prerelease tool versions. With `nvm`, prepare a checkout as follows:

```bash
nvm install
nvm use
npm run toolchain:bootstrap
npm ci
npm run release:preflight:toolchain
```

Run `toolchain:bootstrap` before installing project dependencies. It installs the `packageManager`-pinned npm into the invoked npm's validated global prefix, verifies the exact installed JavaScript CLI with the active Node executable, and publishes the matching shim directory to later GitHub Actions steps. This is necessary because the npm bundled by `actions/setup-node` can be older than the repository's npm floor.

`npm ci` runs the shared `postinstall` entry point. That entry point installs Electron's platform runtime synchronously before asking Electron Builder to rebuild native dependencies, so parallel test workers do not race Electron's lazy downloader. Installing with `--ignore-scripts` intentionally skips both operations; follow the recovery sequence in the [source setup instructions](../README.md#run-from-source) before running or packaging the application.

Do not hard-code the current Node, npm, or Electron version in validation notes. Record the values observed for the tested commit instead.

## Pull-request and branch CI

The [CI workflow](../.github/workflows/ci.yml) runs on pull requests, pushes to `main`, and manual dispatch. Each Node job bootstraps the repository npm before `npm ci` and executes the toolchain-only release preflight after installation.

| Job | When it runs | What a pass establishes |
|---|---|---|
| `production-audit` | Pull request, `main`, manual dispatch | The exception-aware production dependency audit passes for the exact checked-out commit. |
| `quality` | Pull request, `main`, manual dispatch | TypeScript checks; configured lint and format checks; the coverage suite and thresholds; production bundle creation; bundle-size budgets; coverage artifact upload. |
| `hermetic-e2e` | Pull request, `main`, manual dispatch | The built application passes the Playwright Electron suite on the pinned macOS runner without relying on developer state. Failure artifacts are uploaded when available. |
| `windows-state-migration` | Pull request, `main`, manual dispatch | The state migration suite passes on a real `windows-2022` runner, including the production-platform fresh-install, migration, restart, and update path. Simulating `platform: 'win32'` on another OS is useful unit coverage but is not a substitute for this job. |
| `conformance` | Pull request, `main`, manual dispatch | The language-agnostic conformance suite passes on `macos-15`, `ubuntu-22.04`, and `windows-2022` against the reference Node adapter or a configured `OMP_CONFORMANCE_ADAPTER_CMD`. |
| `rust` | Pull request, `main`, manual dispatch | `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --workspace --locked`, and the conformance adapter build pass on all three desktop platforms. |
| `rust-conformance` | Pull request, `main`, manual dispatch | The cross-language conformance suite passes against the Rust adapter with the required-capability gate active, and the adapter capability and test-count summary is uploaded as an artifact. |
| `rust-package-smoke` | Pull request, `main`, manual dispatch | `cargo-packager` builds the macOS `.app`, the packaged binary draws a real GPUI first frame, and its smoke marker is uploaded. |
| `rust-package-smoke-linux` | Pull request, `main`, manual dispatch | `cargo-packager` builds the Linux `.deb`, the extracted binary draws a real GPUI first frame under Xvfb, and its smoke marker is uploaded. |
| `rust-package-smoke-windows` | Pull request, `main`, manual dispatch | `cargo-packager` builds the Windows NSIS installer, installs it silently into a temporary directory, and the installed binary draws a real GPUI first frame; the marker and installer are uploaded. |
| `packaging-smoke` | Pull requests only | Native macOS arm64, Linux x64, and Windows x64 runners build unpacked applications and launch them with `--packaged-smoke`. Linux and Windows additionally verify the ASAR layout and exact native-unpack allowlist. These are unsigned smoke builds, not public installers. |
| `local-qa-package` | Manual dispatch only | Native runners create and verify installable local-QA artifacts for macOS, Linux, and Windows, then upload the configured artifact set. These artifacts are not represented as signed or notarized public releases. |

Expected skips are part of this design:

- `local-qa-package` is expected to be skipped on pull requests and pushes to `main`.
- `packaging-smoke` is expected to be skipped on pushes to `main` and manual dispatches because its condition is pull-request-only.

`windows-state-migration` is required for every CI trigger listed above; a skip is not expected.

A green PR packaging matrix does not prove Developer ID signing, Apple notarization/stapling, Gatekeeper acceptance, Authenticode identity, installer integrity, or the complete public artifact matrix. Those belong to the release workflow.

## Local aggregate commands

Use focused tests while developing, then choose the aggregate that matches the claim you need to make. The command definitions in [`package.json`](../package.json) remain authoritative.

| Command | Scope |
|---|---|
| `npm run release:verify:package` | Toolchain preflight, typecheck, configured code checks, coverage tests, production bundle, and bundle-size gate. It does not create an installer or run Electron E2E. |
| `npm run release:verify` | The package-verification aggregate above plus the hermetic Electron E2E suite. |
| `npm run test:e2e` | Builds the application, then runs the hermetic Electron E2E suite. |
| `npm run conformance:build-adapter` | Bundles the reference Node conformance adapter for `OMP_CONFORMANCE_ADAPTER_CMD` parity validation. |
| `npm run test:conformance` | Runs the framework-independent conformance and black-box suite (`vitest.conformance.config.ts`) across state, projects, sessions, RPC, Git, plugins/MCP, schedules, collaboration, and PTY terminals. |
| `npm run audit:production` | Fetches npm's production audit report and applies the repository's high/critical advisory and exception policy. Network access is required. |
| `npm run package:mac:local-qa` | On macOS, runs the relevant verification aggregate, creates unsigned/unnotarized DMG and ZIP artifacts, and applies macOS post-package checks in QA mode. |
| `npm run package:linux:local-qa` | On Linux, runs the package-verification aggregate, creates the configured Linux artifacts, and verifies their runtime layout in QA mode. |
| `npm run package:win:local-qa` | On Windows, runs the package-verification aggregate, creates the configured Windows artifacts, and verifies their runtime layout in QA mode. |

Packaging is native: run each platform command on its matching operating system and architecture. The public `package:mac`, `package:linux`, and `package:win` commands use distribution mode; macOS and Windows distribution checks require their external signing configuration. A successful local-QA command must not be described as a public trust check. These commands build the legacy Electron application; the shipped Rust application is packaged with `cargo packager` as described in [the Rust workspace README](../rust/README.md).

## Dependency audit policy

The [dependency-audit workflow](../.github/workflows/audit.yml) runs weekly and on manual dispatch. It uses the repository toolchain and executes `npm run audit:production` against the production dependency graph. This scheduled job re-audits the production graph against a current advisory database so advisories disclosed after a merge are still detected.

Ordinary PR CI validates the exception file and its expiry rules, but it does not replace the live registry-backed audit. Use the scheduled or manually dispatched audit workflow when making a current dependency-advisory claim.

The project gate and raw npm output answer different questions:

- `npm audit --omit=dev` is the underlying registry report for the production lock graph. Its output and exit status are diagnostic and can change as the advisory database changes.
- `npm run audit:production` parses that report and fails on every unaccepted **high** or **critical** advisory.
- [`audit-exceptions.json`](../scripts/release/audit-exceptions.json) can accept an exact advisory/package pair only with a reason and expiry. The gate also fails expired exceptions and stale exceptions that no longer match the report.
- The ordinary release-script tests check exception structure and expiry, so an elapsed acceptance is visible in PR CI as well as in the weekly audit.

A passing audit therefore does not mean the production graph carries no known advisory: the gate also passes while an advisory is accepted in [`audit-exceptions.json`](../scripts/release/audit-exceptions.json) with a reason and an unexpired date. Never restate a passing gate as "zero vulnerabilities". Read that file for the accepted-risk position at the commit under review, and treat adding or extending an exception as a security-sensitive change governed by the [dependency pinning and supply-chain policy](security.md#dependency-pinning-and-supply-chain).

## Public release validation

The [release workflow](../.github/workflows/release.yml) runs for a semantic-version tag or a manual request naming an existing tag. It first verifies that the tag matches both package manifests and resolves to a commit on `main`; downstream jobs check out the resulting immutable commit SHA.

| Release job | Responsibility |
|---|---|
| `validate` | Enforce the repository toolchain, validate tag/package versions and `main` ancestry, and expose the exact release SHA. |
| `production-audit` | Apply the exception-aware production dependency audit to that immutable SHA before any package job. |
| `quality` | Run `release:verify:package` for that SHA. |
| `conformance` | Run `npm run test:conformance` for that SHA across macOS, Linux, and Windows before any native package job. |
| `hermetic-e2e` | Build and run the Electron E2E suite for that SHA, keeping the legacy Electron source verified even though it is not shipped by default. |
| `package` | Legacy Electron build, opt-in only. Build both native macOS architectures. Credential preflight is fail-closed; public verification checks the signing identity, required microphone entitlements on the app and every Electron helper, the notarization staple on each packaged app, Gatekeeper, artifact integrity, fuses, native layout/architecture, and package budgets. Both native macOS architectures must pass the packaged application launch smoke before their artifacts are uploaded. |
| `package-linux` | Legacy Electron build, opt-in only. Build the configured Linux architectures on native runners and apply the Linux package/runtime verification path. |
| `package-windows` | Legacy Electron build, opt-in only, and additionally gated on the Windows inputs. Build either Authenticode-signed public packages or unsigned beta packages. Signed mode requires signing secrets and the configured signer subject and/or thumbprint. |
| `package-rust` | Runs on every release. Build and cargo-packager-sign the Rust application on native macOS (both architectures), Linux x86_64, and Windows runners. Unsigned artifacts are never uploaded: without `RUST_UPDATER_SIGNING_KEY` the packaging step skips with a notice, and the release aggregate then fails instead of publishing a release with no Rust artifacts. |
| `release-packages` | Reject failed prerequisites, require all four signed Rust packages, collect the enabled platform artifacts, generate `SHA256SUMS.txt` for every published asset, attest provenance, and create or resume the GitHub Release with write permission scoped to this final job. The legacy Electron assets join that release only when the Electron build is opted in. |
| `rust-update-feed` | Build `updates.json` from the signed Rust packages and upload it to the already-published release. |

Native release jobs pass `--skip-verify` only after the same immutable SHA has passed the upstream quality and E2E jobs. That flag skips a duplicate pre-package test aggregate; it does not skip bundle creation or the platform-specific post-package verification.

The Rust application is the shipping desktop application. The Electron tree remains in the repository as legacy source: it keeps its own pull-request CI (conformance, hermetic E2E, and packaging smoke) and is only packaged for a release when a maintainer sets `include_legacy_electron` on a manual dispatch or the `RELEASE_ELECTRON_ENABLED` repository variable for a tag push. When the legacy build is off, `package`, `package-linux`, and `package-windows` are expected to be skipped; the aggregate release gate accepts those skips but still fails when `package-rust` or one of its signed artifacts is missing.

The legacy Developer ID, notarization, and Authenticode checks require external credentials that are not present in ordinary PR CI, so a green PR packaging matrix does not prove them. An explicitly enabled unsigned Windows beta is not trust-ready and must be labelled as such. Ordinary PR smoke packages and manual local-QA artifacts do not replace any credentialed release check.

## Recording evidence

Keep point-in-time results in the PR, release notes, or another commit-addressed record rather than updating this guide with a new "current status". Record at least:

- the full commit SHA and whether the worktree was clean;
- the workflow run URL or exact commands and exit status;
- runner image or local OS/architecture, plus observed Node and npm versions;
- workflow inputs and which conditional jobs or steps were skipped;
- the audit exception file used for dependency-audit claims;
- artifact names and checksums, and whether each artifact was unsigned, signed, notarized, stapled, or provenance-attested;
- any failure, rerun, accepted limitation, or manual observation needed to interpret the result.

Use test counts only inside that commit-addressed evidence. The durable claim is that the checked-in aggregate completed successfully, not that this guide remembers how many tests happened to exist at some earlier date.

## Rust workspace

The v2 workspace lives in `rust/` and is the shipping desktop application; the Electron tree at the repository root is legacy source. The workspace is pinned by `rust-toolchain.toml` and `rust/Cargo.lock`; CI installs Rust 1.100.0 with `rustfmt` and `clippy`. See [the Rust workspace README](../rust/README.md).

```bash
cd rust
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo deny check
cargo test --workspace --locked
cargo build -p omp-conformance --locked
```

Run the cross-language conformance suite against the Rust adapter from the repository root:

```bash
OMP_CONFORMANCE_PARTIAL=1 \
OMP_CONFORMANCE_REQUIRED_CAPABILITIES=state,projects,sessions,models,agent,git,checkouts,plugins,schedules,collaboration \
OMP_CONFORMANCE_ADAPTER_CMD="$PWD/rust/target/debug/omp-conformance" \
npm run test:conformance
```

`OMP_CONFORMANCE_PARTIAL=1` lets the adapter omit the deliberately removed `terminal` capability. `OMP_CONFORMANCE_REQUIRED_CAPABILITIES` is enforced even in partial mode, so a phase gate cannot pass by skipping a capability it claims to require. The Node reference adapter remains the oracle; the Rust adapter must satisfy the same tests.

`node scripts/rust/generate-hmac-fixtures.mjs` regenerates the Node-signed v1/v2/v3 collaboration envelopes consumed by `cargo test`. Regenerate them only when the envelope format changes; the Rust test fails on any signature drift.

## Rust updater feed

The v2 app has a check-only updater client in `rust/crates/omp-desktop/src/updates.rs`. It reads `updates.json` from the latest GitHub Release and verifies its minisign signature against the public key baked in as `OMP_UPDATER_PUBKEY`. A build without that key reports the updater as unconfigured and never opens a socket.

`scripts/release/prepare-rust-update-feed.mjs` builds that feed from signed artifacts. It uses only Node builtins and writes deterministic JSON (two-space indent, platform keys sorted, trailing newline) in the `cargo-packager-updater` 0.2.3 format: `version` plus `platforms.<os>-<arch>.{url,signature,format}`, where `<os>` is `macos`, `linux`, or `windows` and `format` is `app`, `nsis`, or `appimage`.

Create a manifest listing every platform with its artifact, `.sig` file, and format. Relative paths resolve against the manifest file's directory:

```json
{
  "platforms": [
    { "platform": "macos-aarch64", "artifact": "OMP Desktop_0.1.0_aarch64.app.tar.gz", "signature": "OMP Desktop_0.1.0_aarch64.app.tar.gz.sig", "format": "app" },
    { "platform": "linux-x86_64", "artifact": "omp-desktop_0.1.0_amd64.AppImage", "signature": "omp-desktop_0.1.0_amd64.AppImage.sig", "format": "appimage" },
    { "platform": "windows-x86_64", "artifact": "omp-desktop_0.1.0_x64-setup.exe", "signature": "omp-desktop_0.1.0_x64-setup.exe.sig", "format": "nsis" }
  ]
}
```

Generate the feed, or validate it without writing with `--check`:

```bash
npm run release:rust-update-feed -- \
  --version 0.1.0 \
  --base-url https://github.com/SenCha930511/omp-desktop/releases/download/v0.1.0/ \
  --manifest path/to/updates-manifest.json \
  --output updates.json
```

The script fails closed on a non-semver version, a non-HTTPS base URL (or one with credentials, a query, or a fragment), an empty or duplicate platform list, an unknown `<os>-<arch>` key, an unsupported format, a missing artifact or signature file, and a signature that is not the base64 signature box cargo-packager writes to a `.sig` file.

Signing prerequisite: the feed is only usable with a minisign keypair whose public key is baked into the app at build time. Generate the keypair once and sign each artifact with cargo-packager:

```bash
cargo packager signer generate --path ~/.config/omp/updater.key
cargo packager signer sign --private-key ~/.config/omp/updater.key path/to/artifact
```

The `.sig` file cargo-packager writes is already the base64 signature box the updater expects, so pass that file to the manifest. The generated `.pub` file is the exact `OMP_UPDATER_PUBKEY` value; build with `OMP_UPDATER_PUBKEY="$(cat ~/.config/omp/updater.key.pub)"`.

The `rust-update-feed` release job builds this feed from the signed Rust packages with `--version-file rust/Cargo.toml` (the version compiled into the app, not the release tag) and `--artifacts` (the downloaded `<os>-<arch>` package directories), then uploads `updates.json` to the published release; the client reads `https://github.com/SenCha930511/omp-desktop/releases/latest/download/updates.json`. The feed job runs on every release. A release without `RUST_UPDATER_SIGNING_KEY` is not publishable: `package-rust` skips signing with a notice and `release-packages` fails closed rather than publishing artifacts the updater would reject.
