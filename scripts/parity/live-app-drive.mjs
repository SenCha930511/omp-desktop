#!/usr/bin/env node
/**
 * 實機動態測試（7.8）：連上以真實環境啟動的 OMP Desktop（CDP 9222），
 * 驅動 parity 功能面並斷言可觀察行為。真 ~/.omp、真 omp binary、真
 * provider（僅送一則極小 prompt）。輸出每步 PASS/FAIL 與證據文字。
 */
import { chromium } from "playwright";

const results = [];
const step = (name, ok, evidence) => {
	results.push({ name, ok, evidence: String(evidence ?? "").slice(0, 300) });
	console.log(
		`${ok ? "PASS" : "FAIL"} ${name}${evidence ? " | " + String(evidence).slice(0, 220) : ""}`,
	);
};

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const contexts = browser.contexts();
const pages = contexts.flatMap((context) => context.pages());
const page =
	pages.find((candidate) => candidate.url().startsWith("omp-desktop://")) ??
	pages[0];
if (!page) {
	console.log(
		"FAIL no page found; pages=" + JSON.stringify(pages.map((p) => p.url())),
	);
	process.exit(1);
}
step("cdp-connected", true, page.url());

// 1) 側欄專案與 session 清單（真實資料）
await page
	.waitForSelector('.session-row, [class*="session"]', { timeout: 15000 })
	.catch(() => undefined);
const sidebarText = await page
	.locator('nav, aside, [class*="sidebar"]')
	.first()
	.innerText()
	.catch(() => "");
step(
	"sidebar-sessions",
	/New session|Projects|工作階段|專案/i.test(sidebarText),
	`sidebar len=${sidebarText.length}`,
);

// 2) 開一個新 session（1.8 durable 空 session 邊界）
const newButton = page
	.getByRole("button", { name: /^(新增工作階段|New session)/i })
	.first();
await newButton.click();
await page.waitForTimeout(1500);
const composer = page.getByRole("combobox").first();
const composerVisible = await composer.isVisible().catch(() => false);
step("new-session-composer", composerVisible);

// 3) 模型選擇器（真實 provider 目錄）
const modelTrigger = page.locator(".model-picker__trigger").first();
const modelName = await modelTrigger
	.getAttribute("aria-label")
	.catch(() => null);
step("model-picker", Boolean(modelName), modelName);

// 4) 送一則極小 prompt 給真 provider（5.1/2.x live 路徑）。斷言終態內容：
// 串流佔位（「思考中/Thinking」標籤）不算數——必須等到該列脫離串流
// 佔位且有實際文字，且內容含 'ok'（prompt 要求模型只回 ok），杜絕
// 「provider 掛掉但佔位文字讓步驟 PASS」的假陽性（第二輪審查 M1）。
let assistantReply = "";
if (composerVisible) {
	await composer.fill("reply with exactly: ok");
	await composer.press("Enter");
	const reply = page.locator(".message--assistant").last();
	await reply
		.waitFor({ state: "visible", timeout: 90000 })
		.catch(() => undefined);
	const deadline = Date.now() + 90000;
	while (Date.now() < deadline) {
		assistantReply = (await reply.innerText().catch(() => "")).trim();
		// 佔位列形狀：「思考中/Thinking」＋經過時間（0s/12s/1m，含單位）。
		// 完成列形狀：「已工作 3s」＋內容＋「複製」。開頭非佔位標籤＝終態。
		if (
			assistantReply.length > 0 &&
			!/^(思考中|thinking)\s*[\dms]*$/i.test(assistantReply)
		) {
			break;
		}
		await page.waitForTimeout(1000);
	}
}
step(
	"real-provider-prompt",
	/\bok\b/i.test(assistantReply),
	`reply="${assistantReply.slice(0, 60)}"`,
);

// 5) compact（1.3）：/compact 觸發手動壓縮；權威證據=真 session 檔出現
// compaction entry（下游讀 ~/.omp 的最新 session 檔）。
await composer.fill("/compact").catch(() => undefined);
await composer.press("Enter").catch(() => undefined);
// 上游結果（成功壓縮或「Nothing to compact」）以 toast 呈現、會自動
// 消失——在等待窗內輪詢捕捉，而非事後讀 body（否則誤判 no-outcome）。
let compactOutcomeText = "";
const compactDeadline = Date.now() + 15000;
while (Date.now() < compactDeadline) {
	const bodyNow = await page.locator("body").innerText().catch(() => "");
	const match = bodyNow.match(
		/nothing to compact[^\n]*|too small[^\n]*|compaction[^\n]*/i,
	);
	if (match) {
		compactOutcomeText = match[0];
		break;
	}
	await page.waitForTimeout(500);
}
const { readdirSync, readFileSync, statSync } = await import("node:fs");
const { homedir } = await import("node:os");
const pathMod = await import("node:path");
const sessionsRoot = pathMod.join(homedir(), ".omp", "agent", "sessions");
let newestSession = "";
let newestMtime = 0;
const walk = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = pathMod.join(dir, entry.name);
		if (entry.isDirectory()) walk(full);
		else if (entry.name.endsWith(".jsonl") && !entry.name.startsWith(".")) {
			const mtime = statSync(full).mtimeMs;
			if (mtime > newestMtime) {
				newestMtime = mtime;
				newestSession = full;
			}
		}
	}
};
try {
	walk(sessionsRoot);
} catch {
	/* unreadable root */
}
let compactionSeen = false;
let upstreamOutcome = "";
try {
	compactionSeen =
		newestSession !== "" &&
		readFileSync(newestSession, "utf8").includes('"type":"compaction"');
} catch {
	/* unreadable */
}
// 真實環境門檻（keepRecentTokens 預設 20000）：單輪對話 compact 是合理
// NO-OP——上游會回「session too small」，1.3 的要求是這個結果要可見，
// 不是靜默。對話轉錄或通知需出現壓縮結果（成功或 NO-OP 訊息）。
upstreamOutcome = compactOutcomeText
	? "outcome-visible"
	: "no-visible-outcome";
step(
	"manual-compact",
	compactionSeen || upstreamOutcome === "outcome-visible",
	`entry=${compactionSeen} outcome=${upstreamOutcome}`,
);

// 6) session 設定面板（5.2）：在 context popover 內——點 context-usage-dial
// 開啟後 section.session-settings 應可見。
await page
	.locator("button.context-usage-dial")
	.first()
	.click()
	.catch(() => undefined);
await page.waitForTimeout(800);
const settingsPanel = page
	.locator(
		'section.session-settings, [aria-label="工作階段設定"], [aria-label="Session settings"]',
	)
	.first();
step(
	"session-settings-panel",
	await settingsPanel.isVisible().catch(() => false),
);
await page.keyboard.press("Escape").catch(() => undefined);

// 6b) 子代理（6.1）：fresh session 無子代理可渲染——roster 由事件驅動，
// 實機 spawn 不具成本效益且不確定；覆蓋由 59 項單測＋parity harness
// （真 omp RPC）承擔，此處僅確認不影響主對話（已由 prompt 步驟證明）。
// 註記不計分：覆蓋由 59 項單測＋parity harness（真 omp RPC）承擔，
// 實機 spawn 不具成本效益且不確定（第二輪審查 M2：不得以硬編碼
// PASS 灌水通過數）。
console.log(
	"NOTE subagent-live-coverage: covered by unit tests + parity harness (live spawn nondeterministic)",
);

// 9) Capabilities 頁（5.3 provider 帳號＋5.5 MCP reload）
const capabilitiesButton = page
	.getByRole("button", { name: /^(功能|Capabilities)/i })
	.first();
await capabilitiesButton.click().catch(() => undefined);
await page.waitForTimeout(1500);
const capsText = await page
	.locator("body")
	.innerText()
	.catch(() => "");
step(
	"provider-accounts-panel",
	/Provider accounts|Sign in|提供者/i.test(capsText),
);
step("mcp-reload-buttons", /Reload MCP|重新載入 MCP/i.test(capsText));

// 9) 回 session 檢視（側欄第一個 session）
await page
	.getByRole("button", { name: /New session/i })
	.first()
	.click()
	.catch(() => undefined);
await page.waitForTimeout(1000);

// 11) session tree 對話框（1.6）：slash /tree 開樹狀對話框。
await page
	.getByRole("button", { name: /^(新增工作階段|New session)/i })
	.first()
	.click()
	.catch(() => undefined);
await page.waitForTimeout(1000);
const composerNow = page.getByRole("combobox").first();
await composerNow.fill("/tree").catch(() => undefined);
await page.waitForTimeout(800);
await composerNow.press("Enter").catch(() => undefined);
await page.waitForTimeout(2000);
const treeVisible = await page
	.locator('.session-tree, [class*="session-tree"]')
	.first()
	.isVisible()
	.catch(() => false);
const dialogVisible = await page
	.locator('[role="dialog"]')
	.first()
	.isVisible()
	.catch(() => false);
step(
	"session-tree-dialog",
	treeVisible || dialogVisible,
	`tree=${treeVisible} dialog=${dialogVisible}`,
);
await page.keyboard.press("Escape").catch(() => undefined);

const failed = results.filter((item) => !item.ok);
console.log("---");
console.log(
	JSON.stringify(
		{
			total: results.length,
			passed: results.length - failed.length,
			failed: failed.map((item) => item.name),
		},
		null,
		2,
	),
);
await browser.close();
process.exit(failed.length === 0 ? 0 : 1);
