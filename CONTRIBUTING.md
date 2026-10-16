# Contributing

See the [source setup](README.md#run-from-source) and
[validation guide](docs/validation.md) for the supported toolchain and checks.

## Local macOS development without release credentials

You do not need access to the signing and notarization credentials for the
production `app.ompdesktop.desktop` bundle. Use `npm run dev` while developing and
run the relevant checks from the validation guide before submitting a change.

To exercise the normal local packaging pipeline without release credentials,
run:

```bash
npm run package:mac:local-qa
```

This creates unsigned, unnotarized local-QA artifacts. It does not establish
that a build is ready for public distribution; `npm run package:mac` is reserved
for maintainers with the release credentials.

As an optional development convenience, use a separate app identity and
Electron data directory when keeping a local package alongside OMP Desktop:

```bash
npm run build
npx electron-builder --mac dir --arm64 --publish never \
  --config.mac.identity=null \
  --config.mac.notarize=false \
  --config.productName="OMP Desktop Dev" \
  --config.appId=app.ompdesktop.desktop.localdev \
  --config.extraMetadata.name=omp-desktop-local-dev \
  --config.directories.output=release/local-dev
```

Use `--x64` instead of `--arm64` on an Intel Mac. The `extraMetadata.name`
override isolates Electron state under
`~/Library/Application Support/omp-desktop-local-dev`; changing only the product
name or bundle ID does not isolate it. These values are local examples and must
not replace the production package metadata.
