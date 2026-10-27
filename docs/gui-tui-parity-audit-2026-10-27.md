# GUI 與 OMP TUI 功能及流程差異分析

分析完成日：2026-10-27，Asia/Taipei。

## 比較基準與結論

- GUI：工作目錄 commit `054c7df9b7898555d480d635f7e0c0f666eb3e72`，package version `1.3.12`。開始與完成原始碼分析時工作目錄乾淨。
- `/Applications/OMP Desktop.app` 的版本也是 `1.3.12`。僅確認版本及部分 bundle 符號，未假定其所有程式碼與工作目錄逐位元相同。
- 實際 PATH 上的 OMP：`/opt/homebrew/bin/omp`，`omp/18.12.6`。
- 上游來源：Git tag `v18.12.6`，commit `45c35e40c46166dc726ccc52f5d27f40f2449f99`。所有上游判斷使用該 tag，沒有使用本機舊 checkout 的 18.6.1 內容。
- 驗證：原始碼追蹤、直接執行兩個實際 parser／純函式、7 個相關測試檔共 195 個測試通過。未啟動真實模型對話，未修改或刪除使用者 session，未做完整 GUI E2E。

GUI 使用同一個 OMP 引擎，但自行實作 session 列表、歷史重建、文字佇列、命令分類與 extension UI。因此「模型與工具能執行」不代表流程與 TUI 等價。目前有確認的協定解讀錯誤，也有功能未接上，以及合理的 GUI 設計差異。

本報告的「確認」指來源碼或局部函式已足以證明差異；若未端到端重現，會明確保留限制。這是功能範圍審查，不是已找出所有 bug 的保證。此次只新增本報告，沒有修正產品程式。

## Compact：不能把新舊兩個檔案視為正常壓縮結果

OMP 18.12.6 的一般與 experimental compaction 會呼叫目前 session manager 的 `appendCompaction()`，再重建 display context、替換 agent messages。`experimental-context-rollover` 表示 context 邊界，不能從名稱推導出一定產生新 session 檔案。

上游證據：[session-maintenance.ts:2484](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/session/session-maintenance.ts#L2484)。Experimental 路徑也進入相同 commit 函式。

GUI 的 `supersededSessionPaths()` 卻將 `parentSession` 和 `previousSessionFiles` 當成取代關係，還將同 parent 的 siblings 合併。這兩個欄位的實際意義不同：

| 欄位／操作 | OMP 18.12.6 的用途 | GUI 現況 |
|---|---|---|
| `parentSession` | 正常 fork、指定分支副本、部分檔案衝突分流也會使用 | 當成舊 session 被新 session 取代 |
| 相同 `parentSession` 的多個 session | 可以是使用者刻意保留的不同分支 | 隱藏除 survivor 外的非活動 siblings |
| `previousSessionFiles` | 成功搬移 session 前的舊路徑 | 與 parent lineage 一起處理 |
| compact 紀錄 | 追加到目前 session，更新模型 context | 有註解與測試假設 compact 會建立 successor 檔 |

上游證據：[fork](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/session/session-manager.ts#L2445)、[branch](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/session/session-manager.ts#L3909)、[previousSessionFiles 定義](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/session/session-entries.ts#L53)。

因此，使用者觀察到「compact 後多出一個帶壓縮 context 的 session，原本的仍未變動」，仍需該次 session 的身分、檔案變動與 runtime 事件才能確認根因。上游確實有檔案衝突後保留原檔、轉寫新檔的路徑，但本次沒有證據把它判定為該次事故原因。GUI 已有換檔後 refreshState 的修補，也不能據此宣稱這個案例已修好。

## 需要優先修正的問題

### 1. 正常分支被隱藏，閒置 runtime 可能被導向另一個分支

GUI [sessions.ts:74](/Volumes/T7/Code/omp-desktop/electron/main/sessions.ts:74) 的實際函式已做局部執行驗證。

輸入原對話與兩個時間先後不同、`parentSession` 均指向原對話的正常 fork，結果：

```text
輸入：original、deliberate-fork-a、deliberate-fork-b
隱藏：original、deliberate-fork-a
可見：deliberate-fork-b
```

這是列表隱藏，不能說磁碟資料已刪除。但 [sessions.ts:293](/Volumes/T7/Code/omp-desktop/electron/main/sessions.ts:293) 還會對被判定 superseded 的閒置 runtime 呼叫重新綁定，風險不只在列表外觀。runtime 跳轉未以真實對話端到端重現。

修正方向：分支關係、搬移路徑、真正的取代關係必須分開；不可僅憑 `parentSession` 自動隱藏或改綁對話。

### 2. GUI 建立分支可能寫出檔案後又回報失敗

[sessions.ts:408](/Volumes/T7/Code/omp-desktop/electron/main/sessions.ts:408) 複製整份 JSONL；header 只改 id，沿用原 timestamp 與 parent lineage。接著重新列出 catalog，找不到副本就拋錯。

對已有 parent 的來源再建立 GUI 分支，來源與副本會被上一項 sibling collapse 合併。局部函式重現中副本被隱藏；相同時間下的結果依 catalog 次序，也可能隱藏來源。操作報錯時檔案可能已經存在。

此實作也沒有 OMP 指定 leaf 的 branch 語意，沒有複製 session 附屬 artifacts。這可能留下無法解析的 artifact 參照，是否觸發取決於內容。

### 3. 歷史紀錄可能顯示與模型 context 不同的分支

[transcript.ts:275](/Volumes/T7/Code/omp-desktop/electron/main/sessions/transcript.ts:275) 將最後一筆可顯示紀錄當成 leaf，未處理 OMP 的 `activeLeafId`。

OMP 用 `activeLeafId` 防止遲到的背景工具結果或 usage 紀錄讓 resume 跳回舊分支，也支援 null leaf。GUI 讀取同一檔案可能選錯分支。這是來源碼確認的缺漏，未進行實際 TUI 切分支的 E2E。

上游證據：[session-entries.ts:88](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/session/session-entries.ts#L88)、[leaf 選擇規則](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/session/session-entries.ts#L347)。

### 4. Stop 不等價於 TUI 的停止並取回佇列

[useWorkspaceActions.ts:699](/Volumes/T7/Code/omp-desktop/src/hooks/useWorkspaceActions.ts:699) 暫停 GUI 本地佇列後只送 `abort`。OMP 已提供 `abort_and_restore_queue`，先移除排隊輸入，再 abort，以免 abort 後的佇列排空流程繼續執行。

因此已交給 OMP 的圖片 follow-up 或 steering，不受 GUI 本地 pause 完整控制；有按 Stop 後仍繼續處理待辦輸入的風險。來源碼確認，尚未真實模型重現。

上游證據：[rpc-mode.ts:1963](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L1963)。GUI command schema 未開放這個命令。

### 5. 同一個排隊操作，附圖前後語意不同

忙碌時純文字留在 renderer 佇列；圖片訊息則送 OMP `follow_up`。本地佇列有編輯、刪除、立即送出；OMP 持有的項目主要只有顯示。

上游已有 `remove_queued_message`、`promote_queued_message`，GUI 尚未接上。這會使傳送、取消、重啟恢復的行為依訊息是否有圖片而不同。

證據：[useWorkspaceActions.ts:434](/Volumes/T7/Code/omp-desktop/src/hooks/useWorkspaceActions.ts:434)、[follow_up 路徑](/Volumes/T7/Code/omp-desktop/src/hooks/useWorkspaceActions.ts:610)、[command-schema.ts](/Volumes/T7/Code/omp-desktop/electron/main/agent-rpc/command-schema.ts)。

### 6. Adapter 移除現在已受支援的 streamingBehavior

GUI 送 prompt 時附上預期的 queue／steer 行為，卻在 [harness-adapter.ts:93](/Volumes/T7/Code/omp-desktop/electron/main/agent-rpc/harness-adapter.ts:93) 移除 `streamingBehavior`。

OMP 18.12.6 已支援這個欄位；若收到 prompt 時正在 streaming，沒有欄位就會拒絕。GUI 看見 idle 到實際送達之間發生競態時，原本應該排隊或插話的訊息可能失敗。

上游證據：[agent-session.ts:7838](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/session/agent-session.ts#L7838)。

### 7. 長篇 approval 可能被靜默丟棄，OMP 繼續等待

上游 RPC approval fallback 使用 `select`，將完整提示和程式碼放在 title。GUI 限制 title 4000 字元、選項 32 個、單個選項 500 字元；不符直接解析失敗，呼叫端沒有回覆拒絕或取消。

實際 parser 探針結果：短 title 被接受，4001 字元 title 被丟棄。當 approval 含較長 patch 時，可能沒有對話框可答，卻一直等待。

證據：[extension-ui.ts:31](/Volumes/T7/Code/omp-desktop/src/lib/extension-ui.ts:31)、[useExtensionUi.ts:152](/Volumes/T7/Code/omp-desktop/src/hooks/useExtensionUi.ts:152)、[OMP approval fallback](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/tools/approval.ts#L691)。

### 8. 取消問題會關閉整個 OMP 程序；上游取消事件反而被忽略

[useExtensionUi.ts:86](/Volumes/T7/Code/omp-desktop/src/hooks/useExtensionUi.ts:86) 對使用者取消呼叫 `bridge.agent.stop()`。其實作關閉 stdin，必要時終止程序，不只是回覆該問題 cancelled。

另一方面，OMP 主動送出的 `method: cancel` 不符合 GUI parser 的方法與 title 規則，被丟棄。extension 主動 abort 時可能留下過期對話框；GUI 自有 timeout 只涵蓋部分情況。

這兩種方向都應依 request id 完成對話生命週期，並把「取消問題」與「停止整輪工作」做成不同操作。

### 9. 部分 OMP 重要通知不會顯示

OMP 的 `notice` 包含 session 寫入失敗或搬移的提示。TUI 有顯示處理；GUI event hook 與 reducer 沒有對應分支。stderr 主要用於啟動失敗補充，也不是一般執行中 notice 的呈現替代品。

這可能讓 session 問題只呈現為「多出一筆、消失、卡住」，使用者看不到引擎提供的原因。來源碼確認未消費事件，未重現真實磁碟寫入故障。

證據：[useAgentEvents.ts](/Volumes/T7/Code/omp-desktop/src/hooks/useAgentEvents.ts)、[reduce.ts:388](/Volumes/T7/Code/omp-desktop/src/lib/events/reduce.ts:388)、[上游事件顯示](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/modes/controllers/event-controller.ts#L1448)。

## 輸入、執行與 session 操作差異表

| 項目 | OMP TUI | GUI 現況 | 判斷 |
|---|---|---|---|
| 執行中 Enter | 預設 steer | 預設 queue，可設定反轉 | 操作預設不同 |
| Ctrl+Enter | follow-up | 預設 steer；macOS 也接受 Cmd | 操作預設不同 |
| 空白 Enter | 執行中可中斷並排空待處理輸入 | 不送出 | 功能缺口 |
| `.`、`c` | 特殊 continue 指令 | 一般文字訊息 | 語意不同 |
| Escape | 依狀態中止、取回佇列；雙 Esc 可導航 | Composer 主要關閉補全，另有 Stop | 部分替代，停止語意仍不同 |
| `!`、`!!` | shell 執行；後者結果不加入 context | 無對應路由，當一般 prompt | 缺少 TUI 快捷流程 |
| `$ `、`$$ ` | Python 執行及不加入 context 的變體 | 當一般 prompt | 缺少 TUI 快捷流程 |
| `->`、`=>`、`/queue` | 特殊佇列語法 | 不解析 shorthand，`/queue` 被擋 | 功能缺口 |
| 執行中 slash | extension 命令可即時處理，其他依命令而定 | 全部等 idle，包括 steer 送出的 slash | 分類過於粗略 |
| slash 加圖片 | `/skill:*` 可帶圖片 | 一律拒絕 | 不相容 |
| 普通圖片輸入 | 交由 OMP 輸入流程 | 支援 PNG/JPEG/GIF/WebP，最多 8 張 | 有額外限制 |
| 圖片草稿 | 依 TUI editor 生命週期 | 記憶體暫存，與文字持久化不同，重啟不保證保留 | 設計差異 |
| 新增 session | 建立 durable 空 session 邊界 | 先建立 GUI 草稿 workspace，之後才啟動 | 可接受設計，但跨程序可見性不同 |
| session fork／branch | 分別有完整 fork、指定 leaf 分支與導航語意 | sidebar 複製 JSONL，非完整等價 | 目前有功能及正確性問題 |
| session 刪除 | `dropSession` 刪除 session 與附屬 artifacts | 刪 JSONL，附屬目錄可能殘留 | 清理行為不同 |
| 閒置程序 | 終端機中的 TUI 程序持續存在 | 新 runtime 可回收舊 idle runtime；也有 idle retention | 刻意節省資源，暫存 extension 狀態需重建 |
| context 計數 | OMP 狀態／估算 | 加上 GUI streaming chars / 4 的即時補估 | 不保證每一刻相同，不代表引擎 context 改變 |

輸入依據：[message-shortcuts.ts:12](/Volumes/T7/Code/omp-desktop/src/lib/message-shortcuts.ts:12)、[useWorkspaceActions.ts:427](/Volumes/T7/Code/omp-desktop/src/hooks/useWorkspaceActions.ts:427)、[OMP input controller](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/modes/controllers/input-controller.ts#L978)。

Context 依據：[context-usage.ts](/Volumes/T7/Code/omp-desktop/electron/main/agent-rpc/context-usage.ts)。程序生命週期：[manager.ts:529](/Volumes/T7/Code/omp-desktop/electron/main/agent-rpc/manager.ts:529)。

## 命令與模式覆蓋

GUI 有三種不同情況，不應混為「不支援」。

1. 選單中有顯示。
2. 選單隱藏，但手動輸入仍會轉送 OMP。
3. GUI 明確攔截拒絕，或改成 GUI 自己的操作。

### 選單只顯示固定 builtin 白名單

目前為 `modelpreset`、`context`、`tools`、`usage`、`jobs`、`compact`、`handoff`、`fresh`、`shake`、`todo`、`memory`、`advisor`、`skillful`、`extended-context`、`force`、`security`、`btw`。

Custom、extension、file、skill 命令仍可顯示。上游新增 builtin 即使回傳在 catalog，也會因未加入 GUI 白名單而消失。證據：[slash-command-ui.ts:8](/Volumes/T7/Code/omp-desktop/src/lib/slash-command-ui.ts:8)。

### 明確攔截的 slash

`theme`、`settings`、`config`、`hotkeys`、`help`、`tree`、`resume`、`new`、`clear`、`fork`、`login`、`logout`、`quit`、`q`、`exit`、`delete`、`live`、`record`、`pause`、`setup`、`providers`、`extensions`、`status`、`agents`、`git`、`hub`、`branch`、`rewind`。

另外包含 `plan`、`plan-review`、`vibe`、`goal`、`guided-goal`、`loop`、`queue`，以及 `/todo edit|expand|collapse`、`/advisor configure`。

其中新 session、模型選擇、設定、Git 等有 GUI 入口，不能因 slash 被擋就判定整個功能不存在。Tree／rewind、模式生命週期與 goal 等則沒有等價的完整接入。尤其 OMP 18.12.6 已有 native `goal` RPC，GUI 仍把它歸類為 TUI-only。

證據：[slash-commands.ts:31](/Volumes/T7/Code/omp-desktop/src/lib/slash-commands.ts:31)、[OMP goal wire command](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/modes/rpc/wire/commands.ts#L102)。

### 隱藏但仍可能手動使用

`model`、`switch`、`effort`、`fast`、`slow`、`retry`、`rename`、`session`、`export`、`dump`、`ssh`、`plugins`、`marketplace`、`reload-plugins`、`add-dir`、`remove-dir`、`dirs` 等沒有因選單隱藏而一律禁止。能否成功仍取決於 OMP 的 text handler 與參數，不等於已逐一實跑通過。

`/mcp` 單獨輸入改為開 GUI Capabilities；`/mcp reauth` 明確要求使用外部 CLI。

### 模型、速度與壓縮

| 功能 | GUI 與 TUI 的差異 |
|---|---|
| 模型／effort | GUI 有 picker 並送 OMP RPC，不能說缺少基本模型切換 |
| Fast／Slow | GUI 用 default／priority 與布林 Fast 表示；無完整呈現 TUI `/fast ultra`、Slow 狀態與 scope。手動 `/slow` 仍可轉送 |
| auto compact／auto retry／queue mode | bridge schema 有相關命令，但未找到對應 frontend 操作入口；CLI 設定與 GUI 可調整項目不等價 |
| `/compact soft|remote|snapcompact` | ✔ 已修復（2026-10-27）：模式命令原樣交給上游 slash dispatcher；GUI 自有的重複 regex 已移除 |
| `/compact SOFT` | ✔ 已修復：`parseCompactCommand` 與上游 `Yke` 同語意，模式比對不分大小寫；`/compact snapcompact <指示>` 依上游 rejectsFocus 原地拒絕 |
| `/handoff`、`/shake`、`/fresh` | 有 GUI 命令入口；仍受「忙碌時所有 slash 排隊」規則影響 |
| `/btw` | GUI 已有 side-question RPC 對映，屬於已接入功能 |

證據：[harness-adapter.ts](/Volumes/T7/Code/omp-desktop/electron/main/agent-rpc/harness-adapter.ts)、[useWorkspaceActions.ts:381](/Volumes/T7/Code/omp-desktop/src/hooks/useWorkspaceActions.ts:381)。

## 擴充、工具、設定與 GUI 額外功能

| 項目 | 現況與分類 |
|---|---|
| select／confirm／input／editor | GUI 有基本支援，但有長度限制與取消流程問題 |
| 原生 ask | ✔ 已更新：`runtime.ts` 已 opt in `set_ask_dialog`，ask renderer 已實作（階段 3.6） |
| GUI ask_user | 另外注入自己的 extension，1–5 題問卷與 OMP 原生 ask 不同 |
| `setStatus`／文字 `setWidget` | ✔ 已更新：`useExtensionUi.applyPresentation` 已消費（階段 3.5） |
| `setEditorText`／`pasteToEditor` | ✔ 已更新：`set_editor_text` 已降級為預覽卡呈現（degraded，見 gui-extension-contract.md） |
| 選項說明 | ✔ 已更新：`ExtensionUiOptionDetail` 已保留並渲染（階段 3.5） |
| 自訂 TUI component／editor／快捷鍵 | RPC 本身無法直接重用終端元件，需要另訂 GUI 能力，非單純補一個 renderer 分支 |
| extension 讀 editor | RPC `getEditorText()` 與 TUI 的 editor 狀態不等價 |
| 同時多個普通問題 | GUI 每 runtime 保留一個 pending，新問題會取消前一個；自訂 questionnaire 有特殊聚合規則 |
| Tool output | GUI 主要擷取文字 content；非文字結果和 TUI 自訂 renderResult 不等價 |
| 子代理 | 有 roster 與 transcript 分頁；最多 256 roster、400 顯示 messages，僅可見且選中時輪詢。這是顯示界限，不是執行量限制 |
| Provider 登入 | credentials 由 CLI 管理，GUI catalog／選擇器不是完整登入流程 |
| 本地 MCP | 有 GUI 管理能力，受定義格式與政策限制 |
| HTTP／SSE MCP | 不建立、啟停或認證；外部定義主要唯讀，可在限定條件下移除。是明確產品政策 |
| 工具與系統提示 | GUI 注入 schedule、browser、askUser、collaboration extensions；即使同 binary，可用工具與 prompt 也不同 |
| 專案／Git／終端機／瀏覽器／排程／語音 UI | 屬於 GUI 增加的操作入口，不應為了 TUI 一致性刪除；其存在不代表等價實作了所有 TUI 命令 |

來源：[extension UI parser](/Volumes/T7/Code/omp-desktop/src/lib/extension-ui.ts)、[useSubagents.ts](/Volumes/T7/Code/omp-desktop/src/hooks/useSubagents.ts)、[tool result parser](/Volumes/T7/Code/omp-desktop/src/lib/events/parse.ts)、[MCP 政策](/Volumes/T7/Code/omp-desktop/src/lib/mcp-policy.ts)、[extension manifest](/Volumes/T7/Code/omp-desktop/electron/main/extension-manifest.ts)。

一般 custom_message 的 live 顯示與重新開啟後的持久化顯示也有不同解析路徑；尚未排除 reconcile 會補齊，因此未將它列為確認 bug。

## 驗證結果與下一階段的驗收條件

已執行：

```text
npx vitest run tests/backend/agent-rpc.test.ts tests/backend/omp-agent-rpc.test.ts tests/backend/omp-sessions.test.ts tests/backend/sessions.test.ts tests/frontend/workspace-actions-compact.test.ts tests/unit/slash-commands.test.ts tests/frontend/extension-ui.test.ts
Test Files 7 passed
Tests 195 passed
```

環境實際使用 Node `v26.11.1`；嘗試載入 repo 指引中的 nvm，但本機沒有該 nvm.sh，因此不是 pinned Node 24.15.0 的驗證結果。未宣稱完成 release verification。

局部探針直接擷取現有 TypeScript 函式，透過 Node stripTypeScriptTypes 與 vm 執行，沒有重新實作演算法：

- `supersededSessionPaths()`：驗證正常 parent＋兩個 fork 被合併；再驗證帶既有 parent 的 GUI 副本被合併。
- `parseExtensionUiRequest()`：驗證短 select title 可接受、4001 字元被丟棄，以及 cancel／set_editor_text／setStatus 不被解析為問題。

195 個測試通過只證明既有預期未失敗。部分 compact fixture 手工製造 successor 檔，正好固化了錯誤的 lineage 假設，不能作為與真實 OMP 一致的證明。

建議修正與驗收順序：

1. Session 身分與 branch：正常原對話及所有 fork 都可見；選擇一個不會切到另一個；尊重 activeLeafId；真實 compact 前後檔案身分依 OMP 結果更新。
2. Queue／steer／Stop：文字與圖片採同一套可說明的操作語意；Stop 後沒有未授權的下一輪；idle-to-busy 競態保留 streamingBehavior。
3. Extension 互動：長 approval 可顯示或明確失敗回覆；取消單一問題不殺程序；上游 cancel 清除正確對話；notice 可見。
4. 命令與模式：區分即時控制命令和必須等待 idle 的操作；接入上游已提供的 goal／queue 能力；補齊 skill＋圖片與 catalog 的版本適配。
5. 功能體驗：速度與設定狀態一致、shell shortcuts、artifact 複製與清理、extension widgets／editor 等較低優先項目。

本次沒有足夠證據唯一定位使用者那次 compact 事故；但已確認的 lineage 誤判、雙佇列及互動協定缺漏，足以解釋為何 GUI 目前會出現多種與 TUI 不一致的行為，應優先修正並以真實 OMP 行為補測。

## 修復目標：GUI 與 TUI 功能、資料及操作語意一致

使用者要求 GUI 能與 TUI 一樣。以下是待實作方案，不是已完成的修復。目標涵蓋上述全部差異，不只處理 compact 或隱藏重複列。

一致性的驗收基準：同一版 OMP、同一份設定、相同起始 session 與相同輸入，在 GUI 和 TUI 應得到相同的命令意義、佇列順序、停止結果、active branch、持久化內容與可用能力。模型生成的自然語言不要求逐字相同；可用可控測試 provider 比較確定性的流程結果。

視窗、按鈕、列表可以採 GUI 呈現，但不得偷偷改變操作含義。TUI-only 元件不能直接放入 React，應提供功能等價的 GUI 介面，或補上必要的 OMP RPC。沒有完成接入的項目保留為未完成，不能因移除入口而算作一致。

GUI 的專案、Git、瀏覽器及排程可以保留。會新增工具或改變 system prompt 的 GUI extensions 應明確可設定；做一致性驗證時須讓兩邊使用相同的 extension 與設定。保留使用者既有要求：執行中輸入新文字後，主要按鈕仍由 Stop 切換成 Send，使用既定 delivery intent 傳送。

### 共通實作規則

- OMP 擁有 session、branch、模型設定、執行狀態與已接受的佇列。GUI 保存草稿、呈現偏好及尚未確認送達的操作，不建立第二套不同含義的引擎狀態。
- 優先使用 OMP 現有公開 RPC／命令。缺少能力時先確認版本與協定，再補上游能力；不得假設存在未查證的 API，或用直接改寫 JSONL 模擬會觸發 hooks 的操作。
- 每個新 bridge 操作同步修改 `src/types/api.ts`、`electron/preload/index.ts`、`electron/main/ipc.ts` 及參數驗證；保留 sender 驗證與 fail-closed 行為。
- 命令可用性由版本能力與 catalog 決定。移除過時的 TUI-only 判斷，不可直接把任意 RPC 全部暴露給 renderer。
- 預期可回覆的請求必須成功、失敗或取消；未知事件留下可診斷的紀錄，不能靜默丟棄而讓 OMP 等待。
- 測試分成 GUI 自身邏輯與真實 OMP 協定兩層。手工 fake runtime 只能測邊界，不能定義上游行為。

### 階段 1：先修 session、compact 與分支正確性

主要位置：`electron/main/sessions.ts`、`electron/main/sessions/transcript.ts`、`electron/main/agent-rpc/runtime.ts`、`electron/main/agent-rpc/manager.ts`、`src/hooks/useWorkspaceRuntime.ts`。

1. 移除依 `parentSession` 隱藏 parent／siblings 的規則，並停止據此自動改綁 runtime。`parentSession` 只作關聯與分支顯示。
2. 將 session ID、目前檔案路徑、parent lineage、active leaf 分開追蹤。`previousSessionFiles` 只在符合上游搬移語意時協助辨識舊路徑，不用「較新」推定取代關係。
3. Compact 完成後向該 runtime 取得權威狀態，更新 context、compaction 結果及實際 sessionFile。原檔繼續使用或實際換檔都依回報處理；查詢失敗顯示同步未完成並可重試，不自行挑選某個 child。
4. 對使用者的 compact 案例記錄脫敏診斷：操作前後 session ID／path／leaf、runtime ID、鎖定或 persistence notice 與時間順序。不記錄 prompt、token 或憑證。區分原地 compact、合法 fork、搬移與寫入衝突。
5. Transcript 依上游 `activeLeafId` 規則選 active branch，包含 null、舊版未帶欄位的 fallback 與晚到的 off-branch 結果。Live 顯示與重新開啟後應一致。
6. 將「完整 fork」、「從指定訊息分支」、「tree 導航／rewind」做成不同操作。使用實際可用的 OMP 命令；不再以只改 header ID 的檔案複製替代。完整 fork 或導航若缺公開 RPC，列為上游接入工作。
7. 由 OMP 管理分支 artifacts 與刪除清理；刪除時釐清僅刪選中 session 的語意，不連帶刪 parent／siblings，也不移除仍被其他 session 使用的共用資料。
8. 「新工作階段」比照 TUI 建立 durable 空 session 邊界。尚未建立的輸入框草稿另行表示，不能讓使用者以為已建立卻仍被其他程序續接上一個 session。
9. 清除相關錯誤註解與 successor fixture 假設。恢復原本被隱藏的合法分支；不要用刪檔或重新合併來修列表。檢查已儲存的 pin、archive、選取路徑能否精確保留，無法判定的歷史關係不可猜測。

驗收：原對話＋兩個 fork 全部可見且可獨立續接；對 fork 再分支成功；artifact 可讀；activeLeaf 與 TUI 一致；compact 不額外建立 GUI session；真正衝突時保留雙方資料並顯示原因。跨程序測試以各自可寫的分支進行，同檔競爭時驗證鎖定拒絕，不強制讓兩程序同時寫入。

### 階段 2：統一輸入、佇列、插話與停止

主要位置：`src/hooks/useWorkspaceActions.ts`、`src/hooks/useWorkspaceRuntime.ts`、`src/lib/queued-prompt-storage.ts`、`src/lib/message-shortcuts.ts`、`electron/main/agent-rpc/command-schema.ts`、`electron/main/agent-rpc/harness-adapter.ts`、Composer。

1. 保留 `streamingBehavior`，依版本能力驗證後直接交給 OMP，移除目前無條件刪除欄位的邏輯。
2. 已接受的 steering／follow-up 統一交給 OMP 管理，文字和圖片走相同語意。GUI 本地只保留草稿或尚未確認接受的傳送項目，以免兩份佇列各自決定順序。
3. 接入 `abort_and_restore_queue`，Stop／Esc 依 TUI 規則中止並恢復待送輸入。以 RPC 實際回覆更新畫面，不能只設 `isStreaming=false`。回覆遺失時先查狀態，避免直接重送造成重複執行。
4. 接入上游 queue remove／promote 能力。編輯若沒有原子命令，先定義與 TUI 一致的取回再編輯流程；不能用不可靠的刪除後重送掩蓋競態。
5. 顯示 authoritative queue 順序與身分，文字及圖片都能依引擎能力取回、取消、提前執行。重啟後以 OMP 狀態核對，不能盲目重播已接受的本地舊項目。
6. 預設快捷鍵改成 TUI 語意，Enter 插話、Ctrl+Enter follow-up；macOS 可額外提供 Cmd 同義鍵。保留明確的使用者自訂；設定遷移不能把舊版預設誤認為使用者已選擇。
7. 補齊空白 Enter、`.`／`c`、`->`／`=>`、Esc 與雙 Esc 的上下文行為。優先共用上游解析／命令語意，避免重新發明規則。輸入法 composition 與既有 Stop→Send 互動保持正確。
8. 圖片草稿與待送輸入採明確的生命週期。持久化附件使用受控檔案參照、容量限制與完成後清理；重啟遺失時顯示未恢復，不能把帶圖指令當純文字送出。

驗收：busy／idle 邊界、停止時已排隊、停止與新訊息同時發生、圖片 follow-up、切換 session、重啟、RPC 回覆遺失都沒有重送、漏送或 Stop 後意外續跑。以 TUI 相同操作序列核對佇列內容與消耗順序。

### 階段 3：補齊互動請求、approval 與事件

主要位置：`src/lib/extension-ui.ts`、`src/hooks/useExtensionUi.ts`、`src/hooks/useAgentEvents.ts`、`src/lib/events/reduce.ts`、ExtensionUiModal、RPC schema。

1. 先依事件 method 分類，再驗證各自欄位。`cancel`、status、widget、editor 更新不應被一般問題的 title 必填規則擋掉。
2. 取消問題送對應 request ID 的 cancelled response，不停止整個程序。另保留明確的「停止工作」操作。收到上游 cancel 時關閉正確請求，不接受過期回答。
3. 長 approval 改為可捲動、可展開的完整內容。安全容量上限需與 wire limit 協調；不能任意截斷後要求使用者批准看不到的內容。超限或格式錯誤必須明確回覆失敗／取消並告知使用者。
4. Pending requests 改為依 runtime＋request ID 管理，不以新問題覆蓋舊問題。顯示順序與同時問題處理以 TUI 行為為準，回覆至多一次。
5. 支援 optionDetails、文字 status／widget、set_editor_text／paste，並處理草稿與使用者正在輸入的同步衝突；上游操作語意不明時先補協定。
6. 實作原生 ask dialog 與其回覆型別後才 opt in `set_ask_dialog`。確認原生 ask 與 GUI ask_user 是否重複，再整合或移除重複工具，不在缺 renderer 時先開旗標。
7. 顯示 notice 的 severity、來源與可採取動作，涵蓋 session persistence 錯誤。自動 retry／compaction 的生命週期以正式事件為主，watchdog 只能顯示未知／待同步，不能無證據宣告成功或失敗。
8. 對一般 custom_message、tool content 的 live 與持久化呈現做一致性檢查，保留影像、檔案等非文字內容，提供無自訂 renderer 時的可讀 fallback。

驗收：長 patch approval 可完整閱讀；取消一題不退出 runtime；上游 timeout／abort 不留下 modal；多題不遺失；未知請求不無限等待；寫入失敗有可見通知；重開 session 不改變已顯示訊息的語意。

### 階段 4：命令 catalog、模式與執行入口對齊

主要位置：`src/lib/slash-commands.ts`、`src/lib/slash-command-ui.ts`、`src/hooks/useWorkspaceActions.ts`、RPC adapter／schema。

1. 建立逐命令覆蓋表，記錄上游名稱／aliases、可用版本、參數、busy 時可否執行、GUI handler、驗收測試。由 live catalog 更新候選命令；GUI 本地 metadata 只補必要的呈現與映射。
2. 移除固定 builtin 顯示白名單。已有 GUI 控制的命令仍可從 slash 使用，映射到相同操作。真正未支援的命令明確列出原因及缺少能力，不能假裝成功或送成一般模型文字。
3. 取消「所有 slash 都等 idle」。依上游命令性質分成即時控制、查詢、需 idle、會修改 session 的操作；busy 行為逐項與 TUI 核對。
4. 接入原生 goal；逐項完成 plan、plan-review、vibe、guided-goal、loop、queue 的開始、狀態、取消、續跑及重啟恢復。不能只讓文字命令通過，卻缺少中途 approval 或狀態顯示。
5. 補 tree／resume／new／clear／fork／branch／rewind 對等入口，與階段 1 共用實作。補 todo 編輯、advisor configure、help／hotkeys 等目前被擋的操作。
6. `!`／`!!`、`$ `／`$$ ` 走 OMP 的執行與 context 收錄規則。缺少 RPC 時補協定，不能在 Electron 主程序隨意執行後當成同一能力。
7. 允許上游支援的 skill＋圖片，按命令能力驗證附件。Compact 模式、大小寫與 aliases 共用上游語意，移除容易漂移的重複 regex 判斷。
8. 新 builtin 與 extension 命令自動出現在可發現的入口，涵蓋 export／dump、plugin、workspace directories 等目前選單隱藏但可手動轉送的功能。

驗收：覆蓋表每個命令都有成功、無效參數與 busy 情境結果；GUI 選單操作和 slash 操作效果相同；不再把現有 RPC 能力誤列 TUI-only。

### 階段 5：模型、設定、登入與 MCP

主要位置：`src/hooks/useProviderCatalog.ts`、設定頁、`electron/main/agent-rpc/harness-adapter.ts`、`src/lib/mcp-policy.ts`、provider／MCP 主程序服務。

1. 以 OMP 狀態表示實際 Fast／Ultra／Slow 及 scope，不用單一布林值壓縮不同模式。手動 slash 切換後 GUI 即時更新。
2. 補上 auto-compaction、retry、steering／follow-up mode、interrupt mode、cache warming 等 OMP 可設定項目。標明全域、專案、session 或暫時有效範圍，儲存位置與 TUI 相同。
3. Provider login／logout 與 MCP OAuth 由 OMP 擁有憑證及認證流程，GUI 提供啟動、開瀏覽器、進度、取消與完成顯示。若無公開 RPC，先加入上游能力或明確設計受控 CLI 互動入口。
   （已實作——provider 部分：command-schema 開放 login／get_login_providers／get_logout_accounts／logout（providerId 白名單、credentialId 正整數；login 用戶端逾時 600s 對齊上游）；Capabilities 頁 provider 帳號面板驅動既有 extension_ui 的 open_url＋input 流程，可取消；／login ／logout 移出 DEFERRED 改由 gui-action 開啟面板。憑證歸屬維持 OMP custody：renderer 只持有 LoginProvider／LogoutAccount 白名單欄位，上游拒絕 secret：true 提示，祕密永不到達 GUI，邊界記錄於 docs/security.md。MCP OAuth（5.4 範疇）尚未做。）
4. 要達到全部功能一致，需修改目前網路 MCP 的產品限制，補 HTTP／SSE 建立、啟停、認證與狀態。同步更新安全設計、參數驗證及測試，不能只刪掉禁止訊息。
5. 完整呈現本地與外部 MCP 定義、plugin／skill discovery、reload 與錯誤，讓 GUI 改動與 TUI 讀到的有效設定一致。

驗收：GUI 修改後 TUI 可讀到相同值，反向修改也可刷新；登入成功／失敗／取消都能結束；不複製憑證到 GUI 自有設定或 logs。現有外部 CLI 提示可作過渡，但在完整接入前仍標示未完成。

### 階段 6：工具、子代理與 TUI 專用擴充能力

1. 為子代理補齊 OMP 已提供的可查詢狀態、控制與取消能力。歷史採分頁或游標讀取，不能把目前 400 則顯示上限當成永久無法查閱的歷史邊界。
   > 註記（2026-10-27）：已實作（階段 6.1）。schema 開放 `cancel_subagent {subagentId}` 與 `steer_subagent {subagentId, message}`（上游 `/tmp/omp-upstream/packages/coding-agent/src/modes/rpc/rpc-types.ts` L73-74；handler 見同 repo `rpc-mode.ts` L2278-2304，cancel 回 `{cancelled:boolean}`、false=已不在執行如實顯示，steer 失敗回 error 原文呈現）；`get_subagent_messages` 加 `sessionFile` 選擇子（上游 `rpc-types.ts` L72，白名單解析見 `rpc-subagents.ts` `resolveSessionFile`）。roster 對 running/pending 子代理提供停止鈕（double-click 以 pending 鍵擋下、不重送）；running 子代理 transcript 下方提供導引輸入。歷史：panel 新增「載入更早」，以 `fromByte` 位元組游標自 0 逐頁補到 live 游標邊界（上游回應形狀 `RpcSubagentMessagesResult{sessionFile,fromByte,nextByte,reset,entries,messages}`，`rpc-types.ts` L357-364；讀取語意 `rpc-subagents.ts` `readRpcSubagentTranscript` L70-112：fromByte → 最後一完整行）；補回的歷史頁存於 `agent.history`（不受 400 視窗上限限制），渲染時與 live 視窗以 role:timestamp 去重、時間升冪併接；視窗溢出時自動把歷史游標標記為不完整，保證被擠出段落永遠可再取回。`set_subagent_subscription` 已在 schema，panel roster 補上 off/progress/events 切換（僅在 RPC 回應確認後更新顯示）。測試：`tests/backend/agent-rpc-command-schema.test.ts`「subagent RPC boundary」、`tests/frontend/subagent-control.test.tsx`、`tests/frontend/subagents.test.tsx`「subagent control and history UI」。
2. 影像與其他 tool content 保留原始型別，安全呈現；custom renderer 有對應 GUI adapter，無 adapter 時使用可讀資料視圖。
   > 註記（2026-10-27）：已實作。livedecoder 與持久化 reader 共用 `src/lib/events/message-content.ts` 的形狀語意（GAP 1-5 註解即型別對照表）：image block 僅白名單 MIME + base64 → `data:` URL；未知 content block → `unsupported` part 帶 bounded JSON `data`（可讀資料視圖，`attachment-part.tsx` 呈現，無 data 時僅標籤）；TUI custom renderer 不可執行，一律降級為資料視圖並明示。三態（live stream / session 重開 / fork 後新 leaf）parity 由 `tests/frontend/tool-content-parts.test.ts`、`tests/backend/live-persisted-parity.test.ts`、`tests/backend/transcript.test.ts` fork 案例斷言；XSS 面：hostile payload 永遠 escaped text、尺寸截斷。
3. TUI custom component、editor、補全與快捷鍵需要 GUI extension contract 或上游協定擴充。建立能力清單及 adapter，不承諾所有第三方終端元件能無修改直接搬用。
   > 註記（2026-10-27）：能力清單與 extension 作者 adapter 介面見 [gui-extension-contract.md](gui-extension-contract.md)，程式端真相源為 `src/lib/extension-capabilities.ts` 的 `EXTENSION_CAPABILITIES`（逐項附上游 path:line 證據）。wire 未認領的 `extension_ui_request` 不再靜默丟棄——已知不支援（`setTitle`）與未知方法在 composer 上方顯示可關閉的警告徽章，未知方法另以 cancelled 回應防掛起（上游對無待定請求的回應為 no-op）。extension 自訂快捷鍵 `registerShortcut` 無 wire 公告，屬文件層明示的 unsupported；自訂元件、header/footer、composer shape、補全 provider 等 TUI 元件類能力同列 unsupported/degraded，需上游協定擴充（清單見 contract 文件第五節）。
4. 完成語音、live、record、pause 等工作流程的語意對照，GUI 自有語音功能不能僅因名稱相似就當作已等價。
   > 註記（2026-10-27）：對照表見 [live-voice-parity.md](live-voice-parity.md)。結論：live voice 經 RPC（`live_start/stop/mute`＋`live_*` 事件）完整接線為 equivalent；`/record`（終端畫面錄製）、`/pause`（全螢幕凍結）為 upstream-only、無 RPC 面；GUI dictation 為 GUI-only STT 填詞，不標等價。
5. GUI 程序回收前確認沒有 pending UI、background work 或必須保留的 session 狀態；可恢復狀態由 OMP 持久化。若無法無損恢復，就不要自動回收該 runtime。

驗收：工具產物在 live／重開／fork 後均可讀；子代理歷史可完整查閱；支援的 extension 能完成全部互動；不支援的第三方元件有明確狀態而非靜默失效。

### 階段 7：以真實 OMP 建立一致性驗證

建立可重跑的 parity 測試工具，使用臨時 HOME、固定 OMP 版本、固定設定與 fixture provider，分別驅動 TUI 與 GUI／RPC。每個案例從等價但獨立的 session 副本開始，避免同檔鎖定污染結果。

比較結果應包含：命令回覆、事件順序中的必要先後關係、active branch、已接受／已消耗佇列、模型與模式設定、compaction 紀錄及 artifacts。正規化隨機 ID、時間與測試路徑後比較，不以截圖相似或模型回答相似代替語意驗證。

| 驗收群組 | 必測案例 |
|---|---|
| Session | 新增、resume、兩個 fork、指定 leaf branch、rewind、搬移、鎖衝突、刪除及 artifact |
| Compact | 手動、各可用模式、自動 threshold、overflow、取消、失敗、事件晚到、完成後續問、重開 |
| 輸入 | idle／busy、Enter／modifier、空白輸入、shell／Python、skill＋圖片、命令 aliases |
| Queue | 文字／圖片混合、steer、follow-up、取回、promote、Stop、重啟、回覆遺失 |
| UI 請求 | 長 approval、取消、timeout、並行問題、上游 cancel、status、widget、editor、notice |
| 模式與設定 | goal／plan 等生命週期、Fast／Slow、設定作用域、登入、MCP reload／認證 |
| 顯示 | activeLeaf、off-branch late result、非文字 tool output、子代理分頁、live 與重開一致 |

網路 provider／OAuth 等無法完全 hermetic 的項目另有受控整合驗收，不以 mock 通過宣稱外部整合成功。CI 執行主要離線案例；支援版本更新時重新跑協定與命令覆蓋檢查。全部驗證使用 repo 規定的 Node／npm toolchain。
   > 註記（2026-10-27）：parity 工具落地於 `scripts/parity/`（fixture provider＋RPC/TUI 雙驅動＋正規化比較，README 见各檔）。已落地案例：consistency-basic、divergence-detector（工具自檢）、session-fork（RPC `fork` vs TUI `/fork`）、compact-parity（`compact` vs `/compact`，含上游 16k-token 門檻處理）、queue-abort-restore（`follow_up`＋`abort_and_restore_queue` vs TUI 排隊＋Esc）——五案例實測連續兩輪全 PASS（omp 18.13.1；獨立審查者重跑重現過 compact 案例的 TUI 收束競態，已以「session 檔落盤信號＋keepRecentTokens 種子＋waitForIdle」修正後穩定）。**已證實上游表面差異（finding，非 app 缺陷）**：TUI Esc（`session.abort`）保留中止輪落盤，RPC `abort_and_restore_queue` 回滾 in-flight 輪；`service_tier_change`（RPC）vs `model_change`（TUI) bookkeeping；system-prompt digest 必異。未覆蓋子案例（resume/rewind/move/lock衝突/auto-compact/overflow/取消/失敗、UI 請求需 extension fixture、mode 設定群組）為 README 延伸點，輸入/顯示子項由 2618 項測試套件與 Electron e2e 覆蓋。
   > 註記（2026-10-27，受控整合）：`scripts/parity/real-provider-smoke.mjs` 以隔離 temp HOME＋真實設定快照（models.yml/models.db 副本，不寫回真實 `~/.omp`）＋設定檔引用之憑證環境變數轉發，對真實 provider（NCHC）跑單一極小 prompt——實測 PASS（exit 0、2.3s、回覆符合預期、無錯誤）。**缺失先決條件（不自動化、不以 mock 宣稱）**：OAuth 瀏覽器登入流（anthropic/openai-codex/github-copilot 等）無法 headless 驗證；login/logout RPC schema 與面板流程由單測覆蓋（agent-rpc-command-schema OAuth describe、provider-accounts*），真實瀏覽器往返待手動步驟：Capabilities→Providers→Sign in→完成系統瀏覽器授權→確認徽章變 Signed in、`get_login_providers` 顯示 authenticated。

每階段先加入能表達真實差異的失敗案例，再修復、執行相關測試，完成可驗證單位後才進下一階段。最終執行 `docs/validation.md` 的完整檢查與 Electron E2E，不能只靠上述 195 項舊測試。

### 已知次要事項（獨立審查 7.6 minor，不阻擋）

- `src/hooks/useSubagents.ts` 的歷史併接以 `role:timestamp` 為去重鍵：同 role 且同毫秒的兩則訊息會被吞掉一則（上游 `AgentMessage` 有更強的 id 可用；發生機率低，歷史併接正確性依賴此鍵，列為後續強化）。
- 子代理 `cancel()` 在「已在送出中」時回 false，面板顯示「已不在執行中」——語意可再細分（按鈕 disabled 已擋掉主要路徑）。
- `extension_ui_response` 的 `selectedOptions` 已補 per-item 64 KiB 上限（審查 m6，已修）。

### 完成定義與依賴

- 階段 1–3 優先解除錯誤對話、停止不完整與互動卡住的風險，屬於第一批必要修復。
- 階段 4–6 完成完整功能對齊。上游 RPC 缺口、TUI 專用 extension adapter 與網路 MCP 政策更新都要有明確待辦，不能從完成範圍刪除。
- 階段 7 的測試隨各階段加入，不等全部開發結束才補。
- 所有已支援的 TUI 操作都有對應 GUI 入口或命令，且命令覆蓋表無未說明的缺口，才能宣稱達到本次「GUI 跟 TUI 一樣」的目標。
- 發布前需以真實 OMP 重新驗證使用者的 compact 情境；未取得該案例的足夠證據前，僅能宣稱相關缺陷已修，不宣稱歷史事故根因已確認。
