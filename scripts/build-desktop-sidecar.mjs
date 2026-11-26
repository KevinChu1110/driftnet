// Builds the standalone Node SEA sidecar binary + resources for apps/desktop (Tauri v2).
//   node scripts/build-desktop-sidecar.mjs
// Output:
//   apps/desktop/src-tauri/binaries/driftnet-server-<target-triple>[.exe]
//   apps/desktop/src-tauri/resources/public/*
//   apps/desktop/src-tauri/resources/skills/*
//   apps/desktop/src-tauri/icons/icon.png
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAURI = join(ROOT, "apps/desktop/src-tauri");
const serverPkg = JSON.parse(readFileSync(join(ROOT, "apps/server/package.json"), "utf8"));
const version = process.env.VERSION ?? serverPkg.version;

function targetTriple() {
  if (process.env.TAURI_TARGET_TRIPLE) return process.env.TAURI_TARGET_TRIPLE;
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

const triple = targetTriple();
const ext = triple.includes("windows") ? ".exe" : "";
const work = mkdtempSync(join(tmpdir(), "driftnet-sea-"));

try {
  const bundle = join(work, "driftnet-standalone.cjs");
  await build({
    entryPoints: [join(ROOT, "apps/server/src/cli.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    define: { "process.env.DRIFTNET_VERSION": JSON.stringify(version) },
    logLevel: "warning",
  });

  const seaConfig = join(work, "sea-config.json");
  const blob = join(work, "sea-prep.blob");
  writeFileSync(seaConfig, JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
  }));

  execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

  const binDir = join(TAURI, "binaries");
  mkdirSync(binDir, { recursive: true });
  const outBin = join(binDir, `driftnet-server-${triple}${ext}`);
  copyFileSync(process.execPath, outBin);
  if (process.platform !== "win32") chmodSync(outBin, 0o755);

  if (process.platform === "darwin") {
    execFileSync("codesign", ["--remove-signature", outBin], { stdio: "inherit" });
  }

  // Inject the SEA blob using postject (via npx so it stays out of runtime dependencies).
  const postjectArgs = [
    "-y", "postject", outBin, "NODE_SEA_BLOB", blob,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
  ];
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", postjectArgs, { stdio: "inherit" });

  if (process.platform === "darwin") {
    execFileSync("codesign", ["--sign", "-", outBin], { stdio: "inherit" });
  }

  // Sync web assets, skills and tray/app icon into src-tauri.
  const resDir = join(TAURI, "resources");
  rmSync(resDir, { recursive: true, force: true });
  cpSync(join(ROOT, "apps/server/public"), join(resDir, "public"), { recursive: true });
  cpSync(join(ROOT, "skills"), join(resDir, "skills"), { recursive: true });
  mkdirSync(join(TAURI, "icons"), { recursive: true });
  copyFileSync(join(ROOT, "apps/server/public/icon-512.png"), join(TAURI, "icons/icon.png"));

  console.log(`desktop sidecar ready: ${outBin}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
