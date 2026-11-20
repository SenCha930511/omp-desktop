# UI interaction design

## Problem

The Rust workspace has Electron-level visual tokens but misses motion preferences and live-turn feedback. Keyboard commands, transcript search, and compact overlays also need a shared interaction model. `Workspace` owns the runtime, GPUI entities, and persisted settings. Moving those responsibilities into a new store would duplicate active behavior.

The design must respect the report's intentional UI changes. It must also preserve the existing i18n and geometry work.

## Usage from Workspace

Construction and `update_setting` call `interaction::apply_reduce_motion`. The helper maps the persisted Boolean to `ReduceMotionPreference::Reduce` or `ReduceMotionPreference::System`. It does not create another setting that could drift from `AppSettings`.

Transcript rendering derives `StreamFeedback` from `running` and `streaming_index`. `Idle` covers every non-running state. `AwaitingFirstDelta` and `Receiving` display the same localized activity cue in this first slice. A repeating pulse remains visible at delta zero, which is the static value GPUI uses under Reduced Motion.

Later keyboard work will parse a small `WorkspaceCommand` enum at the root key listener. Transcript search will use `Option<TranscriptSearch>`. The input entity will own the query. Matching will read the live transcript instead of maintaining a copied result cache.

## Shape

`rust/crates/omp-desktop/src/interaction.rs` is private to `app.rs`. It owns motion specifications, preference mapping, keyboard matching, search matching, and cyclic cursor calculations. `Workspace` retains state mutation, focus, rendering, and runtime calls. `docs/ui-parity-decisions.tsv` records the evidence for each implementation unit.

GPUI's `AnimationExt` already honors `App::reduce_motion`. One-shot animations render at delta one. Repeating animations render at delta zero and schedule no animation frames. No wrapper should reproduce this behavior.

The escape handler will retain the current independent overlay fields and dismiss one layer at a time in priority order. The handler will consult `CompositionGuard` before translating Enter or Escape. Browser visibility will continue to exclude native webviews from covered overlays.

Search scrolling needs a separate layout check. The current scroll element wraps all transcript rows in one child, so a direct `scroll_to_item(message_index)` call is not an accepted design by itself.

## Synthesis decision

Candidate B is the base. It preserves existing ownership and adds a small policy module. Candidate A supplied three changes.

- Its corrected System test policy accounts for GPUI's test scheduler having no OS motion reading.
- Its IME rule protects composition Enter and Escape.
- Its browser-suppression assertion protects native webview behavior during search and dismissal.

The independent judge scored Candidate A 24/30 and Candidate B 27/30. It rejected A's claim that raw GPUI animations need another Reduced Motion gate. The pinned `gpui-fast 0.1.17` source disproves that claim.

A full transient-surface reducer is deferred. Introduce it only when exit phases, reversible transitions, or focus ownership make independent flags inconsistent. Do not migrate seven overlay fields in advance of that requirement.

## Tradeoffs accepted

- One extra private module holds shared policy instead of adding more fields to `app.rs`.
- Search will cover loaded transcript rows only. Session-wide search needs a separate core query contract.
- The streaming cue is an overlay, so its appearance does not change transcript scroll height.
- System mode preserves the last motion value until an OS reading is available. Tests must not claim that disabling the app override forces `cx.reduce_motion()` to false.
- Existing independent overlay booleans remain for now. One dismissal method defines Escape ordering.

## Alternatives considered

A full `TransientSurface` enum gives stronger compile-time exclusion but requires an atomic rewrite of unrelated opening, rendering, and snapshot paths. Its extra reducer and effects do not improve the motion slice.

A general `MotionPolicy` wrapper returning `AnyElement` duplicates GPUI's existing Reduced Motion support and erases concrete element types. Named animation specifications are smaller and preserve the current render path.

A single enum for every overlay cannot represent a close prompt above another surface or a Details pane with a child popover. These combinations remain explicit in the dismissal policy.

## Open questions and risks

- Real-OS IME composition still needs native verification on macOS, Windows, and Linux.
- Whole-row search highlighting does not prove text-range highlighting. Text ranges require a later model that includes part and range identifiers.
- Session-wide search, exit animations, and reversible transitions are outside the initial units.
- A cue with `running == false` is always idle, even if a late delta recreates a row cursor.

## Next implementation units

1. Apply Reduced Motion and add live streaming feedback with real turn fixtures.
2. Port role-specific entrances, easing, attachment entrances, modal movement, and synchronized pulse durations.
3. Add the keyboard command layer and idempotent dismissal with IME coverage.
4. Add transient transcript search with validated scroll behavior.
5. Complete small-window sidebar and right-pane overlay behavior.
6. Complete the turn-only ChangesCard, right-pane content, and session-menu safety actions.
7. Finish remaining report gaps by domain and rerun the full native and CI verification matrix.
