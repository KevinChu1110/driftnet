// Renders the store pictures from src/*.html with headless Chrome (over CDP, so the
// size is exact):
//   CHROME=/path/to/chrome node apps/chrome-extension/store/render.mjs
// Output: screenshots/<lang>/1-3.png (1280x800) and promo/<lang>.png (440x280).
// The inputs src/img/post|popup|options-<lang>.png come from
//   SCREENSHOTS=<dir> SHOT_LANG=<lang> node apps/chrome-extension/e2e.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME;
if (!CHROME) throw new Error("Set CHROME to a Chrome for Testing or Chromium binary.");

const profile = mkdtempSync(join(tmpdir(), "driftnet-store-"));
const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--allow-file-access-from-files", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = "";
  chrome.stderr.on("data", (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
  chrome.on("exit", () => reject(new Error(err)));
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
});
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  pending.set(++id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

try {
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const shoot = async (page, lang, out, width, height) => {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp("Page.navigate", { url: `file://${join(here, "src", page)}#${lang}` }, sessionId);
    await new Promise((r) => setTimeout(r, 1200)); // local files: images and fonts settle fast
    await cdp("Page.reload", {}, sessionId); // the hash is read on load; reload so every run starts clean
    await new Promise((r) => setTimeout(r, 1200));
    const { data } = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(data, "base64"));
    console.log("✓", out.replace(here + "/", ""));
  };
  for (const lang of ["en", "zh-TW"]) {
    for (const n of [1, 2, 3]) await shoot(`shot-${n}.html`, lang, join(here, "screenshots", lang, `${n}.png`), 1280, 800);
    await shoot("promo.html", lang, join(here, "promo", `${lang}.png`), 440, 280);
  }
} finally {
  ws.close();
  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
}
