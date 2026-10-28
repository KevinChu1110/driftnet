import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FolderError, Store } from "../src/store.ts";

const j = { isAiTool: 1, category: "news", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
const summary = { name: "x", oneLiner: "x", highlights: [], useCases: [], tags: [], primaryUrl: "https://lib.test/x", category: "coding", worth: "normal" as const };
function seed() {
  const store = new Store(":memory:");
  store.seedFolders({ news: "AI news", coding: "Coding agents" });
  const id = store.upsert({ url: "https://lib.test/a", aliases: [], title: "a", judgement: j, summary: null, flags: [], source: "s" }).id;
  return { store, id };
}

test("the seed becomes the starting tree once, with “other” always there", () => {
  const { store } = seed();
  assert.deepEqual(store.folders().map((f) => [f.id, f.parent, f.name]), [["news", null, null], ["coding", null, null], ["other", null, null]]);
  store.seedFolders({ games: "never applied" });
  assert.equal(store.folders().length, 3, "an existing tree is never re-seeded");
  assert.equal(store.folders().find((f) => f.id === "news")!.count, 1);
});

test("folders nest, describe themselves to the model, and can't loop", () => {
  const { store } = seed();
  const games = store.createFolder({ name: "Games", description: "Game tools" });
  const maple = store.createFolder({ name: "MapleStory", description: "Artale helpers", parent: games.id });
  assert.equal(maple.parent, "games");
  assert.deepEqual(store.descendants("games"), ["games", maple.id]);
  const choices = store.folderChoices((f) => f.name ?? f.id);
  assert.equal(choices[maple.id], "Games › MapleStory — Artale helpers");
  assert.equal(choices.news, "news — AI news");
  assert.throws(() => store.updateFolder("games", { parent: maple.id }), FolderError);
  assert.throws(() => store.createFolder({ name: "  " }), FolderError);
  assert.throws(() => store.createFolder({ name: "x", parent: "nope" }), FolderError);
  assert.equal(store.updateFolder(maple.id, { name: "楓之谷", parent: null }).parent, null);
  assert.match(store.createFolder({ name: "遊戲" }).id, /^f-/, "non-Latin names still get an id");
});

test("a folder shows everything below it, and deleting one moves its contents up", () => {
  const { store, id } = seed();
  const games = store.createFolder({ name: "Games" });
  const maple = store.createFolder({ name: "Maple", parent: games.id });
  assert.ok(store.moveItem(id, maple.id));
  assert.deepEqual(store.list({ category: "games" }).map((i) => i.id), [id]);
  assert.equal(store.list({ category: "news" }).length, 0);
  store.deleteFolder(maple.id);
  assert.equal(store.get(id)!.category, "games");
  store.deleteFolder("games");
  assert.equal(store.get(id)!.category, "other");
  assert.throws(() => store.deleteFolder("other"), FolderError);
  assert.throws(() => store.moveItem(id, "gone"), FolderError);
});

test("an item the reader moved keeps its place when an agent re-classifies it", () => {
  const { store, id } = seed();
  store.enrich(id, summary, "agent:a", { category: "coding" });
  assert.equal(store.get(id)!.category, "coding", "unplaced items follow the classifier");
  store.moveItem(id, "news");
  store.enrich(id, summary, "agent:b", { category: "coding" });
  assert.equal(store.get(id)!.category, "news");
});

test("found-in links are recorded once and recovered from old share notes", () => {
  const store = new Store(":memory:");
  const post = store.upsert({ url: "https://fb.test/p", aliases: [], title: "post", judgement: j, summary: null, flags: [], source: "s" }).id;
  const repo = store.upsert({ url: "https://github.com/a/b", aliases: [], title: "b", judgement: j, summary: null, flags: [], source: "s" }).id;
  store.linkFound(post, repo);
  store.linkFound(post, repo);
  store.linkFound(post, post);
  assert.deepEqual(store.foundLinks(), [{ parent: post, child: repo }]);

  // Links from before found_in existed sit in share notes; reopening the database recovers them.
  const file = join(mkdtempSync(join(tmpdir(), "driftnet-")), "db.sqlite");
  const old = new Store(file);
  const p = old.upsert({ url: "https://fb.test/p", aliases: [], title: "post", judgement: j, summary: null, flags: [], source: "s" }).id;
  const c = old.upsert({ url: "https://github.com/a/b", aliases: [], title: "b", judgement: j, summary: null, flags: [], source: "s" }).id;
  old.recordShare(c, { platform: "http", chatId: "x", note: "Mentioned in https://fb.test/p" });
  assert.deepEqual(new Store(file).foundLinks(), [{ parent: p, child: c }]);
});
