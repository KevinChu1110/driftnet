import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createDriftnet } from "@driftnet/core";
import { createApp } from "../src/app.ts";

const PASSWORD = "history-test-password-1A!";
const READ_KEY = "history-test-read-key";
const env: NodeJS.ProcessEnv = { DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-hist-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en", DRIFTNET_TOKEN: PASSWORD, DRIFTNET_READ_KEY: READ_KEY, DRIFTNET_ACCESS: "private" };
const dn = createDriftnet(env);
const server: Server = createApp({ dn, env, port: 0 });
after(() => server.close());
const judgement = { isAiTool: 1, category: "other", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
const item = dn.store.upsert({ url: "https://hist.test/a", aliases: [], title: "a", judgement, summary: null, flags: [], source: "s" });
let n = 0;
async function call(method: string, path: string, key?: string, body?: unknown) {
  await new Promise<void>((ok) => (server.listening ? ok() : server.listen(0, "127.0.0.1", ok)));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "x-forwarded-for": `198.51.100.${(++n % 250) + 1}`, ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

test("history: the read key can list it, only the password can restore, and restoring is recorded", async () => {
  assert.equal((await call("PUT", `/api/items/${item.id}/note`, PASSWORD, { note: "first" })).status, 200);
  assert.equal((await call("PUT", `/api/items/${item.id}/note`, PASSWORD, { note: "second" })).status, 200);
  assert.equal((await call("GET", `/api/items/${item.id}/history`)).status, 401, "private catalogue: no key, no history");
  const list = await call("GET", `/api/items/${item.id}/history`, READ_KEY);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 2);
  assert.deepEqual(Object.keys(list.body[0]).sort(), ["actor", "at", "before", "fields", "v"]);
  assert.deepEqual(list.body[0].fields, ["note"]);
  assert.equal(list.body[0].before.note, "first");
  assert.equal(list.body[0].actor, "admin");
  const v = list.body[0].v;
  assert.equal((await call("GET", "/api/items/9999/history", READ_KEY)).status, 404);
  assert.equal((await call("POST", `/api/items/${item.id}/history/${v}/restore`, READ_KEY)).status, 401, "the read key cannot restore");
  assert.equal((await call("POST", `/api/items/${item.id}/history/${v}/restore`)).status, 401);
  const done = await call("POST", `/api/items/${item.id}/history/${v}/restore`, PASSWORD);
  assert.equal(done.status, 200);
  assert.equal(done.body.note, "first");
  const after = await call("GET", `/api/items/${item.id}/history`, READ_KEY);
  assert.equal(after.body[0].before.note, "second", "the restore is itself a version, so it can be undone");
  assert.equal((await call("POST", `/api/items/${item.id}/history/99999/restore`, PASSWORD)).status, 404);
});

test("history: a trashed card refuses a restore that would not bring it back", async () => {
  const it = dn.store.upsert({ url: "https://hist.test/b", aliases: [], title: "b", judgement, summary: null, flags: [], source: "s" });
  await call("PUT", `/api/items/${it.id}/note`, PASSWORD, { note: "x" });
  const noteV = (await call("GET", `/api/items/${it.id}/history`, PASSWORD)).body[0].v;
  await call("POST", `/api/items/${it.id}/trash`, PASSWORD);
  assert.equal((await call("POST", `/api/items/${it.id}/history/${noteV}/restore`, PASSWORD)).status, 409);
  const trashV = (await call("GET", `/api/items/${it.id}/history`, PASSWORD)).body[0].v;
  assert.equal((await call("POST", `/api/items/${it.id}/history/${trashV}/restore`, PASSWORD)).status, 200);
});
