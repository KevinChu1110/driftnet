// Builds the GitHub Pages site into dist/site/: the landing page (site/index.html) at the root
// and the zero-backend demo (scripts/build-demo.mjs) under demo/.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist/site");

execFileSync(process.execPath, [join(ROOT, "scripts/build-demo.mjs")], { stdio: "inherit" });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "assets"), { recursive: true });
cpSync(join(ROOT, "site/index.html"), join(OUT, "index.html"));
// Only what the landing page shows.
for (const f of ["logo.svg", "demo-en.gif", "demo-zh-TW.gif", "card-modal-en.jpg", "card-modal-zh-TW.jpg", "map-en.jpg", "map-zh-TW.jpg", "cards-en.jpg", "cards-zh-TW.jpg"]) {
  cpSync(join(ROOT, "assets", f), join(OUT, "assets", f));
}
cpSync(join(ROOT, "assets/screenshot-en.jpg"), join(OUT, "assets/og.jpg"));
cpSync(join(ROOT, "dist/demo"), join(OUT, "demo"), { recursive: true });
writeFileSync(join(OUT, ".nojekyll"), "");
console.log(`site → ${OUT} (landing + demo/)`);
