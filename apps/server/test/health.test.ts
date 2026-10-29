import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDriftnet } from "@driftnet/core";
import { createApp } from "../src/app.ts";
import { createMcpServer } from "../src/mcp.ts";

const PASSWORD = "health-test-password-1A!";
const env: NodeJS.ProcessEnv = { DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-health-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en", DRIFTNET_TOKEN: PASSWORD, DRIFTNET_READ_KEY: "health-read-key-0123456789" };
const dn = createDriftnet(env);
const j = { isAiTool: 1, category: "other", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
const add = (url: string) => dn.store.upsert({ url, aliases: [], title: url, judgement: j, summary: null, flags: [], source: "s" });
const dead = add("https://health.test/dead"), fine = add("https://health.test/fine"), stale = add("https://health.test/stale");
dn.store.setHealth(dead.id, { health: "dead", stars: 7 });
dn.store.setHealth(fine.id, { health: "ok" });
dn.store.setHealth(stale.id, { health: "stale" });

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
async function start() {
  const server = createApp({ dn, env, port: 0 });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  // x-forwarded-for makes the request look remote (this machine alone would count as trusted); one address per call keeps the password throttle quiet.
  let n = 0;
  return (method: string, path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { "x-forwarded-for": `203.0.113.${(++n % 250) + 1}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok({ status: res.statusCode!, body: b }));
    });
    r.on("error", fail); r.end();
  });
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

test("the item list returns health and stars and filters by health", async () => {
  const call = await start();
  const auth = { authorization: `Bearer ${PASSWORD}` };
  const all = JSON.parse((await call("GET", "/api/items?minWorth=skip", auth)).body) as { id: number; health: string | null; stars: number | null }[];
  assert.equal(all.find((i) => i.id === dead.id)!.health, "dead");
  assert.equal(all.find((i) => i.id === dead.id)!.stars, 7);
  const marked = JSON.parse((await call("GET", "/api/items?health=dead,archived,stale", auth)).body) as { id: number }[];
  assert.deepEqual(marked.map((i) => i.id).sort(), [dead.id, stale.id].sort());
  assert.deepEqual(JSON.parse((await call("GET", "/api/items?health=bogus", auth)).body).length >= 3, true, "an unknown value is ignored");
  assert.equal(JSON.parse((await call("GET", "/api/stats", auth)).body).review, 2);
});

test("checking one item by hand needs the write password", async () => {
  const call = await start();
  assert.equal((await call("POST", `/api/items/${dead.id}/health`)).status, 401);
  assert.equal((await call("POST", `/api/items/${dead.id}/health`, { authorization: "Bearer health-read-key-0123456789" })).status, 401);
  assert.equal((await call("POST", "/api/items/99999/health", { authorization: `Bearer ${PASSWORD}` })).status, 404);
});

test("the manual check marks a local address as unfetched and stores a check time", async () => {
  const call = await start();
  const local = add("http://127.0.0.1:9/nothing");
  const res = await call("POST", `/api/items/${local.id}/health`, { authorization: `Bearer ${PASSWORD}` });
  assert.equal(res.status, 200);
  const out = JSON.parse(res.body) as { health: string | null; healthCheckedAt: string | null };
  assert.equal(out.health, null, "never fetched, so nothing learned");
  assert.ok(out.healthCheckedAt);
});

test("MCP: rows carry health and stars, view needs_review lists the marked ones, still 14 tools", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(dn, "test").connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  assert.equal((await client.listTools()).tools.length, 14);
  const review = await client.callTool({ name: "driftnet_search_items", arguments: { view: "needs_review", min_worth: "skip" } });
  const items = (review.structuredContent as { items: { id: number; health: string | null; stars: number | null }[] }).items;
  assert.deepEqual(items.map((i) => i.id).sort(), [dead.id, stale.id].sort());
  assert.deepEqual(items.find((i) => i.id === dead.id), { ...items.find((i) => i.id === dead.id)!, health: "dead", stars: 7 });
  const plain = await client.callTool({ name: "driftnet_search_items", arguments: { query: "fine", min_worth: "skip" } });
  assert.equal((plain.structuredContent as { items: { health: string }[] }).items[0]!.health, "ok");
  assert.match(text(await client.callTool({ name: "driftnet_get_item", arguments: { id: dead.id } })), /"health": ?"dead"/);
});
