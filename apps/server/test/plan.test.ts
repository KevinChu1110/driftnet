import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDriftnet, type Driftnet, type LlmProvider } from "@driftnet/core";
import { bulkUndo } from "../src/bulk.ts";
import { applySuggested, suggestFolders } from "../src/plan.ts";

const j = { isAiTool: 1, category: "news", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
const op = (o: object) => ({ reason: "r", ref: "", name: "", description: "", parent: "", folder: "", cards: [], from: "", into: "", ...o });

function setup(withModel: boolean) {
  const dn = createDriftnet({ DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-plan-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en" }) as Driftnet;
  const ids = [1, 2, 3].map((i) => dn.store.upsert({ url: `https://plan.test/${i}`, aliases: [], title: `maple ${i}`, judgement: { ...j, category: "other" }, summary: null, flags: [], source: "s" }).id);
  let seen = "";
  if (withModel) {
    const llm: LlmProvider = { label: "fake", complete: async (req) => { seen = req.user; return { operations: [
      op({ op: "create", ref: "maple", name: "MapleStory", description: "Maple helpers" }),
      op({ op: "move", folder: "new:maple", cards: ids.slice(0, 2) }),
    ] } as any; } };
    Object.defineProperty(dn, "llm", { get: () => llm });
  }
  return { dn, ids, seen: () => seen };
}
type Body = { plan?: string; operations?: { id: string }[]; undo?: string; error?: string; applied?: string[]; ok?: boolean };

test("no model: the endpoint answers 409 with a clear message and changes nothing", async () => {
  const { dn } = setup(false);
  const r = await suggestFolders(dn, "English");
  assert.equal(r.status, 409);
  assert.match((r.body as Body).error!, /AI model/);
});

test("propose sends names and tags only, apply runs the ticked operations, undo reverts the whole plan", async () => {
  const { dn, ids, seen } = setup(true);
  const before = dn.store.folders().map((f) => f.id).sort();
  const r = await suggestFolders(dn, "English");
  const body = r.body as Body;
  assert.equal(r.status, 200);
  assert.equal(body.operations!.length, 2);
  assert.match(seen(), /maple 1/);
  assert.deepEqual(dn.store.folders().map((f) => f.id).sort(), before, "proposing changes nothing");

  assert.equal(applySuggested(dn, { plan: "nope", accept: ["1"] }).status, 404);
  assert.equal(applySuggested(dn, { plan: body.plan, accept: [] }).status, 409, "nothing ticked");
  const a = applySuggested(dn, { plan: body.plan, accept: body.operations!.map((o) => o.id) });
  assert.equal(a.status, 200);
  const done = a.body as Body;
  const maple = dn.store.folders().find((f) => f.name === "MapleStory")!;
  assert.equal(dn.store.get(ids[0]!)!.category, maple.id);
  assert.equal(dn.store.get(ids[2]!)!.category, "other");
  assert.equal(applySuggested(dn, { plan: body.plan, accept: ["1"] }).status, 404, "a plan applies once");

  assert.equal(bulkUndo(dn.store, { undo: done.undo }).status, 200);
  assert.deepEqual(dn.store.folders().map((f) => f.id).sort(), before);
  assert.deepEqual(ids.map((id) => dn.store.get(id)!.category), ["other", "other", "other"]);
  assert.equal(dn.store.get(ids[0]!)!.placed, false);
});

test("a plan that only renames still undoes", async () => {
  const { dn } = setup(true);
  Object.defineProperty(dn, "llm", { get: () => ({ label: "f", complete: async () => ({ operations: [op({ op: "rename", folder: "coding-agent", name: "Agents" })] }) as any }) });
  const body = (await suggestFolders(dn, "English")).body as Body;
  const done = applySuggested(dn, { plan: body.plan, accept: ["1"] }).body as Body;
  assert.equal(dn.store.folders().find((f) => f.id === "coding-agent")!.name, "Agents");
  assert.equal(bulkUndo(dn.store, { undo: done.undo }).status, 200);
  assert.equal(dn.store.folders().find((f) => f.id === "coding-agent")!.name, null);
});
