// A throwaway driftnet with demo data, for trying the page or testing it by hand.
//   node apps/server/e2e/demo-server.mjs [--port 18800] [--lang zh-TW|en] [--many] [--password pw] [--private] [--read-key key]
// --many adds ~120 generated cards across folders (to see the mind map at scale).
// Prints the URL and keeps running until Ctrl-C; the data lives in a temp folder.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const LANG = opt("lang", "zh-TW") === "en" ? "en" : "zh-TW";
const PORT = Number(opt("port", 18800));
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..");
const tsx = join(SERVER, "../../node_modules/.bin/tsx");

const home = mkdtempSync(join(tmpdir(), "driftnet-demo-"));
const env = [`PORT=${PORT}`, "DRIFTNET_JUDGE=off", `DRIFTNET_LANGUAGE=${LANG === "zh-TW" ? "Traditional Chinese (Taiwan)" : "English"}`];
if (opt("password")) env.push(`DRIFTNET_TOKEN=${opt("password")}`);
if (opt("read-key")) env.push(`DRIFTNET_READ_KEY=${opt("read-key")}`);
if (flag("private")) env.push("DRIFTNET_ACCESS=private");
writeFileSync(join(home, ".env"), env.join("\n") + "\n");

const seed = `
  import { loadCategories, Store } from "@driftnet/core";
  const items = JSON.parse(process.env.DEMO_ITEMS);
  const zh = process.env.DEMO_LANG === "zh-TW";
  const store = new Store(process.env.DEMO_DB);
  store.seedFolders(loadCategories());
  const mine = store.createFolder({ name: zh ? "我的工作流" : "My workflow", description: "Tools I use every day" });
  store.createFolder({ name: zh ? "設計" : "Design", description: "UI and design helpers", parent: mine.id });
  store.updateFolder(mine.id, { position: -1 });
  for (const i of items) store.upsert({ url: i.url, aliases: [], title: i.title, flags: [], source: "demo", summary: i.summary,
    judgement: { isAiTool: 1, category: i.category, kind: i.kind, worth: i.worth, engine: "llm", confidence: 1 } });
  store.recordShare(1, { platform: "line", chatId: "demo", note: zh ? "這個可以拿來管我們的 Hermes agent 團隊" : "Could run our Hermes agent team with this" });
  store.setNote(2, zh ? "試過了，開專案很快；要搭配 pi agent。" : "Tried it — fast to open a repo; needs pi agent.");
  if (process.env.DEMO_MANY) {
    const folders = ["coding-agent", "agent-framework", "automation", "other", "design-frontend", "knowledge-rag"];
    const worth = ["normal", "normal", "low", "must-see", "normal"];
    for (let n = 1; n <= 120; n++) {
      const f = folders[n % folders.length];
      store.upsert({ url: "https://github.com/demo/tool-" + n, aliases: [], title: "tool-" + n, flags: [], source: "demo",
        summary: { name: "Demo Tool " + n, oneLiner: (zh ? "示範工具，編號 " : "A demo tool, number ") + n, highlights: ["one", "two"], useCases: [], tags: ["demo"] },
        judgement: { isAiTool: 1, category: n % 7 === 0 ? "other" : f, kind: "repo", worth: worth[n % worth.length], engine: "llm", confidence: 1 } });
    }
  }
`;
const demo = JSON.parse(readFileSync(join(HERE, "demo-items.json"), "utf8"))[LANG];
await new Promise((resolve, reject) => {
  const p = spawn(tsx, ["--eval", seed], {
    cwd: SERVER, stdio: "inherit",
    env: { ...process.env, DEMO_DB: join(home, "driftnet.db"), DEMO_ITEMS: JSON.stringify(demo), DEMO_LANG: LANG, ...(flag("many") ? { DEMO_MANY: "1" } : {}) },
  });
  p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("seeding failed"))));
});
const server = spawn(tsx, ["src/main.ts"], { cwd: SERVER, env: { ...process.env, DRIFTNET_HOME: home, DRIFTNET_OPEN: "0" }, stdio: "inherit" });
for (let i = 0; i < 50; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/api/stats`).then(() => true, () => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`\ndemo ready: http://127.0.0.1:${PORT}/   (data in ${home})`);
console.log("Seen from elsewhere (a phone, a tunnel): send the header x-forwarded-for, or map a hostname such as remote.test to 127.0.0.1.");
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.kill(); process.exit(0); });
