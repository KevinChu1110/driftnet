import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HANDLERS, type Ctx } from "../src/cli/commands.ts";
import { remoteUrl, type InitCtx, type RunResult } from "../src/cli/init.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TOKEN = "dnt_secret_token_123";

function setup(opts: { claude?: "none" | "fresh" | "exists"; tty?: boolean; answer?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "driftnet-init-"));
  const out: string[] = [], err: string[] = [], calls: string[][] = [];
  const ctx: InitCtx = {
    env: { HOME: home, DRIFTNET_HOME: join(home, ".driftnet") },
    out: (s) => out.push(s), err: (s) => err.push(s), writeBytes: () => {}, fetch,
    isTTY: opts.tty ?? false, confirm: async () => opts.answer ?? true, open: () => {}, sleep: async () => {},
    platform: "darwin",
    skillSource: join(ROOT, "skills", "driftnet", "SKILL.md"),
    run: async (cmd, args): Promise<RunResult> => {
      calls.push([cmd, ...args]);
      if (opts.claude === undefined || opts.claude === "none") return { code: 127, stdout: "", stderr: "not found" };
      if (args[0] === "mcp" && args[1] === "get") return { code: opts.claude === "exists" ? 0 : 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const run = (...argv: string[]) => HANDLERS.init!(ctx as Ctx, argv);
  const text = () => out.join("\n") + "\n" + err.join("\n");
  return { home, ctx, out, err, calls, run, text };
}
const desktopFile = (home: string) => join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
const baks = (dir: string) => readdirSync(dir).filter((f) => f.includes(".bak-driftnet-"));

test("init: nothing installed -> every client skipped, exit 0", async () => {
  const t = setup();
  assert.equal(await t.run("--yes"), 0);
  const s = t.text();
  for (const c of ["Claude Code", "Claude Desktop", "Cursor", "Windsurf", "Codex"]) assert.match(s, new RegExp(`${c}\\s+skipped`));
  assert.ok(!existsSync(join(t.home, ".cursor")));
});

test("init: detects clients by their config dirs; JSON merge keeps other servers, backs up, is idempotent", async () => {
  const t = setup();
  mkdirSync(join(t.home, ".cursor"), { recursive: true });
  const cursor = join(t.home, ".cursor", "mcp.json");
  writeFileSync(cursor, JSON.stringify({ theme: "x", mcpServers: { other: { command: "foo" } } }, null, 2));
  mkdirSync(dirname(desktopFile(t.home)), { recursive: true });
  mkdirSync(join(t.home, ".codeium", "windsurf"), { recursive: true });

  assert.equal(await t.run("--yes"), 0);
  const doc = JSON.parse(readFileSync(cursor, "utf8"));
  assert.deepEqual(doc.mcpServers.other, { command: "foo" });
  assert.equal(doc.theme, "x");
  assert.deepEqual(doc.mcpServers.driftnet, { command: "npx", args: ["-y", "driftnet", "mcp"], env: { DRIFTNET_AGENT: "cursor" } });
  assert.ok(readFileSync(cursor, "utf8").startsWith('{\n  "theme"'), "2-space formatting");
  assert.equal(baks(dirname(cursor)).length, 1, "existing file backed up");
  assert.equal(baks(dirname(desktopFile(t.home))).length, 0, "no backup for a file that did not exist");
  assert.equal(JSON.parse(readFileSync(desktopFile(t.home), "utf8")).mcpServers.driftnet.env.DRIFTNET_AGENT, "claude-desktop");
  assert.equal(JSON.parse(readFileSync(join(t.home, ".codeium", "windsurf", "mcp_config.json"), "utf8")).mcpServers.driftnet.env.DRIFTNET_AGENT, "windsurf");
  assert.match(t.text(), /Restart Cursor to load driftnet/);

  const before = readFileSync(cursor, "utf8");
  t.out.length = 0;
  assert.equal(await t.run("--yes"), 0);
  assert.equal(readFileSync(cursor, "utf8"), before);
  assert.equal(baks(dirname(cursor)).length, 1, "second run writes nothing");
  assert.match(t.text(), /Cursor\s+already set/);
  assert.doesNotMatch(t.text(), /Restart/);
});

test("init: a broken JSON config is reported and left untouched", async () => {
  const t = setup();
  mkdirSync(join(t.home, ".cursor"), { recursive: true });
  const f = join(t.home, ".cursor", "mcp.json");
  writeFileSync(f, "{ nope");
  assert.equal(await t.run("--yes", "--client", "cursor"), 1);
  assert.equal(readFileSync(f, "utf8"), "{ nope");
  assert.match(t.text(), /Cursor\s+failed/);
});

test("init: Codex TOML block is added once, replaced when it changes, user entries untouched", async () => {
  const t = setup();
  mkdirSync(join(t.home, ".codex"), { recursive: true });
  const f = join(t.home, ".codex", "config.toml");
  writeFileSync(f, 'model = "x"\n\n[mcp_servers.other]\ncommand = "foo"\n');
  assert.equal(await t.run("--yes", "--client", "codex"), 0);
  const first = readFileSync(f, "utf8");
  assert.ok(first.startsWith('model = "x"\n\n[mcp_servers.other]\ncommand = "foo"\n\n# >>> driftnet'));
  assert.match(first, /\[mcp_servers\.driftnet\]\ncommand = "npx"\nargs = \["-y", "driftnet", "mcp"\]/);
  assert.match(first, /\[mcp_servers\.driftnet\.env\]\nDRIFTNET_AGENT = "codex"/);
  assert.equal(first.match(/>>> driftnet/g)!.length, 1);
  assert.equal(baks(dirname(f)).length, 1);

  assert.equal(await t.run("--yes", "--client", "codex"), 0);
  assert.equal(readFileSync(f, "utf8"), first, "idempotent");

  assert.equal(await t.run("--yes", "--client", "codex", "--remote", "https://dn.example.com", "--token", TOKEN), 0);
  const remote = readFileSync(f, "utf8");
  assert.equal(remote.match(/>>> driftnet/g)!.length, 1, "replaced, not appended");
  assert.match(remote, /url = "https:\/\/dn\.example\.com\/mcp"/);
  assert.ok(remote.includes(`Bearer ${TOKEN}`));
  assert.ok(!t.text().includes(TOKEN), "token never printed");
  assert.match(remote, /command = "foo"/);

  const own = setup();
  mkdirSync(join(own.home, ".codex"), { recursive: true });
  const f2 = join(own.home, ".codex", "config.toml");
  writeFileSync(f2, '[mcp_servers.driftnet]\ncommand = "mine"\n');
  assert.equal(await own.run("--yes", "--client", "codex"), 0);
  assert.equal(readFileSync(f2, "utf8"), '[mcp_servers.driftnet]\ncommand = "mine"\n');
});

test("init: remote entries per client, token never echoed", async () => {
  const t = setup();
  mkdirSync(join(t.home, ".cursor"), { recursive: true });
  mkdirSync(join(t.home, ".codeium", "windsurf"), { recursive: true });
  mkdirSync(dirname(desktopFile(t.home)), { recursive: true });
  assert.equal(await t.run("--yes", "--remote", "https://dn.example.com/", "--token", TOKEN), 0);
  const cur = JSON.parse(readFileSync(join(t.home, ".cursor", "mcp.json"), "utf8")).mcpServers.driftnet;
  assert.deepEqual(cur, { url: "https://dn.example.com/mcp", headers: { Authorization: `Bearer ${TOKEN}`, "X-Driftnet-Agent": "cursor" } });
  const win = JSON.parse(readFileSync(join(t.home, ".codeium", "windsurf", "mcp_config.json"), "utf8")).mcpServers.driftnet;
  assert.equal(win.serverUrl, "https://dn.example.com/mcp");
  assert.equal(win.headers["X-Driftnet-Agent"], "windsurf");
  const desk = JSON.parse(readFileSync(desktopFile(t.home), "utf8")).mcpServers.driftnet;
  assert.equal(desk.command, "npx");
  assert.deepEqual(desk.args.slice(0, 3), ["-y", "mcp-remote", "https://dn.example.com/mcp"]);
  assert.ok(!desk.args.join(" ").includes(TOKEN), "token not in argv");
  assert.equal(desk.env.DRIFTNET_AUTH, `Bearer ${TOKEN}`);
  assert.ok(!t.text().includes(TOKEN));
  assert.match(t.text(), /mcp-remote/);
});

test("init: remote flags validated", async () => {
  const t = setup();
  assert.equal(await t.run("--remote", "https://x.test"), 2);
  assert.equal(await t.run("--token", "t"), 2);
  assert.equal(await t.run("--remote", "ftp://x.test", "--token", "t"), 2);
  assert.equal(await t.run("--client", "vim"), 2);
  assert.equal(remoteUrl("http://h:8787/mcp/"), "http://h:8787/mcp");
  assert.equal(remoteUrl("https://h/base"), "https://h/base/mcp");
});

test("init: Claude Code uses the claude CLI with an args array (local)", async () => {
  const t = setup({ claude: "fresh" });
  assert.equal(await t.run("--yes", "--client", "claude-code"), 0);
  const add = t.calls.find((c) => c[1] === "mcp" && c[2] === "add")!;
  assert.deepEqual(add, ["claude", "mcp", "add", "driftnet", "--scope", "user", "--env", "DRIFTNET_AGENT=claude-code", "--", "npx", "-y", "driftnet", "mcp"]);
  const skill = join(t.home, ".claude", "skills", "driftnet", "SKILL.md");
  assert.equal(readFileSync(skill, "utf8"), readFileSync(join(ROOT, "skills", "driftnet", "SKILL.md"), "utf8"));
  assert.match(t.text(), /Restart Claude Code/);
  // second run: skill identical -> nothing to do
  const t2calls = t.calls.length;
  t.out.length = 0;
  assert.equal(await t.run("--yes", "--client", "claude-code"), 0);
  assert.match(t.text(), /skill/);
  assert.ok(t.calls.length > t2calls);
});

test("init: Claude Code remote args, existing entry untouched, token scrubbed from failures", async () => {
  const t = setup({ claude: "fresh" });
  assert.equal(await t.run("--yes", "--client", "claude-code", "--remote", "https://dn.example.com", "--token", TOKEN), 0);
  const add = t.calls.find((c) => c[2] === "add")!;
  assert.deepEqual(add, ["claude", "mcp", "add", "--transport", "http", "driftnet", "https://dn.example.com/mcp", "--scope", "user",
    "--header", `Authorization: Bearer ${TOKEN}`, "--header", "X-Driftnet-Agent: claude-code"]);
  assert.ok(!t.text().includes(TOKEN));

  const e = setup({ claude: "exists" });
  assert.equal(await e.run("--yes", "--client", "claude-code"), 0);
  assert.ok(!e.calls.some((c) => c[2] === "add"));
  assert.match(e.text(), /Claude Code\s+already set/);

  const f = setup({ claude: "fresh" });
  f.ctx.run = async (cmd, args) => (args[1] === "add" ? { code: 1, stdout: "", stderr: `bad header Bearer ${TOKEN}` } : { code: args[1] === "get" ? 1 : 0, stdout: "", stderr: "" });
  assert.equal(await f.run("--yes", "--client", "claude-code", "--remote", "https://dn.example.com", "--token", TOKEN), 1);
  assert.match(f.text(), /failed/);
  assert.ok(!f.text().includes(TOKEN));
});

test("init: missing claude CLI is skipped (all) and failed-ish skip when asked for explicitly", async () => {
  const t = setup({ claude: "none" });
  assert.equal(await t.run("--yes", "--client", "claude-code"), 0);
  assert.match(t.text(), /Claude Code\s+skipped: not installed/);
});

test("init: --dry-run writes nothing and exits 0", async () => {
  const t = setup({ claude: "fresh" });
  mkdirSync(join(t.home, ".cursor"), { recursive: true });
  assert.equal(await t.run("--dry-run"), 0);
  assert.ok(!existsSync(join(t.home, ".cursor", "mcp.json")));
  assert.ok(!t.calls.some((c) => c[2] === "add"));
  assert.match(t.text(), /would add/);
  assert.match(t.text(), /dry run/);
});

test("init: non-TTY without --yes prints the plan and exits 1; TTY asks", async () => {
  const t = setup();
  mkdirSync(join(t.home, ".cursor"), { recursive: true });
  assert.equal(await t.run(), 1);
  assert.match(t.text(), /Re-run with --yes/);
  assert.ok(!existsSync(join(t.home, ".cursor", "mcp.json")));

  const no = setup({ tty: true, answer: false });
  mkdirSync(join(no.home, ".cursor"), { recursive: true });
  assert.equal(await no.run(), 0);
  assert.ok(!existsSync(join(no.home, ".cursor", "mcp.json")));
  const yes = setup({ tty: true, answer: true });
  mkdirSync(join(yes.home, ".cursor"), { recursive: true });
  assert.equal(await yes.run(), 0);
  assert.ok(existsSync(join(yes.home, ".cursor", "mcp.json")));
});

test("install doc: copies agree and name every MCP tool", () => {
  const txt = readFileSync(join(ROOT, "docs", "llms-install.txt"), "utf8");
  assert.equal(readFileSync(join(ROOT, "docs", "agents", "install.md"), "utf8"), txt, "docs/agents/install.md must equal docs/llms-install.txt");
  const mcp = readFileSync(join(ROOT, "apps", "server", "src", "mcp.ts"), "utf8");
  const tools = [...mcp.matchAll(/registerTool\(\s*"(driftnet_[a-z_]+)"/g)].map((m) => m[1]!);
  assert.equal(tools.length, 14);
  for (const name of tools) assert.ok(txt.includes(name), `install doc mentions ${name}`);
  assert.ok(txt.split("\n").length <= 120);
  assert.match(txt, /22\.13/);
  assert.match(txt, /init --yes/);
});
