// Builds the Chrome Web Store package: dist/extension (the files Chrome loads) and
// dist/driftnet-extension-<version>.zip (what you upload).
//   node scripts/build-extension.mjs            # build + validate + zip
//   node scripts/build-extension.mjs --icons    # first redraw icons/*.png from assets/*.svg
//                                               #   (headless Chrome; set CHROME=/path/to/chrome)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "apps/chrome-extension");
const out = join(root, "dist/extension");
const json = (p) => JSON.parse(readFileSync(p, "utf8"));

// Smallest sizes use the simplified marks; anything inside the net is noise at 16 px.
const ICONS = { 16: "logo-16.svg", 32: "logo-small.svg", 48: "logo-small.svg", 128: "logo.svg" };

if (process.argv.includes("--icons")) {
  const chrome = process.env.CHROME;
  if (!chrome) throw new Error("--icons needs CHROME=/path/to/Chrome-for-Testing or Chromium");
  const tmp = mkdtempSync(join(tmpdir(), "driftnet-icons-"));
  for (const [size, svg] of Object.entries(ICONS)) {
    const page = join(tmp, `${size}.html`);
    const png = join(tmp, `${size}.png`);
    const data = readFileSync(join(root, "assets", svg), "base64");
    writeFileSync(page, `<!doctype html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${data}" width="${size}" height="${size}" style="display:block"></body>`);
    execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000",
      `--window-size=${size},${size}`, `--screenshot=${png}`, `file://${page}`], { stdio: "ignore" });
    renameSync(png, join(src, "icons", `${size}.png`));
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log("icons redrawn from assets/*.svg");
}

// ── Copy, without the dev-only files ────────────────────────────────────────
const DEV_ONLY = new Set(["e2e.mjs", "test", "store"]);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true, filter: (p) => !DEV_ONLY.has(p.slice(src.length + 1).split("/")[0]) && !p.endsWith(".DS_Store") });

// ── Validate ────────────────────────────────────────────────────────────────
const problems = [];
const check = (ok, msg) => ok || problems.push(msg);
const manifest = json(join(out, "manifest.json"));
const version = json(join(root, "apps/server/package.json")).version;

check(manifest.manifest_version === 3, "manifest_version must be 3");
check(manifest.version === version, `manifest version ${manifest.version} must equal apps/server version ${version}`);
check(manifest.homepage_url, "homepage_url missing");
check(manifest.minimum_chrome_version, "minimum_chrome_version missing");
check(manifest.default_locale, "default_locale missing");
for (const size of Object.keys(ICONS)) check(manifest.icons?.[size] && existsSync(join(out, manifest.icons[size])), `icon ${size}x${size} missing`);

// Every permission must be one the code actually uses (the store rejects extras).
const USED = { activeTab: "popup / context menu click", scripting: "collect.js", contextMenus: "background.js", storage: "settings" };
const code = ["background.js", "options.js", "popup.js"].map((f) => readFileSync(join(out, f), "utf8")).join("\n");
for (const perm of manifest.permissions ?? []) {
  check(perm in USED, `unexpected permission "${perm}"`);
  check(perm === "activeTab" || code.includes(`chrome.${perm}`), `permission "${perm}" is declared but never used`);
}
check(!(manifest.host_permissions ?? []).some((h) => !/^http:\/\/(localhost|127\.0\.0\.1)\//.test(h)), "host_permissions may only list loopback addresses");

for (const lang of ["en", "zh_TW"]) {
  const messages = json(join(out, "_locales", lang, "messages.json"));
  const name = messages.name?.message ?? "";
  const description = messages.description?.message ?? "";
  check(name && [...name].length <= 45, `${lang}: name missing or over 45 characters`);
  check(description && [...description].length <= 132, `${lang}: description missing or over 132 characters (${[...description].length})`);
  for (const key of [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1])) check(messages[key], `${lang}: message "${key}" missing`);
}
for (const f of ["background.js", "collect.js", "popup.html", "popup.js", "options.html", "options.js"]) check(existsSync(join(out, f)), `${f} missing`);
for (const dev of DEV_ONLY) check(!existsSync(join(out, dev)), `${dev} leaked into the package`);

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exit(1);
}

// ── Zip ─────────────────────────────────────────────────────────────────────
const zip = join(root, "dist", `driftnet-extension-${version}.zip`);
rmSync(zip, { force: true });
execFileSync("zip", ["-r", "-X", "-q", zip, "."], { cwd: out });
console.log(`✓ manifest ok (v${version}, ${manifest.permissions.join(", ")})`);
console.log(`✓ ${zip.replace(root + "/", "")}  ${(statSync(zip).size / 1024).toFixed(1)} KB`);
