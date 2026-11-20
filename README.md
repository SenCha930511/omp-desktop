# OMP Desktop

OMP Desktop is a native desktop workspace for [OMP](https://github.com/can1357/oh-my-pi) ([omp.sh](https://omp.sh)). It gives the coding agent a friendly native interface on macOS, Linux, and Windows while leaving the harness in charge of its own models, logins, and saved sessions.

The shipping application is a Rust workspace (GPUI + `gpui-kit`) in [`rust/`](rust/README.md). The repository contains no JavaScript desktop application, no web view for the app UI, and no bundled front-end assets.

> **Origin:** this project is a fork of [GooeyPi](https://github.com/am-will/gooey-pi) by [am-will](https://github.com/am-will), forked at v1.1.17 and reworked into an OMP-only desktop workspace. See [Attribution](#attribution) and [LICENSE](LICENSE) for the upstream notice.

## Attribution

OMP Desktop is a derivative of [GooeyPi](https://github.com/am-will/gooey-pi) by [am-will](https://github.com/am-will) and its contributors, forked at GooeyPi 1.1.17 and reworked into an OMP-only desktop workspace. The upstream project is licensed under the MIT License, and its notice is preserved in [LICENSE](LICENSE) alongside this fork's. OMP itself is [oh-my-pi](https://github.com/can1357/oh-my-pi) by can1357. The v2 rewrite to Rust replaced the original Electron/React shell; the product behavior was carried over and is described below.

## What you can do

### Work with agents

- Stream conversations with Markdown, reasoning summaries, tool activity, retries, and context compaction. Thinking sections can start expanded for every session (**Settings → Harness**), and each one still folds on demand.
- Fenced code blocks carry a language header with a one-click copy button, and long prompts collapse to a readable preview that expands in place.
- Search loaded conversation history with ⌘F / Ctrl+F, including reasoning and tool arguments. Search temporarily reveals matching collapsed content; closing it restores the disclosures.
- Retry a failed turn through OMP's native `/retry`, restore its prompt beside an existing draft, or copy the error.
- Pin the subagent roster, filter by activity, and see unread updates without losing each agent's reading position.
- Revisit the latest five command results in the current workspace, including after closing the output panel.
- Choose a model or a saved model preset, a reasoning level, and Fast mode when the selected model supports it.
- Queue a follow-up or steer an agent while it is working.
- Ask a side question from the dock beside a live session — it rides OMP's `/btw` protocol without derailing the main thread.
- See the active approval mode at a glance next to the composer.
- Paste or drop PNG, JPEG, GIF, and WebP images into a prompt when the model supports vision.
- Type in Chinese, Japanese, or Korean without Enter or Escape leaking through mid-composition.
- Resume, rename, search, archive, or permanently delete persistent sessions.
- See running, finished, failed, and waiting-for-input work in one Activity view, then clear items you have handled. Work that finishes in the background can raise a notification.

### Keep projects organized

- Add local folders and reopen sessions grouped by project.
- Search projects, chats, and branches from the sidebar.
- Switch between linked Git worktrees from the composer.
- Create a branch worktree and open it as a new workspace.
- Delete a project in one confirmation: its saved OMP sessions are permanently removed from disk with it, while the workspace folder itself is kept.
- Mention another top-level session with `@session`, copy its UUID, or let agents create and message model-selected sessions for parallel work.

### Use the built-in coding workspace

- Review Git status and split-pane diffs, stage or unstage files, restore changes with confirmation, and commit without leaving the app. After each reply, the changes card lists only the files that turn edited — never older dirty state.
- Browse project files and reveal them in your system file manager.
- Open a terminal panel for a session and attach highlighted output to the next prompt.
- Open the right-hand Summary, Changes, Browser, or Files panel whenever you need it.

### Browse with shared context

- Use an isolated in-app browser with an address bar, navigation history, and an external-browser handoff.
- Point at page elements and add notes. OMP Desktop attaches those annotations to your next message.
- Enable browser control so an agent can open and operate its own tabs.

### Automate repeat work

- Create one-time or recurring schedules.
- Pick the project or existing session, model, reasoning level, timezone, and Fast mode.
- Run a schedule immediately, pause or resume it, and inspect the result and run history.
- On macOS, opt in under **Settings → General** to keep scheduled work running from the menu bar after closing the window, and optionally launch OMP Desktop in the background at login. The packaged app also accepts `--background` to start without opening its window.

### Add capabilities

The Capabilities page brings together packages, plugins, extensions, skills, prompts, and MCP servers. OMP Desktop can manage local stdio MCP definitions for OMP. Network MCP and authentication stay under the harness's direct control; those entries are visible but read-only in OMP Desktop.

OMP Desktop also ships optional capabilities for:

- Let an agent ask you a small set of questions in a native dialog.
- Give agents controlled access to the in-app browser.
- Use TryCUA computer control when the separate CUA Driver is installed.

Ask User and computer control are off by default. You can enable, disable, or remove capabilities from the app.

### Talk instead of type

- Dictate prompts with OpenAI, Groq, Deepgram, or a local `whisper.cpp` installation.

### Make it comfortable

- Choose a light, dark, or system theme and adjust the interface text size.
- Use the app in English, 繁體中文, or 简体中文 — pick a language or follow the system (**Settings → Appearance**).
- Reduce motion, resize the sidebar and workspace panels, or let them become overlays in a narrow window.
- Use keyboard navigation and the command palette for common actions.

## Get started

1. Install [OMP](https://github.com/can1357/oh-my-pi).
2. Sign in or configure a model provider through the omp CLI.
3. Download OMP Desktop from [GitHub Releases](https://github.com/SenCha930511/omp-desktop/releases), or build it from source.
4. Add a project folder and start a session.

OMP Desktop checks common install locations automatically. If the harness is missing, open **Settings → Harness** to refresh detection or choose its executable.

GitHub Releases ships signed packages: a macOS `.app` archive for Apple Silicon and Intel, a Linux AppImage, and a Windows NSIS installer, plus `updates.json` for the in-app updater. Each release page also lists `SHA256SUMS.txt` covering every asset.

Release artifacts carry the updater's minisign signature but no operating-system code signature or notarization, so the first launch needs one extra step:

- **macOS**: right-click the app in `/Applications` and choose **Open** (or clear it once in **System Settings → Privacy & Security**) to pass Gatekeeper.
- **Windows**: SmartScreen shows "Windows protected your PC" — choose **More info → Run anyway**.
- **Linux**: package installs work as usual; no signature prompts.

Harness provider credentials stay with the harness. Optional voice keys are encrypted with the operating system's secure storage, and local `whisper.cpp` dictation needs no API key.

Upgrading from GooeyPi? OMP Desktop migrates your projects, schedules, settings, voice keys, and agent-message signing key from the old application data directory on first run.

## Build from source

You need the pinned Rust toolchain (`rust-toolchain.toml`) and the platform GUI
dependencies listed in [`rust/README.md`](rust/README.md). The whole application
is built and tested from the Rust workspace:

```bash
cd rust
cargo build -p omp-desktop --locked
cargo run -p omp-desktop
```

Packaging (cargo-packager) and the packaged smoke marker are documented in the
[Rust workspace README](rust/README.md).

The Node toolchain at the repository root exists only for the release scripts,
the conformance harness, and the documentation guards. You will need Node.js 24.15.0 or newer and npm 12.0.2 or newer. The repository pins Node.js 24.15.0 in `.nvmrc`; with [nvm](https://github.com/nvm-sh/nvm), you can select it with:

```bash
nvm install && nvm use
npm run toolchain:bootstrap
```

The bootstrap command verifies the exact size and SHA-512 of the checked-in npm archive, then installs it offline with install-time lifecycle scripts disabled into the invoked npm's configured global prefix, verifies the installed CLI and both tool versions against `package.json` and `.nvmrc`, and makes its shim available to subsequent GitHub Actions steps before dependencies are installed.

```bash
npm ci
npm test
```

## Keyboard shortcuts

Use `⌘` on macOS and `Ctrl` on Linux or Windows.

| Shortcut | Action |
|---|---|
| `⌘/Ctrl+N` | New session |
| `⌘/Ctrl+K` | Command palette |
| `⌘/Ctrl+B` | Toggle the project sidebar |
| `⌘/Ctrl+Shift+B` | Open the browser |
| `⌘/Ctrl+J` | Toggle the terminal |
| `⌘/Ctrl+,` | Open Settings |
| `Enter` | Queue a message while the agent is working |
| `⌘/Ctrl+Enter` | Steer the current turn while the agent is working |
| `Shift+Enter` | Add a new line |
| `Esc` | Close the active menu, dialog, or overlay |

The Queue and Steer shortcuts can be swapped in **Settings → Harness → Message shortcuts**.

## Local data and safety

OMP Desktop is built around local projects and local harness sessions. It does not rewrite session history or take ownership of OMP credentials.

Deleting a conversation or a project is permanent on the harness side: the session files are removed from OMP's own session directory. Workspace folders and their contents are never touched by deletion.

Project paths and desktop actions are checked in the native application, and third-party capabilities still run with your operating-system permissions. Review packages, commands, MCP servers, and projects before allowing them to act.

For suspected vulnerabilities, follow the [security policy](.github/SECURITY.md) and do not post sensitive details publicly. See [docs/security.md](docs/security.md) for the full technical security model.

## Development checks

```bash
cd rust
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

For the Node tooling (release scripts and documentation guards):

```bash
npm ci
npm run typecheck
npm run check
npm test
```

See the [validation guide](docs/validation.md) for the source-of-truth checks and the CI/release job contract.

## License

OMP Desktop is released under the permissive [MIT License](LICENSE). See the [license text](LICENSE) for details.
