import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDriftnet, type Embedder } from "@driftnet/core";
import { createApp } from "../src/app.ts";
import { createMcpServer } from "../src/mcp.ts";

const env: NodeJS.ProcessEnv = { DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-sem-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en" };
const dn = createDriftnet(env);
const j = { isAiTool: 1, category: "other", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
const sum = (name: string, oneLiner: string) => ({ name, oneLiner, highlights: [], useCases: [], tags: [], primaryUrl: "https://x.test", category: "other", worth: "normal" as const });
const add = (url: string, name: string, oneLiner: string) => dn.store.upsert({ url, aliases: [], title: name, judgement: j, summary: sum(name, oneLiner), flags: [], source: "s" });
const oauth = add("https://s.test/1", "OAuth kit", "oauth");
const sso = add("https://s.test/2", "SSO box", "sso auth");
add("https://s.test/3", "PDF tool", "pdf");

const axes = [["oauth", "login", "sso", "auth"], ["pdf"]];
const embedder: Embedder = {
  label: "fake", model: "fake", local: true,
  async embed(texts) {
    return texts.map((t) => {
      const v = axes.map((w) => w.reduce((n, x) => n + t.toLowerCase().split(x).length - 1, 0));
      const norm = Math.hypot(...v, 0.05);
      return Float32Array.from([...v, 0.05].map((x) => x / norm));
    });
  },
};
dn.semantic.use(embedder);
await dn.semantic.idle();

const server: Server = createApp({ dn, env, port: 0 });
after(() => server.close());
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const port = (server.address() as { port: number }).port;
const get = (path: string) => new Promise<{ body: any; total: string | undefined }>((ok, fail) => {
  request({ host: "127.0.0.1", port, path }, (res) => {
    let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok({ body: JSON.parse(b), total: res.headers["x-total-count"] as string | undefined }));
  }).on("error", fail).end();
});

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(dn, "test").connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

test("the API search finds by meaning and reports the fused total; related comes with one card", async () => {
  const r = await get("/api/items?q=login");
  assert.deepEqual(r.body.map((i: { id: number }) => i.id).sort(), [oauth.id, sso.id].sort());
  assert.equal(r.total, "2");
  const one = await get(`/api/items/${oauth.id}`);
  assert.deepEqual(one.body.related, [{ id: sso.id, name: "SSO box" }]);
});

test("MCP keeps exactly 14 tools; search matches by meaning and get_item carries related {id, name}", async () => {
  const client = await connect();
  assert.equal((await client.listTools()).tools.length, 14);
  const found = JSON.parse(text(await client.callTool({ name: "driftnet_search_items", arguments: { query: "login" } })).split("\n\n").slice(1).join("\n\n"));
  const names = (found.items ?? found).map((i: { name: string }) => i.name).sort();
  assert.deepEqual(names, ["OAuth kit", "SSO box"]);
  const got = JSON.parse(text(await client.callTool({ name: "driftnet_get_item", arguments: { id: oauth.id } })).split("\n\n").slice(1).join("\n\n"));
  assert.deepEqual(got.related, [{ id: sso.id, name: "SSO box" }]);
  assert.ok(got.related.length <= 5);
});

test("with semantic search off, MCP and the API behave as before", async () => {
  dn.semantic.use(undefined);
  const r = await get("/api/items?q=login");
  assert.deepEqual(r.body, []);
  assert.equal(r.total, "0");
  const client = await connect();
  assert.equal((await client.listTools()).tools.length, 14);
  const got = JSON.parse(text(await client.callTool({ name: "driftnet_get_item", arguments: { id: oauth.id } })).split("\n\n").slice(1).join("\n\n"));
  assert.deepEqual(got.related, []);
});
