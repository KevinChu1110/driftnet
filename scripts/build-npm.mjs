// Builds the `driftnet` npm package into dist/npm: one bundled file plus the
// web page's assets. Runtime libraries stay as normal dependencies.
//   node scripts/build-npm.mjs && (cd dist/npm && npm pack)   # try it: npx ./driftnet-x.y.z.tgz
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist/npm");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const rootPkg = read("package.json");
const server = read("apps/server/package.json");
const core = read("packages/core/package.json");
const version = process.env.VERSION ?? server.version;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const dependencies = Object.fromEntries(
  Object.entries({ ...core.dependencies, ...server.dependencies }).filter(([name]) => !name.startsWith("@driftnet/")),
);
await build({
  entryPoints: [join(root, "apps/server/src/cli.ts")],
  outfile: join(out, "dist/driftnet.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: Object.keys(dependencies),
  define: { "process.env.DRIFTNET_VERSION": JSON.stringify(version) },
  // Some bundled code still calls require() for Node built-ins.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  logLevel: "warning",
});
cpSync(join(root, "apps/server/public"), join(out, "public"), { recursive: true });
for (const f of ["LICENSE", ".env.example"]) cpSync(join(root, f), join(out, f));
// npmjs.com can't see the repo's assets/ folder: point images and links at GitHub.
for (const f of ["README.md", "README.zh-TW.md"]) {
  writeFileSync(join(out, f), readFileSync(join(root, f), "utf8")
    .replace(/(src|href)="(assets\/[^"]+)"/g, '$1="https://raw.githubusercontent.com/KevinChu1110/driftnet/main/$2"')
    .replace(/\]\((?!https?:|#)([^)]+)\)/g, "](https://github.com/KevinChu1110/driftnet/blob/main/$1)"));
}
cpSync(join(root, "examples"), join(out, "examples"), { recursive: true });
writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "driftnet",
  version,
  description: rootPkg.description,
  license: rootPkg.license,
  type: "module",
  bin: { driftnet: "dist/driftnet.mjs" },
  files: ["dist", "public", "examples", ".env.example", "README.zh-TW.md"],
  engines: rootPkg.engines,
  repository: { type: "git", url: "git+https://github.com/KevinChu1110/driftnet.git" },
  homepage: "https://github.com/KevinChu1110/driftnet#readme",
  keywords: ["ai", "links", "bookmarks", "chatbot", "discord", "telegram", "slack", "line", "mcp", "agents"],
  dependencies,
}, null, 2) + "\n");
console.log(`dist/npm: driftnet@${version}`);
