import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPlan, proposePlan, Store, validatePlan, PLAN_MAX_OPS, type LlmProvider } from "../src/index.ts";

const j = { isAiTool: 1, category: "news", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
function seed() {
  const store = new Store(":memory:");
  store.seedFolders({ news: "AI news", coding: "Coding agents", misc: "Misc" });
  const mine = store.createFolder({ name: "Mine", description: "made by the reader" });
  const ids = [1, 2, 3, 4].map((i) => store.upsert({ url: `https://plan.test/${i}`, aliases: [], title: `maple ${i}`, judgement: j, summary: null, flags: [], source: "s" }).id);
  return { store, mine, ids };
}
const op = (o: Partial<Record<string, unknown>>) => ({ reason: "r", ref: "", name: "", description: "", parent: "", folder: "", cards: [], from: "", into: "", ...o }) as any;
const fake = (operations: object[]): LlmProvider => ({ label: "fake", complete: async () => ({ operations }) as any });

test("a plan is only proposed: creating, moving and merging happen on apply, in one go, and snapshots allow undo", async () => {
  const { store, ids } = seed();
  const llm = fake([
    op({ op: "move", folder: "new:maple", cards: ids.slice(0, 2), reason: "maple cards" }),
    op({ op: "create", ref: "maple", name: "MapleStory", description: "Maple helpers", parent: "" }),
    op({ op: "rename", folder: "misc", name: "Odds and ends" }),
    op({ op: "merge", from: "coding", into: "news" }),
  ]);
  const plan = await proposePlan(store, llm, { choices: store.folderChoices((f) => f.name ?? f.id), language: "English" });
  assert.deepEqual(plan.map((p) => p.op), ["create", "merge", "rename", "move"], "creates first so moves can point at them");
  assert.equal(store.folders().length, 5, "proposing changes nothing");
  assert.equal(store.get(ids[0]!)!.category, "news");

  const r = applyPlan(store, plan, new Set(plan.map((p) => p.id)));
  assert.equal(r.applied.length, 4);
  const maple = store.folders().find((f) => f.name === "MapleStory")!;
  assert.equal(store.get(ids[0]!)!.category, maple.id);
  assert.equal(store.folders().find((f) => f.id === "misc")!.name, "Odds and ends");
  assert.equal(store.folders().some((f) => f.id === "coding"), false);
  assert.equal(maple.builtin, false);

  store.restoreFolders(r.previousFolders);
  store.restoreItems(r.previousItems.map(({ id, folder, user_placed }) => ({ id, category: folder, user_placed })));
  assert.deepEqual(store.folders().map((f) => f.id).sort(), ["coding", "mine", "misc", "news", "other"]);
  assert.equal(store.get(ids[0]!)!.category, "news");
  assert.equal(store.get(ids[0]!)!.placed, false);
});

test("the hard rules: hand-filed cards stay, reader-made folders are never renamed or merged, bad ids are dropped", () => {
  const { store, mine, ids } = seed();
  store.moveItem(ids[0]!, "coding"); // filed by hand
  const plan = validatePlan(store, [
    op({ op: "move", folder: "misc", cards: [ids[0], ids[1]] }),
    op({ op: "rename", folder: mine.id, name: "Renamed" }),
    op({ op: "merge", from: mine.id, into: "news" }),
    op({ op: "merge", from: "coding", into: "news" }), // coding holds a hand-filed card
    op({ op: "rename", folder: "nope", name: "x" }),
    op({ op: "move", folder: "nope", cards: [ids[2]] }),
    op({ op: "move", folder: "coding", cards: [9999] }),
    op({ op: "create", ref: "x", name: "news", parent: "" }), // duplicate sibling name
    op({ op: "merge", from: "other", into: "news" }),
  ]);
  assert.deepEqual(plan.map((p) => p.op), ["move"]);
  assert.deepEqual((plan[0] as { cards: number[] }).cards, [ids[1]], "the hand-filed card is not moved");
});

test("a plan has at most 50 operations, and accepting only some leaves the rest alone", () => {
  const { store, ids } = seed();
  const many = Array.from({ length: 80 }, (_, i) => op({ op: "create", ref: `r${i}`, name: `Folder ${i}` }));
  assert.equal(validatePlan(store, many).length, PLAN_MAX_OPS);
  const plan = validatePlan(store, [
    op({ op: "create", ref: "g", name: "Games" }),
    op({ op: "move", folder: "new:g", cards: [ids[0]] }),
    op({ op: "rename", folder: "misc", name: "Other stuff" }),
  ]);
  // Rename only: the move would point at a folder nobody asked to create.
  const rename = plan.find((p) => p.op === "rename")!;
  const r = applyPlan(store, plan, new Set([rename.id, plan.find((p) => p.op === "move")!.id]));
  assert.deepEqual(r.applied, [rename.id]);
  assert.equal(r.skipped.length, 1);
  assert.equal(store.get(ids[0]!)!.category, "news");
  assert.equal(store.folders().some((f) => f.name === "Games"), false);
});

test("a card filed by hand after the plan was made is skipped at apply time", () => {
  const { store, ids } = seed();
  const plan = validatePlan(store, [op({ op: "create", ref: "g", name: "Games" }), op({ op: "move", folder: "new:g", cards: [ids[0], ids[1]] })]);
  store.moveItem(ids[0]!, "coding");
  const r = applyPlan(store, plan, new Set(plan.map((p) => p.id)));
  assert.equal(r.applied.length, 2);
  assert.equal(store.get(ids[0]!)!.category, "coding");
  assert.equal(store.get(ids[1]!)!.category, store.folders().find((f) => f.name === "Games")!.id);
});

test("built-in folders are marked, also on a database from before the marker", () => {
  const { store, mine } = seed();
  assert.equal(store.isBuiltinFolder("news"), true);
  assert.equal(store.isBuiltinFolder(mine.id), false);
});
