# OMP Parity Harness

以**真實 `omp` binary** 在隔離的臨時 HOME 中驅動確定性 fixture provider，驗證
RPC 協定面、provider 設定與實機 GUI 行為。禁止截圖或渲染相似度；斷言一律走
語意投影或可觀察狀態。

> 內建終端移除後，原本的 RPC／TUI 雙 surface 比對工具（`run.mjs`、
> `tui-driver.mjs`、`rpc-driver.mjs`、`temp-home.mjs`、`normalize.mjs`、
> `compare.mjs`）已一併退役：TUI 驅動需要 `node-pty`，而該依賴不再隨 app
> 出貨。留下的工具都不需要 PTY（`live-app-drive.mjs` 另需 Playwright）。

## 檔案

|檔案|職責|
|---|---|
|`fixture-provider.mjs`|OpenAI 相容確定性 provider（SSE/JSON、常數 id/created、`fixture-ack[N]:<text>` 回覆、剝除 `<system-reminder>`）|
|`smoke-fixture.mjs`|實測 fixture 能被真 binary 使用：`omp -p` 單一 prompt，期待 `fixture-ack[1]:hello fixture`|
|`real-provider-smoke.mjs`|受控真 provider 煙測：複製真實 models 設定的唯讀快照到隔離 HOME，送一則極小 prompt，只回報長度與是否命中（不印回覆內容）|
|`live-app-drive.mjs`|實機 GUI 動態測試：連上以 CDP 9222 啟動的 OMP Desktop，逐步斷言可觀察行為|

## 重跑

```bash
node scripts/parity/smoke-fixture.mjs [--omp /opt/homebrew/bin/omp]
node scripts/parity/real-provider-smoke.mjs [--omp /opt/homebrew/bin/omp]
node scripts/parity/live-app-drive.mjs   # 先以 --remote-debugging-port=9222 啟動 app
```

- 每個工具自建 mkdtemp HOME／session 目錄，跑完即刪；不寫入真實 `~/.omp`。
- 輸出：stderr 逐步 PASS/FAIL，stdout JSON 摘要；exit 0 僅當全部案例通過。

## 已知限制（誠實邊界）

- `real-provider-smoke.mjs` 只證明「設定的 provider 對一則極小 prompt 有回應」，
  不證明模型輸出品質或 GUI 渲染等價。
- OAuth 瀏覽器登入流無法 headless 驗證（login/logout RPC schema 與面板流程由
  單測覆蓋），真實瀏覽器往返仍需手動步驟。
- `live-app-drive.mjs` 依賴實際啟動的 app 與真實環境，不是 CI gate。
