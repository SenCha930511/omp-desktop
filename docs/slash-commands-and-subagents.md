# Slash commands and subagents

Type `/` in the composer, or choose **Commands** from the **+** menu, to search OMP commands. The initial list is replaced
with the running CLI's `available_commands_update` catalog, including installed
extension, skill, custom and file commands. Aliases and declared subcommands
are searchable; select one, supply its arguments, then send it.

The desktop menu keeps conversation/model/context commands and custom
commands. Builtin CLI setup, plugin administration, exports and session
navigation are omitted because those belong to desktop controls or the CLI.
Builtin command descriptions and all new interface labels follow the selected
English, Traditional Chinese or Simplified Chinese locale. Custom descriptions,
model output and CLI-provided argument hints remain in their original language.

Commands run through OMP's native `prompt` dispatcher, so text results such as
`/context`, `/tools`, `/effort high` and `/modelpreset list` appear in a closable,
scrollable result panel immediately above the composer. These text outputs are
not added as system-error messages in the conversation. Switching workspaces
clears the visible result. Commands submitted during an active turn wait for that turn to
finish, including when the composer uses the immediate-send shortcut. Images
are rejected for commands; automatic page/terminal context is kept out of their
arguments. Ordinary `/compact [instructions]` retains the desktop's existing
compaction flow; explicit `soft`, `remote` and `snapcompact` modes use OMP's
native slash dispatcher. MCP authentication retains the desktop's existing
external-CLI policy.

The GUI omits terminal-only controls: `/theme`, `/settings`, `/config`, `/hotkeys`, `/help`, `/tree`,
`/resume`, `/new`, `/clear`, `/fork`, `/login`, `/logout`, `/quit` (`/q`),
`/exit`, `/delete`, `/live`, `/record`, and `/pause`. These commands are
rejected locally instead of being mistaken for model prompts. `/todo edit`
and `/advisor configure` also require the terminal's editor/selector. Use
desktop settings, session and authentication controls where available.
OMP's native RPC catalog excludes TUI-only commands; new CLI versions or
extensions can expose different capabilities.

Other deferred dashboards/selectors are `/setup` (`/providers`), `/extensions`
(`/status`), `/agents`, `/git`, `/hub`, and `/branch` (`/rewind`). Modes
`/plan`, `/plan-review`, `/vibe`, `/goal`, `/guided-goal`, `/loop`, and `/queue`
are also deferred because their handlers depend on the TUI runtime, rather
than a native text-mode command handler. The desktop composer already offers
queueing without `/queue`. These limits are distinct from the many native RPC
commands now exposed in the composer.

Open **Subagents** above the conversation and select an agent to inspect its
status, task, tool/request/token counts, elapsed time, current activity,
thinking blocks, response and tool calls. The Codex-inspired interface switches
between the conversation and a full agent reading pane using the top tabs;
**Conversation** restores the conversation and its composer. The agent overview
stays fixed while messages scroll; task statistics and assignments live in
**Task details**, and parent instructions start collapsed. Main and child agents
share the same message, activity and tool-output components. The separate TUI help page and project
run button are not shown.
Lifecycle and message snapshots stream from the parent runtime. Selecting an
agent also reads its registered transcript incrementally, recovering messages
that preceded selection; closing the panel stops those reads. Completed agents
remain visible for the lifetime of the attached runtime. This view does not
launch agents or make extra model calls.

Thinking is available only when supplied by the model. Reopened parent
sessions do not reconstruct completed agents from previous runtime processes:
OMP's registry snapshot lists currently active agents. Unsupported older CLI
versions show the RPC error in the panel without preventing a session from
starting. Message history is bounded to the latest 400 messages per agent and
the latest 256 agents per runtime.

Protocol reference: [OMP RPC](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md).

Reasoning models offer **Auto** in the effort selector. This sends OMP's native
`auto` selector and retains it separately from the concrete per-turn effort
reported by `get_state`. Persisted `thinking_level_change.configured` entries
restore the auto selection when reopening a conversation.

Each turn has one activity disclosure with elapsed time and tool count. Opening
it reveals thinking and tool summaries in order, without a second thinking
disclosure. Tool arguments and output remain individually expandable.
**Settings → Agent → Expand thinking by default** controls the activity's initial
state in both conversation and subagent views. Each activity can be toggled manually.

**Settings → General → Conversation density** switches between Comfortable and
Compact text, row heights and spacing. Both locales and density preferences
persist across restarts. The conversation reserves the measured height of the
composer, queued messages and command output. Scrolling upward pauses automatic
following; expanding activity preserves the reader's position. The latest-message
button resumes following. Command selection and keyboard shortcuts respect CJK
composition, including legacy key code 229.

The sidebar's trash action replaces archiving. It opens a localized confirmation
dialog; confirmation stops the session's desktop runtime, permanently removes
the authorized conversation JSONL file, clears its sidebar/attention entry,
and closes its browser and terminals. Project files are kept. Existing archived
records retain their legacy API compatibility; new sidebar actions delete.
