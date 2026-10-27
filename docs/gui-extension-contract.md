# GUI Extension Contract（階段 6.3）

定義 OMP Desktop（Electron 前端、經 JSON-RPC 驅動 `omp` agent）對上游 extension API 的實際支援範圍、明示不支援項的機制，以及 extension 作者在 GUI 主機上需要的 adapter 介面。

基準：上游 oh-my-pi v18.12.6（commit 45c35e4），checkout 於 `/tmp/omp-upstream`。所有上游證據路徑相對 `packages/coding-agent/`。程式端唯一真相源是 [`src/lib/extension-capabilities.ts`](../src/lib/extension-capabilities.ts) 的 `EXTENSION_CAPABILITIES` registry，本表與其同步。

原則：

- **不承諾**第三方終端（TUI）元件能無修改直接搬用：TUI 元件樹無法跨行程序列化，凡是回傳 Component/CustomEditor 的 API 在 RPC 主機（GUI 即其一）下必然降級或不支援。
- **不靜默失效**：能抵達 app 的 `extension_ui_request` frame，若 GUI 不支援，一律在 composer 上方顯示明確徽章；從未離開上游行程的能力在此文件與 registry 逐一標示。

## 一、能力清單表

給定上游 extension API 的每個能力 × GUI 狀態 × 呈現方式 × 上游證據。狀態：`supported`（已驗證有完整 GUI 面）/ `degraded`（以資料視圖呈現，功能縮減但有明確替代）/ `unsupported`（明示不支援）。

### A. 對話與互動（等待 `extension_ui_response`）

| 能力 | GUI 狀態 | 呈現方式 | 上游證據 |
|---|---|---|---|
| `ui.select` | supported | ExtensionUiModal 選擇對話框（含 optionDetails、questionnaire 群組） | extensibility/extensions/types.ts:308 |
| `ui.confirm` | supported | ExtensionUiModal 確認對話框 | extensibility/extensions/types.ts:315 |
| `ui.input` | supported | ExtensionUiModal 單行輸入對話框 | extensibility/extensions/types.ts:320 |
| `ui.editor` | supported | ExtensionUiModal 多行編輯對話框 | extensibility/extensions/types.ts:389 |
| `ui.askDialog` | supported | host 以 `set_ask_dialog` 宣告後啟用，ExtensionUiModal 豐富問卷 | extensibility/extensions/types.ts:323、modes/rpc/rpc-mode.ts:2142 |
| `ui.approve` | degraded | 上游 RPC host 未實作 `approve`（選用方法），呼叫者統一降級為 `select`，GUI 以選擇對話框呈現 | extensibility/extensions/types.ts:337、modes/rpc/rpc-mode.ts:1425（class 無 approve 方法） |
| wire `cancel` frame | supported | 上游結算時關閉 GUI 待回應請求（3.6） | modes/rpc/rpc-types.ts:729 |

### B. 呈現型更新（fire-and-forget）

| 能力 | GUI 狀態 | 呈現方式 | 上游證據 |
|---|---|---|---|
| `ui.notify` | supported | 導入指令輸出（src/hooks/useAgentEvents.ts:128） | modes/rpc/rpc-mode.ts:1487 |
| `ui.setStatus` | supported | composer 上方狀態列 | modes/rpc/rpc-mode.ts:1498 |
| `ui.setWidget`（字行內容） | supported | composer 上/下方多行文字面板（依 placement 分流） | modes/rpc/rpc-mode.ts:1513 |
| `ui.setWidget`（component factory） | unsupported | 上游 RPC mode 直接忽略 factory，frame 不會送出；extension 應自備字行降級 | modes/rpc/rpc-mode.ts:1513 註解 |
| `ui.setEditorText` / `ui.pasteToEditor` | degraded | 預覽卡片，需使用者明確「套用/關閉」；`pasteToEditor` 上游降級為 `set_editor_text` | modes/rpc/rpc-mode.ts:1552、:1557 |
| `ui.getEditorText` | degraded | 上游固定回傳 `""`（同步語意無法跨行程）；依賴 composer 內容的 extension 判斷會失準 | modes/rpc/rpc-mode.ts:1567 |
| wire `open_url` frame | supported | 安全網址卡片（僅 http/https），供 OAuth 等流程手動開啟（3.5） | modes/rpc/rpc-mode.ts:2550 |
| `ui.setTitle` | unsupported | 視窗標題由 GUI 自主管理；收到時顯示「不支援」徽章。上游亦預設不送（`PI_RPC_EMIT_TITLE=1` opt-in） | modes/rpc/rpc-mode.ts:1536 |

### C. 上游 RPC mode 內即 stub/忽略的能力（無 wire frame，文件層明示）

| 能力 | GUI 狀態 | 說明 | 上游證據 |
|---|---|---|---|
| `ui.setWorkingMessage` | unsupported | RPC host 忽略；工作訊息為 GUI 本機渲染 | modes/rpc/rpc-mode.ts:1509 |
| `ui.onTerminalInput` | unsupported | RPC mode 無終端輸入通道（no-op） | modes/rpc/rpc-mode.ts:1482 |
| `ui.custom`（自訂疊層元件） | unsupported | 上游直接回傳 `undefined`；元件樹不可序列化 | modes/rpc/rpc-mode.ts:1547 |
| `ui.setHeader` / `ui.setFooter` | unsupported | RPC mode 忽略；GUI 版面固定，替代方案：status/widget 字行 | modes/rpc/rpc-mode.ts:1528 |
| `ui.setEditorComponent` | unsupported | RPC mode 忽略；GUI composer 是 Web 元件、無 CustomEditor 對應 | modes/rpc/rpc-mode.ts:1612 |
| `ui.addAutocompleteProvider` | unsupported | 文件明定 headless/RPC 模式接受並忽略；無補全請求 wire 通道 | extensibility/extensions/types.ts:399 |
| `ui.openTerminal`（選用） | unsupported | RPC host 未實作（選用方法缺省），extension 須自行降級 | extensibility/extensions/types.ts:317 |
| theme API（`ui.theme`/`getAllThemes`/`getTheme`/`setTheme`） | unsupported | 上游回傳固定 theme 或 `not supported` 錯誤；GUI 主題本機管理 | modes/rpc/rpc-mode.ts:1586 |
| `ui.getToolsExpanded` / `setToolsExpanded` | unsupported | 上游回傳固定值並忽略寫入 | modes/rpc/rpc-mode.ts:1603 |

### D. ExtensionAPI 註冊面

| 能力 | GUI 狀態 | 呈現方式 | 上游證據 |
|---|---|---|---|
| `api.registerTool`（執行） | supported | 工具正常註冊、執行，`tool_execution_*` 事件流向 GUI | extensibility/extensions/types.ts:1725 |
| ToolDefinition `renderCall`/`renderResult` | degraded | TUI Component 不跨行程；GUI 以通用 args/result 檢視呈現 | extensibility/extensions/types.ts:945 |
| ToolDefinition `describeCall`/`describeResult` | unsupported | TSP 原生終端專用 `NativeToolView`，RPC mode 不序列化 | extensibility/extensions/types.ts:956 |
| `api.registerCommand` | supported | 命令經 `available_commands_update` 抵達 GUI，可派送執行 | extensibility/extensions/types.ts:1789 |
| registerCommand `getArgumentCompletions` | unsupported | 補全於 TUI 編輯器端運算；RPC host 無補全請求通道，GUI 斜線選單不消費此 hook | extensibility/extensions/types.ts:1601 |
| `api.registerShortcut` | unsupported | 註冊無 wire 公告：GUI 無法得知，亦無對映手勢可派發（見第四節） | extensibility/extensions/types.ts:1799 |
| `api.registerMessageRenderer` | degraded | `custom_message` 以具名 activity part 降級呈現（src/lib/events/message-content.ts:93） | extensibility/extensions/types.ts:1828 |
| `api.registerAssistantThinkingRenderer` | unsupported | renderer 是 TUI 元件，不可序列化；GUI 僅顯示原始 thinking 文字 | extensibility/extensions/types.ts:1831 |
| `api.registerComposerShape` | unsupported | 互動編輯器形狀是 TUI 概念、無 wire 面；GUI composer 為 Web 元件 | extensibility/extensions/types.ts:1839 |
| annotations API（`ctx.ui.custom` 疊層） | unsupported | 疊層元件 RPC mode 直接失敗；GUI 另有自建 annotation picker | extensibility/custom-commands/bundled/annotate/fullscreen.ts:114 |

## 二、Extension 作者 GUI adapter 介面

extension 要讓互動在 GUI（以及任何 RPC 主機）可用，請遵下列「GUI 安全子集」：

1. **互動只用對話 API**：`ui.select` / `confirm` / `input` / `editor` / `askDialog` + `dialogOptions.timeout`。這些在 TUI、GUI、其他 RPC 主機都有定義好的語意。
2. **承認 `askDialog` 為選用**：先檢查 `ctx.ui.askDialog` 存在才呼叫，否則自行降級成 `select`（上游 API 本身就是可選成員）。
3. **自訂元件需提供降級**：`ui.custom()` 在 RPC 主機回傳 `undefined`（上游行為），extension 必須容忍並以對話 API 或 `notify` 達成同一流程。
4. **狀態與 widget 用字行內容**：`setStatus`、`setWidget(key, string[])` 皆跨主機安全；component factory 一律不會出現在 RPC 主機。想要 footer/header 功能→改用 `setStatus`。
5. **寫入 composer 前先檢查 `supportsEditor`**，且接受套用失敗；`pasteToEditor` 可能被降級為整段 `set_editor_text`，使用者仍可拒絕套用。
6. **不仰賴終端裝置語意**：`onTerminalInput`、keybinding、外部 editor 快捷鍵、composer shape、自訂補全在 RPC 主機一律無效。
7. **不仰賴主題 API** 交換 UI 狀態；需要可見性就改用 `notify`/`setStatus`。
8. **工具渲染**：`renderCall`/`renderResult` 只在 TUI 生效；RPC 主機以 args/result 資料檢視呈現，故工具的 `output`/`details` 應可獨立讀懂（有訊息價值的文字或結構）。

宣告式替代（若未來需要正式支援 GUI 的 richtext 元件）：extension 宣告一個 web 渲染安全的 descriptor（純資料：標題、欄位、動作），GUI/renderer 依 descriptor 產生介面；這也是第五節向上游建議的協定擴充方向。

## 三、不支援能力的明示機制

兩個層次，缺一不可：

1. **Wire 層（runtime badge）**：`useExtensionUi.showExtensionUi` 對未被 dialog parser、presentation parser、cancel 認領的 `extension_ui_request` 一律不靜默丟棄：
   - 已知但不支援的 fire-and-forget 方法（目前：`setTitle`）→ composer 上方警告徽章「Unsupported extension update: {method}」，可個別關閉，每方法去重、每 runtime 上限 8 條（超出 FIFO evict）。
   - 未知方法 → 徽章「Unrecognized extension update: {method}」，**且**若 frame 帶 `id` 就以 `extension_ui_response {cancelled:true}` 回應——未知的方法可能是新版上游在等待回應的對話，cancelled 回應對上游無待定請求是 no-op（modes/rpc/rpc-mode.ts:393），安全且防止掛起。
   - payload 無效的已知方法 → 沿用既有 rejection 路徑：dialog 類回 cancelled + reportError；presentation 類 reportError（皆已有文字提示）。
   測試：tests/frontend/extension-capability-notice.test.tsx、tests/unit/extension-capabilities.test.ts。
2. **文件/registry 層**：不會產生 wire frame 的能力（header/footer、composer shape、shortcut……）在 `EXTENSION_CAPABILITIES` 與本文件逐一標示，extension 作者與使用者可查證「為什麼沒看到效果」。

## 四、快捷鍵語意邊界

- 2.6 已完成 TUI 預設快捷鍵對映到 GUI 平台快捷鍵，那一層是 GUI 本機 keymap 工作，不在 extension 範圍。
- **extension 自訂快捷鍵（`api.registerShortcut`）：unsupported。** 上游註冊只影響 TUI 的 `KeybindingsManager`；`registerShortcut` 沒有任何 wire 公告（types.ts:1799），GUI 的 runtime 事件流中連「某 extension 註冊了什麼快捷鍵」都不可見，因此無法在 GUI 提供對映手勢或衝突提示。這不是 GUI 漏接，而是協定根本沒帶這份資料。
- 邊界案例：TUI 常用的「在 select/editor 對話中按外部 editor 鍵」對應 `dialogOptions.onExternalEditor` 等 callback（types.ts:200 區塊）——該回呼通道未進 RPC wire，GUI 對話以一般輸入/多行編輯取代，`onExternalEditor` 不會觸發。列入本清單「不支援但對話本身仍 supported」隱含項。
- 若要支援：需上游協定擴充（見第五節第 2 項）。

## 五、仍需上游協定擴充的清單

1. **宣告式元件描述通道**：讓 `ui.custom` 之類呼叫能送一個 web 安全的 descriptor（標題、欄位、動作、目前值）而非 Component factory；GUI 以 descriptor 渲染。沒有它，自訂疊層/annotations 在本 app 永遠 unsupported。
2. **shortcut 公告與派發**：`available_commands_update` 或新 frame 附帶 extension shortcuts（id、key 描述、command/action id），GUI 才能建立 keymap 並把按鍵派發回上游。
3. **序列化工具/訊息檢視**：上游已有 `NativeToolView`（describeCall/describeResult）做語意檢視；若 `tool_execution_*` 事件可選擇性夾帶 `NativeToolView` JSON，GUI 的 degraded 檢視可以升級成部分 supported。同理 `custom_message` 可夾帶純資料檢視（text/欄位），取代現有 activity 降級。
4. **補全請求通道**：host→agent 的 completion 請求（slash 引數、自訂補全 provider），讓 `getArgumentCompletions`/`addAutocompleteProvider` 在 RPC 主機生效。上游目前明定 headless/RPC 忽略（types.ts:399）。
5. **theme 操作命令**：RPC `set_theme`/`list_themes` 命令映射到 GUI 主題選擇（或拒絕的正式回應），取代現行的靜默 stub。
6. **`approve` 方法實作**：上游 host 若實作 approve prompt（含 grants），GUI 能提供原生核准體驗而非 select 降級。

## 六、驗證範圍與邊界

- 支援的對話系（A 表 supported）回歸測試在 tests/frontend/extension-ui.test.ts（3.5/3.6 既有），本項新增測試通過即代表未被破壞。
- Wire 層明示由 tests/frontend/extension-capability-notice.test.tsx 斷言徽章文字（`Unsupported extension update: …`、`Unrecognized extension update: …`）存在且 dismiss 生效。
- 本文件不保證 GUI 可達到 TUI `ctx.ui.custom` 生態的全部互動；承諾僅止於上表 supported/degraded 項。

實作位置：`src/lib/extension-capabilities.ts`（registry＋frame 分類）、`src/hooks/useExtensionUi.ts`（notice state＋dispatch）、`src/components/ExtensionUiPresentation.tsx`（徽章渲染）、`src/i18n/keys/panels.ts`（三語文案）、`src/styles/overlays.css`（徽章樣式）。
