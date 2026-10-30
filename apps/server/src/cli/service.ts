import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { parseArgs, UsageError } from "./args.ts";
import type { Ctx } from "./commands.ts";
import { realRun, type RunResult } from "./init.ts";

/**
 * `driftnet service install|uninstall|status`: start driftnet at login without a terminal window.
 * macOS: a LaunchAgent · Linux: a systemd --user unit · Windows: a hidden script in the Startup folder.
 *
 * What the service runs: a private copy of this exact version, installed with npm into
 * DRIFTNET_HOME/service, started with the node that ran this command:
 *   <node> <DRIFTNET_HOME>/service/node_modules/driftnet/dist/cli.mjs start
 * Not `npx driftnet`: the npx cache can be cleaned at any time, and re-fetching at login needs the
 * network (and could pick up a different version). Not a global install: that may need sudo and
 * depends on PATH. The copy needs neither, is pinned, and is removed again by `uninstall`.
 * Updating is `npx driftnet@latest service install` (re-install replaces everything).
 */

export const LABEL = "io.github.kevinchu1110.driftnet";
const UNIT = "driftnet.service";
const STARTUP_FILE = "driftnet.vbs";
const MARK = "managed by `driftnet service`; change it with `npx driftnet service install|uninstall`";
/** The source checkout's `pnpm service:install` uses this label; both at once fight over the port. */
const OLD_LABEL = "io.github.driftnet";

export type PortState = "driftnet" | "other" | "free";
export interface Files {
  exists: (p: string) => boolean;
  realpath: (p: string) => string;
  read: (p: string) => string;
  write: (p: string, content: string) => void;
  mkdir: (p: string) => void;
  /** Delete a file or a whole folder; no error if it is not there. */
  remove: (p: string) => void;
}
/** Extra things `service` needs; tests swap them. Optional so the plain CLI context works as is. */
export interface ServiceCtx extends Ctx {
  platform?: NodeJS.Platform;
  run?: (cmd: string, args: string[]) => Promise<RunResult>;
  files?: Files;
  /** The node binary the service will run (default: the one running now). */
  execPath?: string;
  uid?: number;
  /** The driftnet version to pin (default: this one). */
  version?: string;
  probe?: (port: number) => Promise<PortState>;
}

const realFiles: Files = {
  exists: existsSync,
  realpath: (p) => { try { return realpathSync(p); } catch { return p; } },
  read: (p) => readFileSync(p, "utf8"),
  write: (p, c) => {
    mkdirSync(p.replace(/[\\/][^\\/]*$/, ""), { recursive: true });
    writeFileSync(p, c);
  },
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  remove: (p) => rmSync(p, { recursive: true, force: true }),
};

function thisVersion(): string {
  if (process.env.DRIFTNET_VERSION) return process.env.DRIFTNET_VERSION;
  try { return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version; } catch { return "dev"; }
}

/** Is something listening on the port, and is it driftnet? */
async function realProbe(ctx: Ctx, port: number): Promise<PortState> {
  const open = await new Promise<boolean>((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
  if (!open) return "free";
  try {
    const r = await ctx.fetch(`http://127.0.0.1:${port}/api/stats`, { signal: AbortSignal.timeout(2000) });
    const body = (await r.json()) as { items?: unknown };
    return typeof body.items === "number" ? "driftnet" : "other";
  } catch {
    return "other";
  }
}

interface Env {
  platform: NodeJS.Platform;
  path: typeof posix;
  home: string;
  dataHome: string;
  dir: string;
  cli: string;
  node: string;
  logs: string;
  log: string;
  port: number;
  vars: [string, string][];
  files: Files;
  run: NonNullable<ServiceCtx["run"]>;
  uid: number;
  version: string;
}

/**
 * The node to run. Prefer the `node` on PATH when it is this same binary: Homebrew's
 * /opt/homebrew/bin/node survives `brew upgrade`, the versioned Cellar path it points to does not.
 */
function stableNode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, path: typeof posix, files: Files, execPath: string): string {
  const real = files.realpath(execPath);
  const name = platform === "win32" ? "node.exe" : "node";
  for (const d of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":")) {
    if (!d || !path.isAbsolute(d)) continue;
    const c = path.join(d, name);
    if (files.exists(c) && files.realpath(c) === real) return c;
  }
  return execPath;
}

function resolveEnv(ctx: ServiceCtx): Env {
  const platform = ctx.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const files = ctx.files ?? realFiles;
  const home = (platform === "win32" ? ctx.env.USERPROFILE || ctx.env.HOME : ctx.env.HOME) || homedir();
  const dataHome = ctx.env.DRIFTNET_HOME || path.join(home, ".driftnet");
  const dir = path.join(dataHome, "service");
  const logs = path.join(dataHome, "logs");
  const vars: [string, string][] = [];
  // PATH is kept so the claude-cli / gemini-cli providers find their CLIs (Windows inherits the user's own).
  if (platform !== "win32" && ctx.env.PATH) vars.push(["PATH", ctx.env.PATH]);
  if (ctx.env.DRIFTNET_HOME) vars.push(["DRIFTNET_HOME", ctx.env.DRIFTNET_HOME]);
  if (ctx.env.PORT) vars.push(["PORT", ctx.env.PORT]);
  vars.push(["DRIFTNET_OPEN", "0"], ["DRIFTNET_SERVICE", "1"]);
  return {
    platform, path, home, dataHome, dir, logs, vars,
    cli: path.join(dir, "node_modules", "driftnet", "dist", "cli.mjs"),
    node: stableNode(ctx.env, platform, path, files, ctx.execPath ?? process.execPath),
    log: path.join(logs, "driftnet.log"),
    port: Number(ctx.env.PORT || 8787),
    files,
    run: ctx.run ?? realRun,
    uid: ctx.uid ?? process.getuid?.() ?? 0,
    version: ctx.version ?? thisVersion(),
  };
}

// ---- what gets written -------------------------------------------------------------------------

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(e: Env): string {
  const args = [e.node, e.cli, "start"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const vars = e.vars.map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${xml(MARK)} -->
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${xml(e.dataHome)}</string>
  <key>EnvironmentVariables</key><dict>
${vars}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(e.log)}</string>
  <key>StandardErrorPath</key><string>${xml(e.log)}</string>
</dict></plist>
`;
}

/** systemd quoting: double quotes, backslash escapes, and % doubled (specifier expansion). */
const sd = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function unit(e: Env): string {
  return `# ${MARK}
[Unit]
Description=driftnet link catalogue
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${e.dataHome}
${e.vars.map(([k, v]) => `Environment=${sd(`${k}=${v}`)}`).join("\n")}
ExecStart=${[e.node, e.cli, "start"].map(sd).join(" ")}
Restart=on-failure
RestartSec=10
StandardOutput=append:${e.log}
StandardError=append:${e.log}

[Install]
WantedBy=default.target
`;
}

/** The batch file restarts driftnet after a crash (10 s apart) and stops when it exits cleanly. */
export function windowsCmd(e: Env): string {
  const pct = (s: string) => s.replace(/%/g, "%%");
  return `@echo off
rem ${MARK}
${e.vars.map(([k, v]) => `set "${k}=${pct(v)}"`).join("\r\n")}
cd /d "${pct(e.dataHome)}"
:loop
"${pct(e.node)}" "${pct(e.cli)}" start >> "${pct(e.log)}" 2>&1
if %ERRORLEVEL% EQU 0 goto :eof
ping -n 11 127.0.0.1 >nul
goto loop
`.replace(/\r?\n/g, "\r\n");
}

/** Started from the Startup folder; window style 0 keeps the console hidden. */
export function windowsVbs(cmdFile: string): string {
  return `' ${MARK}\r\nCreateObject("WScript.Shell").Run "cmd /c """"${cmdFile.replace(/"/g, '""')}""""", 0, False\r\n`;
}

// ---- per platform ------------------------------------------------------------------------------

interface Plan {
  /** Where it is registered, shown in messages. */
  where: string;
  writes: { path: string; content: string }[];
  /** Commands that register and start it. */
  start: string[][];
  manual?: string;
}

function startupDir(ctx: ServiceCtx, e: Env): string {
  return e.path.join(ctx.env.APPDATA || e.path.join(e.home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

function plan(ctx: ServiceCtx, e: Env): Plan {
  if (e.platform === "darwin") {
    const file = e.path.join(e.home, "Library", "LaunchAgents", `${LABEL}.plist`);
    return {
      where: file,
      writes: [{ path: file, content: plist(e) }],
      start: [["launchctl", "bootout", `gui/${e.uid}/${LABEL}`], ["launchctl", "bootstrap", `gui/${e.uid}`, file]],
    };
  }
  if (e.platform === "linux") {
    const file = e.path.join(ctx.env.XDG_CONFIG_HOME || e.path.join(e.home, ".config"), "systemd", "user", UNIT);
    return {
      where: file,
      writes: [{ path: file, content: unit(e) }],
      start: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", UNIT], ["systemctl", "--user", "restart", UNIT]],
      manual: `To keep it running when you are not logged in (a server), run once: loginctl enable-linger ${ctx.env.USER || "$USER"}`,
    };
  }
  if (e.platform === "win32") {
    // Startup folder, not schtasks: a logon trigger made with schtasks needs an administrator prompt.
    const cmd = e.path.join(e.dir, "driftnet-service.cmd");
    const vbs = e.path.join(startupDir(ctx, e), STARTUP_FILE);
    return {
      where: vbs,
      writes: [{ path: cmd, content: windowsCmd(e) }, { path: vbs, content: windowsVbs(cmd) }],
      start: [["wscript.exe", vbs]],
    };
  }
  throw new UsageError(`driftnet service supports macOS, Linux and Windows (this is ${e.platform}); run \`npx driftnet\` from your own startup script instead`);
}

/** npm's own CLI script, run with node (spawning npm.cmd on Windows needs a shell). */
function npmCli(ctx: ServiceCtx, e: Env): string | undefined {
  const d = e.path.dirname(e.node);
  const candidates = [
    ctx.env.npm_execpath?.replace(/npx-cli\.js$/, "npm-cli.js"),
    e.path.join(d, "node_modules", "npm", "bin", "npm-cli.js"),
    e.path.join(d, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    e.path.join(e.path.dirname(e.files.realpath(e.node)), "..", "libexec", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((p): p is string => !!p && /npm-cli\.js$/.test(p) && e.files.exists(p));
}

function installedVersion(e: Env): string | undefined {
  const pkg = e.path.join(e.dir, "node_modules", "driftnet", "package.json");
  try { return e.files.exists(pkg) ? (JSON.parse(e.files.read(pkg)) as { version?: string }).version : undefined; } catch { return undefined; }
}

const show = (argv: string[]) => argv.map((a) => (/[\s"'$`\\]/.test(a) || a === "" ? JSON.stringify(a) : a)).join(" ");
const firstLine = (r: RunResult) => (r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`;

// ---- commands ----------------------------------------------------------------------------------

async function install(ctx: ServiceCtx, e: Env, dry: boolean): Promise<number> {
  if (e.version === "dev") {
    ctx.err("driftnet: can't tell which driftnet version to install. From a source checkout use `pnpm service:install`.");
    return 1;
  }
  const p = plan(ctx, e);
  const runs = [e.node, e.cli, "start"];
  const have = installedVersion(e);
  const npm = npmCli(ctx, e);
  const npmArgs = ["install", "--prefix", e.dir, "--no-audit", "--no-fund", "--omit=dev", "--loglevel=error", `driftnet@${e.version}`];
  const copy = have === e.version ? undefined : [e.node, npm ?? "<npm-cli.js next to node>", ...npmArgs];

  if (dry) {
    ctx.out(`driftnet service install (dry run; nothing is written or started):`);
    ctx.out(copy ? `  run: ${show(copy)}` : `  keep: driftnet ${e.version} already in ${e.dir}`);
    for (const w of p.writes) ctx.out(`  write ${w.path}:\n${w.content.replace(/\r\n/g, "\n").trimEnd().split("\n").map((l) => `    | ${l}`).join("\n")}`);
    for (const c of p.start) ctx.out(`  run: ${show(c)}`);
    ctx.out(`  the service runs: ${show(runs)}\n  logs: ${e.log}`);
    if (p.manual) ctx.out(`  ${p.manual}`);
    if (copy && !npm) { ctx.err("driftnet: npm was not found next to node; the real install would stop here."); return 1; }
    return 0;
  }

  if (copy) {
    if (!npm) {
      ctx.err(`driftnet: npm was not found next to ${e.node}. Reinstall Node.js from nodejs.org (it includes npm) and try again.`);
      return 1;
    }
    e.files.mkdir(e.dir);
    ctx.out(`Installing driftnet ${e.version} into ${e.dir} (the copy the service runs)…`);
    const r = await e.run(e.node, [npm, ...npmArgs]);
    if (r.code !== 0 || !e.files.exists(e.cli)) {
      ctx.err(`driftnet: npm install failed: ${firstLine(r)}`);
      return 1;
    }
  }
  for (const w of p.writes) e.files.write(w.path, w.content);
  e.files.mkdir(e.logs); // launchd and systemd don't create the log folder

  if (e.platform === "darwin") {
    await e.run("launchctl", p.start[0]!.slice(1)); // not loaded yet is fine
    let r = await e.run("launchctl", p.start[1]!.slice(1));
    if (r.code !== 0) { await ctx.sleep(1000); r = await e.run("launchctl", p.start[1]!.slice(1)); } // bootout can lag
    if (r.code !== 0) r = await e.run("launchctl", ["load", "-w", p.where]); // older macOS
    if (r.code !== 0) { ctx.err(`driftnet: launchctl could not load ${p.where}: ${firstLine(r)}`); return 1; }
    if (e.files.exists(e.path.join(e.home, "Library", "LaunchAgents", `${OLD_LABEL}.plist`))) {
      ctx.err(`note: the source checkout's agent (${OLD_LABEL}) is installed too and uses the same port; remove it with \`pnpm service:uninstall\`.`);
    }
  } else {
    for (const c of p.start) {
      const r = await e.run(c[0]!, c.slice(1));
      if (r.code !== 0) {
        const hint = e.platform === "linux" ? " (systemd user services need a login session with systemd; on WSL or in containers, run `npx driftnet` your own way)" : "";
        ctx.err(`driftnet: ${show(c)} failed: ${firstLine(r)}${hint}`);
        return 1;
      }
    }
  }
  ctx.out(`Installed: driftnet starts at login (${p.where}).`);
  ctx.out(`It runs: ${show(runs)}\nLogs: ${e.log}\nOpen http://localhost:${e.port}`);
  if (p.manual) ctx.out(p.manual);
  const port = await (ctx.probe ?? ((n: number) => realProbe(ctx, n)))(e.port);
  if (port !== "free") ctx.out(`Note: something already listens on port ${e.port}${port === "driftnet" ? " (a driftnet, maybe one in a terminal window)" : ""}. Stop it; the service retries every 10 s and takes over.`);
  ctx.out("Update later with `npx driftnet@latest service install`; remove with `npx driftnet service uninstall`.");
  return 0;
}

async function uninstall(ctx: ServiceCtx, e: Env, dry: boolean): Promise<number> {
  const p = plan(ctx, e);
  const stop: string[][] =
    e.platform === "darwin" ? [["launchctl", "bootout", `gui/${e.uid}/${LABEL}`]]
    : e.platform === "linux" ? [["systemctl", "--user", "disable", "--now", UNIT]]
    : [["powershell", "-NoProfile", "-NonInteractive", "-Command", stopWindows(e.dir)]];
  const after: string[][] = e.platform === "linux" ? [["systemctl", "--user", "daemon-reload"]] : [];
  const remove = [...p.writes.map((w) => w.path), e.dir];
  const installed = p.writes.some((w) => e.files.exists(w.path)) || e.files.exists(e.dir);
  if (dry) {
    ctx.out("driftnet service uninstall (dry run; nothing is removed or stopped):");
    if (!installed) ctx.out("  (not installed; nothing to do)");
    for (const c of stop) ctx.out(`  run: ${show(c)}`);
    for (const f of remove) ctx.out(`  delete ${f}`);
    for (const c of after) ctx.out(`  run: ${show(c)}`);
    ctx.out(`  kept: your data in ${e.dataHome}`);
    return 0;
  }
  if (!installed) { ctx.out("driftnet service is not installed; nothing to do."); return 0; }
  for (const c of stop) await e.run(c[0]!, c.slice(1)); // not running is fine
  for (const f of remove) {
    try { e.files.remove(f); } catch (err) {
      ctx.err(`driftnet: could not delete ${f}: ${(err as NodeJS.ErrnoException).code ?? err}`);
      return 1;
    }
  }
  for (const c of after) await e.run(c[0]!, c.slice(1));
  ctx.out(`Removed: driftnet no longer starts at login. Your data in ${e.dataHome} is untouched (logs: ${e.logs}).`);
  return 0;
}

/** PowerShell that stops the batch loop and its node, matched by the service folder in their command lines. */
function stopWindows(dir: string): string {
  return `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${dir.replace(/'/g, "''")}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
}

async function managerState(e: Env): Promise<string> {
  if (e.platform === "darwin") {
    const r = await e.run("launchctl", ["print", `gui/${e.uid}/${LABEL}`]);
    if (r.code !== 0) return "not loaded";
    const state = r.stdout.match(/^\s*state = (.+)$/m)?.[1]?.trim();
    const pid = r.stdout.match(/^\s*pid = (\d+)/m)?.[1];
    const exit = r.stdout.match(/^\s*last exit code = (.+)$/m)?.[1]?.trim();
    return [state ?? "loaded", pid ? `pid ${pid}` : "", exit && !pid ? `last exit ${exit}` : ""].filter(Boolean).join(", ");
  }
  if (e.platform === "linux") {
    const r = await e.run("systemctl", ["--user", "is-active", UNIT]);
    return r.stdout.trim() || firstLine(r);
  }
  const r = await e.run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${e.cli.replace(/'/g, "''")}') }).Count`]);
  const n = Number(r.stdout.trim());
  return r.code !== 0 || Number.isNaN(n) ? "unknown" : n > 0 ? "running" : "not running";
}

async function status(ctx: ServiceCtx, e: Env): Promise<number> {
  const p = plan(ctx, e);
  const installed = p.writes.every((w) => e.files.exists(w.path));
  const port = await (ctx.probe ?? ((n: number) => realProbe(ctx, n)))(e.port);
  const portLine = `port ${e.port}: ${port === "driftnet" ? `driftnet answers at http://localhost:${e.port}` : port === "other" ? "in use by something that is not driftnet" : "nothing listening"}`;
  if (!installed) {
    ctx.out(`driftnet service: not installed (start it at login with \`npx driftnet service install\`)\n${portLine}`);
    return 1;
  }
  const state = await managerState(e);
  const v = installedVersion(e);
  ctx.out(`driftnet service: installed (${p.where})`);
  ctx.out(`state: ${state}`);
  ctx.out(`runs: ${show([e.node, e.cli, "start"])}${v ? `  (driftnet ${v})` : "  (the copy is missing: run `npx driftnet service install` again)"}`);
  if (!e.files.exists(e.node)) ctx.out(`warning: ${e.node} no longer exists (Node was updated or removed): run \`npx driftnet service install\` again`);
  ctx.out(`logs: ${e.log}`);
  ctx.out(portLine);
  return port === "driftnet" ? 0 : 1;
}

export async function service(ctx: Ctx, argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv, { bool: ["dry-run"] });
  const sub = positional[0];
  if (positional.length !== 1 || !sub || !["install", "uninstall", "status"].includes(sub)) {
    throw new UsageError("usage: driftnet service install|uninstall|status [--dry-run]");
  }
  const sctx = ctx as ServiceCtx;
  const e = resolveEnv(sctx);
  if (!["darwin", "linux", "win32"].includes(e.platform)) {
    ctx.err(`driftnet: service supports macOS, Linux and Windows (this is ${e.platform}); start \`npx driftnet\` from your own startup script instead.`);
    return 1;
  }
  const dry = !!flags["dry-run"];
  if (sub === "install") return install(sctx, e, dry);
  if (sub === "uninstall") return uninstall(sctx, e, dry);
  return status(sctx, e);
}
