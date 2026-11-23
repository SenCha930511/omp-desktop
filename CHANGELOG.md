# Changelog

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
