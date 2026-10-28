#!/usr/bin/env node
// End-to-end test of the extension in a real Chrome: settings page → a fake
// Facebook-style post (truncated caption, link hidden in the comments behind an
// l.facebook.com redirect) → send → what the server received → what the popup shows.
//
//   CHROME=/path/to/"Google Chrome for Testing" node apps/chrome-extension/e2e.mjs
//
// Branded Chrome ignores --load-extension (Chrome 137+); use Chrome for Testing or Chromium.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) {
  console.error("Set CHROME to a Chrome for Testing or Chromium binary.");
  process.exit(2);
}
const EXT = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

// SCREENSHOTS=<dir> also saves pictures of the settings page and the popup
// over the post; SHOT_LANG=zh-TW writes the canned summary in Chinese.
const SHOTS = process.env.SCREENSHOTS;
const ZH = process.env.SHOT_LANG === "zh-TW";
const SUMMARY = ZH
  ? { oneLiner: "以 pi 為核心、會依你的習慣調整的輕量 agentic IDE", highlights: ["每個任務一個 git worktree 工作區", "活規格（SPEC.md）讓 agent 記得專案意圖", "內建終端機、diff 檢視與 PR 流程"] }
  : { oneLiner: "A lightweight agentic IDE built around pi", highlights: ["A git-worktree workspace per task", "Living specs (SPEC.md) the agent keeps up to date", "Terminals, diffs and the PR flow built in"] };

// ── A fake driftnet: records what the extension sends ───────────────────────
const received = [];
const api = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/stats") return res.end(JSON.stringify({ items: 7, shares: 9, byCategory: {} }));
  if (req.url === "/api/ui") return res.end(JSON.stringify({ locale: "en", categories: { "coding-agent": { en: "Coding agents", "zh-TW": "AI 寫程式" } } }));
  if (req.url === "/api/ingest" && req.method === "POST") {
    received.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
    return res.end(JSON.stringify([{ cached: false, item: {
      id: 42, title: "ThinkRail", category: "coding-agent", worth: "must-see", url: "https://github.com/jetbrains/thinkrail",
      summary: { name: "ThinkRail", ...SUMMARY },
    } }]));
  }
  res.statusCode = 404;
  res.end("{}");
});
const apiPort = await listen(api);

// ── A fake social post ──────────────────────────────────────────────────────
const page = createServer((_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><title>AI Tools Daily</title><meta property="og:title" content="A post about an IDE">
<style>
  body { margin: 0; background: #f0f2f5; font: 15px/1.45 -apple-system, "PingFang TC", "Segoe UI", sans-serif; color: #050505; }
  [role=banner] { background: #fff; padding: 12px 20px; color: #65676b; box-shadow: 0 1px 2px #0002; }
  [role=main] { max-width: 560px; margin: 24px 0 0 60px; }
  [role=article] { background: #fff; border-radius: 10px; padding: 16px 18px; box-shadow: 0 1px 2px #0002; margin-bottom: 12px; }
  .who { font-weight: 600; } .when { color: #65676b; font-size: 13px; }
  #more { color: #65676b; font-weight: 600; cursor: pointer; display: inline; }
  .bar { display: flex; gap: 24px; border-top: 1px solid #e4e6eb; margin-top: 12px; padding-top: 8px; color: #65676b; font-weight: 600; }
  #side { max-width: 560px; margin-left: 60px; }
  .thumb { height: 150px; border-radius: 8px; margin-top: 10px; background: linear-gradient(135deg, #1b2b4a, #2459e0 60%, #0f9f8f); }
  a { color: #216fdb; }
</style></head>
<body><div role="banner">feed · Home · Watch · Groups</div>
<div role="main"><div role="article">
  <div class="who">AI Tools Daily</div><div class="when">2h · 🌐</div>
  <p id="cap">Try this agent IDE…</p><div role="button" id="more">See more</div>
  <div class="thumb"></div>
  <div class="bar"><span>👍 Like</span><div role="button" aria-label="Comment" id="cbtn">💬 Comment</div><span>↗ Share</span></div>
</div></div>
<div role="complementary" id="side"></div>
<script>
  more.onclick = () => { cap.textContent = "Try this agent IDE. It runs pi in a real editor with worktrees and a spec graph. Link in the comments."; more.remove(); };
  cbtn.onclick = () => { side.innerHTML = '<div role="article">Here you go: <a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fgithub.com%2Fjetbrains%2Fthinkrail%3Ffbclid%3Dabc&h=x">github.com/jetbrains/thinkrail</a></div>'; };
</script></body></html>`);
});
const pagePort = await listen(page);

// ── Chrome with the extension ───────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), "driftnet-e2e-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--lang=en-US",
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  // macOS takes the UI language from AppleLanguages, not --lang. Chrome also reads
  // the "(en)" as the start page, so it must be the only positional argument.
  ...(process.platform === "darwin" ? ["-AppleLanguages", ZH ? "(zh-TW)" : "(en)"] : ["about:blank"]),
], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = "";
  chrome.stderr.on("data", (d) => {
    err += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
    if (m) resolve(m[1]);
  });
  chrome.on("exit", () => reject(new Error(`Chrome exited:\n${err}`)));
});

// Minimal CDP client over the browser endpoint, flat sessions.
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const evaluate = async (sessionId, expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const open = async (url) => {
  const { targetId } = await cdp("Target.createTarget", { url });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  return sessionId;
};
const waitFor = async (sessionId, expression, what, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await evaluate(sessionId, expression).catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
};

const shoot = async (sessionId, file, width, height) => {
  if (!SHOTS) return;
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(SHOTS, { recursive: true });
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false }, sessionId);
  await sleep(300);
  const { data } = await cdp("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(join(SHOTS, file), Buffer.from(data, "base64"));
};

let failed = false;
try {
  // The extension's id, from its service worker.
  let extId;
  for (let i = 0; i < 50 && !extId; i++) {
    const { targetInfos } = await cdp("Target.getTargets");
    // Ours is the one whose worker is background.js (Chrome has built-in component extensions too).
    extId = targetInfos.find((t) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url))?.url.split("/")[2];
    if (!extId) await sleep(200);
  }
  assert.ok(extId, "extension did not load");
  console.log("✓ extension loaded:", extId);

  // 1. Settings page: point it at the fake server and test the connection.
  const options = await open(`chrome-extension://${extId}/options.html`);
  await waitFor(options, `document.getElementById("save").textContent`, "options page");
  await evaluate(options, `
    document.getElementById("serverUrl").value = "http://127.0.0.1:${apiPort}";
    document.getElementById("token").value = "secret-token";
    document.getElementById("save").click();`);
  const saved = await waitFor(options, `document.getElementById("result").textContent`, "settings result");
  assert.match(saved, /7 (items|則)/); // the UI follows the browser language: en or zh-TW
  console.log("✓ settings saved and tested:", saved);
  await shoot(options, "options.png", 560, 420);

  // 2. The post, then send it the way the popup does.
  const postSession = await open(`http://127.0.0.1:${pagePort}/post`);
  await sleep(500);
  const tabId = await evaluate(options, `chrome.tabs.query({ url: "http://127.0.0.1:${pagePort}/*" }).then((t) => t[0].id)`);
  const popup = await open(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
  const status = await waitFor(popup, `(() => { const s = document.getElementById("status"); return /Saved|Could not|Already|已收錄|傳送失敗|之前收錄/.test(s.textContent) && s.textContent; })()`, "popup result", 20000);
  assert.match(status, /^(Saved|已收錄)$/);

  // 3. What the server received.
  assert.equal(received.length, 1);
  const { auth, body } = received[0];
  assert.equal(auth, "Bearer secret-token");
  assert.equal(body.platform, "chrome");
  assert.equal(body.url, `http://127.0.0.1:${pagePort}/post`);
  assert.match(body.page.text, /spec graph\. Link in the comments\./, "caption was expanded");
  assert.match(body.page.text, /Here you go/, "comments were opened and read");
  assert.doesNotMatch(body.page.text, /Groups/, "page chrome (banner) left out");
  assert.ok(body.page.links.includes("https://github.com/jetbrains/thinkrail?fbclid=abc"), "redirect decoded");
  assert.ok(!body.page.links.some((l) => l.includes("l.facebook.com")));
  console.log("✓ sent: expanded caption, opened comments, decoded link →", body.page.links.join(", "));

  // 4. What the popup shows.
  const shown = await evaluate(popup, `document.getElementById("item").innerText + " | " + document.getElementById("open").href`);
  assert.match(shown, /ThinkRail/);
  assert.match(shown, /Coding agents|AI 寫程式/);
  assert.match(shown, /must-see|必看/);
  assert.match(shown, /worktree/);
  assert.match(shown, new RegExp(`127\\.0\\.0\\.1:${apiPort}/#item-42`));
  console.log("✓ popup:", shown.replace(/\n+/g, " · "));
  await shoot(popup, "popup.png", 360, 268);
  await shoot(postSession, "post.png", 1100, 620);

  // 5. A page the extension may not read reports it instead of failing silently.
  const blank = await evaluate(options, `chrome.tabs.create({ url: "chrome://version", active: false }).then((t) => t.id)`);
  const popup2 = await open(`chrome-extension://${extId}/popup.html?tab=${blank}`);
  const err = await waitFor(popup2, `(() => { const s = document.getElementById("status"); return /can't be read|無法讀取/.test(s.textContent) && s.textContent; })()`, "error message");
  console.log("✓ unreadable page reported:", err);
  console.log("\nall extension checks passed");
} catch (err) {
  failed = true;
  console.error("✗", err.message);
} finally {
  ws.close();
  chrome.kill();
  api.close();
  page.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
