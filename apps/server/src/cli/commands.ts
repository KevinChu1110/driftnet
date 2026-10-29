import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { driftnetHome } from "@driftnet/core";
import { parseArgs, UsageError, type ArgSpec } from "./args.ts";
import { call, HttpError, ok, resolveConnection, ServerDown, type Connection } from "./client.ts";
import { completionScript } from "./completion.ts";

/** Everything the commands touch outside themselves, so tests can swap it. */
export interface Ctx {
  env: NodeJS.ProcessEnv;
  out: (s: string) => void;
  err: (s: string) => void;
  writeBytes: (bytes: Uint8Array) => void;
  fetch: typeof fetch;
  isTTY: boolean;
  confirm: (question: string) => Promise<boolean>;
  open: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export function realCtx(): Ctx {
  return {
    env: process.env,
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
    writeBytes: (b) => process.stdout.write(b),
    fetch,
    isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
    confirm: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try { return /^y(es)?$/i.test((await rl.question(q + " [y/N] ")).trim()); } finally { rl.close(); }
    },
    open: (url) => {
      const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
      try { spawn(command, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* no browser */ }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

const KINDS = ["repo", "product", "video", "article", "post", "other"];
const VIEWS = ["inbox", "favorites", "trash"];
const DOWN_HINT = "no driftnet server answered. Start it with `npx driftnet` (or point at one with --url / DRIFTNET_URL).";
const FALLBACK_NOTE = "(server not running; read the database directly)";

interface PubItem {
  id: number; url: string; title: string; worth: string; kind?: string; category?: string;
  summary?: { name?: string; oneLiner?: string } | null;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const nameOf = (i: PubItem) => clean(i.summary?.name || i.title || i.url);

export function formatItem(i: PubItem): string {
  const line = clean(i.summary?.oneLiner ?? "");
  return `#${i.id}  ${i.worth.padEnd(8)}  ${nameOf(i)}${line ? ` — ${line}` : ""}  ${i.url}`;
}

function parseLimit(v: string | boolean | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError("--limit needs a whole number of 1 or more");
  return n;
}

function oneOf(flag: string, v: string | boolean | undefined, allowed: string[]): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !allowed.includes(v)) throw new UsageError(`--${flag} must be one of: ${allowed.join(", ")}`);
  return v;
}

/** Run a command body: usage mistakes, HTTP refusals and "no server" become a message and exit code 1. */
async function guarded(ctx: Ctx, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof UsageError) { ctx.err(`driftnet: ${e.message}`); return 2; }
    if (e instanceof HttpError) { ctx.err(`driftnet: ${e.message}`); return 1; }
    if (e instanceof ServerDown) { ctx.err(`driftnet: ${DOWN_HINT}`); return 1; }
    throw e;
  }
}

function conn(ctx: Ctx, flags: Record<string, string | boolean>): Connection {
  return resolveConnection(flags, ctx.env);
}

export async function add(ctx: Ctx, argv: string[]): Promise<number> {
  return guarded(ctx, async () => {
    const { positional, flags } = parseArgs(argv, { value: ["note"] });
    if (positional.length !== 1) throw new UsageError('usage: driftnet add <url> [--note "…"]');
    const c = conn(ctx, flags);
    const note = typeof flags.note === "string" ? flags.note : undefined;
    const r = await call(c, ctx.fetch, "POST", "/api/ingest", { json: { url: positional[0], ...(note ? { note } : {}) } });
    const results = ok<{ item: PubItem }[]>(r);
    if (!results.length) { ctx.err("driftnet: no link found in that argument"); return 1; }
    for (const { item } of results) {
      const line = clean(item.summary?.oneLiner ?? "");
      ctx.out(`#${item.id} ${nameOf(item)}${line ? ` — ${line}` : ""}`);
      ctx.out(`${c.url}/#item-${item.id}`);
    }
    return 0;
  });
}

interface ListOpts { q?: string; folder?: string; kind?: string; view?: string; limit: number }

async function listItems(ctx: Ctx, c: Connection, o: ListOpts): Promise<{ items: PubItem[]; direct: boolean }> {
  const qs = new URLSearchParams();
  if (o.q) qs.set("q", o.q);
  if (o.folder) qs.set("category", o.folder);
  if (o.kind) qs.set("kind", o.kind);
  if (o.view) qs.set("view", o.view);
  qs.set("limit", String(o.limit));
  try {
    return { items: ok<PubItem[]>(await call(c, ctx.fetch, "GET", `/api/items?${qs}`, { timeoutMs: 30_000 })), direct: false };
  } catch (e) {
    if (!(e instanceof ServerDown)) throw e;
    ctx.err(FALLBACK_NOTE);
    const { createDriftnet, publicItem } = await import("@driftnet/core");
    const dn = createDriftnet(c.env);
    const items = dn.store.list({
      ...(o.q ? { q: o.q } : {}),
      ...(o.folder ? { category: o.folder } : {}),
      ...(o.kind ? { kind: o.kind as never } : {}),
      ...(o.view ? { view: o.view as never } : {}),
      clean: true, limit: o.limit, offset: 0,
    });
    return { items: items.map((i) => publicItem(i)) as unknown as PubItem[], direct: true };
  }
}

export async function search(ctx: Ctx, argv: string[]): Promise<number> {
  return guarded(ctx, async () => {
    const { positional, flags } = parseArgs(argv, { value: ["folder", "kind", "view", "limit"], bool: ["json"] });
    const opts: ListOpts = {
      limit: parseLimit(flags.limit, 10),
      ...(positional.length ? { q: positional.join(" ") } : {}),
      ...(typeof flags.folder === "string" ? { folder: flags.folder } : {}),
      ...(oneOf("kind", flags.kind, KINDS) ? { kind: flags.kind as string } : {}),
      ...(oneOf("view", flags.view, VIEWS) ? { view: flags.view as string } : {}),
    };
    const { items } = await listItems(ctx, conn(ctx, flags), opts);
    if (flags.json) ctx.out(JSON.stringify(items, null, 2));
    else for (const i of items) ctx.out(formatItem(i));
    return 0;
  });
}

export async function open(ctx: Ctx, argv: string[]): Promise<number> {
  return guarded(ctx, async () => {
    const { positional, flags } = parseArgs(argv);
    if (positional.length > 1 || (positional[0] && !/^#?\d+$/.test(positional[0]))) throw new UsageError("usage: driftnet open [id]");
    const c = conn(ctx, flags);
    const target = positional[0] ? `${c.url}/#item-${positional[0].replace("#", "")}` : `${c.url}/`;
    ctx.open(target);
    ctx.out(target);
    return 0;
  });
}

async function allItemsJson(ctx: Ctx, c: Connection): Promise<PubItem[]> {
  const all: PubItem[] = [];
  for (;;) {
    const r = await call(c, ctx.fetch, "GET", `/api/items?limit=200&offset=${all.length}`, { timeoutMs: 60_000 });
    const page = ok<PubItem[]>(r);
    all.push(...page);
    const total = Number(r.headers.get("x-total-count") ?? page.length);
    if (!page.length || all.length >= total) return all;
  }
}

export async function exportCmd(ctx: Ctx, argv: string[]): Promise<number> {
  return guarded(ctx, async () => {
    const { positional, flags } = parseArgs(argv, { value: ["format", "output"], short: { o: "output" } });
    if (positional.length) throw new UsageError("usage: driftnet export [--format json|md|vault] [-o file]");
    const format = oneOf("format", flags.format, ["json", "md", "vault"]) ?? "md";
    const output = typeof flags.output === "string" ? flags.output : undefined;
    if (format === "vault" && !output) throw new UsageError("a vault is a zip file: give it a name with -o vault.zip");
    const c = conn(ctx, flags);
    let bytes: Uint8Array;
    try {
      if (format === "json") bytes = new TextEncoder().encode(JSON.stringify(await allItemsJson(ctx, c), null, 2) + "\n");
      else {
        const r = await call(c, ctx.fetch, "GET", `/api/export?format=${format}`, { timeoutMs: 120_000 });
        if (r.status !== 200) ok(r);
        bytes = r.bytes;
      }
    } catch (e) {
      if (!(e instanceof ServerDown)) throw e;
      ctx.err(FALLBACK_NOTE);
      bytes = await exportDirect(c, format);
    }
    if (output) {
      writeFileSync(output, bytes);
      ctx.err(`wrote ${bytes.length} bytes to ${output}`);
    } else ctx.writeBytes(bytes);
    return 0;
  });
}

async function exportDirect(c: Connection, format: string): Promise<Uint8Array> {
  const { createDriftnet, publicItem, resolveLocale } = await import("@driftnet/core");
  const dn = createDriftnet(c.env);
  if (format === "json") {
    const items = dn.store.list({ clean: true, limit: 1_000_000, offset: 0 }).map((i) => publicItem(i));
    return new TextEncoder().encode(JSON.stringify(items, null, 2) + "\n");
  }
  const { collect, toMarkdown, toVault, zip } = await import("../export.ts");
  const data = collect(dn, resolveLocale());
  return format === "vault" ? zip(toVault(data)) : new TextEncoder().encode(toMarkdown(data));
}

interface Counts { total: number; duplicates: number; skipped: number }
interface JobState { state: "running" | "done" | "failed"; total: number; done: number; added: number; already: number; failed: number; errors?: unknown[] }

export async function importCmd(ctx: Ctx, argv: string[]): Promise<number> {
  return guarded(ctx, async () => {
    const { positional, flags } = parseArgs(argv, { bool: ["keep-folders", "yes"] });
    if (positional.length !== 1) throw new UsageError("usage: driftnet import <file> [--keep-folders] [--yes]");
    let content: string;
    try { content = readFileSync(positional[0]!, "utf8"); } catch (e) {
      ctx.err(`driftnet: cannot read ${positional[0]}: ${(e as NodeJS.ErrnoException).code ?? e}`);
      return 1;
    }
    const c = conn(ctx, flags);
    const folders = flags["keep-folders"] ? "keep" : "none";
    const preview = ok<Counts>(await call(c, ctx.fetch, "POST", "/api/import", { json: { content, folders, dryRun: true } }));
    // total is what will be imported: duplicates and skipped links are already left out of it.
    ctx.out(`${preview.total + preview.duplicates + preview.skipped} links found: ${preview.total} new, ${preview.duplicates} already saved, ${preview.skipped} skipped.`);
    if (preview.total <= 0) { ctx.out("nothing new to import."); return 0; }
    if (!flags.yes) {
      if (!ctx.isTTY) { ctx.err("driftnet: not a terminal, so I can't ask. Re-run with --yes to import."); return 1; }
      if (!(await ctx.confirm("Import these links?"))) { ctx.err("cancelled."); return 1; }
    }
    const started = await call(c, ctx.fetch, "POST", "/api/import", { json: { content, folders } });
    if (started.status === 409) { ctx.err("driftnet: an import is already running; wait for it to finish."); return 1; }
    const { job } = ok<{ job: string }>(started, [200, 202]);
    let last = "";
    for (;;) {
      const s = ok<JobState>(await call(c, ctx.fetch, "GET", `/api/import/${encodeURIComponent(job)}`, { timeoutMs: 30_000 }));
      const line = `${s.done}/${s.total} done: ${s.added} added, ${s.already} already saved, ${s.failed} failed`;
      if (s.state === "running") {
        if (line !== last) ctx.out(line);
        last = line;
        await ctx.sleep(2000);
        continue;
      }
      ctx.out(`${s.state === "done" ? "finished" : "failed"}: ${line}`);
      for (const e of (s.errors ?? []).slice(0, 5)) ctx.err(`  ${typeof e === "string" ? e : JSON.stringify(e)}`);
      return s.state === "done" ? 0 : 1;
    }
  });
}

export async function status(ctx: Ctx, argv: string[]): Promise<number> {
  return guarded(ctx, async () => {
    const { flags } = parseArgs(argv);
    const c = conn(ctx, flags);
    const home = driftnetHome(c.env);
    const where = `settings: ${c.envFile ?? `none (${join(home, ".env")} not created yet)`}\ndata: ${c.env.DRIFTNET_DB ?? join(home, "driftnet.db")}`;
    try {
      const r = await call(c, ctx.fetch, "GET", "/api/stats", { timeoutMs: 5000 });
      const s = ok<{ items: number }>(r);
      ctx.out(`running at ${c.url}\nitems: ${s.items}\n${where}`);
      return 0;
    } catch (e) {
      if (!(e instanceof ServerDown)) throw e;
      ctx.out(`not running at ${c.url} (start it with \`npx driftnet\`)\n${where}`);
      return 1;
    }
  });
}

export async function completion(ctx: Ctx, argv: string[]): Promise<number> {
  return guarded(ctx, async () => {
    const { positional } = parseArgs(argv);
    const script = positional.length === 1 ? completionScript(positional[0]!) : undefined;
    if (!script) throw new UsageError("usage: driftnet completion bash|zsh");
    ctx.out(script.trimEnd());
    return 0;
  });
}

export const HANDLERS: Record<string, (ctx: Ctx, argv: string[]) => Promise<number>> = {
  add, search, open, export: exportCmd, import: importCmd, completion, status,
};
export type { ArgSpec };
