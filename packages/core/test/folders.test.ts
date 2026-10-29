import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { FolderError, ItemError, Store } from "../src/store.ts";

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
  // The recovery runs once per database: a database from before it existed has no marker yet.
  assert.deepEqual(new Store(file).foundLinks(), [], "already recovered once: not repeated");
  // Simulate a pre-versioning database: no marker, schema version unstamped (the catch-up runs when it is stamped).
  old.setState("found_in_recovered", "0");
  const raw = new DatabaseSync(file);
  raw.exec("DROP TABLE item_fts; PRAGMA user_version = 0");
  raw.close();
  assert.deepEqual(new Store(file).foundLinks(), [{ parent: p, child: c }]);
});

test("two folders with the same name side by side are refused", () => {
  const { store } = seed();
  store.createFolder({ name: "Games" });
  assert.throws(() => store.createFolder({ name: "games" }), FolderError);
  const g = store.folders().find((f) => f.name === "Games")!;
  assert.doesNotThrow(() => store.createFolder({ name: "Games", parent: g.id }), "the same name one level down is fine");
});

function seedMany(n = 3) {
  const { store, id } = seed();
  const ids = [id];
  for (let i = 1; i < n; i++) ids.push(store.upsert({ url: `https://lib.test/${i}`, aliases: [], title: `t${i}`, judgement: j, summary: null, flags: [], source: "s" }).id);
  return { store, ids };
}

test("bulk move is one transaction: user_placed is set, the earlier state comes back, a bad id changes nothing", () => {
  const { store, ids } = seedMany();
  store.moveItem(ids[2]!, "other"); // already placed by the reader
  const before = store.moveItems(ids, "coding");
  assert.deepEqual(before.map((b) => [b.id, b.category, b.user_placed]), [[ids[0], "news", 0], [ids[1], "news", 0], [ids[2], "other", 1]]);
  for (const id of ids) assert.equal(store.get(id)!.category, "coding");
  assert.equal(store.list({ category: "coding" }).length, 3);
  assert.throws(() => store.moveItems([ids[0]!, 9999], "news"), ItemError);
  assert.equal(store.get(ids[0]!)!.category, "coding", "rolled back");
  assert.throws(() => store.moveItems(ids, "nope"), FolderError);
  store.restoreItems(before.map((b) => ({ id: b.id, category: b.category, user_placed: b.user_placed })));
  assert.deepEqual(ids.map((id) => store.get(id)!.category), ["news", "news", "other"]);
});

test("bulk trash and star report what undo needs and are all-or-nothing", () => {
  const { store, ids } = seedMany();
  store.setTrashed(ids[1]!, true);
  const trashedBefore = store.get(ids[1]!)!.trashedAt;
  const prev = store.setTrashedMany(ids, true);
  assert.deepEqual(prev.map((p) => p.trashed_at === null), [true, false, true]);
  assert.equal(store.list({ view: "trash" }).length, 3);
  assert.throws(() => store.setTrashedMany([ids[0]!, 9999], false), ItemError);
  assert.equal(store.list({ view: "trash" }).length, 3, "rolled back");
  store.restoreItems(prev);
  assert.equal(store.list({ view: "trash" }).length, 1);
  assert.equal(store.get(ids[1]!)!.trashedAt, trashedBefore);
  store.setFavorite(ids[0]!, true);
  const stars = store.setFavoriteMany(ids, true);
  assert.deepEqual(stars.map((s) => s.favorite), [1, 0, 0]);
  assert.equal(store.list({ view: "favorites" }).length, 2, "the trashed one is not listed");
  assert.throws(() => store.setFavoriteMany([9999], true), ItemError);
  store.restoreItems(stars);
  assert.equal(store.list({ view: "favorites" }).length, 1);
});

test("folder use counts: moves bump, undo and delete take them back, top folders break ties by tree order", () => {
  const { store, id } = seed();
  const b = store.upsert({ url: "https://lib.test/b", aliases: [], title: "b", judgement: j, summary: null, flags: [], source: "s" }).id;
  assert.deepEqual(store.topFolders(), [], "nothing used yet");
  store.moveItem(id, "coding");
  store.moveItem(b, "news");
  assert.deepEqual(store.topFolders().map((f) => f.id), ["news", "coding"], "a tie goes to tree order");
  const before = store.moveItems([id, b], "coding");
  assert.deepEqual(store.topFolders().map((f) => [f.id, f.uses]), [["coding", 3], ["news", 1]]);
  store.restoreItems(before.map(({ id, category, user_placed }) => ({ id, category, user_placed })));
  assert.equal(store.folders().find((f) => f.id === "coding")!.uses, 1);
  store.bumpFolderUse("news", -50);
  assert.equal(store.folders().find((f) => f.id === "news")!.uses, 0, "floors at 0");
  assert.deepEqual(store.topFolders(1).map((f) => f.id), ["coding"]);
  store.deleteFolder("coding");
  assert.deepEqual(store.topFolders(), []);
});
