# omp-jsonl-core

The Rust/WASM cold-scan core for OMP session metadata. It parses the bucketed JSONL tail, mirrors the fields of `BucketedMetadataAccumulator`, and returns one JSON result. TypeScript still owns the snapshot rules, IPC, and fallback.

## Build

The crate targets `wasm32-unknown-unknown` and uses `serde_json` and `chrono`. It does not use `wasm-bindgen`.

```sh
rustup target add wasm32-unknown-unknown
npm run wasm:build
```

`npm run wasm:build` builds the release artifact and copies it to `assets/wasm/omp-jsonl-core.wasm`. `npm run build:bundle` copies that file to `out/main/omp-jsonl-core.wasm`, and the packaged ASAR layout requires it.

## ABI

The module exports raw functions over linear memory:

- `alloc(length) -> pointer`
- `dealloc(pointer, length)`
- `scan(bytes, length, id, idLength, created, createdLength, updated, updatedLength, titleSlotLength) -> resultLength`
- `result_ptr() -> pointer`
- `result_len() -> length`
- `clear_result()`

`scan` returns `{"status":"ok","accumulator":...}`, `{"status":"fallback","reason":...}`, or `{"status":"error","reason":...}`. The caller must copy the result before `clear_result()` and free every input allocation.

`titleSlotLength` is `256` for an OMP session file. The core parses the title slot first and lets it override later `title_change` records, matching `readOmpTitleSlot`. Pass `0` to scan only the tail.

## Limits

- The integration fast path handles files up to 4 MiB. Larger sessions use the streaming TypeScript reader.
- Timestamps must be finite epoch milliseconds or RFC3339 strings. Anything else returns `fallback`, and the TypeScript reader handles the file.
- UTF-16 truncation that would split a surrogate pair returns `fallback`.
- More than 200,000 records or a record over 64 MiB returns `error`, matching the TypeScript limits.

## Verification

```sh
npm run wasm:verify
```

The command builds 1,000 synthetic OMP session files, compares the WASM reader with the TypeScript reader, and times both. The recorded-call script compares the same readers on real local OMP sessions:

```sh
node scripts/performance/omp-wasm-equivalence.mjs
```

Set `OMP_WASM_ALL_JSONL=1` to include every local JSONL file instead of only OMP session names. `OMP_DESKTOP_DISABLE_WASM=1` forces the TypeScript path at runtime.
