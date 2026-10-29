// The demo data (shared by demo-server.mjs and scripts/build-demo.mjs): seeds a fresh database file
// through the real Store, so the demo shows exactly what the product would.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..");
const tsx = join(SERVER, "../../node_modules/.bin/tsx");

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
  // Pictures for ascii-sharks (the first a GIF). The files are e2e/fixtures/shark-N.jpg; the demo server cannot fetch
  // them from the internet, so its picture proxy answers 404 and the card simply has no pictures there.
  const shark = items.findIndex((i) => /ascii-sharks/.test(i.url)) + 1;
  if (shark > 0) store.setMedia(shark, [0, 1, 2].map((n) => ({ url: "https://media.example/shark-" + n + (n ? ".png" : ".gif"), kind: n ? "image" : "gif", alt: "ascii-sharks picture " + (n + 1) })));
  for (const [id, n] of [[1, 3], [2, 2], [4, 1]]) for (let k = 0; k < n; k++) store.recordShare(id, { platform: "line", chatId: "demo" });
  store.saveNote({ title: zh ? "這週要試的工具" : "To try this week",
    body: zh ? "- #1 管 agent 團隊\\n- #3 做 **ASCII** 動畫\\n\\n> 先在測試機上跑" : "- #1 for the agent team\\n- #3 for **ASCII** animations\\n\\n> Run it on the test box first" });
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

/** Seed `dbPath` with the demo cards in `lang` ("en" | "zh-TW"); `many` adds ~120 generated cards. */
export async function seedDemo({ dbPath, lang, many = false }) {
  const demo = JSON.parse(readFileSync(join(HERE, "demo-items.json"), "utf8"))[lang];
  await new Promise((resolve, reject) => {
    const p = spawn(tsx, ["--eval", seed], {
      cwd: SERVER, stdio: "inherit",
      env: { ...process.env, DEMO_DB: dbPath, DEMO_ITEMS: JSON.stringify(demo), DEMO_LANG: lang, ...(many ? { DEMO_MANY: "1" } : {}) },
    });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("seeding failed"))));
  });
}
