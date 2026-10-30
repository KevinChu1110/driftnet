import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "./args.ts";
import type { Ctx } from "./commands.ts";

/** `driftnet init`: wire the driftnet MCP server (and the Claude Code skill) into the agents on this machine. */

export const CLIENTS = ["claude-code", "claude-desktop", "cursor", "windsurf", "codex"] as const;
export type Client = (typeof CLIENTS)[number];
const LABEL: Record<Client, string> = {
  "claude-code": "Claude Code", "claude-desktop": "Claude Desktop", cursor: "Cursor", windsurf: "Windsurf", codex: "Codex",
};

export interface RunResult { code: number; stdout: string; stderr: string }
/** Extra things init needs; tests swap them. Optional so the plain CLI context works as is. */
export interface InitCtx extends Ctx {
  platform?: NodeJS.Platform;
  /** Run a program with an args array (never a shell). */
  run?: (cmd: string, args: string[]) => Promise<RunResult>;
  /** Path of the skill file to copy into ~/.claude/skills/driftnet/. */
  skillSource?: string;
}

export function realRun(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = "", err = "";
    try {
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", (e) => resolve({ code: 127, stdout: out, stderr: String(e.message) }));
      p.on("close", (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }));
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: String((e as Error).message) });
    }
  });
}

type State = "add" | "update" | "same" | "skip" | "fail";
interface Step { client: Client; state: State; detail: string; apply?: () => Promise<string | void> }
interface Remote { url: string; token: string }

const STDIO_ARGS = ["-y", "driftnet", "mcp"];
const START = "# >>> driftnet (managed by `driftnet init`)";
const END = "# <<< driftnet";

export function remoteUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UsageError(`--remote needs a full URL like https://host:8787 (got "${raw}")`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError("--remote must be an http(s) URL");
  u.hash = ""; u.search = "";
  u.pathname = u.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "") + "/mcp";
  return u.toString();
}

const stdioEntry = (client: Client) => ({ command: "npx", args: STDIO_ARGS, env: { DRIFTNET_AGENT: client } });

function jsonEntry(client: Client, remote?: Remote): Record<string, unknown> {
  if (!remote) return stdioEntry(client);
  const headers = { Authorization: `Bearer ${remote.token}`, "X-Driftnet-Agent": client };
  if (client === "cursor") return { url: remote.url, headers };
  if (client === "windsurf") return { serverUrl: remote.url, headers };
  // Claude Desktop only speaks stdio: bridge with mcp-remote (the token goes in via env, not argv).
  return {
    command: "npx",
    args: ["-y", "mcp-remote", remote.url, "--header", "Authorization:${DRIFTNET_AUTH}", "--header", "X-Driftnet-Agent:claude-desktop"],
    env: { DRIFTNET_AUTH: `Bearer ${remote.token}` },
  };
}

function home(ctx: Ctx): string {
  return ctx.env.HOME || ctx.env.USERPROFILE || homedir();
}

function jsonPath(ctx: InitCtx, client: Client): string {
  const h = home(ctx);
  const platform = ctx.platform ?? process.platform;
  if (client === "cursor") return join(h, ".cursor", "mcp.json");
  if (client === "windsurf") return join(h, ".codeium", "windsurf", "mcp_config.json");
  if (platform === "darwin") return join(h, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return join(ctx.env.APPDATA || join(h, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(ctx.env.XDG_CONFIG_HOME || join(h, ".config"), "Claude", "claude_desktop_config.json");
}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
function backup(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const b = `${file}.bak-driftnet-${stamp()}`;
  copyFileSync(file, b);
  return b;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function planJson(ctx: InitCtx, client: Client, force: boolean, remote?: Remote): Step {
  const file = jsonPath(ctx, client);
  const dirFound = existsSync(dirname(file));
  if (!dirFound && !force) return { client, state: "skip", detail: "not installed" };
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const text = readFileSync(file, "utf8");
      const parsed = text.trim() ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
      doc = parsed;
    } catch (e) {
      return { client, state: "fail", detail: `${file} is not valid JSON (${(e as Error).message}); fix or remove it, nothing was changed` };
    }
  }
  const servers = (doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {}) as Record<string, unknown>;
  const entry = jsonEntry(client, remote);
  if (same(servers.driftnet, entry)) return { client, state: "same", detail: file };
  const state: State = servers.driftnet === undefined ? "add" : "update";
  const via = remote ? (client === "claude-desktop" ? "remote via mcp-remote bridge" : `remote ${remote.url}`) : "local, npx -y driftnet mcp";
  return {
    client, state, detail: `${file} (${via})`,
    apply: async () => {
      const b = backup(file);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ ...doc, mcpServers: { ...servers, driftnet: entry } }, null, 2) + "\n", remote ? { mode: 0o600 } : undefined);
      return b ? `backup: ${b}` : undefined;
    },
  };
}

const tomlStr = (s: string) => JSON.stringify(s);
function codexBlock(remote?: Remote): string {
  const lines = [START, "[mcp_servers.driftnet]"];
  if (remote) {
    lines.push(`url = ${tomlStr(remote.url)}`, `http_headers = { "Authorization" = ${tomlStr(`Bearer ${remote.token}`)}, "X-Driftnet-Agent" = "codex" }`);
  } else {
    lines.push(`command = "npx"`, `args = [${STDIO_ARGS.map(tomlStr).join(", ")}]`, "", "[mcp_servers.driftnet.env]", `DRIFTNET_AGENT = "codex"`);
  }
  lines.push(END);
  return lines.join("\n");
}

function planCodex(ctx: InitCtx, force: boolean, remote?: Remote): Step {
  const file = join(home(ctx), ".codex", "config.toml");
  if (!existsSync(dirname(file)) && !force) return { client: "codex", state: "skip", detail: "not installed" };
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const block = codexBlock(remote);
  const managed = new RegExp(`${START.replace(/[.*+?^${}()|[\]\\`]/g, "\\$&")}[\\s\\S]*?${END}`);
  const m = text.match(managed);
  let next: string;
  let state: State;
  if (m) {
    if (m[0] === block) return { client: "codex", state: "same", detail: file };
    next = text.replace(managed, () => block); state = "update";
  } else if (/^\s*\[mcp_servers\.driftnet(\.[^\]]*)?\]/m.test(text)) {
    return { client: "codex", state: "same", detail: `${file} (a driftnet entry you wrote yourself is left as is)` };
  } else {
    next = text + (text && !text.endsWith("\n") ? "\n" : "") + (text.trim() ? "\n" : "") + block + "\n"; state = "add";
  }
  return {
    client: "codex", state, detail: `${file} (${remote ? `remote ${remote.url}` : "local, npx -y driftnet mcp"})`,
    apply: async () => {
      const b = backup(file);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, next, remote ? { mode: 0o600 } : undefined);
      return b ? `backup: ${b}` : undefined;
    },
  };
}

async function planClaudeCode(ctx: InitCtx, run: NonNullable<InitCtx["run"]>, remote?: Remote): Promise<Step[]> {
  const bin = (ctx.platform ?? process.platform) === "win32" ? "claude.cmd" : "claude";
  const has = await run(bin, ["--version"]);
  if (has.code !== 0) return [{ client: "claude-code", state: "skip", detail: "not installed (`claude` is not on PATH)" }];
  const steps: Step[] = [];
  const existing = await run(bin, ["mcp", "get", "driftnet"]);
  if (existing.code === 0) {
    steps.push({ client: "claude-code", state: "same", detail: "an MCP entry named driftnet already exists (remove it with `claude mcp remove driftnet` to change it)" });
  } else {
    const args = remote
      ? ["mcp", "add", "--transport", "http", "driftnet", remote.url, "--scope", "user",
         "--header", `Authorization: Bearer ${remote.token}`, "--header", "X-Driftnet-Agent: claude-code"]
      : ["mcp", "add", "driftnet", "--scope", "user", "--env", "DRIFTNET_AGENT=claude-code", "--", "npx", ...STDIO_ARGS];
    steps.push({
      client: "claude-code", state: "add", detail: `claude mcp add driftnet --scope user (${remote ? `remote ${remote.url}` : "local, npx -y driftnet mcp"})`,
      apply: async () => {
        const r = await run(bin, args);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || `claude exited ${r.code}`);
      },
    });
  }
  return steps;
}

function findSkill(ctx: InitCtx): string | undefined {
  if (ctx.skillSource) return existsSync(ctx.skillSource) ? ctx.skillSource : undefined;
  const here = dirname(fileURLToPath(import.meta.url));
  // Published package: dist/driftnet.mjs sits next to skills/. From source: apps/server/src/cli/.
  for (const p of [join(here, "..", "skills", "driftnet", "SKILL.md"), join(here, "..", "..", "..", "..", "skills", "driftnet", "SKILL.md")]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

function planSkill(ctx: InitCtx): Step | undefined {
  const src = findSkill(ctx);
  if (!src) return undefined;
  const dest = join(home(ctx), ".claude", "skills", "driftnet", "SKILL.md");
  const want = readFileSync(src);
  if (existsSync(dest) && readFileSync(dest).equals(want)) return { client: "claude-code", state: "same", detail: `skill ${dest}` };
  return {
    client: "claude-code", state: existsSync(dest) ? "update" : "add", detail: `skill ${dest}`,
    apply: async () => {
      const b = backup(dest);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, want);
      return b ? `backup: ${b}` : undefined;
    },
  };
}

const WORD: Record<string, string> = { add: "added", update: "updated", same: "already set", skip: "skipped", fail: "failed" };

export async function init(ctx: Ctx, argv: string[]): Promise<number> {
  try {
    return await runInit(ctx as InitCtx, argv);
  } catch (e) {
    if (e instanceof UsageError) { ctx.err(`driftnet: ${e.message}`); return 2; }
    throw e;
  }
}

async function runInit(ctx: InitCtx, argv: string[]): Promise<number> {
  const p = parseArgs(argv, { value: ["client", "remote"], bool: ["yes", "dry-run"] });
  const clientFlag = typeof p.flags.client === "string" ? p.flags.client : "all";
  if (clientFlag !== "all" && !(CLIENTS as readonly string[]).includes(clientFlag)) {
    throw new UsageError(`--client must be one of: ${CLIENTS.join(", ")}, all`);
  }
  const explicit = clientFlag !== "all";
  let remote: Remote | undefined;
  if (p.flags.remote !== undefined || p.flags.token !== undefined) {
    if (typeof p.flags.remote !== "string" || typeof p.flags.token !== "string") throw new UsageError("--remote URL and --token TOKEN go together");
    remote = { url: remoteUrl(p.flags.remote), token: p.flags.token };
  }
  const scrub = (s: string) => (remote ? s.split(remote.token).join("***") : s);
  const run = ctx.run ?? realRun;
  const wanted = (explicit ? [clientFlag] : [...CLIENTS]) as Client[];

  const steps: Step[] = [];
  for (const c of wanted) {
    if (c === "claude-code") {
      const cc = await planClaudeCode(ctx, run, remote);
      steps.push(...cc);
      if (cc[0]?.state !== "skip") { const s = planSkill(ctx); if (s) steps.push(s); }
    } else if (c === "codex") steps.push(planCodex(ctx, explicit, remote));
    else steps.push(planJson(ctx, c, explicit, remote));
  }

  const show = (verb: Record<State, string>) => {
    for (const s of steps) ctx.out(`  ${LABEL[s.client].padEnd(15)} ${verb[s.state]}${s.detail ? `: ${scrub(s.detail)}` : ""}`);
  };
  const todo = steps.filter((s) => s.apply);
  if (p.flags["dry-run"]) {
    ctx.out("driftnet init (dry run; nothing is written):");
    show({ add: "would add", update: "would update", same: "already set", skip: "skipped", fail: "cannot" });
    if (remote) ctx.out("  (the token is written to the client's config but never printed)");
    return steps.some((s) => s.state === "fail") ? 1 : 0;
  }
  if (!todo.length) {
    ctx.out("driftnet init:");
    show({ add: "", update: "", same: "already set", skip: "skipped", fail: "failed" });
    return steps.some((s) => s.state === "fail") ? 1 : 0;
  }
  if (!p.flags.yes) {
    ctx.out("driftnet init will make these changes:");
    show({ add: "add", update: "update", same: "already set", skip: "skipped", fail: "cannot" });
    if (!ctx.isTTY) {
      ctx.err("driftnet: not a terminal, so not asking. Re-run with --yes to apply this plan (or --dry-run to only print it).");
      return 1;
    }
    if (!(await ctx.confirm("Apply?"))) { ctx.out("Nothing changed."); return 0; }
  }

  const changed = new Set<Client>();
  let failed = steps.some((s) => s.state === "fail");
  ctx.out("driftnet init:");
  for (const s of steps) {
    const name = LABEL[s.client].padEnd(15);
    if (!s.apply) { ctx.out(`  ${name} ${WORD[s.state]}${s.detail ? `: ${scrub(s.detail)}` : ""}`); continue; }
    try {
      const note = await s.apply();
      ctx.out(`  ${name} ${WORD[s.state]}: ${scrub(s.detail)}${note ? ` [${scrub(note)}]` : ""}`);
      changed.add(s.client);
    } catch (e) {
      failed = true;
      ctx.out(`  ${name} failed: ${scrub((e as Error).message)}`);
    }
  }
  for (const c of changed) ctx.out(`Restart ${LABEL[c]} to load driftnet.`);
  if (changed.size && !remote) ctx.out("The local MCP server opens ~/.driftnet directly; run `npx driftnet` too for the web page and chat bots.");
  return failed ? 1 : 0;
}
