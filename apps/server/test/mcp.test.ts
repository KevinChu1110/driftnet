import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDriftnet } from "@driftnet/core";
import { createMcpServer } from "../src/mcp.ts";

const dn = createDriftnet({ DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-mcp-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en" });
const judgement = { isAiTool: 1, category: "other", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
const item = dn.store.upsert({ url: "https://mcp.test/a", aliases: [], title: "a", judgement, summary: null, flags: [], source: "s" });

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(dn, "test").connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

test("agents can read the folder tree, add a folder and file an item into it", async () => {
  const client = await connect();
  const made = JSON.parse(text(await client.callTool({ name: "driftnet_create_folder", arguments: { name: "Games", description: "Game helpers" } })));
  assert.equal(made.id, "games");
  const folders = JSON.parse(text(await client.callTool({ name: "driftnet_folders", arguments: {} })));
  assert.equal(folders.find((f: { id: string }) => f.id === "games").folder, "Games — Game helpers");
  const moved = await client.callTool({ name: "driftnet_move", arguments: { id: item.id, folder: "games" } });
  assert.match(text(moved), /Moved/);
  assert.equal(dn.store.get(item.id)!.category, "games");
  const bad = await client.callTool({ name: "driftnet_move", arguments: { id: item.id, folder: "nope" } });
  assert.equal(bad.isError, true);
  assert.equal((await client.callTool({ name: "driftnet_move", arguments: { id: 999, folder: "games" } })).isError, true);
  await client.close();
});

test("every tool explains itself: descriptions, a description on every parameter, annotations", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 10);
  for (const t of tools) {
    assert.ok((t.description ?? "").length > 150, `${t.name}: description too thin`);
    assert.ok(t.annotations && t.annotations.readOnlyHint !== undefined && t.annotations.destructiveHint !== undefined, `${t.name}: annotations`);
    for (const [name, prop] of Object.entries((t.inputSchema.properties ?? {}) as Record<string, { description?: string }>)) {
      assert.ok(prop.description, `${t.name}.${name} has no description`);
    }
  }
  // Read tools answer with structured content that matches their output schema.
  const search = await client.callTool({ name: "driftnet_search", arguments: { min_worth: "skip" } });
  assert.ok(Array.isArray((search.structuredContent as { items: unknown[] }).items));
  const got = await client.callTool({ name: "driftnet_get", arguments: { id: item.id } });
  assert.match((got.content as { text: string }[])[0]!.text, /"shared_with"/);
  assert.equal((await client.callTool({ name: "driftnet_get", arguments: { id: 9999 } })).isError, true);
  await client.close();
});

test("with only the share key, an agent gets the reading tools", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(dn, "reader", { readOnly: true }).connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["driftnet_folders", "driftnet_get", "driftnet_recent", "driftnet_search"]);
  for (const t of (await client.listTools()).tools) assert.equal(t.annotations?.readOnlyHint, true);
  await client.close();
});
