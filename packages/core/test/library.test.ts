import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";

const j = { isAiTool: 1, category: "news", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
function seed() {
  const store = new Store(":memory:");
  const ids = ["a", "b", "c"].map(
    (x) => store.upsert({ url: `https://lib.test/${x}`, aliases: [], title: x, judgement: j, summary: null, flags: [], source: "s" }).id,
  );
  return { store, ids };
}

test("trash hides an item everywhere and restore brings it back", () => {
  const { store, ids } = seed();
  assert.equal(store.pendingCount(), 3);
  assert.ok(store.setTrashed(ids[0]!, true));
  assert.deepEqual(store.list().map((i) => i.title).sort(), ["b", "c"]);
  assert.deepEqual(store.list({ view: "trash" }).map((i) => i.title), ["a"]);
  assert.ok(store.get(ids[0]!)!.trashedAt);
  assert.equal(store.pendingCount(), 2, "agents don't get trashed items");
  assert.deepEqual([store.stats().items, store.stats().trash, store.stats().byCategory.news], [2, 1, 2]);
  assert.ok(store.setTrashed(ids[0]!, false));
  assert.equal(store.list().length, 3);
  assert.equal(store.get(ids[0]!)!.trashedAt, undefined);
  assert.equal(store.setTrashed(999, true), false);
});

test("favorites are their own view, and a trashed favorite is only in the trash", () => {
  const { store, ids } = seed();
  store.setFavorite(ids[1]!, true);
  assert.deepEqual(store.list({ view: "favorites" }).map((i) => i.title), ["b"]);
  assert.equal(store.get(ids[1]!)!.favorite, true);
  assert.equal(store.stats().favorites, 1);
  store.setTrashed(ids[1]!, true);
  assert.equal(store.list({ view: "favorites" }).length, 0);
  assert.equal(store.stats().favorites, 0);
});

test("sharing a trashed link again brings it back", () => {
  const { store, ids } = seed();
  store.setTrashed(ids[2]!, true);
  store.recordShare(ids[2]!, { platform: "discord", chatId: "c" });
  assert.equal(store.get(ids[2]!)!.trashedAt, undefined);
  assert.equal(store.get(ids[2]!)!.shareCount, 1);
});
