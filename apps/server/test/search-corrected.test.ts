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

const env: NodeJS.ProcessEnv = { DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-typo-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en", DRIFTNET_EMBED: "off" };
const dn = createDriftnet(env);
const j = { isAiTool: 1, category: "other", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
const kit = dn.store.upsert({ url: "https://t.test/1", aliases: [], title: "Figma kit", judgement: j, flags: [], source: "s",
  summary: { name: "Figma kit", oneLiner: "design system 工具", highlights: [], useCases: [], tags: [] } });

const server: Server = createApp({ dn, env, port: 0 });
after(() => server.close());
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const port = (server.address() as { port: number }).port;
const get = (path: string) => new Promise<{ body: { id: number }[]; corrected: string | undefined; total: string | undefined }>((ok, fail) => {
  request({ host: "127.0.0.1", port, path }, (res) => {
    let b = ""; res.on("data", (c) => (b += c));
    res.on("end", () => ok({ body: JSON.parse(b), corrected: res.headers["x-search-corrected"] as string | undefined, total: res.headers["x-total-count"] as string | undefined }));
  }).on("error", fail).end();
});

test("GET /api/items says which query it searched when a typo was corrected", async () => {
  const r = await get(`/api/items?q=${encodeURIComponent("desgin 工具")}`);
  assert.deepEqual(r.body.map((i) => i.id), [kit.id]);
  assert.equal(decodeURIComponent(r.corrected!), "design 工具", "URI-encoded: the header may carry CJK");
  assert.equal(r.total, "1");
  const exact = await get("/api/items?q=design");
  assert.equal(exact.corrected, undefined);
  const asTyped = await get("/api/items?q=desgin&fuzzy=0");
  assert.deepEqual([asTyped.body.length, asTyped.corrected], [0, undefined], "fuzzy=0 searches exactly what was typed");
});

test("driftnet_search_items reports the correction in text and structured output", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(dn, "test").connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const r = await client.callTool({ name: "driftnet_search_items", arguments: { query: "desgin" } });
  const sc = r.structuredContent as { corrected?: string; items: { id: number }[] };
  assert.equal(sc.corrected, "design");
  assert.deepEqual(sc.items.map((i) => i.id), [kit.id]);
  assert.match((r.content as { text: string }[])[0]!.text, /showing results for "design"/);
  const plain = await client.callTool({ name: "driftnet_search_items", arguments: { query: "figma" } });
  assert.equal((plain.structuredContent as { corrected?: string }).corrected, undefined);
  await client.close();
});
