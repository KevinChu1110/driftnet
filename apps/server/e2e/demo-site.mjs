#!/usr/bin/env node
// Checks the static web demo (dist/demo, built by `pnpm build:demo`) in a real browser, served under a sub-path the
// way GitHub Pages serves it (/driftnet/): the page loads, cards render, search works, a star survives a reload, an
// action that needs a server answers with the demo toast, and the language toggle works.
//
//   CHROME=/path/to/chrome node apps/server/e2e/demo-site.mjs   (run `pnpm build:demo` first)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Set CHROME to a Chrome or Chromium binary."); process.exit(2); }
const DIST = join(dirname(fileURLToPath(import.meta.url)), "../../../dist/demo");
if (!existsSync(join(DIST, "index.html"))) { console.error("dist/demo is missing: run `pnpm build:demo` first."); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = "/driftnet/";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json" };

// Like GitHub Pages: files only under /driftnet/, everything else (notably /api/...) is a 404.
const requests = [];
const site = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  requests.push(path);
  if (!path.startsWith(BASE)) { res.writeHead(404); return res.end("not found"); }
  const rel = normalize(path.slice(BASE.length) || "index.html").replace(/^(\.\.[/\\])+/, "");
  const file = join(DIST, rel.endsWith("/") ? rel + "index.html" : rel);
  if (!existsSync(file) || !file.startsWith(DIST)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const port = site.address().port;
const URL_ = `http://127.0.0.1:${port}${BASE}`;

const profile = mkdtempSync(join(tmpdir(), "driftnet-demo-chrome-"));
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
const pageErrors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
  if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
});
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
const { sessionId: s } = await cdp("Target.attachToTarget", { targetId, flatten: true });
await cdp("Runtime.enable", {}, s);
await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false }, s);
const evaluate = async (expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expression, what, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await evaluate(expression).catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); }
};
const cards = () => evaluate(`[...document.querySelectorAll(".swipe")].map((e) => Number(e.dataset.id))`);

let failed = false;
try {
  await cdp("Page.navigate", { url: URL_ }, s);
  await waitFor(`document.readyState === "complete"`, "page load");
  await evaluate(`localStorage.setItem("driftnet-locale", "en"); sessionStorage.clear()`);
  await cdp("Page.reload", {}, s);
  await waitFor(`document.querySelectorAll(".swipe").length`, "cards");
  const all = await cards();
  assert.ok(all.length >= 4, `cards render (${all.length})`);
  assert.ok(await evaluate(`!!document.getElementById("demo-banner") && /Demo/.test(document.getElementById("demo-banner").textContent)`), "the demo banner shows");
  assert.ok(await evaluate(`document.querySelector("nav .tree")?.children.length > 3`), "the folder tree renders");
  assert.ok(!requests.some((p) => p.includes("/api/")), "no /api request reaches the host");
  if (process.env.SCREENSHOT) writeFileSync(process.env.SCREENSHOT, Buffer.from((await cdp("Page.captureScreenshot", { format: "png" }, s)).data, "base64"));
  console.log(`ok  page loads under ${BASE} with ${all.length} cards`);

  // Search: type, the list narrows; clear, it comes back.
  const setQ = (v) => evaluate(`(() => { const q = document.getElementById("q"); q.value = ${JSON.stringify(v)}; q.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await setQ("paperclip");
  await waitFor(`document.querySelectorAll(".swipe").length === 1`, "search narrows to one card");
  await setQ("zzzzqqq");
  await waitFor(`document.querySelectorAll(".swipe").length === 0`, "search with no hit shows none");
  await setQ("");
  await waitFor(`document.querySelectorAll(".swipe").length === ${all.length}`, "clearing search restores the cards");
  console.log("ok  search narrows and clears");

  // A star survives a reload (sessionStorage), and shows in Favorites.
  const target = all[0];
  const star = `document.querySelector("#item-${target} [data-act='favorite']")`;
  await evaluate(`${star}.click()`);
  await waitFor(`${star}?.getAttribute("aria-pressed") === "true"`, "the star turns on");
  await cdp("Page.reload", {}, s);
  await waitFor(`document.querySelectorAll(".swipe").length`, "cards after reload");
  assert.equal(await evaluate(`${star}.getAttribute("aria-pressed")`), "true", "the star survives a reload");
  await evaluate(`document.querySelector('[data-field="view"][data-value="favorites"]').click()`);
  await waitFor(`document.querySelectorAll(".swipe").length === 1`, "Favorites lists the starred card");
  await evaluate(`document.querySelector('[data-field="view"][data-value="all"]').click()`);
  await waitFor(`document.querySelectorAll(".swipe").length === ${all.length}`, "back to all cards");
  console.log("ok  a star survives a reload");

  // Trash and undo from the toast.
  await evaluate(`document.querySelector("#item-${all[1]} [data-act='trash']").click()`);
  await waitFor(`!document.getElementById("item-${all[1]}")`, "the card leaves");
  await evaluate(`document.getElementById("toast-undo").click()`);
  await waitFor(`!!document.getElementById("item-${all[1]}")`, "undo brings it back");
  console.log("ok  trash and undo");

  // Card modal opens; the mind map draws.
  await evaluate(`document.querySelector("#item-${all[0]} .card").click()`);
  await waitFor(`document.getElementById("item-dlg").open`, "card modal opens");
  await evaluate(`document.getElementById("item-dlg").close()`);
  await evaluate(`document.querySelector('[data-field="view"][data-value="map"]').click()`);
  await waitFor(`document.querySelector("#list svg, #list canvas, #list .map")`, "mind map draws");
  await evaluate(`document.querySelector('[data-field="view"][data-value="all"]').click()`);
  await waitFor(`document.querySelectorAll(".swipe").length`, "cards again");
  console.log("ok  card modal and mind map");

  // Needs a server: a friendly toast instead of a failure.
  await evaluate(`document.querySelector("#item-${all[0]} [data-act='refresh']").click()`);
  await waitFor(`/npx driftnet/.test(document.getElementById("toast-text").textContent) && document.getElementById("toast").classList.contains("show")`, "demo toast on refresh");
  await evaluate(`document.getElementById("toast").classList.remove("show"); document.getElementById("toast-text").textContent = ""`);
  await evaluate(`document.querySelector("[data-settings]").click()`);
  await sleep(150);
  assert.ok(await evaluate(`/npx driftnet/.test(document.getElementById("toast-text").textContent)`), "demo toast on settings");
  console.log("ok  demo toast for actions that need a server");

  // Language toggle.
  await evaluate(`document.getElementById("lang").click()`);
  await waitFor(`document.documentElement.lang === "zh-TW" && /展示/.test(document.getElementById("demo-banner").textContent)`, "zh-TW banner");
  await waitFor(`/[\\u4e00-\\u9fff]/.test(document.querySelector(".swipe")?.textContent ?? "")`, "cards in zh-TW");
  assert.equal(await evaluate(`${star}.getAttribute("aria-pressed")`), "true", "the star is still on in the other language");
  await evaluate(`document.getElementById("lang").click()`);
  await waitFor(`document.documentElement.lang === "en"`, "back to English");
  console.log("ok  language toggle (cards, banner, state kept)");

  assert.deepEqual(pageErrors, [], "no uncaught page errors");
  console.log("demo site e2e passed");
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  try { await cdp("Browser.close"); } catch { /* already gone */ }
  chrome.kill(); site.close();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
