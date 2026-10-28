import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFolderTemplate, FOLDER_TEMPLATES, loadCategories, TEMPLATE_NAMES, TemplateError } from "../src/categories.ts";
import { categoryLabel, LOCALES } from "../src/i18n.ts";
import { Store } from "../src/store.ts";

test("each template seeds its folders, keeps 'other', and has labels in every locale", () => {
  for (const name of TEMPLATE_NAMES) {
    const store = new Store(":memory:");
    store.seedFolders(loadCategories({ DRIFTNET_FOLDERS: name }));
    const ids = store.folders().map((f) => f.id);
    assert.deepEqual(ids.sort(), Object.keys(FOLDER_TEMPLATES[name]).sort(), name);
    assert.ok(ids.includes("other"));
    for (const f of store.folders()) {
      assert.ok(f.description.length > 5, `${name}/${f.id} needs a description`);
      for (const l of LOCALES) assert.notEqual(categoryLabel(f.id, l), f.id, `${name}/${f.id} label ${l}`);
    }
  }
  assert.deepEqual(Object.keys(loadCategories({})), Object.keys(FOLDER_TEMPLATES.ai), "default is ai");
  assert.deepEqual(Object.keys(loadCategories({ DRIFTNET_FOLDERS: "nonsense" })), Object.keys(FOLDER_TEMPLATES.ai));
});

test("applying a template replaces an untouched seed", () => {
  const store = new Store(":memory:");
  store.seedFolders(loadCategories({}));
  assert.equal(applyFolderTemplate(store, "everyday"), "everyday");
  assert.deepEqual(store.folders().map((f) => f.id).sort(), Object.keys(FOLDER_TEMPLATES.everyday).sort());
  applyFolderTemplate(store, "research");
  assert.ok(store.folders().some((f) => f.id === "papers"));
});

test("refused when an item exists, or a folder was created, renamed or moved", () => {
  const withItem = new Store(":memory:");
  withItem.seedFolders(loadCategories({}));
  withItem.upsert({ url: "https://e.com/1", aliases: [], title: "t", judgement: { isAiTool: 1, category: "other", kind: "other", worth: "normal", engine: "heuristic", confidence: 0 }, summary: null, flags: [], source: "e.com" });
  assert.throws(() => applyFolderTemplate(withItem, "research"), TemplateError);

  const mk = () => { const s = new Store(":memory:"); s.seedFolders(loadCategories({})); return s; };
  const created = mk(); created.createFolder({ name: "Mine" });
  assert.throws(() => applyFolderTemplate(created, "research"), TemplateError);
  const renamed = mk(); renamed.updateFolder("news", { name: "Headlines" });
  assert.throws(() => applyFolderTemplate(renamed, "research"), TemplateError);
  const moved = mk(); moved.updateFolder("news", { parent: "learning" });
  assert.throws(() => applyFolderTemplate(moved, "research"), TemplateError);
  assert.throws(() => applyFolderTemplate(mk(), "bogus"), TemplateError);
  assert.ok(created.folders().some((f) => f.name === "Mine"), "refusal changes nothing");
});
