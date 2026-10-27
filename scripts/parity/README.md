# OMP Parity Harness（階段 7.1/7.3）

以**真實 `omp` binary** 驅動兩種 surface——RPC mode（GUI 的實際路徑）與互動
TUI（終端的實際路徑）——對著本機確定性 fixture provider 跑相同操作序列，
比較正規化後的 session 工件。禁止截圖或渲染相似度；比較一律走語意投影。

## 重跑

```bash
node scripts/parity/run.mjs [--omp /opt/homebrew/bin/omp] [--keep]
```

- 每案例全新 mkdtemp HOME（`--session-dir`、models.yml、config.yml 全在裡面），
  雙側狀態等價但獨立，無共用檔案鎖。
- 輸出：stderr 每案例 PASS/FAIL＋diff 上下文；stdout JSON 摘要
  `{omp, cases:[{case,status,diffCount,surfaceNotes}], allPassed}`；exit 0
  僅當一致性案例 PASS **且** 差異自檢案例有抓到差異。
- `--keep` 保留暫存根目錄供偵錯（路徑會印在失敗訊息裡）。

實測輸出（omp 18.13.1，2026-10-27）：

```
PASS consistency-basic
PASS divergence-detector
   detected 5 real diff(s):
   - entry-count: rpc=8 tui=4
   - rpc-only-4: {"type":"message","role":"user","text":"beta parity"}
   - rpc-only-5: {"type":"message","role":"assistant","text":"fixture-ack[2]:beta parity",...}
   ...
{"allPassed": true}  EXIT=0
```

### 7.2 驗收群組案例（已落地）

|案例|群組|斷言|
|---|---|---|
|`session-fork`|Session|RPC `fork` vs TUI `/fork`：fork 後 active session 的對話投影相等|
|`compact-parity`|Compact|RPC `compact` vs TUI `/compact`：compaction entry 存在＋壓縮前後對話投影相等（門檻由種子 `keepRecentTokens: 200` 降低，小對話即可 compact）|
|`queue-abort-restore`|Queue|RPC `follow_up`＋`abort_and_restore_queue` vs TUI Enter 排隊＋Esc：佇列退還後重送的對話投影相等|

實測（omp 18.13.1）：五案例**連續兩輪**全 PASS、exit 0（`allPassed: true`；
queue 案例每輪如實輸出 1 筆 FINDING）。全程 ~270s/輪（compact 案例的
compaction 落盤輪詢為主要耗時）。

### 已證實的上游表面差異（findings）

- **abort 持久化**：TUI Esc 走 `session.abort()`（interactive-mode.ts），
  中止輪的 user 訊息與空 assistant 訊息會落盤；RPC
  `abort_and_restore_queue` 會回滾 in-flight 輪。上游自有行為，非 app
  缺陷；queue 案例以 finding 記錄（`FINDING:` 行＋JSON `findings` 欄位），
  核心斷言是佇列退還後重送的一致性。
- 表面 bookkeeping（`service_tier_change` vs `model_change`、system prompt
  digest）見 normalize.mjs 註記，列 `surfaceNotes` 不算 fail。

單獨驗證 fixture 本身（真 binary、print mode）：

```bash
node scripts/parity/smoke-fixture.mjs [--omp /opt/homebrew/bin/omp]
# 期待 stdout 含 fixture-ack[1]:hello fixture、exit 0
```


## 檔案

|檔案|職責|
|---|---|
|`fixture-provider.mjs`|OpenAI 相容確定性 provider（SSE/JSON、常數 id/created、`fixture-ack[N]:<text>` 回覆、剝除 `<system-reminder>`）|
|`temp-home.mjs`|隔離 HOME 建構：models.yml 指向 fixture（上游 `docs/models.md` L52 baseUrl 自訂）＋ config.yml `setupVersion: 2` 跳過首 run 精靈（上游 `CURRENT_SETUP_VERSION=2`）＋ `compaction.keepRecentTokens: 200`（上游預設 20000，降低 compact 案例門檻）|
|`rpc-driver.mjs`|繼承 `verify-omp-parity.mjs` 的 `OmpRpcClient`（framing/chunk/timeout 全同已驗證實作），加事件帳本；`waitForTurnEnd` 等 `message_end`|
|`tui-driver.mjs`|node-pty 驅動；等待條件式（渲染字串輪詢＋**session 檔落盤信號**判定輪收束）；`/exit`＋kill 階梯收尾|
|`normalize.mjs`|session `.jsonl` 與 `get_state` 的語意投影：保留 role/text/provider/model/模式設定/compaction；丟棄 id/parentId/time/pad/usage/cwd|
|`compare.mjs`|投影深比較＋有界 diff 上下文|
|`run.mjs`|案例註冊與 CLI|

## 案例設計

- **consistency-basic**：雙側各跑 `alpha parity`、`beta parity` 兩輪；正規化
  session 投影、turn 收斂、模型身分必須相等。
- **divergence-detector**（工具自檢）：RPC 跑三輪、TUI 只跑一輪；比較器
  **必須**報出差異，否則工具本身不合格。

## 已知限制（誠實邊界）

- **表面 bookkeeping 差異被排除於核心比較、列於 `surfaceNotes`**：RPC mode
  持久化 `service_tier_change`、TUI 持久化 `model_change`；兩 surface 的
  system prompt 嵌入不同上下文 → `system-prompt-digest` 必異。這是上游
  各 surface 的紀錄選擇，不是使用者可見的語意差異。
- **queue 案例的比對過濾（範圍明示）**：`dropAbortedTurnArtifacts` 對兩側
  移除空 assistant 訊息與本案例控制的 `'hold turn one'` 中止輪，並剝除
  `fixture-ack[N]` 的計數（計數=持久化 user 輪數，是 abort 持久化差異的
  直接指紋，屬 FINDING 而非 fail）。多送/少送一整輪仍會被 entry-count
  與訊息比對抓到。
- **TUI 輪收束信號**：`sendPrompt` 以「session 檔出現含該輪回顯尾端的
  assistant 訊息」為準（omp 於輪收束時持久化）；compact 案例另以
  config.yml 種子 `compaction.keepRecentTokens: 200`（上游預設 20000）
  降低 compaction 門檻，避免 23k 字大文造成的串流/落盤競態。
- **queue 案例仍有時間窗**：busy 中送佇列訊息與 Esc 的時序落在 fixture
  HOLD 模式的 4 秒窗口內（800/350/300ms 固定延遲）——窗口有界但非事件
  驅動；HOLD 期間 spinner 持續重繪，提早送出會被上游以 interjection
  包裹並在 diff 中現形（fail-loud）。
- entry 的 id/parentId 鏈未做同構比對（保留順序）；usage/cost 數字不比；
  未知 entry type 與非 compaction 的 custom data 保留 2kB bounded dump。
- fixture 回覆為純文字輪；**tool-call 輪未覆蓋**（擴充：fixture 加
  tool_calls 回合，斷言雙側 tool 執行段落一致）。
- 鎖檔（`*.lock.os`）已排除；`--keep` 保留全部案例的暫存根供偵錯。

## 7.2 驗收群組怎麼接（交接點）

在 `run.mjs` 註冊新案例，重用 `runRpcSide`/`runTuiSide` 並擴充 drivers：

|群組|接法|
|---|---|
|Session|RPC：`request({type:'fork'})`、`new_session`、`set_session_name`；TUI：`/fork`、`/new`、`/rename` 送鍵盤序列；比較 fork 後雙側 leaf 檔|
|Compact|RPC：`{type:'compact', customInstructions}`；TUI：`/compact`；斷言 `custom(compaction)` 條目與後續問答|
|輸入|busy 中再送 prompt（RPC 直接、TUI 打字送出）；queue 行為比較|
|Queue|RPC `abort_and_restore_queue`；TUI Esc；比較 `get_state().queue` 與 restore 後草稿|
|UI 請求|fixture 無法觸發 extension_ui——需 extension fixture（上游 `--no-extensions` 要拿掉）或留給 app 層 e2e|
|模式與設定|`set_slow_mode`/`set_steering_mode` 等 RPC vs TUI `/slow`、`/mode`；`get_state` 投影比較|
|顯示|本工具比較落盤工件，live 渲染屬 app e2e（tests/e2e）職責|
