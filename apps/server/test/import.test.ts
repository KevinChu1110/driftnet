import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDriftnet, type IngestResult } from "@driftnet/core";
import { createApp } from "../src/app.ts";

const PASSWORD = "import-test-password-1A!";
const READ_KEY = "import-test-read-key";
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const judgement = { isAiTool: 1, category: "other", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };

async function start(gate?: Promise<void>) {
  const env: NodeJS.ProcessEnv = { DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-import-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en", DRIFTNET_TOKEN: PASSWORD, DRIFTNET_READ_KEY: READ_KEY };
  const dn = createDriftnet(env);
  const notes: string[] = [];
  // No network: ingest just stores the link (what a failed fetch also ends up doing).
  (dn.pipeline as { ingest: unknown }).ingest = async (url: string, ctx: { platform: string; chatId: string; note?: string }): Promise<IngestResult> => {
    notes.push(`${ctx.platform}/${ctx.chatId}/${ctx.note ?? ""}`);
    if (gate) await gate;
    if (url.endsWith("/bad")) throw new Error("refused");
    return { item: dn.store.upsert({ url, aliases: [], title: url, judgement, summary: null, flags: [], source: "s" }), cached: false };
  };
  const server = createApp({ dn, env, port: 0 });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  let n = 0;
  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    new Promise<{ status: number; body: any }>((ok, fail) => {
      const r = request({ host: "127.0.0.1", port, method, path, headers: { "x-forwarded-for": `203.0.113.${(++n % 250) + 1}`, ...(body ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => ok({ status: res.statusCode!, body: b ? JSON.parse(b) : null }));
      });
      r.on("error", fail);
      r.end(body ? JSON.stringify(body) : undefined);
    });
  const auth = { authorization: `Bearer ${PASSWORD}` };
  const poll = async (job: string) => {
    for (let i = 0; i < 200; i++) {
      const r = await call("GET", `/api/import/${job}`, auth);
      if (r.body.state !== "running") return r.body;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    throw new Error("import did not finish");
  };
  return { call, auth, dn, notes, poll };
}

const HTML = `<DL><DT><H3>Reading</H3><DL><DT><A HREF="https://i.example/1">One</A><DT><H3>Sub</H3><DL><DT><A HREF="https://i.example/2">Two</A></DL></DL>
<DT><A HREF="https://i.example/bad">Bad</A><DT><A HREF="http://127.0.0.1/x">Local</A></DL>`;

test("import needs the write password: no credentials, a wrong one and the read key are all refused", async () => {
  const { call } = await start();
  const body = { content: "https://x.example/1" };
  assert.equal((await call("POST", "/api/import", {}, body)).status, 401);
  assert.equal((await call("POST", "/api/import", { authorization: "Bearer nope" }, body)).status, 401);
  assert.equal((await call("POST", "/api/import", { authorization: `Bearer ${READ_KEY}` }, body)).status, 401);
  assert.equal((await call("GET", "/api/import/abcdef", { authorization: `Bearer ${READ_KEY}` })).status, 404, "reading a job needs only the read gate");
});

test("dry run counts and previews without ingesting anything", async () => {
  const { call, auth, dn, notes } = await start();
  dn.store.upsert({ url: "https://i.example/1", aliases: [], title: "have", judgement, summary: null, flags: [], source: "s" });
  const r = await call("POST", "/api/import", auth, { content: HTML, dryRun: true });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.format, r.body.total, r.body.duplicates, r.body.skipped], ["html", 2, 1, 1]);
  assert.deepEqual(r.body.preview.map((e: { url: string }) => e.url), ["https://i.example/2", "https://i.example/bad"]);
  assert.equal(notes.length, 0);
  assert.equal(dn.store.findByUrl("https://i.example/2"), null);
});

test("import runs in the background: 202, progress, failures counted, folders kept under Imported", async () => {
  const { call, auth, dn, notes, poll } = await start();
  const r = await call("POST", "/api/import", auth, { content: HTML, folders: "keep" });
  assert.equal(r.status, 202);
  assert.equal(r.body.total, 3);
  assert.equal(r.body.skipped, 1);
  const done = await poll(r.body.job);
  assert.deepEqual([done.state, done.total, done.done, done.added, done.failed], ["done", 3, 3, 2, 1]);
  assert.match(done.errors[0], /i\.example\/bad: refused/);
  assert.ok(notes.includes("import/import/One"));
  const folder = (name: string, parent: string | null) => dn.store.folders().find((f) => f.name === name && (f.parent ?? null) === parent)!;
  const imported = folder("Imported", null), reading = folder("Reading", imported.id), sub = folder("Sub", reading.id);
  assert.equal(dn.store.findByUrl("https://i.example/1")!.category, reading.id);
  const two = dn.store.findByUrl("https://i.example/2")!;
  assert.equal(two.category, sub.id);
  assert.equal(two.placed, true);
  assert.equal(dn.store.findByUrl("https://i.example/bad"), null);
  // Importing the same file again finds everything already there.
  const again = await call("POST", "/api/import", auth, { content: HTML, dryRun: true });
  assert.equal(again.body.duplicates, 2);
});

test("a second import while one runs is 409; an unknown job is 404; bad input is 400", async () => {
  let release!: () => void;
  const { call, auth, poll } = await start(new Promise<void>((ok) => (release = ok)));
  const first = await call("POST", "/api/import", auth, { content: "https://g.example/1\nhttps://g.example/2" });
  assert.equal(first.status, 202);
  assert.equal((await call("POST", "/api/import", auth, { content: "https://g.example/3" })).status, 409);
  assert.equal((await call("POST", "/api/import", auth, { content: "https://g.example/3", dryRun: true })).status, 200, "a preview is still allowed");
  assert.equal((await call("GET", `/api/import/${first.body.job}`, auth)).body.state, "running");
  release();
  assert.equal((await poll(first.body.job)).state, "done");
  assert.equal((await call("POST", "/api/import", auth, { content: "https://g.example/3" })).status, 202, "free again");
  assert.equal((await call("GET", "/api/import/ffffffff", auth)).status, 404);
  assert.equal((await call("POST", "/api/import", auth, { content: "" })).status, 400);
  assert.equal((await call("POST", "/api/import", auth, { content: "x", format: "xml" })).status, 400);
  assert.equal((await call("POST", "/api/import", auth, { content: "x", folders: "all" })).status, 400);
});

test("nothing to import is a plain answer with no job; a large body is accepted", async () => {
  const { call, auth } = await start();
  const none = await call("POST", "/api/import", auth, { content: "no links here" });
  assert.deepEqual([none.status, none.body.job, none.body.total], [200, null, 0]);
  const big = await call("POST", "/api/import", auth, { content: `${"filler ".repeat(300_000)}\nhttps://big.example/1`, dryRun: true });
  assert.equal(big.status, 200, "over the 1 MB default");
  assert.equal(big.body.total, 1);
});
