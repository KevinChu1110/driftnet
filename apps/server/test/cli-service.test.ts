import assert from "node:assert/strict";
import { test } from "node:test";
import { HANDLERS, type Ctx } from "../src/cli/commands.ts";
import { completionScript } from "../src/cli/completion.ts";
import type { RunResult } from "../src/cli/init.ts";
import { LABEL, type Files, type PortState, type ServiceCtx } from "../src/cli/service.ts";

/** An in-memory file system and a fake runner: nothing here touches the real machine. */
function setup(opts: {
  platform?: NodeJS.Platform; env?: Record<string, string>; port?: PortState;
  fail?: (cmd: string, args: string[]) => RunResult | undefined; installed?: string; launchctlPrint?: string;
  /** symlink -> target, for realpath; the links exist as files. */ links?: Record<string, string>; execPath?: string;
} = {}) {
  const platform = opts.platform ?? "darwin";
  const win = platform === "win32";
  const home = win ? "C:\\Users\\kim" : "/home/kim";
  const node = win ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/local/bin/node";
  const npmCli = win ? "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" : "/usr/local/lib/node_modules/npm/bin/npm-cli.js";
  const fs = new Map<string, string>([[node, ""], [npmCli, ""]]);
  for (const l of Object.keys(opts.links ?? {})) fs.set(l, "");
  const dirs = new Set<string>();
  const removed: string[] = [];
  const calls: string[][] = [];
  const out: string[] = [], err: string[] = [];
  const pkgOf = (dir: string) => `${dir}${win ? "\\" : "/"}node_modules${win ? "\\" : "/"}driftnet${win ? "\\" : "/"}`;
  const files: Files = {
    realpath: (p) => opts.links?.[p] ?? p,
    exists: (p) => fs.has(p) || dirs.has(p) || [...fs.keys()].some((k) => k.startsWith(p + (win ? "\\" : "/"))),
    read: (p) => { const v = fs.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    write: (p, c) => { fs.set(p, c); },
    mkdir: (p) => { dirs.add(p); },
    remove: (p) => { removed.push(p); for (const k of [...fs.keys()]) if (k === p || k.startsWith(p + (win ? "\\" : "/"))) fs.delete(k); dirs.delete(p); },
  };
  const env: Record<string, string> = { ...(win ? { USERPROFILE: home, APPDATA: `${home}\\AppData\\Roaming` } : { HOME: home, PATH: "/usr/local/bin:/usr/bin", USER: "kim" }), ...(opts.env ?? {}) };
  const dataHome = env.DRIFTNET_HOME ?? (win ? `${home}\\.driftnet` : `${home}/.driftnet`);
  const serviceDir = win ? `${dataHome}\\service` : `${dataHome}/service`;
  if (opts.installed) {
    fs.set(pkgOf(serviceDir) + "package.json", JSON.stringify({ version: opts.installed }));
    fs.set(pkgOf(serviceDir) + (win ? "dist\\cli.mjs" : "dist/cli.mjs"), "");
  }
  const ctx: ServiceCtx = {
    env, out: (s) => out.push(s), err: (s) => err.push(s), writeBytes: () => {}, fetch,
    isTTY: false, confirm: async () => true, open: () => {}, sleep: async () => {},
    platform, files, execPath: opts.execPath ?? node, uid: 501, version: "1.0.0",
    probe: async () => opts.port ?? "free",
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      const f = opts.fail?.(cmd, args);
      if (f) return f;
      if (args[0] === npmCli && args[1] === "install") {
        fs.set(pkgOf(serviceDir) + "package.json", JSON.stringify({ version: "1.0.0" }));
        fs.set(pkgOf(serviceDir) + (win ? "dist\\cli.mjs" : "dist/cli.mjs"), "");
      }
      if (cmd === "launchctl" && args[0] === "print") return { code: opts.launchctlPrint ? 0 : 113, stdout: opts.launchctlPrint ?? "", stderr: "" };
      if (cmd === "systemctl" && args[1] === "is-active") return { code: 0, stdout: "active\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const run = (...argv: string[]) => HANDLERS.service!(ctx as Ctx, argv);
  return { fs, calls, out, err, run, home, node, npmCli, dataHome, serviceDir, removed, text: () => out.join("\n") + "\n" + err.join("\n") };
}

const PLIST = "/home/kim/Library/LaunchAgents/io.github.kevinchu1110.driftnet.plist";
const UNIT = "/home/kim/.config/systemd/user/driftnet.service";

test("service: macOS install writes a LaunchAgent and loads it with bootstrap", async () => {
  const t = setup({ env: { PORT: "9999", DRIFTNET_HOME: "/data/dn" } });
  assert.equal(await t.run("install"), 0, t.text());
  const plist = t.fs.get(PLIST)!;
  assert.ok(plist, "plist written");
  assert.match(plist, new RegExp(`<key>Label</key><string>${LABEL}</string>`));
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/data\/dn\/service\/node_modules\/driftnet\/dist\/cli\.mjs<\/string>\s*<string>start<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(plist, /<key>StandardOutPath<\/key><string>\/data\/dn\/logs\/driftnet\.log<\/string>/);
  for (const kv of ["<key>DRIFTNET_HOME</key><string>/data/dn</string>", "<key>PORT</key><string>9999</string>",
    "<key>DRIFTNET_OPEN</key><string>0</string>", "<key>DRIFTNET_SERVICE</key><string>1</string>", "<key>PATH</key><string>/usr/local/bin:/usr/bin</string>"]) {
    assert.ok(plist.includes(kv), kv);
  }
  assert.deepEqual(t.calls[0], [t.node, t.npmCli, "install", "--prefix", "/data/dn/service", "--no-audit", "--no-fund", "--omit=dev", "--loglevel=error", "driftnet@1.0.0"]);
  assert.deepEqual(t.calls.slice(1), [["launchctl", "bootout", `gui/501/${LABEL}`], ["launchctl", "bootstrap", "gui/501", PLIST]]);
  assert.match(t.text(), /Logs: \/data\/dn\/logs\/driftnet\.log/);
});

test("service: no PORT / DRIFTNET_HOME set -> not passed; XML is escaped", async () => {
  const t = setup({ env: { PATH: "/a&b<c>" } });
  assert.equal(await t.run("install"), 0);
  const plist = t.fs.get(PLIST)!;
  assert.ok(!plist.includes("<key>PORT</key>"));
  assert.ok(!plist.includes("<key>DRIFTNET_HOME</key>"));
  assert.ok(plist.includes("<string>/a&amp;b&lt;c&gt;</string>"));
  assert.match(plist, /\/home\/kim\/\.driftnet\/service\/node_modules/);
});

test("service: re-install is idempotent: the pinned copy is kept, the agent replaced", async () => {
  const t = setup({ installed: "1.0.0" });
  assert.equal(await t.run("install"), 0);
  assert.ok(!t.calls.some((c) => c[2] === "install"), "no npm install when the same version is already there");
  assert.equal(await t.run("install"), 0);
  assert.equal(t.calls.filter((c) => c[1] === "bootout").length, 2);
});

test("service: macOS falls back to launchctl load when bootstrap fails", async () => {
  const t = setup({ fail: (cmd, a) => (cmd === "launchctl" && a[0] === "bootstrap" ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5" } : undefined) });
  assert.equal(await t.run("install"), 0);
  assert.deepEqual(t.calls.at(-1), ["launchctl", "load", "-w", PLIST]);
});

test("service: npm failure -> exit 1, nothing registered", async () => {
  const t = setup({ fail: (_c, a) => (a[1] === "install" ? { code: 1, stdout: "", stderr: "npm ERR! 404 Not Found" } : undefined) });
  assert.equal(await t.run("install"), 1);
  assert.match(t.text(), /npm install failed: npm ERR! 404/);
  assert.ok(!t.fs.has(PLIST));
  assert.ok(!t.calls.some((c) => c[0] === "launchctl"));
});

test("service: --dry-run prints files and commands, writes and runs nothing", async () => {
  const t = setup();
  const before = new Map(t.fs);
  assert.equal(await t.run("install", "--dry-run"), 0);
  assert.deepEqual(t.fs, before);
  assert.deepEqual(t.calls, []);
  const s = t.text();
  assert.match(s, /dry run/);
  assert.match(s, /run: \/usr\/local\/bin\/node \/usr\/local\/lib\/node_modules\/npm\/bin\/npm-cli\.js install --prefix \/home\/kim\/\.driftnet\/service .* driftnet@1\.0\.0/);
  assert.ok(s.includes(`write ${PLIST}:`));
  assert.match(s, /\| {3}<key>RunAtLoad<\/key><true\/>/);
  assert.match(s, /run: launchctl bootstrap gui\/501/);

  const u = setup({ installed: "1.0.0" });
  u.fs.set(PLIST, "x");
  assert.equal(await u.run("uninstall", "--dry-run"), 0);
  assert.ok(u.fs.has(PLIST));
  assert.deepEqual(u.calls, []);
  assert.match(u.text(), /delete \/home\/kim\/Library\/LaunchAgents/);
});

test("service: Linux writes a systemd --user unit, enables it, and prints the linger hint", async () => {
  const t = setup({ platform: "linux", env: { DRIFTNET_HOME: "/srv/50% off", PORT: "8800" } });
  assert.equal(await t.run("install"), 0, t.text());
  const unit = t.fs.get(UNIT)!;
  assert.match(unit, /^ExecStart="\/usr\/local\/bin\/node" "\/srv\/50%% off\/service\/node_modules\/driftnet\/dist\/cli\.mjs" "start"$/m);
  assert.match(unit, /^Environment="DRIFTNET_HOME=\/srv\/50%% off"$/m);
  assert.match(unit, /^Environment="PORT=8800"$/m);
  assert.match(unit, /^Environment="DRIFTNET_OPEN=0"$/m);
  assert.match(unit, /^Environment="DRIFTNET_SERVICE=1"$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartSec=10$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.match(unit, /^StandardOutput=append:\/srv\/50% off\/logs\/driftnet\.log$/m);
  assert.deepEqual(t.calls.slice(1), [
    ["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "driftnet.service"], ["systemctl", "--user", "restart", "driftnet.service"],
  ]);
  assert.match(t.text(), /loginctl enable-linger kim/);
  assert.ok(!t.calls.some((c) => c.includes("sudo") || c[0] === "loginctl"), "never runs sudo or loginctl");
});

test("service: Linux without a user systemd -> clear error, exit 1", async () => {
  const t = setup({ platform: "linux", fail: (cmd) => (cmd === "systemctl" ? { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" } : undefined) });
  assert.equal(await t.run("install"), 1);
  assert.match(t.text(), /systemctl --user daemon-reload failed: Failed to connect to bus.*systemd user services need/);
});

test("service: Windows uses a hidden script in the Startup folder (no admin)", async () => {
  const t = setup({ platform: "win32", env: { PORT: "8790" } });
  assert.equal(await t.run("install"), 0, t.text());
  const vbsPath = "C:\\Users\\kim\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\driftnet.vbs";
  const cmdPath = "C:\\Users\\kim\\.driftnet\\service\\driftnet-service.cmd";
  const vbs = t.fs.get(vbsPath)!, cmd = t.fs.get(cmdPath)!;
  assert.ok(vbs.includes(`.Run "cmd /c """"${cmdPath}""""", 0, False`), vbs);
  assert.ok(cmd.includes('set "PORT=8790"\r\n'));
  assert.ok(cmd.includes('set "DRIFTNET_OPEN=0"'));
  assert.ok(cmd.includes('set "DRIFTNET_SERVICE=1"'));
  assert.ok(!cmd.includes("PATH="), "Windows keeps the user's own PATH");
  assert.ok(cmd.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\kim\\.driftnet\\service\\node_modules\\driftnet\\dist\\cli.mjs" start >> "C:\\Users\\kim\\.driftnet\\logs\\driftnet.log" 2>&1'));
  assert.match(cmd, /if %ERRORLEVEL% EQU 0 goto :eof/);
  assert.ok(!/\r?\n/.test(cmd.replace(/\r\n/g, "")), "CRLF line ends");
  assert.equal(t.calls[0]![1], "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js");
  assert.deepEqual(t.calls.at(-1), ["wscript.exe", vbsPath]);
  assert.ok(!t.calls.some((c) => c[0] === "schtasks"));

  assert.equal(await t.run("uninstall"), 0);
  assert.ok(!t.fs.has(vbsPath) && !t.fs.has(cmdPath));
  const stop = t.calls.find((c) => c[0] === "powershell")!;
  assert.match(stop.at(-1)!, /Contains\('C:\\Users\\kim\\\.driftnet\\service'\)/);
  assert.match(stop.at(-1)!, /ProcessId -ne \$PID/);
});

test("service: uninstall stops, deletes files and the copy, keeps data; second run is a no-op", async () => {
  const t = setup({ installed: "1.0.0" });
  assert.equal(await t.run("install"), 0);
  t.fs.set("/home/kim/.driftnet/driftnet.db", "data");
  assert.equal(await t.run("uninstall"), 0);
  assert.ok(t.calls.some((c) => c.join(" ") === `launchctl bootout gui/501/${LABEL}`));
  assert.ok(!t.fs.has(PLIST));
  assert.ok(![...t.fs.keys()].some((k) => k.startsWith(t.serviceDir)));
  assert.ok(t.fs.has("/home/kim/.driftnet/driftnet.db"));
  assert.match(t.text(), /data in \/home\/kim\/\.driftnet is untouched/);
  const n = t.calls.length;
  assert.equal(await t.run("uninstall"), 0);
  assert.match(t.text(), /not installed; nothing to do/);
  assert.equal(t.calls.length, n);

  const l = setup({ platform: "linux", installed: "1.0.0" });
  assert.equal(await l.run("install"), 0);
  assert.equal(await l.run("uninstall"), 0);
  assert.ok(l.calls.some((c) => c.join(" ") === "systemctl --user disable --now driftnet.service"));
  assert.ok(!l.fs.has(UNIT));
});

test("service: status reports installed / running / command / logs / port", async () => {
  const none = setup({ port: "other" });
  assert.equal(await none.run("status"), 1);
  assert.match(none.text(), /not installed/);
  assert.match(none.text(), /port 8787: in use by something that is not driftnet/);

  const t = setup({ port: "driftnet", installed: "1.0.0", launchctlPrint: "\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n" });
  assert.equal(await t.run("install"), 0);
  assert.match(t.text(), /something already listens on port 8787 \(a driftnet/);
  t.out.length = 0;
  assert.equal(await t.run("status"), 0);
  const s = t.text();
  assert.match(s, /installed \(\/home\/kim\/Library\/LaunchAgents\/io\.github\.kevinchu1110\.driftnet\.plist\)/);
  assert.match(s, /state: running, pid 4242/);
  assert.match(s, /runs: \/usr\/local\/bin\/node \/home\/kim\/\.driftnet\/service\/node_modules\/driftnet\/dist\/cli\.mjs start {2}\(driftnet 1\.0\.0\)/);
  assert.match(s, /logs: \/home\/kim\/\.driftnet\/logs\/driftnet\.log/);
  assert.match(s, /port 8787: driftnet answers/);

  const l = setup({ platform: "linux", installed: "1.0.0", port: "free" });
  await l.run("install");
  l.out.length = 0;
  assert.equal(await l.run("status"), 1);
  assert.match(l.text(), /state: active/);
  assert.match(l.text(), /port 8787: nothing listening/);
});

test("service: usage errors exit 2, unsupported platform exits 1, completion knows it", async () => {
  const t = setup();
  assert.equal(await t.run(), 2);
  assert.equal(await t.run("start"), 2);
  assert.equal(await t.run("install", "--force"), 2);
  assert.match(t.text(), /usage: driftnet service install\|uninstall\|status/);
  const f = setup({ platform: "freebsd" });
  assert.equal(await f.run("install"), 1);
  assert.match(f.text(), /supports macOS, Linux and Windows/);
  assert.match(completionScript("bash")!, /service\) opts="install uninstall status --dry-run"/);
  assert.match(completionScript("zsh")!, /'service'/);
});

test("service: runs the stable node on PATH (Homebrew symlink), not the versioned Cellar path", async () => {
  const cellar = "/opt/homebrew/Cellar/node/26.1.0/bin/node";
  const t = setup({
    env: { PATH: "/home/kim/bin:/opt/homebrew/bin:/usr/bin" }, execPath: cellar,
    links: { "/opt/homebrew/bin/node": cellar, "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js": "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js" },
  });
  assert.equal(await t.run("install", "--dry-run"), 0, t.text());
  assert.match(t.text(), /the service runs: \/opt\/homebrew\/bin\/node /);
  assert.match(t.text(), /run: \/opt\/homebrew\/bin\/node \/opt\/homebrew\/lib\/node_modules\/npm\/bin\/npm-cli\.js install/);
});
