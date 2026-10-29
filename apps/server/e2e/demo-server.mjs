// A throwaway driftnet with demo data, for trying the page or testing it by hand.
//   node apps/server/e2e/demo-server.mjs [--port 18800] [--lang zh-TW|en] [--many] [--password pw] [--private] [--read-key key]
// --many adds ~120 generated cards across folders (to see the mind map at scale).
// Prints the URL and keeps running until Ctrl-C; the data lives in a temp folder.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedDemo } from "./demo-seed.mjs";

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

await seedDemo({ dbPath: join(home, "driftnet.db"), lang: LANG, many: flag("many") });
const server = spawn(tsx, ["src/main.ts"], { cwd: SERVER, env: { ...process.env, DRIFTNET_HOME: home, DRIFTNET_OPEN: "0" }, stdio: "inherit" });
for (let i = 0; i < 50; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/api/stats`).then(() => true, () => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`\ndemo ready: http://127.0.0.1:${PORT}/   (data in ${home})`);
console.log("Seen from elsewhere (a phone, a tunnel): send the header x-forwarded-for, or map a hostname such as remote.test to 127.0.0.1.");
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.kill(); process.exit(0); });
