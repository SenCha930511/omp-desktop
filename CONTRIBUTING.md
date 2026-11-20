# Contributing

See the [build instructions](README.md#build-from-source) and
[validation guide](docs/validation.md) for the supported toolchain and checks.

## Local development

OMP Desktop is the Rust workspace in `rust/`:

```bash
cd rust
cargo run -p omp-desktop
```

Run the checks from the validation guide before submitting a change:

```bash
cd rust
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

The Node toolchain at the repository root only guards the release scripts and
documentation:

```bash
npm ci
npm run typecheck
npm run check
npm test
```

## Local packaging without release credentials

You do not need the updater signing key to build a local package. cargo-packager
builds an unsigned, unnotarized artifact:

```bash
cd rust
cargo build -p omp-desktop --locked
cd crates/omp-desktop
cargo packager --formats app   # or deb / nsis
```

`--formats` must name the host's format: `app` is macOS-only, `deb` is
Linux-only, and `nsis` is Windows-only. Local packages are for testing; they are
not distribution builds. The release workflow adds the minisign signature with
`RUST_UPDATER_SIGNING_KEY`, and a release without it fails closed.

To verify a package actually boots, run it with the packaged-smoke marker:

```bash
"rust/dist/OMP Desktop.app/Contents/MacOS/omp-desktop" \
  --packaged-smoke=/tmp/smoke.json --user-data-dir=/tmp/omp-rust
cat /tmp/smoke.json
```

The marker is written only after the first real frame is drawn, so it proves the
window rendered.
