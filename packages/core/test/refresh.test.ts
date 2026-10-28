import assert from "node:assert/strict";
import { test } from "node:test";
import { Pipeline, registerExtractor, Store, Summarizer, type LlmProvider } from "../src/index.ts";
import { RefreshBusy, RefreshTooSoon } from "../src/pipeline.ts";
import { DEFAULT_CATEGORIES } from "../src/categories.ts";

// The page behind the link changes between fetches: first a login wall (title only), then the real article.
let page = { title: "example.com", text: "" };
registerExtractor({
  name: "refresh-fixture",
  matches: (u) => u.startsWith("https://refresh.test/"),
  extract: async (url) => ({ url, kind: "article", title: page.title, text: page.text, outlinks: [], meta: {} }),
});

function build(withModel = true) {
  let n = 0;
  const llm: LlmProvider = {
    label: "fixture",
    complete: async () => ({
      name: `tool v${++n}`, one_liner: `summary ${n}`, highlights: [], use_cases: [], tags: [], primary_url: "", mentions: [],
      ai_tool: true, category: "other", kind: "article", worth: "normal",
    }) as any,
  };
  const store = new Store(":memory:");
  store.seedFolders(DEFAULT_CATEGORIES);
  const p = new Pipeline({ store, categories: DEFAULT_CATEGORIES, ...(withModel ? { summarizer: new Summarizer(llm, "English") } : {}) });
  return { store, p };
}

test("refresh re-summarises but keeps note, favorite, shares and a folder the reader chose", async () => {
  const { store, p } = build();
  page = { title: "Cool tool", text: "first version of the page" };
  const first = await p.ingest("https://refresh.test/a", { platform: "t", chatId: "c", note: "from my friend" });
  const id = first.item.id;
  assert.equal(first.item.summary?.oneLiner, "summary 1");
  store.setNote(id, "my own note");
  store.setFavorite(id, true);
  store.recordShare(id, { platform: "t", chatId: "d", note: "again" });
  store.moveItem(id, "learning", "me");

  page = { title: "Cool tool", text: "the page now has much more content" };
  const after = (await p.refresh(id))!;
  assert.equal(after.summary?.oneLiner, "summary 2");
  assert.equal(after.id, id);
  assert.equal(after.note, "my own note");
  assert.equal(after.favorite, true);
  assert.equal(after.shareCount, 2);
  assert.deepEqual(store.notes(id).sort(), ["again", "from my friend"]);
  assert.equal(after.category, "learning", "a folder the reader chose stays");
  assert.equal(after.placed, true);
});

test("an auto-filed card may be re-filed; an unknown id is null; a second refresh within a minute is refused", async () => {
  const { p } = build();
  page = { title: "x", text: "text" };
  const { item } = await p.ingest("https://refresh.test/b", { platform: "t", chatId: "c" });
  assert.equal(item.placed, false);
  assert.ok(await p.refresh(item.id));
  await assert.rejects(p.refresh(item.id), RefreshTooSoon);
  assert.equal(await p.refresh(9999), null);
});

test("a refresh already running is refused as busy", async () => {
  const { p } = build();
  page = { title: "x", text: "text" };
  const { item } = await p.ingest("https://refresh.test/c", { platform: "t", chatId: "c" });
  const running = p.refresh(item.id);
  await assert.rejects(p.refresh(item.id), RefreshBusy);
  await running;
});

test("without a model, a refreshed card goes back to the agent queue", async () => {
  const { store, p } = build(false);
  page = { title: "x", text: "text" };
  const { item } = await p.ingest("https://refresh.test/d", { platform: "t", chatId: "c" });
  store.enrich(item.id, { name: "n", oneLiner: "old", highlights: [], useCases: [], tags: [] } as any, "agent");
  const after = (await p.refresh(item.id))!;
  assert.equal(after.summary, null);
  assert.equal(after.pending, true);
});

test("a page that now returns nothing does not wipe a good summary", async () => {
  const { store, p } = build();
  page = { title: "x", text: "real content" };
  const { item } = await p.ingest("https://refresh.test/e", { platform: "t", chatId: "c" });
  page = { title: "refresh.test", text: "" };
  await assert.rejects(p.refresh(item.id), /no content/);
  assert.equal(store.get(item.id)!.summary?.oneLiner, "summary 1");
});
