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
  const folders = JSON.parse(text(await client.callTool({ name: "driftnet_list_folders", arguments: {} })));
  assert.equal(folders.find((f: { id: string }) => f.id === "games").folder, "Games — Game helpers");
  const moved = await client.callTool({ name: "driftnet_move_item", arguments: { id: item.id, folder: "games" } });
  assert.match(text(moved), /Moved/);
  assert.equal(dn.store.get(item.id)!.category, "games");
  const bad = await client.callTool({ name: "driftnet_move_item", arguments: { id: item.id, folder: "nope" } });
  assert.equal(bad.isError, true);
  assert.equal((await client.callTool({ name: "driftnet_move_item", arguments: { id: 999, folder: "games" } })).isError, true);
  // Several at once, all or nothing; exactly one of id / ids.
  const second = dn.store.upsert({ url: "https://mcp.test/b", aliases: [], title: "b", judgement, summary: null, flags: [], source: "s" });
  const many = await client.callTool({ name: "driftnet_move_item", arguments: { ids: [item.id, second.id], folder: "other" } });
  assert.match(text(many), /Moved 2 items/);
  assert.equal(dn.store.get(second.id)!.category, "other");
  // The batch can be reverted with the id it returned, once.
  const undo = (many.structuredContent as { undo: string }).undo;
  assert.match(text(many), new RegExp(undo));
  assert.equal((await client.callTool({ name: "driftnet_undo", arguments: { undo } })).isError, undefined);
  assert.deepEqual([dn.store.get(item.id)!.category, dn.store.get(second.id)!.category], ["games", "other"]);
  assert.equal((await client.callTool({ name: "driftnet_undo", arguments: { undo } })).isError, true);
  await client.callTool({ name: "driftnet_move_item", arguments: { ids: [item.id, second.id], folder: "other" } });
  const listed = JSON.parse(text(await client.callTool({ name: "driftnet_list_folders", arguments: {} })));
  assert.equal(listed.find((f: { id: string }) => f.id === "other").uses, 2);
  assert.equal((await client.callTool({ name: "driftnet_move_item", arguments: { ids: [item.id, 999], folder: "games" } })).isError, true);
  assert.equal(dn.store.get(item.id)!.category, "other", "a bad id moves nothing");
  assert.equal((await client.callTool({ name: "driftnet_move_item", arguments: { folder: "games" } })).isError, true);
  assert.equal((await client.callTool({ name: "driftnet_move_item", arguments: { id: item.id, ids: [item.id], folder: "games" } })).isError, true);
  await client.close();
});

test("every tool explains itself: descriptions, a description on every parameter, annotations", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 19);
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
  const got = await client.callTool({ name: "driftnet_get_item", arguments: { id: item.id } });
  assert.match((got.content as { text: string }[])[0]!.text, /"shared_with"/);
  assert.equal((await client.callTool({ name: "driftnet_get_item", arguments: { id: 9999 } })).isError, true);
  await client.close();
});

test("with only the share key, an agent gets the reading tools", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(dn, "reader", { readOnly: true }).connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["driftnet_get_item", "driftnet_list_folders", "driftnet_list_recent", "driftnet_search"]);
  for (const t of (await client.listTools()).tools) assert.equal(t.annotations?.readOnlyHint, true);
  await client.close();
});

test("items carry a link to their card when the server has a public address", async () => {
  process.env.DRIFTNET_PUBLIC_URL = "https://dn.example/";
  try {
    const client = await connect();
    const r = await client.callTool({ name: "driftnet_search", arguments: { min_worth: "skip" } });
    const items = (r.structuredContent as { items: { id: number; page_url: string | null }[] }).items;
    assert.ok(items.length);
    for (const i of items) assert.equal(i.page_url, `https://dn.example/#item-${i.id}`);
    await client.close();
  } finally {
    delete process.env.DRIFTNET_PUBLIC_URL;
  }
});

test("agents can trash and restore, star, note, rename and delete folders", async () => {
  const client = await connect();
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const extra = dn.store.upsert({ url: "https://mcp.test/b", aliases: [], title: "b", judgement, summary: null, flags: [], source: "s" });
  assert.match(text(await call("driftnet_trash_item", { id: extra.id })), /trash/);
  assert.ok(dn.store.get(extra.id)!.trashedAt);
  assert.equal((await call("driftnet_trash_item", { id: extra.id })).isError, true, "already in the trash");
  await call("driftnet_restore_item", { id: extra.id });
  assert.equal(dn.store.get(extra.id)!.trashedAt, undefined);
  await call("driftnet_favorite_item", { id: extra.id, favorite: true });
  assert.equal(dn.store.get(extra.id)!.favorite, true);
  await call("driftnet_set_note", { id: extra.id, note: "needs Docker" });
  assert.equal(dn.store.get(extra.id)!.note, "needs Docker");
  const made = JSON.parse(text(await call("driftnet_create_folder", { name: "Tmp" })));
  const upd = JSON.parse(text(await call("driftnet_update_folder", { id: made.id, name: "Later", description: "Read when free" })));
  assert.match(upd.folder, /^Later — Read when free/);
  await call("driftnet_move_item", { id: extra.id, folder: made.id });
  assert.match(text(await call("driftnet_delete_folder", { id: made.id })), /moved up/);
  assert.equal(dn.store.get(extra.id)!.category, "other", "the item moved up, nothing lost");
  assert.equal((await call("driftnet_delete_folder", { id: "other" })).isError, true);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find((t) => t.name === "driftnet_delete_folder")!.annotations!.destructiveHint, true, "the one destructive tool says so");
  await client.close();
});

test("the inbox filter and suggested folders show up for agents; suggest_folders is read-only and needs a model", async () => {
  const client = await connect();
  const a = dn.store.upsert({ url: "https://mcp.test/inbox", aliases: [], title: "maple tool", judgement, summary: null, flags: [], source: "s", suggestions: [{ folder: "other", score: 0.5 }] });
  const res = await client.callTool({ name: "driftnet_search", arguments: { inbox: true, min_worth: "skip" } });
  const items = (res.structuredContent as { items: { id: number; in_inbox: boolean; suggested_folders: { folder: string }[] }[] }).items;
  assert.ok(items.some((i) => i.id === a.id && i.in_inbox && i.suggested_folders[0]!.folder === "other"));
  dn.store.moveItem(a.id, "other");
  const after = (await client.callTool({ name: "driftnet_search", arguments: { inbox: true, min_worth: "skip" } })).structuredContent as { items: { id: number }[] };
  assert.ok(!after.items.some((i) => i.id === a.id));
  const tool = (await client.listTools()).tools.find((t) => t.name === "driftnet_suggest_folders")!;
  assert.equal(tool.annotations!.readOnlyHint, true);
  const r = await client.callTool({ name: "driftnet_suggest_folders", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /AI model/);
  await client.close();
});
