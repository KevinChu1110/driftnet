#!/usr/bin/env node
// End-to-end test of the web page in a real browser, phone-sized with touch:
// swipe left → trash, undo, swipe right → favorite, trash view → restore.
// With SCREENSHOTS=<dir> it also saves desktop and phone pictures for the README.
//
//   CHROME=/path/to/chrome [SHOT_LANG=zh-TW] [SCREENSHOTS=dir] node apps/server/e2e/web.mjs
//
// The catalogue is seeded from demo-items.json: summaries a real model wrote.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "node:net";

const CHROME = process.env.CHROME;
if (!CHROME) {
  console.error("Set CHROME to a Chrome or Chromium binary.");
  process.exit(2);
}
const LANG = process.env.SHOT_LANG === "zh-TW" ? "zh-TW" : "en";
const SHOTS = process.env.SCREENSHOTS;
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });

// ── A catalogue with real summaries ─────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), "driftnet-web-e2e-"));
const port = await freePort();
writeFileSync(join(home, ".env"), `PORT=${port}\nDRIFTNET_JUDGE=off\nDRIFTNET_LANGUAGE=${LANG === "zh-TW" ? "Traditional Chinese (Taiwan)" : "English"}\n`);
const seed = `
  import { Store } from "@driftnet/core";
  const items = JSON.parse(process.env.DEMO_ITEMS);
  const store = new Store(process.env.DEMO_DB);
  for (const i of items) store.upsert({ url: i.url, aliases: [], title: i.title, flags: [], source: "demo", summary: i.summary,
    judgement: { isAiTool: 1, category: i.category, kind: i.kind, worth: i.worth, engine: "llm", confidence: 1 } });
  for (const [id, n] of [[1, 3], [2, 2], [4, 1]]) for (let k = 0; k < n; k++) store.recordShare(id, { platform: "line", chatId: "demo" });
`;
const demo = JSON.parse(readFileSync(join(HERE, "demo-items.json"), "utf8"))[LANG];
await new Promise((resolve, reject) => {
  const p = spawn(join(SERVER, "../../node_modules/.bin/tsx"), ["--eval", seed], {
    cwd: SERVER, stdio: "inherit", env: { ...process.env, DEMO_DB: join(home, "driftnet.db"), DEMO_ITEMS: JSON.stringify(demo) },
  });
  p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("seeding failed"))));
});
const server = spawn(join(SERVER, "../../node_modules/.bin/tsx"), ["src/main.ts"], { cwd: SERVER, env: { ...process.env, DRIFTNET_HOME: home }, stdio: "ignore" });
for (let i = 0; i < 50; i++) {
  if (await fetch(`http://127.0.0.1:${port}/api/stats`).then(() => true, () => false)) break;
  await sleep(200);
}

// ── Chrome ──────────────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), "driftnet-web-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = "";
  chrome.stderr.on("data", (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
  chrome.on("exit", () => reject(new Error(`Chrome exited:\n${err}`)));
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
});
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evaluate = async (s, expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (s, expression, what, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await evaluate(s, expression).catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); }
};
const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
const { sessionId: s } = await cdp("Target.attachToTarget", { targetId, flatten: true });
const viewport = async (width, height, mobile) => {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile }, s);
  await cdp("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 }, s);
};
const shoot = async (file) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const { data } = await cdp("Page.captureScreenshot", { format: "png" }, s);
  writeFileSync(join(SHOTS, file), Buffer.from(data, "base64"));
};
const open = async () => {
  await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/` }, s);
  await evaluate(s, `localStorage.setItem("driftnet-locale", ${JSON.stringify(LANG)})`).catch(() => {});
  await cdp("Page.reload", {}, s);
  await waitFor(s, `document.querySelectorAll(".swipe").length`, "cards");
};
/** A real touch swipe on the card with this id, dx pixels sideways. */
const swipe = async (id, dx) => {
  const box = await evaluate(s, `(() => { const r = document.querySelector('#item-${id} .card').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 30 }; })()`);
  const touch = (type, x) => cdp("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: box.y }] }, s);
  await touch("touchStart", box.x);
  for (let k = 1; k <= 12; k++) { await touch("touchMove", box.x + (dx * k) / 12); await sleep(16); }
  await touch("touchEnd", box.x + dx);
  await sleep(450);
};
const ids = () => evaluate(s, `[...document.querySelectorAll(".swipe")].map((e) => Number(e.dataset.id))`);
const api = (path) => fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json());

let failed = false;
try {
  // Desktop picture first.
  await viewport(1280, 820, false);
  await open();
  await shoot(`web-desktop-${LANG}.png`);

  // Phone, with touch.
  await viewport(390, 844, true);
  await open();
  await shoot(`web-phone-${LANG}.png`);
  const first = (await ids())[0];

  // A picture mid-swipe, then let go short of the threshold: nothing happens.
  {
    const box = await evaluate(s, `(() => { const r = document.querySelector('#item-${first} .card').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 30 }; })()`);
    const touch = (type, x) => cdp("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: box.y }] }, s);
    await touch("touchStart", box.x);
    for (let k = 1; k <= 10; k++) { await touch("touchMove", box.x - 13 * k); await sleep(16); }
    await sleep(150);
    await shoot(`web-phone-swiping-${LANG}.png`);
    for (let k = 9; k >= 0; k--) { await touch("touchMove", box.x - 13 * k); await sleep(16); }
    await touch("touchEnd", box.x);
    await sleep(400);
    assert.ok((await ids()).includes(first), "letting go early keeps the card");
  }

  // Swipe left: to the trash, with an undo toast.
  await swipe(first, -230);
  assert.ok(!(await ids()).includes(first), "card left the list");
  assert.ok((await api(`/api/items/${first}`)).trashedAt, "server has it in the trash");
  assert.ok(await waitFor(s, `document.getElementById("toast").classList.contains("show")`, "undo toast"));
  await shoot(`web-phone-trash-toast-${LANG}.png`);
  console.log("✓ swipe left moved the card to the trash");

  // Undo.
  await evaluate(s, `document.getElementById("toast-undo").click()`);
  await waitFor(s, `[...document.querySelectorAll(".swipe")].some((e) => e.dataset.id === "${first}")`, "card back after undo");
  assert.equal((await api(`/api/items/${first}`)).trashedAt, undefined);
  console.log("✓ undo restored it");

  // Swipe right: favorite. A short swipe must not count.
  const second = (await ids())[1];
  await swipe(second, 40);
  assert.equal((await api(`/api/items/${second}`)).favorite, false, "a short swipe does nothing");
  await swipe(second, 230);
  assert.equal((await api(`/api/items/${second}`)).favorite, true);
  assert.ok(await evaluate(s, `document.querySelector('#item-${second} [data-act="favorite"]').textContent === "★"`));
  console.log("✓ swipe right added a favorite (and a short swipe did nothing)");

  // Favorites view shows it.
  await evaluate(s, `document.querySelector('[data-field="view"][data-value="favorites"]').click()`);
  await waitFor(s, `document.querySelectorAll(".swipe").length === 1 && document.querySelector(".swipe").dataset.id === "${second}"`, "favorites view");
  console.log("✓ favorites view");

  // Trash a card with the button, then restore it from the trash view with a swipe.
  await evaluate(s, `document.querySelector('[data-field="view"][data-value="all"]').click()`);
  await waitFor(s, `document.querySelectorAll(".swipe").length > 1`, "all view");
  const third = (await ids())[2];
  await evaluate(s, `document.querySelector('#item-${third} [data-act="trash"]').click()`);
  await sleep(500);
  await evaluate(s, `document.querySelector('[data-field="view"][data-value="trash"]').click()`);
  await waitFor(s, `document.querySelector(".swipe")?.dataset.id === "${third}"`, "trash view");
  await shoot(`web-phone-trash-view-${LANG}.png`);
  await swipe(third, 230);
  assert.equal((await api(`/api/items/${third}`)).trashedAt, undefined);
  assert.equal(await evaluate(s, `document.querySelectorAll(".swipe").length`), 0, "trash is empty again");
  console.log("✓ trash view: swipe right restored it");

  // A vertical drag scrolls; it must not trigger anything.
  const before = (await api("/api/stats")).trash;
  const box = await evaluate(s, `(() => { document.querySelector('[data-field="view"][data-value="all"]').click(); return 1; })()`);
  await waitFor(s, `document.querySelectorAll(".swipe").length > 1`, "all view again");
  const top = await evaluate(s, `(() => { const r = document.querySelector(".swipe .card").getBoundingClientRect(); return { x: r.x + 40, y: r.y + 40 }; })()`);
  await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: top.x, y: top.y }] }, s);
  for (let k = 1; k <= 10; k++) await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: top.x - k * 3, y: top.y - k * 25 }] }, s);
  await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, s);
  await sleep(400);
  assert.equal((await api("/api/stats")).trash, before, "scrolling must not trash a card");
  console.log("✓ a vertical drag is a scroll, not a swipe");
  void box;
  console.log("\nall web checks passed");
} catch (err) {
  failed = true;
  console.error("✗", err.message);
} finally {
  ws.close();
  chrome.kill();
  server.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
