# Validation guide

OMP Desktop ships as a native Rust application in [`rust/`](../rust/README.md). The
Node toolchain at the repository root exists only for the release scripts, the
conformance harness, and the documentation guards; it no longer builds a desktop
application. Nothing in this guide launches a browser engine, a bundler, or a
packaged JavaScript app.

## Local verification

Rust application (run from `rust/`):

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo deny check
cargo test --workspace --locked
cargo build -p omp-desktop --locked
```

Release tooling and documentation guards (run from the repository root):

```bash
npm ci
npm run typecheck
npm run check
npm test
```

`npm test` runs the Vitest suites that guard the release scripts and the
documentation: `tests/release-scripts.test.ts`,
`tests/validation-documentation.test.ts`,
`tests/security-policy-documentation.test.ts`, and
`tests/omp-parity-script.test.ts`.

The Node toolchain is bootstrapped from the vendored, pinned npm archive before
any other command:

```bash
npm run toolchain:bootstrap
npm run release:preflight
```

See the [security model](security.md) for why the npm archive is verified byte
for byte, and [conformance-protocol.md](conformance-protocol.md) for the
adapter protocol.

## Conformance suite

The cross-language suite in `tests/conformance/` drives the
Conformance Protocol v1 adapter over stdio. The only adapter in this repository
is the Rust one:

```bash
cd rust && cargo build -p omp-conformance --locked && cd ..
OMP_CONFORMANCE_PARTIAL=1 \
OMP_CONFORMANCE_REQUIRED_CAPABILITIES=state,projects,sessions,models,agent,git,checkouts,plugins,schedules,collaboration \
OMP_CONFORMANCE_ADAPTER_ARGV='["rust/target/debug/omp-conformance"]' \
npm run test:conformance
```

`terminal` is deliberately absent from the required capability set: the Rust
application has no built-in PTY. An adapter can also be supplied through
`OMP_CONFORMANCE_ADAPTER_CMD`. When neither variable is set, the harness uses
`rust/target/debug/omp-conformance` (or `omp-conformance.exe` on Windows) and
fails with build instructions if that binary is missing.

## Pull-request and branch CI

[`ci.yml`](../.github/workflows/ci.yml) runs on every pull request, on pushes to
`main`, and on manual dispatch.

| Job | What it proves |
| --- | --- |
| `release-scripts` | The pinned Node/npm toolchain installs, typechecks, lints, formats, and passes the Node test suites that guard the release scripts and documentation. |
| `rust` | `cargo fmt`, `cargo clippy -D warnings`, `cargo deny`, and `cargo test --workspace --locked` pass on macOS, Linux, and Windows. The Windows leg is the state-migration gate: the `omp-core` tests replay the Windows tombstone, quarantine, and backup protocol there. |
| `rust-conformance` | The conformance suite passes against the Rust adapter on macOS, Linux, and Windows, with the required capability set enforced and a capability/test-count summary uploaded. |
| `rust-package-smoke` | cargo-packager builds the macOS `.app`, and the packaged binary draws its first GPUI frame and writes the readiness marker. |
| `rust-package-smoke-linux` | cargo-packager builds the Linux `.deb`; the packaged binary draws its first frame under Xvfb. |
| `rust-package-smoke-windows` | cargo-packager builds the NSIS installer; the silently installed binary draws its first frame and writes the marker. |

## Protected `main` validation contract

Require these checks on `main`:

- `Release tooling`
- `Rust workspace (macos-15)`
- `Rust workspace (ubuntu-22.04)`
- `Rust workspace (windows-2022)`
- `Rust conformance (macos-15)`
- `Rust conformance (ubuntu-22.04)`
- `Rust conformance (windows-2022)`
- `Rust packaged smoke`
- `Rust packaged smoke (Linux deb)`
- `Rust packaged smoke (Windows nsis)`

Do not require any job: the whole workflow also runs on manual dispatch, and a
dispatch-only job would otherwise satisfy a required check that pull requests
never exercise.

## Public release validation

[`release.yml`](../.github/workflows/release.yml) publishes a release for a
pushed `v*.*.*` tag or for an existing tag supplied to a manual dispatch. Every
downstream job checks out the commit SHA resolved once by `validate`, so a tag
moved mid-run cannot mix commits.

| Job | What it proves |
| --- | --- |
| `validate` | The tag matches `package.json` and `package-lock.json`, the tagged commit is an ancestor of `main`, and the run is pinned to one commit SHA. |
| `quality` | The pinned toolchain typechecks, lints, formats, and passes the Node test suites for the exact release commit. |
| `package-rust` | cargo-packager builds and minisign-signs the macOS arm64/x86_64, Linux x86_64, and Windows x86_64 packages on native runners. A missing `RUST_UPDATER_SIGNING_KEY` skips signing with a notice instead of publishing artifacts the updater would reject. |
| `release-packages` | Fails closed unless every platform produced a `.sig`, then publishes one GitHub Release with every signed package, `SHA256SUMS.txt`, and build-provenance attestations. Stale draft assets are pruned before a resumed draft is published. |
| `rust-update-feed` | Generates `updates.json` for the updater from the signed artifacts and uploads it to the published release. The feed version is the Rust workspace version, not the tag. |

A release without the signing key is not publishable: the aggregate gate fails
closed rather than publishing an unsigned set.

## Rust updater feed

`scripts/release/prepare-rust-update-feed.mjs` writes the
cargo-packager-updater 0.2.3 feed. Every artifact must be a file with a matching
`.sig` that decodes to a minisign signature box, the base URL must be HTTPS
without credentials, query, or fragment, and platform names must be one of
`macos-aarch64`, `macos-x86_64`, `linux-x86_64`, or `windows-x86_64`. The client
verifies the feed with the public key baked in through `OMP_UPDATER_PUBKEY`.

Run it locally with `npm run release:rust-update-feed` and the same flags the
workflow uses (`--version-file rust/Cargo.toml --base-url ... --artifacts ...
--output ...`); `--check` validates without writing.

## Packaged smoke marker

Every packaged build accepts `--packaged-smoke=<absolute marker path>`. The
application starts normally, and only after the real window draws its first
frame does it write a size-capped JSON marker and quit. CI and the release smoke
jobs require `{"event":"gooeypi-packaged-smoke-ready"}`. The flag grants no
capability and is ignored outside packaged builds.

## Documentation guards

`npm test` fails when this guide links a missing local file, names an
`npm run` script that does not exist, or drifts from the job ids in
[`ci.yml`](../.github/workflows/ci.yml) and
[`release.yml`](../.github/workflows/release.yml). It also fails when the
security policy or the security model links a missing file.
