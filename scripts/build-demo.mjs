// Builds the zero-backend web demo into dist/demo/ (published by .github/workflows/pages.yml).
//   node scripts/build-demo.mjs
// The real page (apps/server/public/index.html) is copied as it is, with two <script> tags injected before its
// own script: data.js (a snapshot of the real server answering the demo seed, one per language) and demo-api.js
// (demo/demo-api.js: a fetch shim that answers /api/* from that snapshot, in memory + sessionStorage).
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedDemo } from "../apps/server/e2e/demo-seed.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "apps/server");
const PUBLIC = join(SERVER, "public");
const OUT = join(ROOT, "dist/demo");
const tsx = join(ROOT, "node_modules/.bin/tsx");

const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

/** Seed one language, run the real server on it, and read every list the page asks for. */
async function snapshot(lang) {
  const home = mkdtempSync(join(tmpdir(), "driftnet-demo-build-"));
  const port = await freePort();
  writeFileSync(join(home, ".env"), [`PORT=${port}`, "DRIFTNET_JUDGE=off", `DRIFTNET_LANGUAGE=${lang === "zh-TW" ? "Traditional Chinese (Taiwan)" : "English"}`].join("\n") + "\n");
  await seedDemo({ dbPath: join(home, "driftnet.db"), lang });
  const server = spawn(tsx, ["src/main.ts"], { cwd: SERVER, env: { ...process.env, DRIFTNET_HOME: home, DRIFTNET_OPEN: "0" }, stdio: "ignore" });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      if (await fetch(`${base}/api/stats`).then(() => true, () => false)) break;
      if (i > 150) throw new Error("demo server did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
    const get = (p) => fetch(base + p).then((r) => r.json());
    const items = await get("/api/items?all=1&limit=500");
    // The Inbox view also carries each card's suggested folders.
    for (const i of await get("/api/items?all=1&view=inbox&limit=500")) Object.assign(items.find((x) => x.id === i.id) ?? {}, { suggestions: i.suggestions });
    const [folders, ui, notes] = await Promise.all([get("/api/folders"), get("/api/ui"), get("/api/notes")]);
    return { items, folders, ui: { ...ui, port: 8787, local: false, passwordSet: false, setup: false }, notes, builtAt: new Date().toISOString() };
  } finally {
    server.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

const data = {};
for (const lang of ["en", "zh-TW"]) data[lang] = await snapshot(lang);

// Pictures: the server serves them through a proxy; the demo ships the e2e fixture files as plain static files.
const FIXTURES = join(SERVER, "e2e/fixtures");
const mediaFiles = new Map();
for (const lang of Object.keys(data)) {
  for (const item of data[lang].items) {
    item.media = item.media.map((m, n) => {
      const rel = `media/${item.id}-${n}.jpg`;
      mediaFiles.set(rel, join(FIXTURES, `shark-${n}.jpg`));
      return { ...m, src: rel };
    });
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const f of ["favicon.svg", "apple-touch-icon.png", "icon-512.png", "qr.js", "manifest.webmanifest"]) cpSync(join(PUBLIC, f), join(OUT, f));
mkdirSync(join(OUT, "media"), { recursive: true });
for (const [rel, from] of mediaFiles) cpSync(from, join(OUT, rel));
cpSync(join(ROOT, "demo/demo-api.js"), join(OUT, "demo-api.js"));
writeFileSync(join(OUT, "data.js"), `window.DRIFTNET_DEMO_DATA=${JSON.stringify(data)};\n`);
writeFileSync(join(OUT, ".nojekyll"), "");

// The page asks for /favicon.svg etc. from the site root; on Pages the site lives under /driftnet/, so make them relative.
// The feed link is dropped: there is no feed on a static site.
let html = readFileSync(join(PUBLIC, "index.html"), "utf8");
const before = html;
html = html
  .replace(/<link rel="alternate" type="application\/atom\+xml"[^>]*>\n?/, "")
  .replaceAll('href="/', 'href="./').replaceAll('src="/', 'src="./')
  .replace('import("/qr.js")', 'import("./qr.js")');
if (!html.includes("<head>") && !html.includes("</head>")) throw new Error("index.html has no <head>");
html = html.replace("</head>", '<script src="data.js"></script>\n<script src="demo-api.js"></script>\n</head>');
if (html === before) throw new Error("nothing was rewritten");
writeFileSync(join(OUT, "index.html"), html);
console.log(`demo built: ${OUT}  (${data.en.items.length} cards)`);
