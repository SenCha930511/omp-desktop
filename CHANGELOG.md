# Changelog

## 1.3.21 — 2026-11-24

### Added

- Startup prewarm for the selected durable OMP session, using the interactive launch path without creating a session, sending a prompt, or generating model output.
- A Rust/WASM OMP metadata scanner with a TypeScript fallback, packaged WASM verification, and large-session streaming reads.
- CPU, memory, transcript, catalog, math, and bundle-size improvements across startup, project scans, search, and rendering.

### Changed

- The workspace becomes usable before the prewarm handshake finishes, and concurrent starts for the same session converge on one ready runtime.
- Provider and composer alignment preserves restored model, effort, and fast choices while the runtime becomes ready.
- Oversized PNG, JPEG, and WebP prompt attachments are fitted to the RPC frame before sending; the main-process frame guard remains the final boundary.

### Fixed

- Large images no longer fail with `command is too large for the RPC transport`.
- Concurrent and deferred session starts no longer leak duplicate children, attach pre-handshake runtimes to renderer discovery, or lose host-tool registration after an unavailable acknowledgement.
- WASM scanner cleanup, catalog array comparison, syntax highlighting budgets, and transcript insertion paths were hardened.

**Full Changelog**: https://github.com/SenCha930511/omp-desktop/compare/v1.3.20...v1.3.21

## 1.3.20 — 2026-11-23

### Added

- Native word prediction in the composer: ghost text, request/response fencing, cursor and session validation, feedback handling, and native fixture e2e coverage.
- Paginated transcript history with bounded session reads, scroll restoration, and localized loading states.
- Trusted `desktop_open_url` host authorization with owner-bound IPC, a review prompt, cancellation, and fail-closed runtime registration.
- Inspector file previews for text, code, images, PDF, and HTML files, plus local workspace images and inline `data:image/*` images in model output. HEIC and TIFF images are decoded before preview.
- Browser-style inspector tabs with multiple browser tabs, PDF/HTML preview, and keyboard navigation across browser and file tabs.
- Backslash LaTeX delimiters (`\(...\)` and `\[...\]`) in model output.
- A WebRTC audio-session abstraction for desktop dictation with cancellation, timeout, channel-error, reconnect, and teardown coverage.
- An OMP v19 desktop parity support matrix documenting verified, partial, upstream-only, and security-blocked surfaces.

### Changed

- Busy slash commands now dispatch directly instead of being queued behind the active turn.
- Toolbar, HUD, transcript, and skill-icon layout alignment was tightened.
- The capability bridge uses `Promise.withResolvers`, and inspector layout behavior is covered by rerender tests.
- The optional sessions bridge is guarded so older preload surfaces remain usable.

### Fixed

- The native file dialog is awaited before preview loading continues.
- Memo and read lifecycle invariants are preserved while guarding optional bridge methods.
- Word-prediction tests isolate `localStorage` and verify debounce-timer cleanup.
- Sandboxed preload bridge groups match the current e2e smoke contract.
- Host Open URL prompt tests no longer carry an unused parameter.

### Not included in this release

Interactive OMP live voice controls and real microphone/speaker audio verification remain outside this release. Desktop dictation cleanup is included. `omp ps`, session portability commands, `omp stats`, and terminal-only `/record` and `/pause` remain upstream-only.

**Full Changelog**: https://github.com/SenCha930511/omp-desktop/compare/v1.3.19...v1.3.20

## 1.3.19 — 2026-11-23

### Added

- OMP v19 parity work: native extension forms with bounded model selection, interactive form dialogs, native execution details, and session-command alignment.
- Scoped native slow controls and cached approval mode for newly started runtimes.
- A native word-prediction command lane with request/response validation, UTF-16 cursor checks, feedback handling, and runtime/session fencing. This release includes the protocol lane; the prediction UI is not included.
- Scheduled-task labels in English, Traditional Chinese, and Simplified Chinese.
- A side-chat disclaimer below the composer.

### Changed

- Fast mode now reflects the authoritative enabled/active state returned by the harness, refreshes after toggling, and ignores stale queued responses.
- Windows process and session launch semantics, plugin/session identity normalization, and state durability were tightened.
- Locale catalogs load as a synchronous chunk, and visible app text refreshes when the locale changes.
- Composer shortcuts now align with native session commands.
- Packaging keeps source text as LF across platforms and installs the Linux packaging dependency explicitly.

### Fixed

- Windows process/session launch behavior, plugin discovery, and reveal authorization.
- Complete oversized RPC frames are rejected before decoding.
- Cached approval settings are accepted by the existing validator.
- Content-hash cache keys use nanosecond file metadata.
- Diff, image, and subagent-status controls are localized.
- Activity and workbench labels are aligned with native status display.
- Windows native npm installation and packaging time budgets are covered by tests.

### Not included in this release

The in-progress prediction UI, paginated history UI, host Open URL approval flow, and live voice/WebRTC integration remain outside this release because they have not completed native and end-to-end verification.

**Full Changelog**: https://github.com/SenCha930511/omp-desktop/compare/v1.3.18...v1.3.19
