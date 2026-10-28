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
