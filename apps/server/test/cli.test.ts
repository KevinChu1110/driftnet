import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDriftnet } from "@driftnet/core";
import { parseArgs, UsageError } from "../src/cli/args.ts";
import { resolveConnection } from "../src/cli/client.ts";
import { COMMANDS, completionScript } from "../src/cli/completion.ts";
import { HANDLERS, formatItem, type Ctx } from "../src/cli/commands.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "driftnet-cli-"));

function makeCtx(env: NodeJS.ProcessEnv, over: Partial<Ctx> = {}) {
  const out: string[] = [], err: string[] = [], opened: string[] = [];
  const bytes: Uint8Array[] = [];
  const ctx: Ctx = {
    env: { DRIFTNET_HOME: tmp(), ...env },
    out: (s) => out.push(s), err: (s) => err.push(s), writeBytes: (b) => bytes.push(b),
    fetch, isTTY: false, confirm: async () => true, open: (u) => opened.push(u), sleep: async () => {},
    ...over,
  };
  return { ctx, out, err, opened, bytes };
}

interface Seen { method: string; url: string; headers: IncomingMessage["headers"]; body: string }
async function mock(handler: (req: Seen) => [number, unknown, Record<string, string>?]): Promise<{ url: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const s = { method: req.method!, url: req.url!, headers: req.headers, body };
      seen.push(s);
      const [status, json, headers] = handler(s);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(typeof json === "string" ? json : JSON.stringify(json));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() };
}

const item = (id: number, name: string, oneLiner = "does a thing") => ({ id, url: `https://x.test/${id}`, title: name, worth: "must-see", summary: { name, oneLiner } });

test("cli args: flags, =, short, errors", () => {
  const p = parseArgs(["a", "b", "--kind", "repo", "--limit=3", "--json", "-o", "f.md"], { value: ["kind", "limit", "output"], bool: ["json"], short: { o: "output" } });
  assert.deepEqual(p.positional, ["a", "b"]);
  assert.deepEqual(p.flags, { kind: "repo", limit: "3", json: true, output: "f.md" });
  assert.throws(() => parseArgs(["--nope"]), UsageError);
  assert.throws(() => parseArgs(["--kind"], { value: ["kind"] }), /needs a value/);
  assert.deepEqual(parseArgs(["--", "--x"]).positional, ["--x"]);
});

test("cli connection: flags beat env beat .env; default port", () => {
  const home = tmp();
  writeFileSync(join(home, ".env"), "DRIFTNET_TOKEN=fromfile\nPORT=9999\n");
  assert.deepEqual(
    [resolveConnection({}, { DRIFTNET_HOME: home }).url, resolveConnection({}, { DRIFTNET_HOME: home }).token],
    ["http://127.0.0.1:9999", "fromfile"],
  );
  const c = resolveConnection({}, { DRIFTNET_HOME: home, DRIFTNET_TOKEN: "fromenv", DRIFTNET_URL: "http://h:1/" });
  assert.equal(c.token, "fromenv");
  assert.equal(c.url, "http://h:1");
  const f = resolveConnection({ url: "http://f:2", token: "flag" }, { DRIFTNET_HOME: home, DRIFTNET_TOKEN: "fromenv" });
  assert.deepEqual([f.url, f.token], ["http://f:2", "flag"]);
  const none = resolveConnection({}, { DRIFTNET_HOME: tmp() });
  assert.equal(none.url, "http://127.0.0.1:8787");
  assert.equal(none.token, undefined);
});

test("cli search: formatting, query params, headers, --json", async () => {
  const m = await mock(() => [200, [item(7, "Alpha", "first"), { ...item(8, "Beta"), worth: "low" }]]);
  try {
    const { ctx, out } = makeCtx({ DRIFTNET_URL: m.url, DRIFTNET_TOKEN: "sekrit" });
    assert.equal(await HANDLERS.search!(ctx, ["hello", "world", "--kind", "repo", "--folder", "dev", "--view", "favorites", "--limit", "5"]), 0);
    assert.equal(out[0], "#7  must-see  Alpha — first  https://x.test/7");
    assert.equal(out[1], "#8  low       Beta — does a thing  https://x.test/8");
    const q = new URL(m.url + m.seen[0]!.url).searchParams;
    assert.deepEqual([q.get("q"), q.get("kind"), q.get("category"), q.get("view"), q.get("limit")], ["hello world", "repo", "dev", "favorites", "5"]);
    assert.equal(m.seen[0]!.headers["x-driftnet-agent"], "cli");
    assert.equal(m.seen[0]!.headers.authorization, "Bearer sekrit");
    const j = makeCtx({ DRIFTNET_URL: m.url });
    await HANDLERS.search!(j.ctx, ["--json"]);
    assert.equal(JSON.parse(j.out.join("\n")).length, 2);
    assert.equal(new URL(m.url + m.seen[1]!.url).searchParams.get("limit"), "10");
    const bad = makeCtx({ DRIFTNET_URL: m.url });
    assert.equal(await HANDLERS.search!(bad.ctx, ["--kind", "nope"]), 2);
  } finally { m.close(); }
});

test("cli search/export: no server falls back to the database", async () => {
  const home = tmp();
  const env = { DRIFTNET_HOME: home, DRIFTNET_DB: join(home, "t.db"), DRIFTNET_URL: "http://127.0.0.1:1", DRIFTNET_LLM_PROVIDER: "", DRIFTNET_JUDGE: "off" };
  const dn = createDriftnet({ ...env });
  await dn.pipeline.ingest("https://github.com/acme/widget", { platform: "t", chatId: "c" }, 0, { title: "Widget", text: "A widget library for building things." });
  const s = makeCtx(env);
  assert.equal(await HANDLERS.search!(s.ctx, ["widget"]), 0);
  assert.deepEqual(s.err, ["(server not running; read the database directly)"]);
  assert.match(s.out.join("\n"), /^#\d+ +\S+ +.*github\.com\/acme\/widget/);
  const e = makeCtx(env);
  assert.equal(await HANDLERS.export!(e.ctx, ["--format", "json"]), 0);
  assert.equal(JSON.parse(new TextDecoder().decode(e.bytes[0]!)).length, 1);
  const md = makeCtx(env);
  assert.equal(await HANDLERS.export!(md.ctx, []), 0);
  assert.match(new TextDecoder().decode(md.bytes[0]!), /github\.com\/acme\/widget/);
});

test("cli add: prints card link; refusal and no-server exit 1", async () => {
  const m = await mock((r) => r.body.includes("blocked") ? [422, { error: "address not allowed" }] : [200, [{ item: item(3, "Gamma", "neat") , cached: false }]]);
  try {
    const { ctx, out } = makeCtx({ DRIFTNET_URL: m.url });
    assert.equal(await HANDLERS.add!(ctx, ["https://g.test", "--note", "later"]), 0);
    assert.deepEqual(out, ["#3 Gamma — neat", `${m.url}/#item-3`]);
    assert.deepEqual(JSON.parse(m.seen[0]!.body), { url: "https://g.test", note: "later" });
    const r = makeCtx({ DRIFTNET_URL: m.url });
    assert.equal(await HANDLERS.add!(r.ctx, ["http://blocked.test"]), 1);
    assert.deepEqual(r.err, ["driftnet: address not allowed"]);
  } finally { m.close(); }
  const down = makeCtx({ DRIFTNET_URL: "http://127.0.0.1:1" });
  assert.equal(await HANDLERS.add!(down.ctx, ["https://g.test"]), 1);
  assert.match(down.err[0]!, /npx driftnet/);
});

test("cli import: preview, --yes, progress, done; refusal without --yes; 409", async () => {
  const file = join(tmp(), "bookmarks.html");
  writeFileSync(file, "<a href='https://a.test'>a</a>");
  let polls = 0;
  const m = await mock((r) => {
    if (r.method === "POST") {
      const b = JSON.parse(r.body);
      return b.dryRun ? [200, { total: 10, duplicates: 2, skipped: 1, preview: [] }] : [202, { job: "j1", total: 10, duplicates: 2, skipped: 1 }];
    }
    polls++;
    return polls < 3
      ? [200, { state: "running", total: 7, done: polls * 2, added: polls * 2, already: 0, failed: 0 }]
      : [200, { state: "done", total: 7, done: 7, added: 6, already: 0, failed: 1, errors: ["bad url"] }];
  });
  try {
    const nt = makeCtx({ DRIFTNET_URL: m.url });
    assert.equal(await HANDLERS.import!(nt.ctx, [file]), 1);
    assert.match(nt.err.join(), /--yes/);
    assert.equal(m.seen.length, 1);
    assert.equal(m.seen[0]!.url, "/api/import");

    const { ctx, out } = makeCtx({ DRIFTNET_URL: m.url });
    assert.equal(await HANDLERS.import!(ctx, [file, "--yes", "--keep-folders"]), 0);
    assert.match(out[0]!, /10 links found: 7 new, 2 already saved, 1 skipped/);
    assert.deepEqual(JSON.parse(m.seen[2]!.body), { content: "<a href='https://a.test'>a</a>", folders: "keep" });
    assert.match(out.at(-1)!, /^finished: 7\/7 done: 6 added, 0 already saved, 1 failed/);
    assert.ok(out.some((l) => l.startsWith("2/7 done")));

    const tty = makeCtx({ DRIFTNET_URL: m.url }, { isTTY: true, confirm: async () => false });
    const before = m.seen.length;
    assert.equal(await HANDLERS.import!(tty.ctx, [file]), 1);
    assert.equal(m.seen.length, before + 1, "declined: only the dry run was sent");
  } finally { m.close(); }

  const busy = await mock((r) => r.method === "POST" && !JSON.parse(r.body).dryRun ? [409, { error: "an import is already running" }] : [200, { total: 1, duplicates: 0, skipped: 0 }]);
  try {
    const { ctx, err } = makeCtx({ DRIFTNET_URL: busy.url });
    assert.equal(await HANDLERS.import!(ctx, [file, "--yes"]), 1);
    assert.match(err[0]!, /already running/);
  } finally { busy.close(); }
  const down = makeCtx({ DRIFTNET_URL: "http://127.0.0.1:1" });
  assert.equal(await HANDLERS.import!(down.ctx, [file, "--yes"]), 1);
  assert.match(down.err[0]!, /npx driftnet/);
});

test("cli export: server formats, -o file, vault needs -o", async () => {
  const m = await mock((r) => r.url.startsWith("/api/export") ? [200, "# md body"] : [200, [item(1, "A")], { "X-Total-Count": "1" }]);
  try {
    const a = makeCtx({ DRIFTNET_URL: m.url });
    assert.equal(await HANDLERS.export!(a.ctx, []), 0);
    assert.equal(new TextDecoder().decode(a.bytes[0]!), "# md body");
    const f = join(tmp(), "o.md");
    const b = makeCtx({ DRIFTNET_URL: m.url });
    assert.equal(await HANDLERS.export!(b.ctx, ["--format", "md", "-o", f]), 0);
    assert.equal(readFileSync(f, "utf8"), "# md body");
    const j = makeCtx({ DRIFTNET_URL: m.url });
    await HANDLERS.export!(j.ctx, ["--format", "json"]);
    assert.equal(JSON.parse(new TextDecoder().decode(j.bytes[0]!))[0].id, 1);
    const v = makeCtx({ DRIFTNET_URL: m.url });
    assert.equal(await HANDLERS.export!(v.ctx, ["--format", "vault"]), 2);
  } finally { m.close(); }
});

test("cli status, open and completion", async () => {
  const m = await mock(() => [200, { items: 42 }]);
  try {
    const { ctx, out } = makeCtx({ DRIFTNET_URL: m.url });
    assert.equal(await HANDLERS.status!(ctx, []), 0);
    assert.match(out[0]!, /running at .*\nitems: 42\nsettings: none.*\ndata: .*driftnet\.db/);
    const o = makeCtx({ DRIFTNET_URL: m.url });
    await HANDLERS.open!(o.ctx, ["12"]);
    assert.deepEqual(o.opened, [`${m.url}/#item-12`]);
  } finally { m.close(); }
  const down = makeCtx({ DRIFTNET_URL: "http://127.0.0.1:1" });
  assert.equal(await HANDLERS.status!(down.ctx, []), 1);
  assert.match(down.out[0]!, /not running/);
  for (const shell of ["bash", "zsh"]) {
    const s = completionScript(shell)!;
    for (const c of Object.keys(COMMANDS)) assert.ok(s.includes(c), `${shell} completes ${c}`);
    for (const f of ["--folder", "--keep-folders", "--format"]) assert.ok(s.includes(f));
  }
  assert.equal(completionScript("fish"), undefined);
  const c = makeCtx({});
  assert.equal(await HANDLERS.completion!(c.ctx, ["zsh"]), 0);
  assert.equal(await HANDLERS.completion!(c.ctx, ["fish"]), 2);
});

test("cli: formatItem tolerates a card with no summary", () => {
  assert.equal(formatItem({ id: 1, url: "https://u", title: "T", worth: "skip" }), "#1  skip      T  https://u");
});
