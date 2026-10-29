#!/usr/bin/env node
// Makes the animated demo at the top of the README: assets/demo-en.gif and assets/demo-zh-TW.gif.
// A throwaway driftnet with the demo cards is driven in headless Chrome (a chat bubble scene, the real web page,
// an end card); frames are captured on a steady clock and assembled with ffmpeg.
//
//   pnpm demo:gif                       # both languages
//   pnpm demo:gif -- --lang en          # one language
//   CHROME=/path/to/chrome FFMPEG=/path/to/ffmpeg pnpm demo:gif
//   FRAMES=dir keeps the captured frames.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "apps/server");
const CHROME = process.env.CHROME || join(homedir(), "Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const FFMPEG = process.env.FFMPEG || (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");
const FPS = 12, W = 1280, H = 800, OUT_W = 960;
const args = process.argv.slice(2);
const only = args.includes("--lang") ? args[args.indexOf("--lang") + 1] : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });

const TEXT = {
  en: {
    locale: "en", language: "English", font: `-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif`,
    chatUser: "Mia", channel: "reading-list", userMsg: "look at this https://www.facebook.com/reel/…",
    reply: (id) => `Paperclip — open-source control plane for AI agent teams · driftnet.example/#item-${id}`,
    search: "agents",
    caps: ["Drop a link in any chat", "It becomes a sorted, explained card", "Search everything you saved", "Summary, demo, why it matters, related cards", "Or see it as a mind map", ""],
    tagline: "Drop links in a chat. Get sorted, explained, searchable cards.", agent: "Your agents read the same catalogue over MCP.", typing: "driftnet is typing",
  },
  "zh-TW": {
    locale: "zh-TW", language: "Traditional Chinese (Taiwan)", font: `-apple-system, "PingFang TC", "Noto Sans TC", "Helvetica Neue", sans-serif`,
    chatUser: "小米", channel: "待看清單", userMsg: "看看這個 https://www.facebook.com/reel/…",
    reply: (id) => `Paperclip — 開源的 AI 代理團隊控制台 · driftnet.example/#item-${id}`,
    search: "代理",
    caps: ["在任何聊天室丟出連結", "自動變成分類好、附說明的卡片", "搜尋你存過的一切", "摘要、示範、為什麼值得看、相關卡片", "也能用心智圖瀏覽", ""],
    tagline: "把連結丟進聊天室，變成分類好、可搜尋的卡片。", agent: "你的代理也能透過 MCP 讀同一份資料。", typing: "driftnet 正在輸入",
  },
};

const logoSvg = readFileSync(join(ROOT, "assets/logo.svg"), "utf8");

// ── Scenes that are not the web page ────────────────────────────────────────
const sceneCss = (t) => `*{box-sizing:border-box;margin:0}body{width:${W}px;height:${H}px;overflow:hidden;font-family:${t.font};color:#e6e9ef;background:#1e2128}`;
const captionCss = `#cap{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);background:rgba(15,18,28,.88);color:#fff;font-size:28px;font-weight:600;padding:14px 30px;border-radius:40px;white-space:nowrap;letter-spacing:.01em;box-shadow:0 8px 30px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);z-index:99999;transition:opacity .25s;opacity:0}#cap.on{opacity:1}`;
const chatHtml = (t, id) => `<!doctype html><meta charset=utf-8><style>${sceneCss(t)}${captionCss}
.top{height:72px;display:flex;align-items:center;padding:0 40px;background:#16181d;border-bottom:1px solid #2b2f38;font-size:24px;font-weight:700;gap:12px}.top b{color:#8b93a5;font-weight:500}
.msgs{padding:60px 90px;display:flex;flex-direction:column;gap:34px}
.m{display:flex;gap:20px;align-items:flex-start;opacity:0;transform:translateY(14px);transition:all .35s}.m.on{opacity:1;transform:none}
.av{width:60px;height:60px;border-radius:50%;flex:none;display:grid;place-items:center;font-weight:700;font-size:26px;color:#fff}
.who{font-size:21px;font-weight:700;margin-bottom:6px}.who i{font-style:normal;font-size:14px;background:#2459e0;color:#fff;border-radius:5px;padding:2px 7px;margin-left:8px;vertical-align:2px}
.txt{font-size:30px;line-height:1.45;max-width:900px;word-break:break-word}.txt a{color:#6aa7ff}
.dots span{display:inline-block;width:11px;height:11px;border-radius:50%;background:#8b93a5;margin-right:7px;animation:b 1s infinite}.dots span:nth-child(2){animation-delay:.15s}.dots span:nth-child(3){animation-delay:.3s}@keyframes b{50%{transform:translateY(-8px);opacity:.4}}
.dots{font-size:22px;color:#8b93a5;display:flex;align-items:center;gap:14px}
.bar{position:fixed;left:90px;right:90px;bottom:120px;height:60px;border:1px solid #343945;background:#272b34;border-radius:14px;padding:0 24px;display:flex;align-items:center;color:#7c8497;font-size:24px}
</style><div class=top>#&nbsp;${t.channel}</div>
<div class=msgs>
 <div class=m id=u><div class=av style="background:#d1568c">${t.chatUser[0]}</div><div><div class=who>${t.chatUser}</div><div class=txt id=ut></div></div></div>
 <div class=m id=t><div class=av style="background:linear-gradient(135deg,#2459e0,#0f9f8f)"><svg viewBox="0 0 128 128" width="40" height="40">${logoSvg.replace(/<svg[^>]*>|<\/svg>/g, "")}</svg></div><div><div class=who>driftnet<i>BOT</i></div><div class=dots><span></span><span></span><span></span></div></div></div>
 <div class=m id=r><div class=av style="background:linear-gradient(135deg,#2459e0,#0f9f8f)"><svg viewBox="0 0 128 128" width="40" height="40">${logoSvg.replace(/<svg[^>]*>|<\/svg>/g, "")}</svg></div><div><div class=who>driftnet<i>BOT</i></div><div class=txt id=rt></div></div></div>
</div><div class=bar></div><div id=cap></div>
<script>
const $=(i)=>document.getElementById(i), msg=${JSON.stringify(t.userMsg)}, rep=${JSON.stringify(t.reply(id))};
const link=(s)=>s.replace(/(https?:\\/\\/\\S+|driftnet\\.example\\/\\S+)/g,'<a>$1</a>');
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{ await sleep(300); $("u").classList.add("on"); const ut=$("ut");
 for(let i=1;i<=msg.length;i++){ut.innerHTML=link(msg.slice(0,i));await sleep(22);}
 await sleep(350); $("t").classList.add("on"); await sleep(800); $("t").remove(); $("r").classList.add("on"); const rt=$("rt");
 for(let i=1;i<=rep.length;i+=3){rt.innerHTML=link(rep.slice(0,i));await sleep(20);} rt.innerHTML=link(rep); window.done=true; })();
window.cap=(s)=>{const c=$("cap");c.textContent=s;c.classList.toggle("on",!!s)};
</script>`;
const endHtml = (t) => `<!doctype html><meta charset=utf-8><style>${sceneCss(t)}
body{background:radial-gradient(circle at 30% 20%,#1d3a8a 0,#0d1b3d 45%,#08111f 100%);display:grid;place-items:center;text-align:center}
.logo{width:150px;height:150px;margin:0 auto 22px;filter:drop-shadow(0 12px 30px rgba(15,159,143,.45))}
h1{font-size:92px;letter-spacing:-.02em;color:#fff}.tag{margin-top:14px;font-size:30px;color:#c9d4f2}
.cmd{display:inline-block;margin-top:34px;padding:16px 38px;border-radius:14px;background:#0a0f1c;border:1px solid #3a4a7a;font:600 38px ui-monospace,"SF Mono",Menlo,monospace;color:#7ee0cf}.cmd i{color:#6aa7ff;font-style:normal}
.ag{margin-top:30px;font-size:25px;color:#9fb0dc}
</style><div><div class=logo>${logoSvg}</div><h1>driftnet</h1><div class=tag>${t.tagline}</div><div class=cmd><i>$</i> npx driftnet</div><div class=ag>${t.agent}</div></div>`;

const pageInject = `
(() => {
  document.getElementById("cur")?.remove();
  const st = document.createElement("style");
  st.textContent = ${JSON.stringify(captionCss)} + \`
  @keyframes glow{0%,100%{box-shadow:0 0 0 3px #2459e0,0 0 26px 6px rgba(36,89,224,.55)}50%{box-shadow:0 0 0 3px #0f9f8f,0 0 34px 10px rgba(15,159,143,.6)}}
  .newcard .card{animation:glow 1.1s ease-in-out infinite;border-radius:14px}
  #cur{position:fixed;z-index:100000;width:30px;height:30px;pointer-events:none;left:0;top:0;transition:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}\`;
  document.head.append(st);
  const c = document.createElement("div"); c.id = "cap"; document.body.append(c);
  window.cap = (s) => { c.textContent = s; c.classList.toggle("on", !!s); };
  const cur = document.createElement("div"); cur.id = "cur"; cur.style.display = "none";
  cur.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.9L21 10.6z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.append(cur);
  window.cur = (x, y) => { cur.style.display = "block"; cur.style.transform = "translate(" + x + "px," + y + "px)"; };
})()`;

// ── Chrome ──────────────────────────────────────────────────────────────────
async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), "driftnet-gif-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--hide-scrollbars", "--force-color-profile=srgb", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = "";
    chrome.stderr.on("data", (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
    chrome.on("exit", () => reject(new Error(`Chrome exited:\n${err}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let nextId = 0; const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1.5, mobile: false }, s);
  const evaluate = async (expression) => {
    const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, what, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) { const v = await evaluate(expression).catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(80); }
  };
  const close = () => { try { ws.close(); } catch {} chrome.kill(); rmSync(profile, { recursive: true, force: true }); };
  return { cdp, s, evaluate, waitFor, close };
}

// ── One language ────────────────────────────────────────────────────────────
async function makeOne(lang) {
  const t = TEXT[lang];
  const home = mkdtempSync(join(tmpdir(), "driftnet-gif-"));
  const frames = process.env.FRAMES ? join(process.env.FRAMES, lang) : mkdtempSync(join(tmpdir(), "driftnet-gif-frames-"));
  rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true });
  const port = await freePort();
  writeFileSync(join(home, ".env"), `PORT=${port}\nDRIFTNET_JUDGE=off\nDRIFTNET_LANGUAGE=${t.language}\n`);
  const items = JSON.parse(readFileSync(join(SERVER, "e2e/demo-items.json"), "utf8"))[lang];
  const tsx = join(ROOT, "node_modules/.bin/tsx");
  const run = (code, env) => new Promise((resolve, reject) => {
    const p = spawn(tsx, ["--eval", code], { cwd: SERVER, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, DEMO_DB: join(home, "driftnet.db"), DEMO_LANG: lang, ...env } });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("seeding failed"))));
  });
  const up = `store.upsert({ url: i.url, aliases: [], title: i.title, flags: [], source: "demo", summary: i.summary, judgement: { isAiTool: 1, category: i.category, kind: i.kind, worth: i.worth, engine: "llm", confidence: 1 } });`;
  const star = (i) => /paperclip/i.test(i.url);
  // Everything but the card that "arrives" in the chat scene.
  await run(`import { loadCategories, Store } from "@driftnet/core";
    const items = JSON.parse(process.env.DEMO_ITEMS); const store = new Store(process.env.DEMO_DB); store.seedFolders(loadCategories());
    for (const i of items) { ${up} }
    for (const [id, n] of [[1, 2], [2, 1]]) for (let k = 0; k < n; k++) store.recordShare(id, { platform: "line", chatId: "demo" });`, { DEMO_ITEMS: JSON.stringify(items.filter((i) => !star(i))) });
  const server = spawn(tsx, ["src/main.ts"], { cwd: SERVER, env: { ...process.env, DRIFTNET_HOME: home, DRIFTNET_OPEN: "0" }, stdio: "ignore" });
  const b = await launchChrome();
  const { cdp, s, evaluate, waitFor } = b;
  try {
    for (let i = 0; i < 60; i++) { if (await fetch(`http://127.0.0.1:${port}/api/stats`).then(() => true, () => false)) break; await sleep(200); }

    // A steady capture loop on a virtual clock (time spent while paused does not count).
    let busy = false, paused = true, stop = false, vt = 0, last = Date.now(), n = 0; const stamps = [];
    const loop = (async () => {
      while (!stop) {
        const now = Date.now(); if (!paused) vt += now - last; last = now;
        if (paused) { await sleep(10); continue; }
        const at = vt;
        busy = true;
        const { data } = await Promise.race([cdp("Page.captureScreenshot", { format: "jpeg", quality: 92 }, s), sleep(3000).then(() => ({ data: null }))]).catch(() => ({ data: null }));
        busy = false;
        if (data) { writeFileSync(join(frames, `f${String(n).padStart(5, "0")}.jpg`), Buffer.from(data, "base64")); stamps.push(at); n++; }
      }
    })();
    const resume = () => { last = Date.now(); paused = false; };
    const hold = (ms) => sleep(ms);
    const load = async (url, ready) => {
      paused = true; while (busy) await sleep(10); await cdp("Page.navigate", { url }, s); await sleep(250); await waitFor(ready, "page " + url); await sleep(150);
    };
    const log = (m) => console.log(`[${lang}] ${m}`);
    const caption = (txt) => evaluate(`window.cap(${JSON.stringify(txt)})`);

    log("scene 1");
    // 1 — the chat
    const chatFile = join(home, "chat.html");
    // Chat id: where the arriving card will land.
    const arriveId = items.length;
    writeFileSync(chatFile, chatHtml(t, arriveId));
    await load("file://" + chatFile, "!!document.getElementById('cap')");
    resume(); await sleep(250); await caption(t.caps[0]); await waitFor("window.done", "chat scene", 12000); await hold(900);

    // The card arrives (as if the bot had just filed it).
    const star1 = items.find(star);
    await run(`import { Store } from "@driftnet/core"; const store = new Store(process.env.DEMO_DB); const i = JSON.parse(process.env.DEMO_ITEMS); ${up}`, { DEMO_ITEMS: JSON.stringify(star1) });

    log("scene 2");
    // 2 — the real page: the new card in the Inbox
    await load(`http://127.0.0.1:${port}/`, "1");
    await evaluate(`localStorage.setItem("driftnet-locale", ${JSON.stringify(t.locale)})`);
    await cdp("Page.reload", {}, s); await sleep(300);
    await waitFor(`document.querySelectorAll(".swipe").length >= 3`, "cards");
    await evaluate(`document.querySelector('[data-field="view"][data-value="inbox"]').click()`);
    await waitFor(`!!document.getElementById("item-${arriveId}")`, "the new card");
    await evaluate(pageInject);
    await evaluate(`document.getElementById("item-${arriveId}").classList.add("newcard"); window.scrollTo(0,0)`);
    await sleep(300); resume(); await caption(t.caps[1]); await hold(1500);
    await evaluate(`document.getElementById("item-${arriveId}").classList.remove("newcard")`);

    log("scene 3");
    // 3 — search
    const moveCursor = async (x0, y0, x1, y1, ms = 500) => {
      const steps = Math.max(2, Math.round(ms / 40));
      for (let k = 1; k <= steps; k++) { const e = 1 - Math.pow(1 - k / steps, 3); await evaluate(`window.cur(${x0 + (x1 - x0) * e},${y0 + (y1 - y0) * e})`); await sleep(40); }
    };
    await evaluate(`document.querySelector('[data-field="view"][data-value="all"]').click()`);
    await sleep(500); await caption(t.caps[2]);
    const box = (sel) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const q = await box("#q");
    await moveCursor(W - 300, 520, q.x + q.w / 2, q.y + q.h / 2, 600);
    await evaluate(`document.getElementById("q").focus()`); await sleep(200);
    for (const ch of [...t.search]) { await cdp("Input.insertText", { text: ch }, s); await sleep(110 + Math.random() * 50); }
    await waitFor(`document.querySelectorAll(".swipe").length < ${items.length}`, "the list filters", 4000).catch(() => {});
    await hold(1100);

    log("scene 4");
    // 4 — the card detail
    await caption(t.caps[3]);
    const c = await box(`#item-${arriveId} .card`);
    await moveCursor(q.x + q.w / 2, q.y + q.h / 2, c.x + c.w * 0.45, c.y + c.h * 0.4, 600);
    await sleep(150);
    await evaluate(`document.querySelector('#item-${arriveId} .card').click()`);
    await waitFor(`document.getElementById("item-dlg").open`, "modal"); await evaluate(`window.cur(-100,-100)`);
    await hold(1700);
    await evaluate(`document.getElementById("item-dlg").close(); history.replaceState(null, "", location.pathname)`).catch(() => {});

    log("scene 5");
    // 5 — the mind map
    await caption(t.caps[4]);
    await evaluate(`document.getElementById("q").value = ""; document.getElementById("q").dispatchEvent(new Event("input", { bubbles: true }))`);
    const mb = await box('[data-field="view"][data-value="map"]');
    await moveCursor(c.x + c.w * 0.45, c.y + c.h * 0.4, mb.x + mb.w / 2, mb.y + mb.h / 2, 600);
    await evaluate(`document.querySelector('[data-field="view"][data-value="map"]').click()`);
    await waitFor(`!!document.querySelector('.mnode[data-key="root"]')`, "map"); await evaluate(`window.cur(-100,-100)`);
    await evaluate(`document.querySelector('.map-hint button, [data-act="hint-close"]')?.click(); [...document.querySelectorAll('button')].find((b) => /Expand all|全部展開/.test(b.textContent))?.click()`).catch(() => {});
    await hold(1800);
    paused = true; while (busy) await sleep(10);

    log("scene 6");
    // 6 — end card
    const endFile = join(home, "end.html"); writeFileSync(endFile, endHtml(t));
    await load("file://" + endFile, "document.body.innerText.length > 5");
    resume(); await hold(1500);
    stop = true; await loop;

    // Assemble: timestamps → concat durations → palette GIF.
    const list = stamps.map((a, i) => `file 'f${String(i).padStart(5, "0")}.jpg'\nduration ${(((stamps[i + 1] ?? a + 1000 / FPS) - a) / 1000).toFixed(4)}`);
    list.push(`file 'f${String(stamps.length - 1).padStart(5, "0")}.jpg'`);
    writeFileSync(join(frames, "list.txt"), list.join("\n"));
    const out = join(ROOT, "assets", `demo-${lang}.gif`);
    const vf = `fps=${FPS},scale=${OUT_W}:-1:flags=lanczos`;
    execFileSync(FFMPEG, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", join(frames, "list.txt"), "-vf", `${vf},split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`, "-loop", "0", out], { stdio: "inherit" });
    console.log(`${lang}: ${stamps.length} frames captured, ${(vt / 1000).toFixed(1)} s, ${(statSync(out).size / 1e6).toFixed(2)} MB → ${out}`);
  } finally {
    b.close(); server.kill(); rmSync(home, { recursive: true, force: true });
    if (!process.env.FRAMES) rmSync(frames, { recursive: true, force: true });
  }
}

for (const lang of only ? [only] : ["en", "zh-TW"]) await makeOne(lang);
