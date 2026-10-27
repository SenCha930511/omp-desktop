# 語音 / live / record / pause 語意對照（階段 6.4）

對象版本：omp `v18.12.6`（checkout `45c35e4`，路徑皆為上游 repo 內相對路徑）。

## 名詞與上游證據

### Live voice（上游 `/live`，RPC `live_*` 命令與事件）

Codex realtime（GPT live）的**會話型語音模式，綁定當前 AgentSession**；對話可以把 coding work 委派給 session（用 session 的工具與 context 執行）。

- RPC 命令定義：`packages/coding-agent/src/modes/rpc/rpc-types.ts:76-78`
  — `live_start {voice?, instructions?}` / `live_stop` / `live_mute {muted?}`，區塊註解原文「Live voice (GPT live bound to this session)」。
- 成功回應：`live_start` → `data {voice}`、`live_mute` → `data {muted}`（rpc-types.ts RpcResponse「Live voice」段）。
- 事件幀：`live_phase` / `live_levels` / `live_transcript` / `live_end`
  — rpc-types.ts「Live Voice Frames」段標頭註解：「not session events, so `set_event_filter` never drops them」（保證送達，不被事件過濾器攔截）。
- phase 機：`"connecting" | "listening" | "working" | "speaking" | "muted" | "error"`
  — `packages/tui/src/apps/live-visualizer.ts:15`；產生在 `packages/coding-agent/src/live/controller.ts`（`#refreshAudioPhase` L459-472：muted 優先，其次 working（委派中）、speaking（output level 超閾）、兜底 listening；`#emitPhase` L474-…）。
- transcript payload：`{role: 'user'|'assistant', turn, text, final}`，`role+turn` 是合併鍵，`final` 標記該輪定稿
  — `controller.ts:28-34`（LiveTranscript，`turn` 註解「Monotonic role-local turn number used to coalesce streaming updates」）；RPC 轉發在 `rpc-live.ts` `onTranscript`。
- levels：麥克風／喇叭 RMS ∈ [0,1]，**最多每 100ms 一幀且只攜最新值**
  — `rpc-live.ts` `RPC_LIVE_LEVELS_INTERVAL_MS = 100` 與 `#queueLevels`/`#flushLevels`；上游型別註解「at most one frame per 100 ms carrying the latest values」。
- live_end：每個 live session **恰送一次**；`error` 攜失敗原因，正常結束時缺席
  — `rpc-live.ts` `onTerminal`（`terminated` 旗標保證 once）。
- mute：`live_mute` 的 `muted` 省略 = toggle；無活動 session 時回錯「No live session is active」
  — `rpc-live.ts` `setMuted`。
- **音訊 I/O 全部在 harness（omp）程序內**：
  - 麥克風：`AudioCapture(16_000, …)`（`controller.ts:4,186`，`packages/natives/native/index.d.ts:7-12`，mono PCM Float32）。
  - 傳輸＋播放：`LiveWebRtcPeer`（`index.d.ts:381-403`）— 原生 WebRTC peer，「accepts 16 kHz mono PCM and renders remote Opus audio」，`close()` 會一併關「speaker playback」。Signaling 走 Codex realtime HTTP（`transport.ts` `SIGNALING_URL`），sideband WebSocket 連線最多 5 次 × 15s 逾時（`SIDEBAND_CONNECT_ATTEMPTS/TIMEOUT_MS`）。
  - 結論：renderer **不需要也不應接觸音訊裝置**；這是 RPC 協定的設計（rpc-mode.ts L444-445 註解：`live_start` 在「connected and recording」時才回應，可以被 `live_stop` 取消）。
- TUI 入口：`/live`（`slash-commands/builtin-control.ts:59-66`，「Start Codex-backed realtime voice mode」→ `LiveCommandController`），介面為 LiveVisualizer（相位圖示＋mic level 顯示＋transcript，`live-visualizer.ts:162-200`）。
- voice 名冊：`live/voices.ts` `LIVE_VOICE_OPTIONS` 九個（arbor/breeze/cove/ember/juniper/maple/sol/spruce/vale），預設 `sol`；session 設定鍵 `live.voice`（`live/settings.ts`）。`live_start` 省略 voice 時依序取：參數 → session 設定 → 預設（`rpc-live.ts` `start`）。

### GUI 自有 dictation（**不等價**）

- 憑證與服務：`electron/main/voice.ts` — App 自管 OpenAI／Groq／Deepgram／自管 endpoint 的 API key（safeStorage），批次 WAV 上傳或 WebRTC 轉錄。
- 流程：`src/hooks/useDictation.ts` — 狀態機 `idle → connecting → recording → transcribing`，產出**文字填進 composer**；UI 是 Composer 的麥克風按鈕（`composer.dictation.*`）。
- 語意：**聽寫（STT 填詞）**。不綁 agent session、不能委派工作、不產生 `live_*` 事件、不需要 Codex 登入（用自己的語音服務憑證）。
- 上游 TUI 也另有 mic dictation（`interactive-mode.ts` MicCursor「transcribing」游標），與 `/live` 同樣是兩回事。**「語音」名稱相似並不代表功能等價。**

### `/record`（上游）＝ 錄製終端畫面，不是錄音

- `interactive-mode.ts:8332` `toggleRecording`：「Start a `/record` **screen capture**, or stop the running one…」；`SessionRecorder`（`stream/recording.ts`）把 TUI 渲染串流錄成可回放檔案（`builtin-control.ts:70-71`：「recording this screen to a replayable file (`omp play`)」；停止訊息「replay: omp play · share: omp clip」）。
- RPC：`RpcCommand` 中**沒有** record 命令 — 無協定面可接。
- 結論：**upstream-only**；對 GUI 價值低（GUI 不是文字終端），不接線，也不把它當語音功能。

### `/pause`（上游）＝ 全螢幕暫停畫面，凍結所有 agent

- `builtin-control.ts:78-86`：「/pause — Freeze all agents (main, subagents, advisor) until resumed」→ `runPauseScreen`（`packages/tui/src/overlays/pause-screen`）；`interactive-mode.ts:2421`（/pause 停掉 live-preview tick）。
- RPC：無 pause 命令。注意區分：`goal` 的 op `pause` 是 goal 生命週期控制（GUI 已有 goal schema）；`agent_messages_pause` 是已移除 Prime harness 的命令，列於 `OMP_UNSUPPORTED_COMMANDS`。
- 結論：**upstream-only**（TUI 專用 UI），無協定面可接。

## 對照表

| 功能 | 上游語意 | GUI 改造前現況 | 結論 |
|---|---|---|---|
| Live voice（`/live`） | Codex realtime 會話，綁 session；音訊 I/O 在 harness 程序內 | 無 | **equivalent（經 RPC 接線）**——本階段完成 |
| `live_start` / `live_stop` / `live_mute` | 見上；start 等到「連上且開始錄音」才回應 | 無 | equivalent — schema 白名單驗證＋10 分鐘客戶端逾時 |
| `live_phase` / `live_levels` / `live_transcript` / `live_end` | 非 session event，保證送達；levels ≤100ms/幀 | 無 | equivalent — adapter 白名單轉發，renderer hook 摺疊；levels 不進 transcript store |
| Dictation（聽寫） | 上游 TUI 另有獨立 mic dictation | GUI 自有 STT 填 composer（voice.ts / useDictation.ts） | **GUI-only，不得標為 live voice 等價**；本任務不改其行為，UI 與文件註明邊界 |
| `/record` | 錄製終端畫面成可回放檔（`omp play`） | 無 | **upstream-only**，無 RPC 面，不實作 |
| `/pause` | 全螢幕凍結所有 agent | 無 | **upstream-only**，無 RPC 面，不實作 |

## 本階段接線（檔案）

- `electron/main/agent-rpc/command-schema.ts`：`live_start`（voice 對齊上游名冊白名單、instructions ≤32K）、`live_stop`、`live_mute`（muted 可省略＝toggle）驗證分支（檔尾 throw 前）。
- `electron/main/agent-rpc/runtime.ts`：`live_start` 納入 10 分鐘客戶端逾時（上游 worst case 超過 60s 預設：signaling＋sideband 5×15s）。
- `electron/main/agent-rpc/harness-adapter.ts`：`live_*` 四種事件幀白名單驗證轉發；`live_levels` 不再聚合（上游已限流），renderer 以獨立 hook 訂閱。
- `src/hooks/useLiveVoice.ts` + `src/components/LiveVoicePanel.tsx`：start/stop/mute 控件、phase 指示、levels meter、`live_transcript` 顯示（role+turn 合併）、錯誤呈現。
- 採用路線：**事件＋控制完整接線**（不是 control-only，也不是 unsupported）——因為音訊難點（裝置、格式、延遲）全部在 harness 程序內解決，renderer 無需接觸音訊裝置。

## unsupported / degraded 清單

| 項目 | 狀態 | 原因 |
|---|---|---|
| `/record` 畫面錄製 | unsupported-with-state（不接） | 上游無 RPC 命令，需協定擴充；GUI 不偽造按鈕 |
| `/pause` 凍結畫面 | unsupported-with-state（不接） | 上游無 RPC 命令；TUI 專用 UI |
| Live voice 事前可用性探測 | degraded（無探測） | 上游無「是否支援/是否已登入 Codex」查詢；`live_start` 失敗時以伺服器錯誤訊息呈現（需 openai-codex 登入），不預先隱藏入口 |
| 麥克風權限歸屬 | degraded（平台行為） | 擷取在 omp 子程序；macOS TCC 歸屬負責程序（OMP Desktop），首次啟動會彈系統權限提示；喇叭播放不需權限 |
| `live_levels` 高頻幀 | by-design 不持久化 | 上游已限 100ms/幀；只進 useLiveVoice 的 React state，不進 transcript store，不觸發訊息列表重算 |
