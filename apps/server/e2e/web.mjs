#!/usr/bin/env node
// End-to-end test of the web page in a real browser, phone-sized with touch:
// swipe left → trash, undo, swipe right → favorite, trash view → restore.
// With SCREENSHOTS=<dir> it also saves desktop and phone pictures for the README.
//
//   CHROME=/path/to/chrome [SHOT_LANG=zh-TW] [SCREENSHOTS=dir] node apps/server/e2e/web.mjs
//
// The catalogue is seeded from demo-items.json: summaries a real model wrote.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { deflateSync } from "node:zlib";

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
  import { loadCategories, Store } from "@driftnet/core";
  const items = JSON.parse(process.env.DEMO_ITEMS);
  const store = new Store(process.env.DEMO_DB);
  store.seedFolders(loadCategories());
  // A reader's own folders next to the built-in ones.
  const zh = process.env.DEMO_LANG === "zh-TW";
  const mine = store.createFolder({ name: zh ? "我的工作流" : "My workflow", description: "Tools I use every day" });
  store.createFolder({ name: zh ? "設計" : "Design", description: "UI and design helpers", parent: mine.id });
  store.updateFolder(mine.id, { position: -1 });
  for (const i of items) store.upsert({ url: i.url, aliases: [], title: i.title, flags: [], source: "demo", summary: i.summary,
    judgement: { isAiTool: 1, category: i.category, kind: i.kind, worth: i.worth, engine: "llm", confidence: 1 } });
  // Pictures: three for ascii-sharks (the first a GIF), one dead link on card 2. The browser serves the bytes (below).
  const shark = items.findIndex((i) => /ascii-sharks/.test(i.url)) + 1;
  store.setMedia(shark, [0, 1, 2].map((n) => ({ url: \`https://media.example/shark-\${n}.\${n ? "png" : "gif"}\`, kind: n ? "image" : "gif", alt: \`ascii-sharks picture \${n + 1}\` })));
  store.setMedia(2, [{ url: "https://media.example/gone.png", kind: "image", alt: "gone" }]);
  for (const [id, n] of [[1, 3], [2, 2], [4, 1]]) for (let k = 0; k < n; k++) store.recordShare(id, { platform: "line", chatId: "demo" });
  // What a friend wrote with the link, the reader's own note, and a free-standing note.
  store.recordShare(1, { platform: "line", chatId: "demo", note: zh ? "這個可以拿來管我們的 Hermes agent 團隊" : "Could run our Hermes agent team with this" });
  store.setNote(2, zh ? "試過了，開專案很快；要搭配 pi agent。" : "Tried it — fast to open a repo; needs pi agent.");
  store.saveNote({ title: zh ? "這週要試的工具" : "To try this week",
    body: zh ? "- #1 管 agent 團隊\\n- #3 做 **ASCII** 動畫\\n\\n> 先在測試機上跑" : "- #1 for the agent team\\n- #3 for **ASCII** animations\\n\\n> Run it on the test box first" });
`;
const demo = JSON.parse(readFileSync(join(HERE, "demo-items.json"), "utf8"))[LANG];
await new Promise((resolve, reject) => {
  const p = spawn(join(SERVER, "../../node_modules/.bin/tsx"), ["--eval", seed], {
    cwd: SERVER, stdio: "inherit", env: { ...process.env, DEMO_DB: join(home, "driftnet.db"), DEMO_ITEMS: JSON.stringify(demo), DEMO_LANG: LANG },
  });
  p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("seeding failed"))));
});
// A stand-in for cloudflared: prints a quick-tunnel URL and stays up, like the real one.
const fakeCf = join(home, "cloudflared");
writeFileSync(fakeCf, `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\necho "INF |  https://demo-tunnel.trycloudflare.com  |" >&2\nexec sleep 600\n`, { mode: 0o755 });
const server = spawn(join(SERVER, "../../node_modules/.bin/tsx"), ["src/main.ts"], { cwd: SERVER, env: { ...process.env, DRIFTNET_HOME: home, DRIFTNET_CLOUDFLARED: fakeCf }, stdio: "ignore" });
for (let i = 0; i < 50; i++) {
  if (await fetch(`http://127.0.0.1:${port}/api/stats`).then(() => true, () => false)) break;
  await sleep(200);
}

// ── Chrome ──────────────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), "driftnet-web-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run",
  // remote.test reaches the same server but is not "this machine": how a phone or a tunnel looks to driftnet.
  "--host-resolver-rules=MAP remote.test 127.0.0.1", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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

// ── Pictures without the network ─────────────────────────────────────────────
// The seed stores real media and the server signs the paths, but the proxy would fetch from the internet: the
// browser answers GET /api/media/... itself with a generated PNG (card 2's picture answers 404: a dead link must
// not show as a broken image).
const crcTable = Int32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const pngChunk = (type, data) => { const t = Buffer.from(type), n = Buffer.alloc(4), c = Buffer.alloc(4); n.writeUInt32BE(data.length); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([n, t, data, c]); };
const makePng = (w, h, px) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3, [r, g, b] = px(x, y); raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
};
const picture = (n) => makePng(640, 360, (x, y) => [40 + ((x * 180) / 640 + n * 50) % 200, 90 + (y * 120) / 360, 200 - ((x + y) % 120) - n * 20]);
const sharkId = demo.findIndex((i) => /ascii-sharks/.test(i.url)) + 1, deadId = 2;
ws.addEventListener("message", async (e) => {
  const m = JSON.parse(e.data);
  if (m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params, sid = m.sessionId;
  const [, id, n] = new URL(request.url).pathname.split("/").slice(2).map(Number);
  if (id === deadId) return void await cdp("Fetch.fulfillRequest", { requestId, responseCode: 404, body: "" }, sid).catch(() => {});
  // ascii-sharks gets real-looking pictures (for the README screenshots); anything else a generated PNG.
  const shark = id === sharkId && existsSync(join(HERE, "fixtures", `shark-${n}.jpg`));
  const body = shark ? readFileSync(join(HERE, "fixtures", `shark-${n}.jpg`)) : picture(n);
  await cdp("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: shark ? "image/jpeg" : "image/png" }], body: body.toString("base64") }, sid).catch(() => {});
});
const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
const { sessionId: s } = await cdp("Target.attachToTarget", { targetId, flatten: true });
await cdp("Fetch.enable", { patterns: [{ urlPattern: "*/api/media/*", requestStage: "Request" }] }, s);
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
/** A finger tap on an element (a script click() looks like a keyboard press). */
const tap = async (selector) => {
  const p = await evaluate(s, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] }, s);
  await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, s);
  await sleep(350);
};
const ids = () => evaluate(s, `[...document.querySelectorAll(".swipe")].map((e) => Number(e.dataset.id))`);
const api = (path) => fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json());

let failed = false;
try {
  // Inbox: unfiled cards with one-tap folder chips; 1–3 pick a chip, s skips; a plan button that needs a model.
  // First, before anything is moved by hand, so the seeded cards are still unfiled.
  {
    await viewport(1280, 820, false);
    await open();
    const key = async (k) => {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, text: k }, s);
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k }, s);
      await sleep(150);
    };
    // The password may be set by now (and the catalogue private): read through the page's own token.
    const tok = await evaluate(s, `localStorage.getItem("driftnet-token") || localStorage.getItem("driftnet-key") || ""`);
    const get = (path) => fetch(`http://127.0.0.1:${port}${path}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} }).then((r) => r.json());
    const inboxBefore = (await get("/api/items?view=inbox&limit=500")).length;
    assert.ok(inboxBefore > 3, "the seeded cards are all in the Inbox");
    await evaluate(s, `document.querySelector('[data-field="view"][data-value="inbox"]').click()`);
    await waitFor(s, `document.querySelectorAll(".swipe .chips").length > 2`, "inbox cards with chips");
    await shoot(`web-inbox-${LANG}.png`);
    assert.equal(await evaluate(s, `document.querySelector('[data-field="view"][data-value="inbox"] .count').textContent`), String(inboxBefore), "the sidebar shows the Inbox count");
    // 1 files the focused card into its first suggestion; the next card takes focus.
    const first = await evaluate(s, `(() => { const sw = document.querySelector(".swipe"); sw.querySelector(".card").focus(); return JSON.stringify({ id: Number(sw.dataset.id), folder: sw.querySelector("[data-chip]")?.dataset.chip ?? null }); })()`).then(JSON.parse);
    if (first.folder) {
      await key("1");
      await waitFor(s, `!document.getElementById("item-${first.id}")`, "the filed card leaves the Inbox");
      assert.equal((await get(`/api/items/${first.id}`)).category, first.folder);
      assert.equal((await get("/api/items?view=inbox&limit=500")).length, inboxBefore - 1);
      assert.equal(await evaluate(s, `document.activeElement.closest(".swipe") !== null`), true, "focus moves to the next card");
      // Undo puts it back in the Inbox.
      await evaluate(s, `document.getElementById("toast-undo").click()`);
      await waitFor(s, `!!document.getElementById("item-${first.id}")`, "undo returns the card to the Inbox");
    }
    // s skips: focus moves on and nothing is filed.
    const skipped = await evaluate(s, `(() => { const c = [...document.querySelectorAll(".swipe .card")]; c[0].focus(); return c[0].closest(".swipe").dataset.id; })()`);
    await key("s");
    assert.notEqual(await evaluate(s, `document.activeElement.closest(".swipe").dataset.id`), skipped);
    assert.equal((await get(`/api/items/${skipped}`)).placed, false);
    // Chips are tappable too; "m" opens the full picker.
    await evaluate(s, `document.querySelector(".swipe .card").focus()`);
    await key("m");
    await waitFor(s, `document.getElementById("move-dlg").open`, "full picker from the Inbox");
    await evaluate(s, `document.getElementById("mv-cancel").click()`);
    // The ? dialog explains that 1–3 mean chips here.
    await key("?");
    await waitFor(s, `document.getElementById("ky-body").innerText.includes("1") && document.querySelectorAll("#ky-body h4").length >= 5`, "shortcuts dialog lists the Inbox keys");
    await evaluate(s, `document.getElementById("ky-close").click()`);
    // No model in this setup: the suggest button says so instead of failing.
    await evaluate(s, `document.querySelector("[data-suggest]").click()`);
    await waitFor(s, `document.getElementById("toast").classList.contains("show") && document.getElementById("toast-text").textContent.length > 0 && !document.getElementById("plan-dlg").open`, "suggest folders needs a model");
    const r = await fetch(`http://127.0.0.1:${port}/api/folders/suggest`, { method: "POST", headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    assert.equal(r.status, 409, "the endpoint refuses without a model");
    await evaluate(s, `document.querySelector('[data-field="view"][data-value="all"]').click()`);
    console.log("✓ inbox: chips file a card with 1–3, s skips, m opens the picker, undo returns it; suggest folders needs a model");
  }

  // Desktop: the folder tree, a drag onto it, and the picture.
  await viewport(1280, 820, false);
  await open();
  {
    const folders = await api("/api/folders");
    const design = folders.find((f) => f.parent && f.parent === folders.find((x) => x.name && !x.parent)?.id);
    assert.ok(design, "the demo's nested folder exists");
    assert.ok(await evaluate(s, `!!document.querySelector('#nav .folder[data-folder="${design.id}"]')`), "nested folder shows in the tree");
    // Drag a card by its grip onto the nested folder (synthetic HTML5 drag events carry the same DataTransfer).
    const id = (await ids())[3];
    await evaluate(s, `(() => {
      const dt = new DataTransfer();
      document.querySelector('#item-${id} [data-grip]').dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      const row = document.querySelector('#nav .folder[data-folder="${design.id}"]');
      row.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      return 1;
    })()`);
    await waitFor(s, `document.getElementById("toast").classList.contains("show")`, "move toast");
    const moved = await api(`/api/items?category=${design.parent}`);
    assert.deepEqual(moved.map((i) => i.id), [id], "the card is in the folder, and its parent folder shows it");
    assert.equal(moved[0].category, design.id);
    await evaluate(s, `document.getElementById("toast").classList.remove("show")`);
    console.log("✓ desktop: dragging a card onto a nested folder moves it; the parent folder lists it");
    // A new folder from the sidebar's ＋.
    await evaluate(s, `document.querySelector('#nav [data-new]').click()`);
    await waitFor(s, `document.getElementById("folder-dlg").open`, "folder dialog");
    await evaluate(s, `(() => { document.getElementById("fd-name").value = "Later"; document.getElementById("fd-desc").value = "Read when I have time"; document.getElementById("fd-save").click(); return 1; })()`);
    await waitFor(s, `!document.getElementById("folder-dlg").open && !!document.querySelector('#nav .folder[data-folder="later"]')`, "new folder in tree");
    assert.equal((await api("/api/folders")).find((f) => f.id === "later").description, "Read when I have time");
    // Deleting it asks twice, inside the dialog.
    await evaluate(s, `document.querySelector('#nav [data-edit="later"]').click()`);
    await waitFor(s, `document.getElementById("folder-dlg").open`, "edit dialog");
    await evaluate(s, `document.getElementById("fd-delete").click()`);
    assert.ok(await evaluate(s, `document.getElementById("folder-dlg").open`), "first press only arms delete");
    await evaluate(s, `document.getElementById("fd-delete").click()`);
    await waitFor(s, `!document.querySelector('#nav .folder[data-folder="later"]')`, "folder deleted");
    console.log("✓ folders: ＋ creates one with a description; delete asks twice");
    await open();
  }
  await shoot(`web-desktop-${LANG}.png`);

  // The tidier card list and the detail modal.
  {
    const old = 5;   // a card with no media, demo or why
    const key = async (k, code) => {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, windowsVirtualKeyCode: code }, s);
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, windowsVirtualKeyCode: code }, s);
      await sleep(150);
    };
    const KEYS = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowRight: 39 };
    const press = (k) => key(k, KEYS[k]);
    const modalOpen = `document.getElementById("item-dlg").open`;
    const title = `document.getElementById("md-title")?.textContent`;
    await waitFor(s, `!!document.querySelector('#item-${sharkId} .thumb img')`, "a thumbnail on the card with media");
    await waitFor(s, `document.querySelector('#item-${sharkId} .thumb img').naturalWidth > 0`, "the thumbnail loaded");
    assert.equal(await evaluate(s, `document.querySelector('#item-${sharkId} .thumb img').getAttribute("referrerpolicy") + document.querySelector('#item-${sharkId} .thumb img').loading`), "no-referrerlazy");
    assert.ok(await evaluate(s, `document.querySelector('#item-${sharkId} .thumb img').alt.length > 0`), "thumbnail has alt text");
    assert.ok(await evaluate(s, `document.querySelector('#item-${sharkId} .card .demo')?.textContent.length > 10`), "the demo line is the second line of the card");
    assert.ok(await evaluate(s, `!document.querySelector('#item-${sharkId} .card ul, #item-${sharkId} .card .said, #item-${sharkId} .card .tags, #item-${sharkId} .card .link-btn')`), "highlights, chat, tags and the note link are off the card");
    await waitFor(s, `!document.querySelector('#item-${deadId} .thumb')`, "a thumbnail that 404s is dropped");
    assert.ok(await evaluate(s, `!document.querySelector('#item-${old} .thumb') && !document.querySelector('#item-${old} .card .demo')`), "an old card has no thumbnail box and no demo line");
    await shoot(`web-cards-${LANG}.png`);

    // Click on the card body opens the modal: gallery, demo, why, the actions.
    await evaluate(s, `document.querySelector('#item-${sharkId} .card').click()`);
    await waitFor(s, modalOpen, "modal opens on a card click");
    assert.equal(await evaluate(s, `location.hash`), `#item-${sharkId}`, "the address bar names the card");
    assert.equal(await evaluate(s, `document.getElementById("item-dlg").getAttribute("aria-labelledby")`), "md-title");
    assert.match(await evaluate(s, title), /ascii-sharks/);
    await waitFor(s, `document.querySelectorAll("#item-dlg .g-slide img").length === 3 && document.querySelector("#item-dlg .g-slide img").naturalWidth > 0`, "the gallery shows the seeded pictures");
    assert.equal(await evaluate(s, `document.querySelectorAll("#item-dlg .g-th").length`), 3, "a thumbnail strip");
    await evaluate(s, `document.querySelectorAll("#item-dlg .g-th")[1].click()`);
    await waitFor(s, `document.querySelectorAll("#item-dlg .g-th")[1].classList.contains("on")`, "the strip follows the gallery");
    assert.ok(await evaluate(s, `document.querySelector("#item-dlg .md-sec.demo")?.textContent.length > 20 && document.querySelector("#item-dlg .md-sec.why")?.textContent.length > 20`), "demo and why sections");
    assert.ok(await evaluate(s, `!!document.querySelector("#item-dlg .md-sec.try button[data-md=copy]") && !!document.querySelector("#item-dlg .md-sec.hl li") && !!document.querySelector("#item-dlg .md-sec.tags")`), "tryIt with a copy button, highlights, tags");
    assert.ok(await evaluate(s, `["favorite", "move", "refresh", "note", "trash"].every((a) => document.querySelector('#item-dlg [data-md="' + a + '"]'))`), "the actions are in the modal");
    await evaluate(s, `document.getElementById("item-dlg").querySelector(".md-scroll").scrollTop = 0`);
    await shoot(`web-card-modal-${LANG}.png`);

    // ←/→ step through the list.
    const order = await ids();
    const at = order.indexOf(sharkId);
    assert.ok(at >= 0 && at < order.length - 1, "the shark card has a next card");
    const nameOf = async (id) => evaluate(s, `document.querySelector('#item-${id} .name').textContent`);
    await press("ArrowRight");
    assert.equal(await evaluate(s, title), await nameOf(order[at + 1]), "→ shows the next card");
    assert.equal(await evaluate(s, `location.hash`), `#item-${order[at + 1]}`);
    await press("ArrowLeft");
    assert.equal(await evaluate(s, title), await nameOf(sharkId), "← comes back");
    // Esc closes it and focus returns to the card.
    await press("Escape");
    await waitFor(s, `!${modalOpen} && document.activeElement?.closest?.(".swipe")?.dataset.id === "${sharkId}" && location.hash === ""`, "Esc closes the modal, focus returns to the card, the hash clears");
    // Enter on a focused card opens it too; stepping and closing leaves focus on the card you ended on.
    await press("Enter");
    await waitFor(s, modalOpen, "Enter opens the modal");
    await press("ArrowRight");
    await press("Escape");
    await waitFor(s, `!${modalOpen} && document.activeElement?.closest?.(".swipe")?.dataset.id === "${order[at + 1]}"`, "focus lands on the card you stepped to");
    // A card with nothing but a one-liner: no gallery, no empty sections, no broken pictures.
    await evaluate(s, `document.querySelector('#item-${old} .card').click()`);
    await waitFor(s, modalOpen, "old card opens");
    assert.ok(await evaluate(s, `!document.querySelector("#item-dlg .gallery") && !document.querySelector("#item-dlg .md-sec.demo") && ![...document.querySelectorAll("#item-dlg .md-sec")].some((e) => !e.textContent.trim())`), "an old card has no empty boxes");
    await evaluate(s, `document.getElementById("item-dlg").close()`);
    // A card whose picture is gone: the dead image is dropped, not shown broken.
    await evaluate(s, `document.querySelector('#item-${deadId} .card').click()`);
    await waitFor(s, `${modalOpen} && !document.querySelector("#item-dlg .gallery")`, "a 404 picture disappears from the modal");
    await evaluate(s, `document.getElementById("item-dlg").close()`);
    // A shared link: #item-<id> opens the modal, on a fresh load and on a hash change.
    await cdp("Page.navigate", { url: "about:blank" }, s);
    await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/#item-${sharkId}` }, s);
    await waitFor(s, `document.getElementById("item-dlg")?.open && document.getElementById("md-title")?.textContent.includes("ascii-sharks")`, "a #item link opens the modal on load");
    await evaluate(s, `document.getElementById("item-dlg").close()`);
    await evaluate(s, `location.hash = "#item-${old}"`);
    await waitFor(s, `${modalOpen} && location.hash === "#item-${old}"`, "a hash change opens the modal");
    await evaluate(s, `document.getElementById("item-dlg").close()`);
    await open();
    console.log("✓ cards: thumbnail + demo line, dead pictures hidden; modal opens by click and Enter, ←/→ step, Esc returns focus, #item-<id> deep link, old cards stay clean");
  }

  // Notes on a card, the notes page, settings and export.
  {
    const id = (await ids())[0];
    await evaluate(s, `document.querySelector('#item-${id} .card').click()`);
    await waitFor(s, `document.getElementById("item-dlg").open`, "detail modal");
    await evaluate(s, `document.querySelector('#item-dlg [data-md="note"]').click()`);
    await waitFor(s, `document.getElementById("note-dlg").open`, "note dialog");
    await evaluate(s, `(() => { document.getElementById("in-text").value = "remember: check the license"; document.getElementById("in-save").click(); return 1; })()`);
    await waitFor(s, `document.querySelector('#item-dlg .mynote')?.textContent.includes("check the license") && !!document.querySelector('#item-${id} .has-note')`, "note in the modal, marked on the card");
    await evaluate(s, `document.getElementById("item-dlg").close()`);
    assert.equal((await api(`/api/items/${id}`)).note, "remember: check the license");
    assert.ok((await api("/api/items?q=license")).some((i) => i.id === id), "notes are searchable");
    assert.ok((await api("/api/items")).find((i) => i.id === 1).said.length, "chat text comes with the item");
    console.log("✓ a note on a card is saved, shown in the modal and searchable");

    await evaluate(s, `document.querySelector('[data-field="view"][data-value="notes"]').click()`);
    await waitFor(s, `document.querySelector(".note-card a[data-card]")`, "notes page with card links");
    await evaluate(s, `document.getElementById("toast").classList.remove("show")`);
    await sleep(300);
    await shoot(`web-notes-${LANG}.png`);
    await evaluate(s, `document.querySelector(".note-card a[data-card]").click()`);
    await waitFor(s, `location.hash === "#item-1" && !!document.getElementById("item-1")`, "jump from a note to its card");
    console.log("✓ notes page: #1 in a note opens card 1");

    await evaluate(s, `document.querySelector("#nav [data-settings]").click()`);
    await waitFor(s, `document.getElementById("settings-dlg").open && !!document.querySelector('[data-key="DRIFTNET_SUMMARY_RULES"]')`, "settings dialog");
    await evaluate(s, `document.getElementById("toast").classList.remove("show")`);
    await sleep(300);
    await shoot(`web-settings-${LANG}.png`);
    await evaluate(s, `(() => {
      document.querySelector('[data-key="DRIFTNET_SUMMARY_RULES"]').value = "Say whether it is free.";
      document.querySelector('[data-pref="sort"]').value = "newest";
      document.querySelector('[data-pref="compact"]').checked = true;
      document.getElementById("st-save").click(); return 1; })()`);
    await waitFor(s, `!document.getElementById("settings-dlg").open && document.body.classList.contains("compact")`, "settings saved");
    const saved = await api("/api/settings");
    assert.equal(saved.settings.find((x) => x.key === "DRIFTNET_SUMMARY_RULES").value, "Say whether it is free.");
    assert.match(readFileSync(join(home, ".env"), "utf8"), /DRIFTNET_SUMMARY_RULES=`Say whether it is free\.`/);
    await waitFor(s, `document.querySelector(".swipe")?.dataset.id === "${demo.length}"`, "newest first");
    // A foreign page can't change settings, even with no token set.
    const csrf = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: "PUT", headers: { "content-type": "application/json", origin: "https://evil.test" },
      body: JSON.stringify({ values: { DRIFTNET_LLM_BASE_URL: "https://evil.test/v1" } }) });
    assert.equal(csrf.status, 403);
    const plain = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: "PUT", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(plain.status, 403, "no simple (preflight-free) requests");
    await evaluate(s, `(() => { localStorage.removeItem("driftnet-prefs"); return 1; })()`);
    console.log("✓ settings: saved to ~/.driftnet/.env, display options apply, cross-site writes refused");

    const zipRes = await fetch(`http://127.0.0.1:${port}/api/export?format=vault`);
    const buf = Buffer.from(await zipRes.arrayBuffer());
    assert.equal(buf.readUInt32LE(0), 0x04034b50, "a zip");
    assert.match(await (await fetch(`http://127.0.0.1:${port}/api/export`)).text(), /^# driftnet — /);
    console.log("✓ export: Markdown and a zip vault");
    await open();
  }

  // Phone, with touch.
  await viewport(390, 844, true);
  await open();
  await shoot(`web-phone-${LANG}.png`);
  const first = (await ids())[0];

  // The ☰ drawer: opens, picking a shelf closes it and the crumb says what is shown.
  {
    const open = () => evaluate(s, `document.body.classList.contains("menu-open")`);
    assert.equal(await open(), false);
    await tap("#menu");
    assert.equal(await open(), true);
    assert.equal(await evaluate(s, `document.activeElement?.closest?.("#nav") ? "nav" : "elsewhere"`), "elsewhere", "a tap doesn't pull focus into the drawer");
    assert.equal(await evaluate(s, `document.getElementById("menu").getAttribute("aria-expanded")`), "true");
    const inView = await evaluate(s, `(() => { const r = document.getElementById("nav").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`);
    assert.ok(inView, "drawer slid in");
    await shoot(`web-phone-menu-${LANG}.png`);
    const shelf = await evaluate(s, `(() => { const b = document.querySelector('#nav [data-field="category"]'); b.click(); return b.querySelector("span").textContent; })()`);
    await sleep(350);
    assert.equal(await open(), false, "picking a shelf closes the drawer");
    const crumb = await evaluate(s, `document.getElementById("crumb").textContent`);
    assert.ok(crumb.includes(shelf), `crumb shows the shelf: ${JSON.stringify(crumb)} vs ${JSON.stringify(shelf)}`);
    // Back to everything; the scrim and Escape close it too.
    await evaluate(s, `document.getElementById("crumb").click()`);
    await sleep(300);
    await evaluate(s, `document.querySelector('#nav [data-field="category"][aria-pressed="true"]').click()`);
    await sleep(300);
    await evaluate(s, `document.getElementById("menu").click()`);
    await sleep(300);
    await evaluate(s, `document.getElementById("scrim").click()`);
    await sleep(300);
    assert.equal(await open(), false, "scrim closes");
    await evaluate(s, `document.getElementById("menu").click()`);
    await sleep(300);
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, s);
    await sleep(300);
    assert.equal(await open(), false, "Escape closes");
    assert.equal(await evaluate(s, `document.activeElement.id`), "menu", "after Escape, focus returns to ☰");
    await evaluate(s, `document.activeElement.blur()`);
    await waitFor(s, `document.querySelectorAll(".swipe").length > 3`, "all items again");
    console.log("✓ ☰ drawer: opens, closes on pick / scrim / Escape, crumb shows the filter");
  }

  // 📁 Move to…: a picker on phones, with undo.
  {
    const id = (await ids())[0];
    const target = (await api("/api/folders")).find((f) => f.id === "other");
    await tap(`#item-${id} [data-act="move"]`);
    await waitFor(s, `document.getElementById("move-dlg").open`, "move picker");
    await shoot(`web-phone-move-${LANG}.png`);
    await evaluate(s, `document.querySelector('#mv-list [data-to="${target.id}"]').scrollIntoView({ block: "center" })`);
    await tap(`#mv-list [data-to="${target.id}"]`);
    await waitFor(s, `!document.getElementById("move-dlg").open && document.getElementById("toast").classList.contains("show")`, "moved toast");
    assert.equal((await api(`/api/items/${id}`)).category, "other");
    await evaluate(s, `document.getElementById("toast-undo").click()`);
    for (let i = 0; i < 20 && (await api(`/api/items/${id}`)).category === "other"; i++) await sleep(200);
    assert.notEqual((await api(`/api/items/${id}`)).category, "other", "undo puts it back");
    console.log("✓ phone: 📁 picker moves a card, undo moves it back");
  }

  // Holding a card (~0.5 s) starts selecting; a tap on another card adds it; Clear ends it.
  {
    const [a, b] = await ids();
    const at = await evaluate(s, `(() => { const r = document.querySelector('#item-${a} .card').getBoundingClientRect(); return { x: r.x + 40, y: r.bottom - 10 }; })()`);
    await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] }, s);
    await sleep(700);
    await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, s);
    await waitFor(s, `document.querySelectorAll(".swipe.selected").length === 1 && !document.getElementById("selbar").hidden`, "long press selects");
    await evaluate(s, `document.querySelector('#item-${b} .card .meta span').scrollIntoView({ block: "center" })`);
    await tap(`#item-${b} .card .meta span`);
    await waitFor(s, `document.querySelectorAll(".swipe.selected").length === 2`, "a tap adds a card while selecting");
    await evaluate(s, `document.querySelector('#selbar [data-sel="clear"]').click()`);
    await waitFor(s, `document.querySelectorAll(".swipe.selected").length === 0 && document.getElementById("selbar").hidden`, "cleared");
    await evaluate(s, `scrollTo(0, 0)`);
    console.log("✓ phone: a long press starts selecting cards");
  }

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
  await waitFor(s, `![...document.querySelectorAll(".swipe")].some((e) => e.dataset.id === "${first}")`, "card left the list");
  assert.ok((await api(`/api/items/${first}`)).trashedAt, "server has it in the trash");
  assert.ok(await waitFor(s, `document.getElementById("toast").classList.contains("show")`, "undo toast"));
  await shoot(`web-phone-trash-toast-${LANG}.png`);
  console.log("✓ swipe left moved the card to the trash");

  // Undo.
  await evaluate(s, `document.getElementById("toast-undo").click()`);
  await waitFor(s, `[...document.querySelectorAll(".swipe")].some((e) => e.dataset.id === "${first}")`, "card back after undo");
  assert.equal((await api(`/api/items/${first}`)).trashedAt, undefined);
  console.log("✓ undo restored it");

  // Refresh: the button spins, then a toast says how it went (success or failure depending on the network);
  // the card survives either way with its shares intact.
  const sharesBefore = (await api(`/api/items/${first}`)).shareCount;
  await evaluate(s, `document.getElementById("toast").classList.remove("show"); document.querySelector('#item-${first} [data-act="refresh"]').click()`);
  await waitFor(s, `document.querySelector('#item-${first} [data-act="refresh"]') && !document.querySelector('#item-${first} [data-act="refresh"]').disabled && document.getElementById("toast").classList.contains("show")`, "refresh finished with a toast");
  assert.equal((await api(`/api/items/${first}`)).shareCount, sharesBefore, "refresh keeps the shares");
  console.log("✓ refresh button ran and reported");

  // Swipe right: favorite. A short swipe must not count.
  const second = (await ids())[1];
  await swipe(second, 40);
  assert.equal((await api(`/api/items/${second}`)).favorite, false, "a short swipe does nothing");
  await swipe(second, 230);
  assert.equal((await api(`/api/items/${second}`)).favorite, true);
  assert.ok(await evaluate(s, `document.querySelector('#item-${second} [data-act="favorite"]').classList.contains("on")`));
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
  await waitFor(s, `document.querySelectorAll(".swipe").length === 0`, "the swipe restored it");
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

  // Select three cards (x, then Shift-click the third), move them together, undo; then a number key files a card.
  {
    await viewport(1280, 820, false);
    await open();
    const key = async (k) => {
      const text = k.length === 1 ? k : undefined;
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, ...(text ? { text } : {}) }, s);
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k }, s);
      await sleep(120);
    };
    const three = (await ids()).slice(0, 3);
    const folders = await api("/api/folders");
    const cats = await Promise.all(three.map(async (id) => (await api(`/api/items/${id}`)).category));
    const dest = folders.find((f) => !cats.includes(f.id)).id;
    await evaluate(s, `document.querySelector('#item-${three[0]} .card').focus()`);
    await key("x");
    const r = await evaluate(s, `(() => { const r = document.querySelector('#item-${three[2]} .card').getBoundingClientRect(); return { x: r.left + 6, y: r.top + 6 }; })()`);
    const click = async (type) => cdp("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, modifiers: 8 }, s);
    await click("mousePressed"); await click("mouseReleased");
    await waitFor(s, `document.querySelectorAll(".swipe.selected").length === 3 && !document.getElementById("selbar").hidden`, "three selected and the bar showing");
    assert.match(await evaluate(s, `document.querySelector("#selbar .sel-n").textContent`), /3/);
    await shoot(`web-select-${LANG}.png`);
    await evaluate(s, `document.querySelector('#selbar [data-sel="move"]').click()`);
    await waitFor(s, `document.getElementById("move-dlg").open`, "move picker for the selection");
    await evaluate(s, `document.querySelector('#mv-list [data-to="${dest}"]').click()`);
    await waitFor(s, `document.getElementById("toast").classList.contains("show") && document.getElementById("selbar").hidden`, "bulk toast");
    for (const id of three) assert.equal((await api(`/api/items/${id}`)).category, dest, "all three are in the folder");
    await evaluate(s, `document.getElementById("toast-undo").click()`);
    await waitFor(s, `document.querySelectorAll(".swipe").length > 0`, "list back");
    await sleep(500);
    for (const [n, id] of three.entries()) assert.equal((await api(`/api/items/${id}`)).category, cats[n], "undo put each card back where it was");
    console.log("✓ selected three cards, moved them together, and Undo put them back");

    // Esc clears a selection.
    await evaluate(s, `document.querySelector('#item-${three[0]} .card').focus()`);
    await key("x");
    await waitFor(s, `document.querySelectorAll(".swipe.selected").length === 1`, "one selected");
    await key("Escape");
    await waitFor(s, `document.querySelectorAll(".swipe.selected").length === 0 && document.getElementById("selbar").hidden`, "Esc cleared it");

    // The undo above took the folder's count back to zero; filing the three again (server-side) makes it quick folder 1.
    assert.equal((await api("/api/folders")).find((f) => f.id === dest).uses, 0, "undo rebalanced the folder's counter");
    await evaluate(s, `fetch("/api/items/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "move", ids: ${JSON.stringify(three)}, folder: ${JSON.stringify(dest)} }) }).then((r) => r.ok)`);
    assert.equal((await api("/api/folders")).find((f) => f.id === dest).uses, 3);
    await open();
    await waitFor(s, `document.querySelectorAll(".swipe").length > 0`, "list after reload");
    // That folder is now quick folder 1: the key files a single card there.
    const one = (await ids()).find((id) => !three.includes(id)) ?? three[0];
    await evaluate(s, `document.querySelector('#item-${one} .card').focus()`);
    await key("1");
    await waitFor(s, `document.getElementById("toast").classList.contains("show")`, "quick move toast");
    assert.equal((await api(`/api/items/${one}`)).category, dest, "key 1 filed the card into the most-used folder");
    console.log("✓ number key 1 filed a card into the most-used folder");
    await key("?");
    await waitFor(s, `document.getElementById("keys-dlg").open && document.getElementById("ky-body").textContent.includes(${JSON.stringify(folders.find((f) => f.id === dest).label[LANG] ?? "")})`, "legend in the ? dialog");
    await evaluate(s, `document.getElementById("keys-dlg").close()`);
    await evaluate(s, `document.getElementById("toast").classList.remove("show")`);
  }
  // The mind map: open a folder, drag a card onto another folder, nest a folder.
  {
    await viewport(1280, 820, false);
    await open();
    await evaluate(s, `document.querySelector('[data-field="view"][data-value="map"]').click()`);
    await waitFor(s, `!!document.querySelector('.mnode[data-key="root"]')`, "map");
    await evaluate(s, `document.querySelector('[data-map="expand"]').click()`);
    await waitFor(s, `document.querySelectorAll(".mnode.item").length > 2`, "expanded map");
    const pick = await evaluate(s, `(() => { const n = document.querySelector(".mnode.item"); return Number(n.dataset.key.slice(2)); })()`);
    const before = (await api(`/api/items/${pick}`)).category;
    const target = await evaluate(s, `(() => { const f = [...document.querySelectorAll(".mnode.folder")].find((n) => n.dataset.key !== "f:${before}"); return f.dataset.key.slice(2); })()`);
    const center = (sel) => evaluate(s, `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await evaluate(s, `document.querySelector('.mnode[data-key="f:${target}"]').scrollIntoView({ block: "center", inline: "center" })`);
    await evaluate(s, `document.querySelector('.mnode[data-key="i:${pick}"]').scrollIntoView({ block: "center", inline: "nearest" })`);
    const a = await center(`.mnode[data-key="i:${pick}"]`);
    const b = await center(`.mnode[data-key="f:${target}"]`);
    const mouse = (type, p) => cdp("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 }, s);
    await mouse("mousePressed", a);
    for (let k = 1; k <= 12; k++) { await mouse("mouseMoved", { x: a.x + ((b.x - a.x) * k) / 12, y: a.y + ((b.y - a.y) * k) / 12 }); await sleep(16); }
    await mouse("mouseReleased", b);
    await waitFor(s, `document.getElementById("toast").classList.contains("show")`, "moved on the map");
    assert.equal((await api(`/api/items/${pick}`)).category, target, "dragging a card onto a folder files it");
    await evaluate(s, `document.getElementById("toast").classList.remove("show")`);
    // Two-sided by default (XMind); one tap switches everything to the right, and back.
    assert.ok(await evaluate(s, `document.querySelectorAll(".mnode.left").length > 0`), "branches on both sides by default");
    await evaluate(s, `document.querySelector('[data-map="layout"]').click()`);
    await waitFor(s, `!!document.querySelector('.mnode[data-key="root"]') && document.querySelectorAll(".mnode.left").length === 0`, "all to the right");
    await evaluate(s, `document.querySelector('[data-map="layout"]').click()`);
    await waitFor(s, `document.querySelectorAll(".mnode.left").length > 0`, "both sides again");
    console.log("✓ mind map: both sides by default, switch to right side and back");
    // Focus mode: double-click a folder, only its subtree renders, breadcrumb and Esc come back; the URL carries it.
    {
      const sub = await evaluate(s, `(() => { const n = [...document.querySelectorAll(".mnode.folder")].find((x) => x.getAttribute("aria-expanded") === "true" || x.classList.contains("l1")); return n.dataset.key.slice(2); })()`);
      const allNodes = await evaluate(s, `document.querySelectorAll(".mnode").length`);
      await evaluate(s, `document.querySelector('.mnode[data-key="f:${sub}"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
      await waitFor(s, `!!document.querySelector(".map-crumb") && location.hash === "#focus=" + encodeURIComponent(${JSON.stringify(sub)})`, "focused on a folder");
      assert.ok(await evaluate(s, `document.querySelectorAll(".mnode").length < ${allNodes}`), "focus renders only the subtree");
      assert.ok(await evaluate(s, `!document.querySelector('.mnode[data-key="f:${sub}"]')`), "the focused folder is now the root");
      await evaluate(s, `document.querySelector('.map-crumb [data-map="focus"][data-id=""]').click()`);
      await waitFor(s, `!document.querySelector(".map-crumb") && document.querySelectorAll(".mnode").length === ${allNodes} && !location.hash.startsWith("#focus=")`, "breadcrumb returns to the full map");
      // z undoes while a toast is up (longer text stays longer); let the last one expire so z means "focus".
      await waitFor(s, `!document.getElementById("toast").classList.contains("show")`, "the last toast expired", 12000);
      await evaluate(s, `document.querySelector('.mnode[data-key="f:${sub}"]').focus()`);
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "z", text: "z" }, s);
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "z" }, s);
      await waitFor(s, `!!document.querySelector(".map-crumb")`, "z focuses the folder");
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" }, s);
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape" }, s);
      await waitFor(s, `!document.querySelector(".map-crumb")`, "Esc goes up one level");
      console.log("✓ mind map: focus a folder (dblclick / z), breadcrumb and Esc return");
    }
    // Keyboard-only tree walk: roving tabindex, arrows move focus, → opens a folder, ← closes it.
    {
      const kd = async (k) => {
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, ...(k.length === 1 ? { text: k } : {}) }, s);
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k }, s);
        await sleep(120);
      };
      const active = () => evaluate(s, `document.activeElement?.dataset?.key ?? null`);
      assert.equal(await evaluate(s, `document.getElementById("map-canvas").getAttribute("role")`), "tree");
      assert.equal(await evaluate(s, `document.querySelectorAll('.mnode[tabindex="0"]').length`), 1, "one tab stop");
      assert.equal(await evaluate(s, `document.querySelector(".mnode").getAttribute("role")`), "treeitem");
      await evaluate(s, `document.querySelector('.mnode[data-key="root"]').focus()`);
      await kd("ArrowDown");
      const first = await active();
      assert.notEqual(first, "root", "ArrowDown moves to the next node");
      assert.equal(await evaluate(s, `document.querySelectorAll('.mnode[tabindex="0"]').length`), 1);
      assert.equal(await evaluate(s, `document.activeElement.getAttribute("tabindex")`), "0");
      await kd("ArrowUp");
      assert.equal(await active(), "root");
      await kd("End");
      assert.notEqual(await active(), "root");
      await kd("Home");
      assert.equal(await active(), "root");
      // Find a collapsed folder with contents, walk to it, → opens it, → again enters it, ← returns.
      const closed = await evaluate(s, `(() => { const n = document.querySelector('.mnode.folder[aria-expanded="false"]'); return n && n.dataset.key; })()`);
      if (closed) {
        await evaluate(s, `document.querySelector('.mnode[data-key="${closed}"]').focus()`);
        await kd("ArrowRight");
        await waitFor(s, `document.activeElement?.dataset?.key === ${JSON.stringify(closed)} && document.activeElement.getAttribute("aria-expanded") === "true"`, "→ expands a folder");
        await kd("ArrowRight");
        const child = await active();
        assert.notEqual(child, closed, "→ on an open folder enters its first child");
        await kd("ArrowLeft");
        assert.equal(await active(), closed, "← goes to the parent");
        await kd("ArrowLeft");
        await waitFor(s, `document.activeElement?.dataset?.key === ${JSON.stringify(closed)} && document.activeElement.getAttribute("aria-expanded") === "false"`, "← collapses");
      }
      console.log("✓ mind map: keyboard tree walk (roving tabindex, arrows, expand/collapse)");
    }
    await evaluate(s, `document.querySelector('[data-map="fit"]').click()`);
    await sleep(300);
    await shoot(`web-map-${LANG}.png`);
    // Phone: the same map, panned with a finger.
    await viewport(390, 844, true);
    await open();
    await evaluate(s, `document.querySelector('[data-field="view"][data-value="map"]').click()`);
    await waitFor(s, `document.querySelectorAll(".mnode.item").length > 2`, "map on a phone");
    await evaluate(s, `document.querySelector('[data-map="fit"]').click()`);
    await sleep(300);
    await shoot(`web-phone-map-${LANG}.png`);
    // Touch: hold a card, let go, tap a folder — filed, with nothing fighting the scroll.
    {
      const cardKey = await evaluate(s, `document.querySelector(".mnode.item").dataset.key`);
      const cid = Number(cardKey.slice(2));
      const was = (await api(`/api/items/${cid}`)).category;
      const dest = await evaluate(s, `[...document.querySelectorAll(".mnode.folder")].map((n) => n.dataset.key.slice(2)).find((k) => k !== ${JSON.stringify(was)})`);
      await evaluate(s, `document.querySelector('.mnode[data-key="${cardKey}"]').scrollIntoView({ block: "center", inline: "center" })`);
      const at = await evaluate(s, `(() => { const r = document.querySelector('.mnode[data-key="${cardKey}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] }, s);
      await sleep(450);
      await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, s);
      await waitFor(s, `!document.getElementById("pickbar").hidden`, "picked up by holding");
      await shoot(`web-phone-pickup-${LANG}.png`);
      await evaluate(s, `document.querySelector('.mnode[data-key="f:${dest}"]').scrollIntoView({ block: "center", inline: "center" })`);
      await tap(`.mnode[data-key="f:${dest}"]`);
      await waitFor(s, `document.getElementById("pickbar").hidden`, "dropped");
      for (let k = 0; k < 20 && (await api(`/api/items/${cid}`)).category !== dest; k++) await sleep(150);
      assert.equal((await api(`/api/items/${cid}`)).category, dest, "hold + tap a folder files the card");
      console.log("✓ phone map: hold a card, tap a folder — filed");
    }
    // Touch: hold one card, tap a second to add it, tap a folder — both are filed in one go.
    {
      const keys = await evaluate(s, `[...document.querySelectorAll(".mnode.item")].slice(0, 2).map((n) => n.dataset.key)`);
      const [x, y] = keys.map((k) => Number(k.slice(2)));
      const was = await Promise.all([x, y].map(async (id) => (await api(`/api/items/${id}`)).category));
      const dest = await evaluate(s, `[...document.querySelectorAll(".mnode.folder")].map((n) => n.dataset.key.slice(2)).find((k) => !${JSON.stringify(was)}.includes(k))`);
      const centre = (key) => evaluate(s, `(() => { const n = document.querySelector('.mnode[data-key="${key}"]'); n.scrollIntoView({ block: "center", inline: "center" }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [await centre(keys[0])] }, s);
      await sleep(450);
      await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, s);
      await waitFor(s, `!document.getElementById("pickbar").hidden`, "first card picked up");
      await tap(`.mnode[data-key="${keys[1]}"]`);
      await waitFor(s, `document.querySelectorAll(".mnode.sel").length === 2`, "second card added to the pick-up");
      await evaluate(s, `document.querySelector('.mnode[data-key="f:${dest}"]').scrollIntoView({ block: "center", inline: "center" })`);
      await tap(`.mnode[data-key="f:${dest}"]`);
      for (let k = 0; k < 20 && (await api(`/api/items/${y}`)).category !== dest; k++) await sleep(150);
      assert.equal((await api(`/api/items/${x}`)).category, dest, "the held card is filed");
      assert.equal((await api(`/api/items/${y}`)).category, dest, "and so is the one added to it");
      console.log("✓ phone map: hold a card, tap another, tap a folder — both filed together");
    }
    await evaluate(s, `document.querySelector('[data-field="view"][data-value="all"]').click()`);
    console.log("✓ mind map: expand, drag a card onto a folder (mouse), phone layout");
  }

  // Command palette (⌘K / Ctrl+K) and the split view.
  {
    await viewport(1280, 820, false);
    await open();
    const folders = await api("/api/folders");
    const f = folders.find((x) => x.id !== "other" && x.label?.[LANG]) ?? folders[0];
    const pressK = async () => {
      await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 }, s);
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 }, s);
    };
    await pressK();
    await waitFor(s, `document.getElementById("cmd-dlg").open && document.activeElement.id === "cmd-input"`, "palette opened with Ctrl+K");
    assert.equal(await evaluate(s, `document.getElementById("cmd-input").getAttribute("role")`), "combobox");
    assert.equal(await evaluate(s, `document.getElementById("cmd-list").getAttribute("role")`), "listbox");
    await shoot(`web-palette-${LANG}.png`);
    await cdp("Input.insertText", { text: f.label?.[LANG] ?? f.id }, s);
    await waitFor(s, `!!document.querySelector('#cmd-list [aria-selected="true"]') && document.getElementById("cmd-input").getAttribute("aria-activedescendant") === document.querySelector('#cmd-list [aria-selected="true"]').id`, "a folder is highlighted");
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, s);
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, s);
    await waitFor(s, `!document.getElementById("cmd-dlg").open && document.querySelector('[data-field="category"][data-value="${f.id}"]')?.getAttribute("aria-pressed") === "true"`, "Enter jumped to the folder");
    console.log("✓ command palette: Ctrl+K opens it, a folder name + Enter jumps there");
    // Back to everything, then the split view at a wide window: cards on the left, the map on the right.
    await evaluate(s, `document.querySelector('[data-field="view"][data-value="all"]').click()`);
    await waitFor(s, `document.querySelectorAll(".swipe").length > 1`, "all cards");
    await evaluate(s, `document.querySelector("[data-split]").click()`);
    await waitFor(s, `document.body.classList.contains("split-view") && document.querySelectorAll("#split-list .swipe").length > 1 && !!document.querySelector('#split-map .mnode[data-key="root"]')`, "list and map together");
    const sides = await evaluate(s, `(() => { const a = document.getElementById("split-list").getBoundingClientRect(), b = document.getElementById("split-map").getBoundingClientRect(); return { listRight: a.right, mapLeft: b.left, w: a.width, mw: b.width }; })()`);
    assert.ok(sides.listRight <= sides.mapLeft + 1 && sides.w > 300 && sides.mw > 400, `list left, map right (${JSON.stringify(sides)})`);
    assert.equal(await evaluate(s, `localStorage.getItem("driftnet-split")`), "1", "the choice is remembered");
    await shoot(`web-split-${LANG}.png`);
    // Moving a card from the list keeps both sides in step.
    const mv = await evaluate(s, `Number(document.querySelector("#split-list .swipe").dataset.id)`);
    const before = (await api(`/api/items/${mv}`)).category;
    const to = folders.find((x) => x.id !== before && x.id !== "other")?.id ?? "other";
    await evaluate(s, `moveItem(${mv}, ${JSON.stringify(to)}, true)`);
    await waitFor(s, `mapItems.find((i) => i.id === ${mv})?.category === ${JSON.stringify(to)} && document.querySelector("#item-${mv} .badge.folder")?.textContent.length > 0`, "both sides know the move");
    await evaluate(s, `moveItem(${mv}, ${JSON.stringify(before)}, true)`);
    await waitFor(s, `mapItems.find((i) => i.id === ${mv})?.category === ${JSON.stringify(before)}`, "moved back");
    // Narrower than 1200px: the toggle is hidden and the page falls back to the list alone.
    await viewport(1000, 820, false);
    await waitFor(s, `!document.querySelector("#split-map") && document.querySelectorAll(".swipe").length > 1 && getComputedStyle(document.querySelector("[data-split]")).display === "none"`, "single view below 1200px");
    await viewport(1280, 820, false);
    await waitFor(s, `!!document.querySelector("#split-map")`, "split is back when wide again");
    await evaluate(s, `document.querySelector("[data-split]").click()`);
    await waitFor(s, `!document.querySelector("#split-map") && localStorage.getItem("driftnet-split") === "0"`, "split switched off");
    console.log("✓ split view: list and map side by side at 1280px, moves keep both in step, single view below 1200px");
  }

  // No password yet: another website's page must not write into (or read) the catalogue.
  {
    const res = await fetch(`http://127.0.0.1:${port}/api/ingest`, { method: "POST", headers: { origin: "https://evil.test", "content-type": "text/plain" },
      body: JSON.stringify({ url: "https://evil.test/spam" }) });
    assert.equal(res.status, 401, "cross-site write refused");
    const read = await fetch(`http://127.0.0.1:${port}/api/items`, { headers: { origin: "https://evil.test" } });
    assert.equal(read.headers.get("access-control-allow-origin"), null, "no CORS: a foreign page can't read responses");
    console.log("✓ first run: a foreign website can't write, and gets no CORS to read");
  }

  // Access: a password from the page, private reading, a share key, the public URL, the connect cards.
  {
    await viewport(1280, 820, false);
    await open();
    await evaluate(s, `document.querySelector("#nav [data-settings]").click()`);
    await waitFor(s, `document.getElementById("settings-dlg").open && !!document.getElementById("ac-pw")`, "access panel");
    await evaluate(s, `(() => { const i = document.getElementById("ac-pw"); i.value = "1234"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
    assert.equal(await evaluate(s, `document.getElementById("ac-meter").dataset.s`), "weak");
    await evaluate(s, `document.getElementById("ac-gen").click()`);
    const pw = await evaluate(s, `document.getElementById("ac-pw").value`);
    assert.equal(await evaluate(s, `document.getElementById("ac-meter").dataset.s`), "strong");
    await evaluate(s, `(() => { document.querySelector('[data-key="DRIFTNET_ACCESS"]').value = "private"; document.getElementById("st-save").click(); return 1; })()`);
    await waitFor(s, `!document.getElementById("settings-dlg").open`, "saved password");
    assert.equal(await evaluate(s, `localStorage.getItem("driftnet-token")`), pw, "the page keeps the password it set");
    const remote = { "x-forwarded-for": "203.0.113.9" };
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/items`, { headers: remote })).status, 401, "private now (from elsewhere)");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/items`, { headers: { ...remote, authorization: `Bearer ${pw}` } })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/items`)).status, 200, "this machine itself needs no password");
    await waitFor(s, `document.querySelectorAll(".swipe").length > 1`, "page still works with the saved password");

    await evaluate(s, `document.querySelector("#nav [data-settings]").click()`);
    await waitFor(s, `document.getElementById("settings-dlg").open && !!document.getElementById("ac-newkey")`, "access panel again");
    await evaluate(s, `document.getElementById("ac-newkey").click()`);
    await waitFor(s, `!!document.getElementById("ac-key")?.value`, "share key");
    const key = await evaluate(s, `document.getElementById("ac-key").value`);
    assert.equal((await fetch(`http://127.0.0.1:${port}/llms.txt?key=${key}`, { headers: remote })).status, 200, "the share key reads by URL");
    assert.equal((await fetch(`http://127.0.0.1:${port}/llms.txt?key=${pw}`, { headers: remote })).status, 401, "the admin password never works in a URL");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/ingest`, { method: "POST", headers: { ...remote, authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}" })).status, 401, "the share key can't write");
    await evaluate(s, `document.getElementById("ac-tunnel").click()`);
    await waitFor(s, `document.getElementById("ac-url")?.value === "https://demo-tunnel.trycloudflare.com"`, "public URL shown");
    await evaluate(s, `document.querySelector('[data-tab-btn="access"]').click()`);
    await evaluate(s, `document.getElementById("ac").scrollIntoView({ block: "start" })`);
    await evaluate(s, `document.getElementById("toast").classList.remove("show")`);
    await shoot(`web-access-${LANG}.png`);
    await evaluate(s, `document.getElementById("st-cancel").click()`);
    console.log("✓ access: password from the page, private reads, a URL-safe share key, the public URL");

    await evaluate(s, `document.querySelector("#nav [data-connect]").click()`);
    await waitFor(s, `document.getElementById("connect-dlg").open`, "connect dialog");
    const cards = await evaluate(s, `document.getElementById("cx-body").innerText`);
    assert.ok(cards.includes(`https://demo-tunnel.trycloudflare.com/mcp?key=${key}`), "cards carry the public URL and the share key");
    assert.ok(!cards.includes(pw), "the admin password is never printed on the cards");
    assert.ok(cards.includes(`https://demo-tunnel.trycloudflare.com/feed.xml?key=${key}`), "the feed card carries the share key");
    await evaluate(s, `document.getElementById("toast").classList.remove("show")`);
    await shoot(`web-connect-${LANG}.png`);
    console.log("✓ connect cards: public URL and share key filled in, password left out");

    // A card makes a token for its agent and shows the snippet with it, not the password.
    assert.equal(await evaluate(s, `document.getElementById("cn-cc").value`), "Claude Code", "the card suggests a name");
    assert.equal(await evaluate(s, `document.getElementById("cn-agents").value`), "Hermes", "the shared card suggests Hermes");
    await evaluate(s, `document.getElementById("cn-cc").value = "Claude Code (laptop)"`);
    await evaluate(s, `document.querySelector('[data-mint="cc"]').click()`);
    await waitFor(s, `document.getElementById("cx-cc").textContent.includes("dn_")`, "token on the Claude Code card");
    const cardToken = (await evaluate(s, `document.getElementById("cx-cc").textContent`)).match(/dn_[\w-]+/)[0];
    assert.ok(!(await evaluate(s, `document.getElementById("cx-body").innerText`)).includes(pw), "still no password on the cards");
    const asAgent = (t, path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { ...remote, authorization: `Bearer ${t}`, "content-type": "application/json" } });
    assert.equal((await asAgent(cardToken, "/api/ingest", { method: "POST", body: "{}" })).status, 200, "a write token writes");
    await evaluate(s, `document.getElementById("cx-close").click()`);

    // Settings → Access lists it; make a read token, see it once, revoke it.
    await evaluate(s, `document.querySelector("#nav [data-settings]").click()`);
    await waitFor(s, `document.getElementById("settings-dlg").open && !!document.querySelector("#agent-tokens .tok")`, "agent tokens listed");
    assert.ok((await evaluate(s, `document.getElementById("agent-tokens").innerText`)).includes("Claude Code (laptop)"), "the card mints with the edited name");
    await evaluate(s, `(() => { document.getElementById("at-name").value = "Dashboard"; document.getElementById("at-scope").value = "read"; document.getElementById("at-create").click(); return 1; })()`);
    await waitFor(s, `!!document.getElementById("ac-newtok")?.value`, "new token shown once");
    await evaluate(s, `document.getElementById("agent-tokens").scrollIntoView({ block: "start" })`);
    await shoot(`web-tokens-${LANG}.png`);
    const readToken = await evaluate(s, `document.getElementById("ac-newtok").value`);
    assert.equal((await asAgent(readToken, "/api/items")).status, 200, "a read token reads");
    assert.equal((await asAgent(readToken, "/api/ingest", { method: "POST", body: "{}" })).status, 401, "a read token can't write");
    assert.equal((await asAgent(cardToken, "/api/agent-tokens")).status, 403, "a token can't manage tokens");
    await evaluate(s, `document.querySelector('[data-revoke]:not([disabled])') && [...document.querySelectorAll("#agent-tokens .tok")].find((r) => r.innerText.includes("Dashboard")).querySelector("[data-revoke]").click()`);
    await waitFor(s, `[...document.querySelectorAll("#agent-tokens .tok.revoked")].some((r) => r.innerText.includes("Dashboard"))`, "token revoked in the list");
    assert.equal((await asAgent(readToken, "/api/items")).status, 401, "a revoked token stops at once");
    assert.equal(await evaluate(s, `!!document.getElementById("ac-newtok")`), false, "the token is not shown a second time");
    // A revoked token can be removed from the list; an active one has no Remove button.
    assert.equal(await evaluate(s, `[...document.querySelectorAll("#agent-tokens .tok")].filter((r) => !r.classList.contains("revoked")).some((r) => r.querySelector("[data-remove]"))`), false, "active tokens can't be removed");
    await evaluate(s, `[...document.querySelectorAll("#agent-tokens .tok.revoked")].find((r) => r.innerText.includes("Dashboard")).querySelector("[data-remove]").click()`);
    await waitFor(s, `![...document.querySelectorAll("#agent-tokens .tok")].some((r) => r.innerText.includes("Dashboard"))`, "revoked token removed from the list");
    await evaluate(s, `document.getElementById("st-cancel").click()`);
    console.log("✓ agent tokens: made from a card and from Settings, scoped, shown once, revoked at once");

    // Unlock a phone: Settings shows a QR for a one-time link; a fresh browser (nothing stored) opens it and is in.
    await evaluate(s, `document.querySelector("#nav [data-settings]").click()`);
    await waitFor(s, `document.getElementById("settings-dlg").open && !!document.getElementById("pr-create")`, "pairing panel");
    await evaluate(s, `(() => { document.getElementById("pr-name").value = "Test phone"; document.getElementById("pr-scope").value = "write"; document.getElementById("pr-create").click(); return 1; })()`);
    await waitFor(s, `!!document.getElementById("pair-link")?.value && !!document.querySelector("#pair-out svg")`, "QR and link shown");
    const pairLink = await evaluate(s, `document.getElementById("pair-link").value`);
    assert.ok(pairLink.startsWith("https://demo-tunnel.trycloudflare.com/#pair="), "the link uses the public URL, code in the fragment");
    assert.ok((await evaluate(s, `document.getElementById("pair-time").textContent`)).length > 0, "a countdown is shown");
    await evaluate(s, `document.getElementById("pair-panel").scrollIntoView({ block: "start" })`);
    await shoot(`web-pair-${LANG}.png`);
    const { browserContextId } = await cdp("Target.createBrowserContext");
    const { targetId: t2 } = await cdp("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId: s2 } = await cdp("Target.attachToTarget", { targetId: t2, flatten: true });
    await cdp("Page.navigate", { url: `http://remote.test:${port}/${pairLink.slice(pairLink.indexOf("#"))}` }, s2);
    await waitFor(s2, `document.querySelectorAll(".swipe").length > 1`, "phone unlocked by the code");
    assert.equal(await evaluate(s2, `location.hash`), "", "the code is taken out of the address bar");
    assert.match(await evaluate(s2, `localStorage.getItem("driftnet-token")`), /^dn_/, "the phone holds its own token, not the password");
    assert.equal(await evaluate(s2, `document.getElementById("lock").hidden`), true, "write scope: no unlock chip");
    const phoneToken = await evaluate(s2, `localStorage.getItem("driftnet-token")`);
    assert.equal((await asAgent(phoneToken, "/api/ingest", { method: "POST", body: "{}" })).status, 200, "the phone writes");
    assert.equal((await asAgent(phoneToken, "/api/pair", { method: "POST", body: JSON.stringify({ name: "x", scope: "write" }) })).status, 403, "a device can't pair more devices");
    const code = pairLink.split("#pair=")[1];
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/pair/claim`, { method: "POST", headers: { ...remote, "content-type": "application/json" }, body: JSON.stringify({ code }) })).status, 404, "a code works once");
    // Back on the computer: the device is listed by name and can be revoked.
    await waitFor(s, `[...document.querySelectorAll("#agent-tokens .tok")].some((r) => r.innerText.includes("Test phone"))`, "device listed after pairing");
    await evaluate(s, `[...document.querySelectorAll("#agent-tokens .tok")].find((r) => r.innerText.includes("Test phone")).querySelector("[data-revoke]").click()`);
    await waitFor(s, `[...document.querySelectorAll("#agent-tokens .tok.revoked")].some((r) => r.innerText.includes("Test phone"))`, "device revoked");
    assert.equal((await asAgent(phoneToken, "/api/items")).status, 401, "a revoked phone is locked out");
    await evaluate(s, `document.getElementById("st-cancel").click()`);
    await cdp("Target.disposeBrowserContext", { browserContextId });
    console.log("✓ pairing: QR for a one-time link, a clean browser unlocked with its own revocable token");

    // A phone that got a link from a bot: no password stored, only ?key= in the link.
    await evaluate(s, `(() => { localStorage.removeItem("driftnet-token"); localStorage.removeItem("driftnet-key"); return 1; })()`);
    await cdp("Page.navigate", { url: `http://remote.test:${port}/?key=${key}#item-1` }, s);
    await waitFor(s, `document.querySelectorAll(".swipe").length > 1`, "cards through a share-key link");
    assert.equal(await evaluate(s, `location.search`), "", "the key is taken out of the address bar");
    assert.equal(await evaluate(s, `location.hash`), "#item-1");
    await waitFor(s, `document.getElementById("item-dlg")?.open`, "the shared card opens as a sheet");
    assert.equal(await evaluate(s, `document.querySelectorAll("#md-actions [data-md]").length`), 0, "a reader gets no edit actions in the modal");
    await shoot(`web-phone-modal-${LANG}.png`);
    await evaluate(s, `document.getElementById("item-dlg").close()`);
    assert.equal(await evaluate(s, `localStorage.getItem("driftnet-key")`), key);
    // A reader sees no edit controls, and a chip that unlocks editing.
    assert.equal(await evaluate(s, `getComputedStyle(document.querySelector('#item-1 .tools')).display`), "none", "no edit buttons for a reader");
    assert.equal(await evaluate(s, `document.getElementById("lock").hidden`), false, "the unlock chip is shown");
    await shoot(`web-phone-reader-${LANG}.png`);
    console.log("✓ a share-key link opens without a password, read-only, with an unlock chip");
    // The unlock chip: a wrong password is refused, the right one unlocks editing.
    await evaluate(s, `document.getElementById("lock").click()`);
    await waitFor(s, `document.getElementById("login-dlg").open`, "login dialog");
    await evaluate(s, `(() => { document.getElementById("lg-pw").value = "wrong-password"; document.getElementById("lg-ok").click(); return 1; })()`);
    await waitFor(s, `document.getElementById("lg-error").textContent.length > 0`, "wrong password refused");
    await evaluate(s, `(() => { document.getElementById("lg-pw").value = ${JSON.stringify(pw)}; document.getElementById("lg-ok").click(); return 1; })()`);
    await waitFor(s, `!document.getElementById("login-dlg").open && document.getElementById("lock").hidden`, "unlocked");
    await waitFor(s, `getComputedStyle(document.querySelector('#item-1 .tools')).display !== "none"`, "edit buttons back");
    console.log("✓ 🔑 entry: a wrong password is refused, the right one unlocks editing");
  }

  // Paging: 60 cards a page, then "Show more (N left)" appends the next page without rebuilding the first.
  // Last on purpose: it adds 70 cards that would skew every count above.
  {
    const extra = `
      import { Store } from "@driftnet/core";
      const items = JSON.parse(process.env.DEMO_ITEMS);
      const store = new Store(process.env.DEMO_DB);
      for (let n = 0; n < 70; n++) { const i = items[n % items.length];
        store.upsert({ url: \`https://paging.example/repo-\${n}\`, aliases: [], title: \`Paging card \${n}\`, flags: [], source: "demo", summary: i.summary,
          judgement: { isAiTool: 1, category: i.category, kind: i.kind, worth: i.worth, engine: "llm", confidence: 1 } }); }
    `;
    await new Promise((resolve, reject) => {
      const p = spawn(join(SERVER, "../../node_modules/.bin/tsx"), ["--eval", extra], {
        cwd: SERVER, stdio: "inherit", env: { ...process.env, DEMO_DB: join(home, "driftnet.db"), DEMO_ITEMS: JSON.stringify(demo) },
      });
      p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("paging seeding failed"))));
    });
    const more = (n) => (LANG === "zh-TW" ? `再顯示 ${n} 張` : `Show more (${n} left)`);
    await viewport(1280, 820, false);
    await open();
    await evaluate(s, `document.querySelector('[data-field="view"][data-value="all"]').click()`);
    const tok = await evaluate(s, `localStorage.getItem("driftnet-token") || localStorage.getItem("driftnet-key") || ""`);
    const head = await fetch(`http://127.0.0.1:${port}/api/items?limit=1`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    const total = Number(head.headers.get("x-total-count"));
    assert.ok(total > 60 + 1, "more cards than one page");
    assert.equal((await head.json()).length, 1, "the body stays a plain array");
    await waitFor(s, `document.querySelectorAll(".swipe").length === 60`, "the first page is 60 cards");
    assert.equal(await evaluate(s, `document.querySelector("#page-more [data-page-more]").textContent`), more(total - 60), "the button counts what is left");
    // Mark the first card: appending a page must not rebuild it.
    await evaluate(s, `document.querySelector(".swipe").dataset.mark = "kept"`);
    const first = await evaluate(s, `document.querySelector(".swipe").dataset.id`);
    await evaluate(s, `document.querySelector("#page-more [data-page-more]").click()`);
    await waitFor(s, `document.querySelectorAll(".swipe").length === ${Math.min(120, total)}`, "the next page is appended");
    assert.ok((await evaluate(s, `document.querySelectorAll(".swipe")[60] !== undefined`)), "card 61 is there");
    assert.equal(await evaluate(s, `document.querySelector(".swipe").dataset.mark`), "kept", "page 1 was not rebuilt");
    assert.equal(await evaluate(s, `document.querySelector(".swipe").dataset.id`), first);
    assert.equal(await evaluate(s, `new Set([...document.querySelectorAll(".swipe")].map((e) => e.dataset.id)).size`), Math.min(120, total), "no card twice");
    if (total > 120) assert.equal(await evaluate(s, `document.querySelector("#page-more [data-page-more]").textContent`), more(total - 120));
    else assert.equal(await evaluate(s, `!!document.getElementById("page-more")`), false, "nothing left, no button");
    // A new filter starts again at page 1.
    await evaluate(s, `document.querySelector('[data-field="view"][data-value="favorites"]').click()`);
    await evaluate(s, `document.querySelector('[data-field="view"][data-value="all"]').click()`);
    await waitFor(s, `document.querySelectorAll(".swipe").length === 60`, "switching view resets to page 1");
    console.log("✓ paging: 60 cards a page, Show more appends page 2 in place, a new view starts over");
  }

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
