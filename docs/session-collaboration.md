# Session collaboration

OMP Desktop lets top-level sessions in the same working directory coordinate
without turning them into parent/child subagents. This document describes the
layer the Rust application implements today: signed peer envelopes and bounded
peer reads in `rust/crates/omp-core/src/collaboration.rs`.

## Signed peer envelopes

Incoming peer prompts travel as an app-local, HMAC-signed envelope so ordinary
prompt text cannot impersonate another session:

```
===== BEGIN GOOEYPI AGENT MESSAGE =====
{"version":3,"from_session_id":"…","reply_with":"gooeypi_session_send","nonce":"…","sent_at":"…","signature":"…"}
===== END GOOEYPI AGENT MESSAGE =====

<the actual message>
```

- The signing key (`agent-message-signing.key`) is a 32-byte regular file in the
  app's user-data directory, created with `create_new` and mode `0600` on POSIX.
  A symlink, a directory, or a wrong-length file is rejected; the key is never
  exposed to a harness runtime.
- Verification is constant-time (`subtle`) and happens before the transcript may
  render a user record with agent-message styling.
- Version 3 envelopes expose only the sender UUID, a `gooeypi_session_send`
  reply hint, envelope-authenticity fields, and the message itself. They never
  include the sender title, harness, opening prompt, or transcript context.
  Saved version-1 and version-2 envelopes (which carried a sender title and
  harness) remain readable for transcript compatibility but are never newly
  produced.
- The marker and field names (`GOOEYPI` framing, `gooeypi_session_send`) are
  deliberate pre-rebrand compatibility contracts and keep their names.

## Peer discovery and reads

`peer_sessions` lists candidate peers from the same canonical working directory
with their UUIDs, titles, and liveness. `peer_messages` returns a bounded recent
conversational snapshot and cursor for one peer: user, assistant, agent, and
thinking text are retained, while tool calls, tool results, and compaction
internals are omitted. Transcripts stay read-only.

## Tool surface

The `gooeypi_session_list`, `gooeypi_session_models`, `gooeypi_session_create`,
`gooeypi_session_read`, `gooeypi_session_send`, and `gooeypi_session_wait` tool
names are reserved compatibility contracts: agent-facing tools must keep these
names if they are provided. The Rust build does not inject JavaScript extension
files into OMP runtimes, so those tools are not installed by this application
today; the envelope and peer-read layer above is what ships.

## Upstream research

No single runtime provides the top-level-session API this feature needs:

| Runtime | Existing collaboration | Missing piece |
|---|---|---|
| Codex Desktop | Addressable tasks, background sends, bounded reads, and cursor-based waits; titles resolve to stable task IDs. | This is the product behavior OMP Desktop mirrors, not a harness API it can call. |
| Prime Agent 0.7.2 | Daemon `send_message` accepts a UUID/name and can wake a saved session. Agent-origin messaging and observation are family-scoped, and observation does not uniformly cover top-level workers. | No uniform cross-worker read/wait contract. (Historical row: Prime Agent support was removed from the app.) |
| OMP 17.2.15 | Task subagents can follow up/await inside one parent run; `/collab` and `omp join` provide a live shared relay room. | No arbitrary saved top-level session UUID/name read/send/wait RPC. |
| pi 0.84.1 | Current-session RPC, `switch_session`, and illustrative subprocess subagent/handoff extensions. | `switch_session` replaces the caller's runtime; there is no durable peer mailbox or arbitrary target API. (Historical row: pi support was removed from the app.) |

## Safety boundaries

- Targets are exact session UUIDs resolved through the session catalog; titles
  are display-only.
- Peers must be different, non-archived top-level sessions in the same canonical
  working directory. A multi-folder workspace does not widen that scope.
- Reads are bounded and never mutate the peer's transcript. Anything that would
  start or wake a runtime must go through the normal path, which revalidates the
  project grant and the canonical session path.
