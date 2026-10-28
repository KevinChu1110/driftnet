import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "@driftnet/core";
import { BULK_LIMIT, bulkAction, bulkUndo } from "../src/bulk.ts";

const j = { isAiTool: 1, category: "news", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
function seed() {
  const store = new Store(":memory:");
  store.seedFolders({ news: "AI news", coding: "Coding agents" });
  const ids = [1, 2, 3].map((i) => store.upsert({ url: `https://bulk.test/${i}`, aliases: [], title: `t${i}`, judgement: j, summary: null, flags: [], source: "s" }).id);
  return { store, ids };
}
type Reply = { status: number; body: { ok?: boolean; error?: string; previous?: unknown[] } };

test("bulk move, then undo, puts every card back exactly", () => {
  const { store, ids } = seed();
  const r = bulkAction(store, { action: "move", ids, folder: "coding" }) as Reply;
  assert.equal(r.status, 200);
  assert.equal(store.list({ category: "coding" }).length, 3);
  assert.deepEqual(r.body.previous, ids.map((id) => ({ id, folder: "news", user_placed: 0 })));
  assert.equal(bulkUndo(store, { previous: r.body.previous }).status, 200);
  assert.deepEqual(ids.map((id) => store.get(id)!.category), ["news", "news", "news"]);
});

test("bulk trash, restore and star share one endpoint and undo through the previous state", () => {
  const { store, ids } = seed();
  const t = bulkAction(store, { action: "trash", ids, folder: "ignored" }) as Reply;
  assert.equal(store.list({ view: "trash" }).length, 3);
  bulkUndo(store, { previous: t.body.previous });
  assert.equal(store.list({ view: "trash" }).length, 0);
  assert.equal(bulkAction(store, { action: "favorite", ids: [ids[0], ids[0], ids[1]] }).status, 200);
  assert.equal(store.list({ view: "favorites" }).length, 2);
  assert.equal(bulkAction(store, { action: "unfavorite", ids }).status, 200);
  assert.equal(store.list({ view: "favorites" }).length, 0);
});

test("bulk requests are capped, validated, and unknown folders or ids are 404 with nothing changed", () => {
  const { store, ids } = seed();
  const many = Array.from({ length: BULK_LIMIT + 1 }, (_, i) => i + 1);
  assert.equal(bulkAction(store, { action: "trash", ids: many }).status, 400);
  assert.equal(bulkAction(store, { action: "trash", ids: [] }).status, 400);
  assert.equal(bulkAction(store, { action: "nuke", ids }).status, 400);
  assert.equal(bulkAction(store, { action: "move", ids }).status, 400, "move needs a folder");
  assert.equal(bulkAction(store, { action: "move", ids, folder: "nope" }).status, 404);
  assert.equal(bulkAction(store, { action: "move", ids: [...ids, 9999], folder: "coding" }).status, 404);
  assert.equal(store.list({ category: "coding" }).length, 0);
  assert.equal(bulkAction(store, { action: "trash", ids: Array.from({ length: BULK_LIMIT }, (_, i) => ids[i % 3]!) }).status, 200, "exactly the cap is fine");
  assert.equal(bulkUndo(store, { previous: [] }).status, 400);
});
