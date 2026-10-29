import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_LATEST, createDriftnet } from "@driftnet/core";
import { createApp } from "../src/app.ts";
import { applyPendingRestore, buildBackup, checkBackupZip, inspectDb, pendingPath, settingsForBackup, snapshotTo, zipStream } from "../src/backup.ts";
import { HANDLERS, type Ctx } from "../src/cli/commands.ts";
import { agentBrief } from "../src/brief.ts";

const PASSWORD = "backup-test-password-1A!";
const READ_KEY = "backup-test-read-key-1234";
const SECRET_ENV = [
  "DRIFTNET_LANGUAGE=Japanese",
  "DRIFTNET_PROFILE=`Backend engineer\nnot interested in crypto`",
  "DRIFTNET_LLM_API_KEY=sk-super-secret",
  "TELEGRAM_BOT_TOKEN=tg-super-secret",
  `DRIFTNET_READ_KEY=${READ_KEY}`,
  "DRIFTNET_WEBHOOK_URL=https://hooks.test/abc-secret",
  "SLACK_SIGNING_SECRET=slack-super-secret",
].join("\n") + "\n";
const SECRET_WORDS = ["sk-super-secret", "tg-super-secret", READ_KEY, "abc-secret", "slack-super-secret"];

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const judgement = { isAiTool: 1, category: "coding-agent", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };

async function boot() {
  const home = mkdtempSync(join(tmpdir(), "driftnet-backup-"));
  writeFileSync(join(home, ".env"), SECRET_ENV);
  const env: NodeJS.ProcessEnv = { DRIFTNET_HOME: home, DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en", DRIFTNET_TOKEN: PASSWORD, DRIFTNET_READ_KEY: READ_KEY, DRIFTNET_VERSION: "9.9.9" };
  const dn = createDriftnet(env);
  for (const i of [1, 2, 3]) dn.store.upsert({ url: `https://backup.test/${i}`, aliases: [], title: `item ${i}`, judgement, summary: null, flags: [], source: "s" });
  const server = createApp({ dn, env, port: 0 });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: Buffer) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((ok, fail) => {
      const r = request({ host: "127.0.0.1", port, method, path, headers: { "x-forwarded-for": "203.0.113.7", ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      r.on("error", fail);
      r.end(body);
    });
  return { home, env, dn, call, db: join(home, "driftnet.db"), auth: { authorization: `Bearer ${PASSWORD}` } };
}

const unzipTo = async (zip: Buffer) => {
  const dir = mkdtempSync(join(tmpdir(), "driftnet-unzip-"));
  const file = join(dir, "in.zip");
  writeFileSync(file, zip);
  const work = join(dir, "out");
  mkdirSync(work);
  return checkBackupZip(file, work);
};

async function build(files: { name: string; data: Buffer }[]): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of zipStream(files)) parts.push(c);
  return Buffer.concat(parts);
}

/** A genuine backup, to tamper with. */
async function genuine(b: Awaited<ReturnType<typeof boot>>) {
  const res = await b.call("GET", "/api/backup", b.auth);
  assert.equal(res.status, 200);
  const dir = mkdtempSync(join(tmpdir(), "driftnet-gen-"));
  const file = join(dir, "g.zip");
  writeFileSync(file, res.body);
  const { listZip } = await import("../src/backup.ts");
  assert.equal(listZip(file).length, 3);
  const checked = await unzipTo(res.body);
  return { zip: res.body, db: readFileSync(checked.db), manifest: checked.manifest, settings: Buffer.from(checked.settings) };
}

const zipHeaders = (extra: Record<string, string> = {}) => ({ "content-type": "application/zip", ...extra });

test("backup: a zip with a manifest, a database snapshot that opens and has the items, and settings without secrets", async () => {
  const b = await boot();
  const res = await b.call("GET", "/api/backup", b.auth);
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/zip");
  assert.match(String(res.headers["content-disposition"]), /driftnet-backup-\d{4}-\d{2}-\d{2}\.zip/);
  assert.equal(res.headers["x-driftnet-backup-secrets"], "removed");
  const c = await unzipTo(res.body);
  assert.equal(c.manifest.format, "driftnet-backup");
  assert.equal(c.manifest.driftnet, "9.9.9");
  assert.equal(c.manifest.schema, SCHEMA_LATEST);
  assert.equal(c.manifest.items, 3);
  assert.equal(c.manifest.secrets, false);
  assert.ok(Date.parse(c.manifest.created) > Date.now() - 60_000);
  const snap = new DatabaseSync(c.db, { readOnly: true });
  assert.equal((snap.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 3);
  snap.close();
  // settings: what is safe stays, every secret is gone (flagged keys, the share key, and keys the settings page doesn't even know)
  assert.match(c.settings, /DRIFTNET_LANGUAGE=Japanese/);
  assert.match(c.settings, /DRIFTNET_PROFILE=/);
  for (const w of SECRET_WORDS) assert.ok(!c.settings.includes(w), `${w} leaked into settings.env`);
  // the temp snapshot never outlives the request
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(readdirSync(b.home).filter((n) => n.startsWith(".backup-") || n.startsWith(".restore-")), []);
  // standard tools open it
  try {
    const f = join(mkdtempSync(join(tmpdir(), "driftnet-z-")), "b.zip");
    writeFileSync(f, res.body);
    execFileSync("unzip", ["-tq", f], { stdio: "pipe" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
});

test("backup: secrets only with the password sent again in a header, and the response says so", async () => {
  const b = await boot();
  assert.equal((await b.call("GET", "/api/backup?secrets=1", b.auth)).status, 403);
  assert.equal((await b.call("GET", "/api/backup?secrets=1", { ...b.auth, "x-driftnet-confirm": "wrong" })).status, 403);
  const res = await b.call("GET", "/api/backup?secrets=1", { ...b.auth, "x-driftnet-confirm": PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-driftnet-backup-secrets"], "included");
  const c = await unzipTo(res.body);
  assert.equal(c.manifest.secrets, true);
  assert.ok(c.settings.includes("sk-super-secret") && c.settings.includes("tg-super-secret"));
  // the password in the URL is never a way in
  assert.equal((await b.call("GET", `/api/backup?secrets=1&confirm=${PASSWORD}`, b.auth)).status, 403);
});

test("backup access: admin password only; no credentials, the read key and agent tokens are refused (backup and restore)", async () => {
  const b = await boot();
  const write = b.dn.store.createAgentToken({ name: "Hermes", scope: "write" });
  const read = b.dn.store.createAgentToken({ name: "Dash", scope: "read" });
  for (const [method, path] of [["GET", "/api/backup"], ["POST", "/api/backup/restore"]] as const) {
    const h = method === "POST" ? zipHeaders() : {};
    for (const who of [{} as Record<string, string>, { authorization: `Bearer ${READ_KEY}` }, { authorization: `Bearer ${write.token}` }, { authorization: `Bearer ${read.token}` }, { authorization: "Bearer nope" }]) {
      const r = await b.call(method, path, { ...h, ...who }, method === "POST" ? Buffer.from("x") : undefined);
      assert.ok(r.status === 401 || r.status === 403, `${method} ${path} with ${JSON.stringify(who)} answered ${r.status}`);
    }
  }
  assert.equal((await b.call("GET", "/api/backup?key=" + READ_KEY)).status >= 401, true);
});

test("restore: bad input is refused and nothing is staged", async () => {
  const b = await boot();
  const g = await genuine(b);
  const post = (zip: Buffer, h: Record<string, string> = {}) => b.call("POST", "/api/backup/restore", { ...b.auth, ...zipHeaders(), ...h }, zip);
  const refused = async (zip: Buffer, re: RegExp, status = 400) => {
    const r = await post(zip);
    assert.equal(r.status, status, r.body.toString());
    assert.match(JSON.parse(r.body.toString()).error, re);
    assert.ok(!existsSync(pendingPath(b.db)), "nothing may be staged");
  };
  await refused(Buffer.from("this is not a zip at all, just some text that is long enough"), /not a zip/);
  await refused(await build([{ name: "../driftnet.db", data: g.db }, { name: "manifest.json", data: Buffer.from(JSON.stringify(g.manifest)) }]), /unsafe path/);
  await refused(await build([{ name: "manifest.json", data: Buffer.from(JSON.stringify(g.manifest)) }, { name: "driftnet.db", data: g.db }, { name: "extra.sh", data: Buffer.from("echo hi") }]), /unexpected file/);
  await refused(await build([{ name: "manifest.json", data: Buffer.from(JSON.stringify(g.manifest)) }, { name: "sub/driftnet.db", data: g.db }]), /unexpected file/);
  await refused(await build([{ name: "driftnet.db", data: g.db }]), /manifest/);
  await refused(await build([{ name: "manifest.json", data: Buffer.from("{}") }, { name: "driftnet.db", data: g.db }]), /not a driftnet backup/);
  await refused(await build([{ name: "manifest.json", data: Buffer.alloc(300 * 1024, 32) }, { name: "driftnet.db", data: g.db }]), /larger than/);
  await refused(await build([{ name: "manifest.json", data: Buffer.from(JSON.stringify(g.manifest)) }, { name: "driftnet.db", data: Buffer.from("not sqlite, just text") }]), /not a SQLite/);
  // corrupted pages
  const bad = Buffer.from(g.db);
  for (let i = 4096; i < Math.min(bad.length, 4096 * 6); i++) bad[i] = (i * 7) & 0xff;
  await refused(await build([{ name: "manifest.json", data: Buffer.from(JSON.stringify(g.manifest)) }, { name: "driftnet.db", data: bad }]), /damaged|could not be/);
  // a newer schema, in the manifest and in the database itself
  const newer = join(mkdtempSync(join(tmpdir(), "driftnet-newer-")), "n.db");
  writeFileSync(newer, g.db);
  const nd = new DatabaseSync(newer);
  nd.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  nd.exec(`PRAGMA user_version = ${SCHEMA_LATEST + 1}`);
  nd.close();
  const newerBytes = readFileSync(newer);
  await refused(await build([{ name: "manifest.json", data: Buffer.from(JSON.stringify({ ...g.manifest, schema: SCHEMA_LATEST + 1 })) }, { name: "driftnet.db", data: newerBytes }]), /newer driftnet/);
  await refused(await build([{ name: "manifest.json", data: Buffer.from(JSON.stringify(g.manifest)) }, { name: "driftnet.db", data: newerBytes }]), /newer driftnet/);
  // code smuggled into the database
  const evil = join(mkdtempSync(join(tmpdir(), "driftnet-evil-")), "e.db");
  writeFileSync(evil, g.db);
  const ed = new DatabaseSync(evil);
  ed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  ed.exec("CREATE TRIGGER sneaky AFTER INSERT ON items BEGIN UPDATE items SET title = 'x'; END");
  ed.close();
  await refused(await build([{ name: "manifest.json", data: Buffer.from(JSON.stringify(g.manifest)) }, { name: "driftnet.db", data: readFileSync(evil) }]), /code driftnet did not create/);
  // the request itself: wrong content type, another site, too big
  assert.equal((await b.call("POST", "/api/backup/restore", { ...b.auth, "content-type": "application/json" }, g.zip)).status, 403);
  assert.equal((await post(g.zip, { origin: "https://evil.example" })).status, 403);
  assert.equal((await b.call("POST", "/api/backup/restore", { ...b.auth, ...zipHeaders(), "content-length": String(201 * 1024 * 1024) })).status, 413);
  assert.deepEqual(readdirSync(b.home).filter((n) => n.startsWith(".")  && n !== ".env"), []);
});

test("restore: a valid backup is staged, nothing live changes, the settings are shown but not applied, and the swap happens at the next start", async () => {
  const b = await boot();
  const g = await genuine(b);
  // the live data moves on after the backup
  b.dn.store.upsert({ url: "https://backup.test/4", aliases: [], title: "item 4", judgement, summary: null, flags: [], source: "s" });
  const r = await b.call("POST", "/api/backup/restore", { ...b.auth, ...zipHeaders() }, g.zip);
  assert.equal(r.status, 200, r.body.toString());
  const body = JSON.parse(r.body.toString());
  assert.equal(body.restartRequired, true);
  assert.equal(body.items, 3);
  assert.match(body.settings, /DRIFTNET_LANGUAGE=Japanese/);
  // staged, not applied
  assert.ok(existsSync(pendingPath(b.db)));
  assert.equal(b.dn.store.stats().items, 4);
  assert.equal(b.env.DRIFTNET_LANGUAGE, undefined);
  assert.equal(readFileSync(join(b.home, ".env"), "utf8"), SECRET_ENV);
  const view = await b.call("GET", "/api/settings", b.auth);
  assert.equal(JSON.parse(view.body.toString()).restorePending, true);
  // next start: swap
  const logs: string[] = [];
  const done = await applyPendingRestore(b.db, (m) => logs.push(m));
  assert.ok(done?.before && existsSync(done.before) && /\.before-restore-/.test(done.before));
  assert.ok(!existsSync(pendingPath(b.db)));
  const live = new DatabaseSync(b.db, { readOnly: true });
  assert.equal((live.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 3);
  live.close();
  const before = new DatabaseSync(done!.before!, { readOnly: true });
  assert.equal((before.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 4);
  before.close();
  assert.match(logs.join("\n"), /restored the database/);
  // and the restored database opens in the real store
  assert.equal(createDriftnet({ ...b.env, DRIFTNET_HOME: b.home }).store.stats().items, 3);
});

test("pending swap at start: nothing staged is a no-op; a staged file that no longer validates is set aside, the live database stays", async () => {
  const b = await boot();
  assert.equal(await applyPendingRestore(b.db, () => {}), null);
  writeFileSync(pendingPath(b.db), "garbage, not a database");
  const logs: string[] = [];
  assert.equal(await applyPendingRestore(b.db, (m) => logs.push(m)), null);
  assert.ok(!existsSync(pendingPath(b.db)));
  assert.ok(readdirSync(b.home).some((n) => n.includes(".restore-rejected-")));
  assert.match(logs[0]!, /not valid/);
  assert.equal(b.dn.store.stats().items, 3);
  // no live database at all (a fresh machine): the staged one simply becomes it
  const g = await genuine(b);
  const home = mkdtempSync(join(tmpdir(), "driftnet-fresh-"));
  const db = join(home, "driftnet.db");
  writeFileSync(pendingPath(db), g.db);
  assert.deepEqual(await applyPendingRestore(db, () => {}), {});
  assert.ok(existsSync(db));
});

test("settingsForBackup: allow-list plus secret filter", () => {
  const f = join(mkdtempSync(join(tmpdir(), "driftnet-env-")), ".env");
  writeFileSync(f, SECRET_ENV + "SOME_UNKNOWN=1\nDRIFTNET_PUBLIC_URL=https://me.example\n");
  const text = settingsForBackup(f, false);
  assert.match(text, /DRIFTNET_PUBLIC_URL=https:\/\/me\.example/);
  assert.ok(!/SOME_UNKNOWN|TELEGRAM|API_KEY|READ_KEY|WEBHOOK_URL|SIGNING/.test(text), text);
  assert.equal(settingsForBackup(f, true), readFileSync(f, "utf8"));
  assert.equal(settingsForBackup(join(tmpdir(), "does-not-exist-.env"), false), "");
});

// ── CLI ──────────────────────────────────────────────────────────────────────

function cliCtx(home: string, extraEnv: Record<string, string> = {}) {
  const out: string[] = [], err: string[] = [];
  // port 1: nothing listens, so "the server is down"
  const ctx: Ctx = {
    env: { DRIFTNET_HOME: home, DRIFTNET_URL: "http://127.0.0.1:1", ...extraEnv },
    out: (s) => out.push(s), err: (s) => err.push(s), writeBytes: () => {},
    fetch, isTTY: false, confirm: async () => true, open: () => {}, sleep: async () => {},
  };
  return { ctx, out, err };
}

test("cli backup with the server down: reads the database directly, no secrets by default", async () => {
  const b = await boot();
  const out = join(mkdtempSync(join(tmpdir(), "driftnet-cli-out-")), "b.zip");
  const { ctx, out: lines, err } = cliCtx(b.home);
  assert.equal(await HANDLERS.backup!(ctx, ["-o", out]), 0, err.join("\n"));
  assert.match(lines[0]!, /3 items/);
  assert.match(err.join("\n"), /read the database directly/);
  const c = await unzipTo(readFileSync(out));
  assert.equal(c.manifest.items, 3);
  for (const w of SECRET_WORDS) assert.ok(!c.settings.includes(w));
  const withSecrets = join(mkdtempSync(join(tmpdir(), "driftnet-cli-out-")), "s.zip");
  assert.equal(await HANDLERS.backup!(cliCtx(b.home).ctx, ["-o", withSecrets, "--secrets"]), 0);
  assert.ok((await unzipTo(readFileSync(withSecrets))).settings.includes("sk-super-secret"));
  assert.deepEqual(readdirSync(b.home).filter((n) => n.startsWith(".backup-")), []);
  // no database at all: a clear message, exit 1
  const empty = cliCtx(mkdtempSync(join(tmpdir(), "driftnet-empty-")));
  assert.equal(await HANDLERS.backup!(empty.ctx, ["-o", join(tmpdir(), "nope.zip")]), 1);
  assert.match(empty.err.join("\n"), /no database file/);
});

test("cli backup with a server up: sends the password, and --secrets needs it again", async () => {
  const seen: { url: string; headers: Record<string, unknown> }[] = [];
  const srv: Server = createServer((req, res) => {
    seen.push({ url: req.url!, headers: req.headers });
    res.writeHead(200, { "content-type": "application/zip" });
    res.end(Buffer.from("PK-fake"));
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const out = join(mkdtempSync(join(tmpdir(), "driftnet-cli-out-")), "b.zip");
  const home = mkdtempSync(join(tmpdir(), "driftnet-cli-home-"));
  const noToken = cliCtx(home, { DRIFTNET_URL: url });
  assert.equal(await HANDLERS.backup!(noToken.ctx, ["-o", out, "--secrets"]), 2);
  assert.match(noToken.err.join("\n"), /--secrets needs the admin password/);
  const ok = cliCtx(home, { DRIFTNET_URL: url, DRIFTNET_TOKEN: "pw-1234567" });
  assert.equal(await HANDLERS.backup!(ok.ctx, ["-o", out, "--secrets"]), 0);
  const last = seen[seen.length - 1]!;
  assert.equal(last.url, "/api/backup?secrets=1");
  assert.equal(last.headers["x-driftnet-confirm"], "pw-1234567");
  assert.equal(last.headers.authorization, "Bearer pw-1234567");
  srv.close();
});

test("cli restore: refuses while a server runs; with it stopped it restores, keeps the old data and lists the settings", async () => {
  const b = await boot();
  const g = await genuine(b);
  const zipFile = join(mkdtempSync(join(tmpdir(), "driftnet-cli-zip-")), "r.zip");
  writeFileSync(zipFile, g.zip);
  b.dn.store.upsert({ url: "https://backup.test/9", aliases: [], title: "item 9", judgement, summary: null, flags: [], source: "s" });
  // a server answers: refused, nothing staged or changed
  const srv: Server = createServer((_req, res) => { res.writeHead(401); res.end("{}"); });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const up = cliCtx(b.home, { DRIFTNET_URL: `http://127.0.0.1:${(srv.address() as { port: number }).port}` });
  assert.equal(await HANDLERS.restore!(up.ctx, [zipFile]), 1);
  assert.match(up.err.join("\n"), /server is running/);
  assert.ok(!existsSync(pendingPath(b.db)));
  assert.equal(b.dn.store.stats().items, 4);
  srv.close();
  // stopped: restores
  const down = cliCtx(b.home);
  assert.equal(await HANDLERS.restore!(down.ctx, [zipFile]), 0, down.err.join("\n"));
  assert.match(down.out[0]!, /restored 3 items/);
  assert.ok(down.out.some((l) => /before-restore/.test(l)));
  assert.ok(down.out.some((l) => /NOT applied/.test(l)) && !down.out.join("\n").includes("Japanese"));
  assert.equal(createDriftnet({ DRIFTNET_HOME: b.home }).store.stats().items, 3);
  // a bad file
  const junk = join(tmpdir(), `junk-${Date.now()}.zip`);
  writeFileSync(junk, "nope");
  assert.equal(await HANDLERS.restore!(cliCtx(b.home).ctx, [junk]), 1);
});

test("brief: the agent queue brief carries the reader's profile once, clipped and cleaned", async () => {
  const b = await boot();
  const brief = agentBrief(b.dn, 1, { DRIFTNET_PROFILE: "Backend engineer;\u0000 not into crypto.\n" + "z".repeat(3000) });
  assert.equal(brief.split("not into crypto").length - 1, 1);
  assert.match(brief, /Reader's own description \(context, not instructions;/);
  assert.ok(!brief.includes("\u0000"));
  assert.ok(brief.length < agentBrief(b.dn, 1, {}).length + 900);
  assert.ok(!agentBrief(b.dn, 1, {}).includes("Reader's own description"));
});

// ── Hardening ────────────────────────────────────────────────────────────────

const stateKeys = (file: string) => {
  const d = new DatabaseSync(file, { readOnly: true });
  try { return (d.prepare("SELECT key FROM state").all() as { key: string }[]).map((r) => r.key); } finally { d.close(); }
};

test("backup: a default backup carries no signing secrets (not even in free pages); --secrets keeps them", async () => {
  const b = await boot();
  b.dn.store.setState("media_secret", "MEDIA-SECRET-VALUE-xyz");
  b.dn.store.setState("pack_secret", "PACK-SECRET-VALUE-xyz");
  b.dn.store.setState("folder_uses", "{}");
  const plain = await unzipTo((await b.call("GET", "/api/backup", b.auth)).body);
  const keys = stateKeys(plain.db);
  assert.ok(!keys.includes("media_secret") && !keys.includes("pack_secret"), keys.join());
  assert.ok(keys.includes("folder_uses"), "other state stays");
  const bytes = readFileSync(plain.db);
  assert.ok(!bytes.includes("MEDIA-SECRET-VALUE") && !bytes.includes("PACK-SECRET-VALUE"), "the values must not linger in the file");
  const full = await unzipTo((await b.call("GET", "/api/backup?secrets=1", { ...b.auth, "x-driftnet-confirm": PASSWORD })).body);
  assert.ok(stateKeys(full.db).includes("media_secret") && stateKeys(full.db).includes("pack_secret"));
  // the same holds for the file-level snapshot used by the CLI
  const dest = join(mkdtempSync(join(tmpdir(), "driftnet-snap-")), "s.db");
  await snapshotTo(b.db, dest, false);
  assert.ok(!stateKeys(dest).includes("media_secret"));
});

test("backup: the snapshot and the integrity check run in a worker, so the event loop keeps ticking", async () => {
  const b = await boot();
  let ticks = 0;
  const t = setInterval(() => ticks++, 1);
  const built = await buildBackup({ dbPath: b.db, envFile: join(b.home, ".env"), version: "9.9.9", secrets: false });
  const snap = join(mkdtempSync(join(tmpdir(), "driftnet-w-")), "x.db");
  await snapshotTo(b.db, snap, true);
  assert.equal((await inspectDb(snap)).items, 3);
  clearInterval(t);
  built.cleanup();
  assert.ok(ticks > 0, "timers ran while the work was going on");
  writeFileSync(snap, "SQLite format 3\0" + "x".repeat(4096));
  await assert.rejects(inspectDb(snap), /damaged|could not be read/);
});

test("restore check: a backup missing one of our tables or columns is refused; extra columns are fine", async () => {
  const b = await boot();
  const make = (sql: string) => {
    const f = join(mkdtempSync(join(tmpdir(), "driftnet-struct-")), "d.db");
    const src = new DatabaseSync(b.db, { readOnly: true });
    src.exec(`VACUUM INTO '${f}'`);
    src.close();
    const d = new DatabaseSync(f);
    d.exec(sql);
    d.close();
    return f;
  };
  assert.equal((await inspectDb(make("ALTER TABLE items ADD COLUMN extra_col TEXT"))).items, 3);
  await assert.rejects(inspectDb(make("DROP TABLE shares")), /table shares is missing/);
  await assert.rejects(inspectDb(make("ALTER TABLE items DROP COLUMN note")), /items\.note is missing/);
  await assert.rejects(inspectDb(make("ALTER TABLE agent_tokens DROP COLUMN revoked_at")), /agent_tokens\.revoked_at is missing/);
});

test("settingsForBackup: a value that carries a credential is dropped whatever the key", () => {
  const f = join(mkdtempSync(join(tmpdir(), "driftnet-env2-")), ".env");
  writeFileSync(f, [
    "DRIFTNET_PUBLIC_URL=https://me.example",
    "DRIFTNET_LLM_BASE_URL=https://user:pw123@llm.example/v1",
    "DRIFTNET_EMBED_BASE_URL=https://emb.example/v1?api_key=zzz",
    "DRIFTNET_PLUGINS=https://x.example/p.js?token=abc",
    "DRIFTNET_LANGUAGE=English",
  ].join("\n") + "\n");
  const text = settingsForBackup(f, false);
  assert.match(text, /DRIFTNET_PUBLIC_URL=https:\/\/me\.example/);
  assert.match(text, /DRIFTNET_LANGUAGE=English/);
  assert.ok(!/pw123|zzz|abc/.test(text), text);
});

test("pending restore: any failure sets the file aside and starts on; leftovers keep only the newest two", async () => {
  const b = await boot();
  const g = await genuine(b);
  const home = mkdtempSync(join(tmpdir(), "driftnet-pend-"));
  const db = join(home, "driftnet.db");
  writeFileSync(db, g.db);
  for (let i = 1; i <= 4; i++) {
    for (const kind of ["before-restore", "restore-rejected"]) {
      const f = `${db}.${kind}-2026-01-0${i}T00-00-00-000Z`;
      writeFileSync(f, "x");
      utimesSync(f, new Date(2026, 0, i), new Date(2026, 0, i));
    }
  }
  const logs: string[] = [];
  writeFileSync(pendingPath(db), "SQLite format 3\0" + "bad".repeat(2000));
  assert.equal(await applyPendingRestore(db, (m) => logs.push(m)), null);
  assert.match(logs.join(" "), /WARNING.*not applied/);
  assert.ok(!existsSync(pendingPath(db)));
  assert.equal((new DatabaseSync(db, { readOnly: true }).prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 3, "the current database is untouched");
  const left = readdirSync(home);
  assert.equal(left.filter((n) => n.includes(".before-restore-")).length, 2);
  assert.equal(left.filter((n) => n.includes(".restore-rejected-")).length, 2);
  assert.ok(left.includes("driftnet.db.before-restore-2026-01-04T00-00-00-000Z") && !left.includes("driftnet.db.before-restore-2026-01-01T00-00-00-000Z"));
  // a valid staged file but a swap that throws half-way (the live path is a folder): set aside, no exception, no exit
  const odd = join(mkdtempSync(join(tmpdir(), "driftnet-pend2-")), "driftnet.db");
  mkdirSync(odd);
  writeFileSync(pendingPath(odd), g.db);
  const logs2: string[] = [];
  assert.equal(await applyPendingRestore(odd, (m) => logs2.push(m)), null);
  assert.match(logs2.join(" "), /WARNING/);
  assert.ok(!existsSync(pendingPath(odd)) && readdirSync(dirname(odd)).some((n) => n.includes(".restore-rejected-")));
});

test("restore route: a work-folder failure does not leave the restore lock set", async () => {
  const b = await boot();
  const file = join(b.home, "not-a-folder");
  writeFileSync(file, "x");
  const bad = await boot();
  // point this app at a database path below a regular file: the work folder cannot be created
  bad.env.DRIFTNET_DB = join(file, "sub", "driftnet.db");
  const status = async () => (await bad.call("POST", "/api/backup/restore", { ...bad.auth, ...zipHeaders() }, Buffer.from("zip"))).status;
  const first = await status();
  assert.ok(first >= 400 && first !== 409, `first: ${first}`);
  assert.notEqual(await status(), 409, "the lock must have been released");
});
