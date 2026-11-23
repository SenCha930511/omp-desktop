# OMP 19 Desktop Parity Support Matrix

Reference runtime probed on macOS: `omp/19.1.1` (`/opt/homebrew/bin/omp`).  
Reference upstream RPC specification: `set_host_tools`, `host_tool_*`, `predict_word`, `predict_word_feedback`, `live_connect` / `live_start`, `dictation_start` / `dictation_stop` (see [docs/live-voice-parity.md](./live-voice-parity.md)).

## 1. Verified and Integrated

| Feature | Implementation Surface | Verification Scope |
|---|---|---|
| Native word prediction (`predict_word`, `predict_word_feedback`) | `NativeWordPredictionLane`, `useWordPrediction`, `ComposerGhostText` | Unit tests, frontend hook/component tests, and native fixture e2e (`word-prediction-native.spec.ts`) |
| Bounded session history pagination | `SessionService.readPage`, `sessions:readPage`, `src/lib/session-pagination.ts`, `Transcript.tsx` | Backend pagination tests, frontend reducer/scroll-anchor tests |
| Trusted `desktop_open_url` host tool | `DesktopOpenUrlService`, `AgentRpcManager`, `hostAuth` owner-bound IPC, `HostOpenUrlPrompt` | Service unit tests, RPC integration tests with fake child process, IPC contract/security tests, modal component tests (no OS browser launched in tests) |
| Model output LaTeX math rendering | `normalizeLatexDelimiters` in `src/lib/markdown-math.ts`, `MarkdownText.tsx`, bundled KaTeX fonts (`.ttf`) | Frontend math rendering tests covering `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, CJK, and fenced code exclusions |
| Model output inline & local workspace images | `MarkdownText.tsx` (`markdownUrlTransform`, `MarkdownImage`), `MarkdownWorkspaceProvider`, `Transcript.tsx` | Frontend tests for inline `data:image/*` URIs, authorized project image loading via `files:read`, and blocked remote `http(s)://` images |
| Right-side Inspector file preview panel | `FilePreviewService`, `files:read` / `files:pick`, `FilePreviewPanel`, `WorkspaceInspector` `'preview'` tab | Backend path-containment/allowlist tests and frontend Markdown/code/image/PDF preview tests |
| Composer slash-menu skill icon alignment | `src/styles/composer.css`, `src/components/Composer.tsx` | Frontend slash-menu layout test and CSS regression check |
| WebRTC dictation session lifecycle & cleanup | `WebRtcAudioSession`, `src/hooks/useDictation.ts` | Fake WebRTC/AudioContext unit and hook tests covering cancellation, timeout, channel errors, and reconnect |

## 2. Partially Integrated or Hardware-Dependent

- **OMP Live Voice (`live_*`)**: `OMP_RPC_ADAPTER.normalizeEvent` validates and forwards `live_phase`, `live_levels`, `live_transcript`, and `live_end`, while interactive `live_start` / `live_connect` UI controls remain deferred (see [docs/live-voice-parity.md](./live-voice-parity.md)). Real microphone/speaker hardware audio loops are not verified by automated tests.
- **Desktop Dictation (`useDictation`)**: Desktop-owned speech-to-text for composer text entry using OS/provider credentials in `VoiceService`; this is intentionally separate from OMP's `/live` and CLI `dictation_start` / `dictation_stop` sub-protocols.

## 3. Upstream-Only (Not Exposed or Faked in GUI)

Probed from `omp --version`, `omp ps --help`, `omp session --help`, and `omp stats --help` on `omp/19.1.1`:

- **`/record` and `/pause`**: Terminal-only capture (`omp play` / `omp clip`) and full-screen TUI agent freeze overlay with no interactive GUI equivalent or RPC command surface.
- **`omp ps`**: Daemon-supervised background process controller CLI (`list`, `info`, `logs`, `stop`, `kill`, `restart`, `send`, `mode`).
- **`omp session` portability commands**: `pack`, `unpack`, `moved`, and `lease` CLI workflows remain CLI-only.
- **`omp stats`**: Local dashboard web server CLI (`-p/--port`, `--host`, `-j/--json`, `-s/--summary`).
- **Unverified CLI flags**: Flags not passed by `OMP_RPC_ADAPTER.buildStartArgs` (such as `--profile`, `--no-session`, `--add-dir`, `--config`) are not assumed or exposed.

## 4. Blocked by Desktop Security Policy

- **Arbitrary renderer-defined host tools**: Only main-process-owned `DESKTOP_OPEN_URL_TOOL` is registered on interactive owner runtimes via `set_host_tools`; renderers cannot register custom host tools and unattended scheduled children (`startUnattended`) never expose `desktop_open_url`.
- **Unbounded local filesystem reads**: `files:read` rejects paths outside explicitly authorized project roots unless individually chosen through `files:pick` (capped FIFO allowlist).
- **Remote Markdown image auto-fetching**: `MarkdownImage` blocks `http://` and `https://` image URLs to prevent remote tracking/exfiltration.
- **Unchecked model / IPC routing**: All `set_model` / start model selections still enforce `requireAvailableModel()`, and every IPC handler/forwarder enforces trusted URL and owner/sender verification.
