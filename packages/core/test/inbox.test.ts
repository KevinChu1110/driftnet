import assert from "node:assert/strict";
import { test } from "node:test";
import { keywordSuggestions, Pipeline, registerExtractor, Store, Summarizer, suggestionsFor, type LlmProvider } from "../src/index.ts";

const j = { isAiTool: 1, category: "other", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
function seed() {
  const store = new Store(":memory:");
  store.seedFolders({ coding: "Coding agents and code assistants", news: "AI news and releases" });
  const games = store.createFolder({ name: "Games", description: "Game tools and MapleStory helpers" });
  const add = (n: number, extra: object = {}) => store.upsert({ url: `https://inbox.test/${n}`, aliases: [], title: `t${n}`, judgement: j, summary: null, flags: [], source: "s", ...extra });
  return { store, games, add };
}

test("the inbox holds what is not filed by hand, newest first, and leaves it when moved or trashed", () => {
  const { store, add } = seed();
  const [a, b, c] = [add(1), add(2), add(3)];
  assert.deepEqual(store.list({ view: "inbox" }).map((i) => i.id), [c.id, b.id, a.id]);
  assert.equal(store.inboxCount(), 3);
  store.moveItem(b.id, "coding");
  store.setTrashed(c.id, true);
  assert.deepEqual(store.list({ view: "inbox" }).map((i) => i.id), [a.id]);
  assert.equal(store.inboxCount(), 1);
  assert.equal(store.get(b.id)!.placed, true);
});

test("suggestions persist as JSON and survive a re-ingest that has none", () => {
  const { store, add } = seed();
  const it = add(1, { suggestions: [{ folder: "coding", score: 0.9 }, { folder: "news", score: 0.2 }] });
  assert.deepEqual(store.get(it.id)!.suggestions, [{ folder: "coding", score: 0.9 }, { folder: "news", score: 0.2 }]);
  add(1);
  assert.equal(store.get(it.id)!.suggestions!.length, 2);
});

test("without a model, suggestions come from keyword overlap with folder names and descriptions", () => {
  const { store, games, add } = seed();
  const choices = store.folderChoices((f) => f.name ?? f.id);
  const s = keywordSuggestions(choices, { name: "Artale MapleStory bot", tags: ["maplestory", "game"] });
  assert.equal(s[0]!.folder, games.id);
  assert.ok(s.length <= 3);
  assert.deepEqual(keywordSuggestions(choices, { name: "zzz qqq", tags: [] }), []);
  // The card's current real folder leads.
  assert.equal(keywordSuggestions(choices, { name: "Artale", tags: [], current: "news" })[0]!.folder, "news");
  // A stored suggestion pointing at a deleted folder is dropped, then the fallback fills in.
  const it = add(2, { title: "MapleStory helper", suggestions: [{ folder: "gone", score: 1 }] });
  assert.equal(suggestionsFor(store.get(it.id)!, choices)[0]!.folder, games.id);
});

registerExtractor({
  name: "inbox-fixture",
  matches: (u) => u.startsWith("https://inbox-fixture.test/"),
  extract: async (url) => ({ url, kind: "article", title: "A tool", meta: {}, text: "text", outlinks: [] }),
});

test("a classification keeps the model's top folders; without a model answer the keywords fill in", async () => {
  const store = new Store(":memory:");
  store.seedFolders({ coding: "Coding agents", news: "AI news" });
  const llm: LlmProvider = {
    label: "fake",
    complete: async () => ({
      name: "tool", one_liner: "x", highlights: [], use_cases: [], tags: ["coding"], primary_url: "", mentions: [],
      ai_tool: true, category: "coding", kind: "article", worth: "normal",
      suggestions: [{ category: "news", score: 0.3 }, { category: "coding", score: 0.8 }, { category: "bogus", score: 1 }],
    }) as any,
  };
  const p = new Pipeline({ store, categories: store.folderChoices((f) => f.id), summarizer: new Summarizer(llm, "English") });
  const r = await p.ingest("https://inbox-fixture.test/a", { platform: "t", chatId: "c" });
  assert.equal(r.item.category, "coding");
  assert.deepEqual(r.item.suggestions, [{ folder: "coding", score: 0.8 }, { folder: "news", score: 0.3 }]);
  // No model at all: heuristic category, suggestions from the keyword fallback (here, nothing overlaps).
  const bare = new Pipeline({ store: new Store(":memory:"), categories: { coding: "Coding agents", other: "x" } });
  const r2 = await bare.ingest("https://inbox-fixture.test/b", { platform: "t", chatId: "c" });
  assert.deepEqual(r2.item.suggestions, []);
});
