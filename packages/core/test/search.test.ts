import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";

const j = { isAiTool: 1, category: "coding", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
const sum = (name: string, extra: Record<string, unknown> = {}) => ({
  name, oneLiner: `${name} one-liner`, highlights: [], useCases: [], tags: [], primaryUrl: "https://x.test", category: "coding", worth: "normal" as const, ...extra,
});
function add(store: Store, url: string, title: string, summary: ReturnType<typeof sum> | null, worth: "low" | "normal" | "must-see" = "normal") {
  return store.upsert({ url, aliases: [], title, judgement: { ...j, worth }, summary, flags: [], source: "s" });
}
const ids = (s: Store, q: string, rest = {}) => s.list({ q, ...rest }).map((i) => i.id);

test("multi-word queries AND their terms, case-insensitively, across summary fields", () => {
  const s = new Store(":memory:");
  const a = add(s, "https://a.test/1", "Doc tool", sum("Docling", { highlights: ["Parses tables"], tags: ["Extraction"] }));
  add(s, "https://a.test/2", "Other", sum("Other", { highlights: ["Parses tables"] }));
  assert.equal(ids(s, "parses tables").length, 2);
  assert.deepEqual(ids(s, "PARSES extraction"), [a.id]);
  assert.deepEqual(ids(s, "parses nothingthere"), []);
});

test("Chinese text matches by substring; short terms fall back to LIKE", () => {
  const s = new Store(":memory:");
  const a = add(s, "https://zh.test/1", "文件工具", sum("Marker", { oneLiner: "把 PDF 轉成 Markdown，支援掃描檔", tags: ["文件轉換"] }));
  add(s, "https://zh.test/2", "Unrelated", sum("Unrelated"));
  assert.deepEqual(ids(s, "轉成"), [a.id], "2 characters: LIKE path");
  assert.deepEqual(ids(s, "pdf"), [a.id], "3 characters: trigram, case-insensitive");
  assert.deepEqual(ids(s, "掃描檔"), [a.id]);
  assert.deepEqual(ids(s, "文件轉換 pdf"), [a.id], "index term and LIKE-free term together");
  assert.deepEqual(ids(s, "轉成 pdf"), [a.id], "short and long terms combine with AND");
  assert.deepEqual(ids(s, "轉成 nomatch"), []);
});

test("a name match outranks a chat-note match; worth breaks ties", () => {
  const s = new Store(":memory:");
  const chatOnly = add(s, "https://r.test/1", "Something", sum("Something"), "must-see");
  s.recordShare(chatOnly.id, { platform: "tg", chatId: "c", note: "tried playwright yesterday, it was fine" });
  const named = add(s, "https://r.test/2", "Playwright", sum("Playwright"), "low");
  assert.deepEqual(ids(s, "playwright"), [named.id, chatOnly.id]);
  assert.deepEqual(ids(s, "playwright", { sort: "newest" }), [named.id, chatOnly.id].sort((a, b) => b - a), "other sorts keep their order");
});

test("the reader's note and chat notes are searchable; driftnet's own bookkeeping is not", () => {
  const s = new Store(":memory:");
  const a = add(s, "https://n.test/1", "A", sum("A"));
  const b = add(s, "https://n.test/2", "B", sum("B"));
  s.setNote(a.id, "remember for quarterly budgeting");
  s.recordShare(b.id, { platform: "tg", chatId: "c", note: "sent by Alice about sprockets" });
  s.recordShare(b.id, { platform: "tg", chatId: "c", note: "Mentioned in https://n.test/1" });
  assert.deepEqual(ids(s, "budgeting"), [a.id]);
  assert.deepEqual(ids(s, "sprockets"), [b.id]);
  assert.deepEqual(ids(s, "Mentioned in"), [], "synthetic notes are excluded");
  assert.deepEqual(ids(s, "Mentioned"), []);
});

test("the index follows setNote, refreshItem and enrich", () => {
  const s = new Store(":memory:");
  const a = add(s, "https://s.test/1", "A", null);
  s.setNote(a.id, "zebrafish lab");
  assert.deepEqual(ids(s, "zebrafish"), [a.id]);
  s.setNote(a.id, "");
  assert.deepEqual(ids(s, "zebrafish"), [], "a cleared note leaves the index");
  s.enrich(a.id, sum("Quokka", { tags: ["marsupial"] }) as never, "agent:1");
  assert.deepEqual(ids(s, "quokka"), [a.id]);
  assert.deepEqual(ids(s, "marsupial"), [a.id]);
  s.refreshItem(a.id, { title: "A", judgement: j, summary: sum("Wombat"), flags: [], source: "s" });
  assert.deepEqual(ids(s, "quokka"), [], "old summary text is gone");
  assert.deepEqual(ids(s, "wombat"), [a.id]);
  add(s, "https://s.test/1", "A2", sum("Numbat"));
  assert.deepEqual(ids(s, "numbat"), [a.id], "upsert on an existing URL reindexes");
  assert.deepEqual(ids(s, "wombat"), []);
});

test("filters still apply: trash, kind, category subtree, worth, limit", () => {
  const s = new Store(":memory:");
  s.seedFolders({ coding: "c", news: "n" });
  const a = add(s, "https://f.test/1", "Alpha search tool", sum("Alpha"), "must-see");
  const b = add(s, "https://f.test/2", "Beta search tool", sum("Beta"), "low");
  s.setTrashed(b.id, true);
  assert.deepEqual(ids(s, "search"), [a.id]);
  assert.deepEqual(ids(s, "search", { view: "trash" }), [b.id]);
  assert.deepEqual(ids(s, "search", { minWorth: "must-see" }), [a.id]);
  assert.deepEqual(ids(s, "search", { kind: "article" }), []);
  assert.deepEqual(ids(s, "search", { category: "news" }), []);
  assert.deepEqual(ids(s, "search", { category: "coding" }), [a.id]);
  assert.equal(s.list({ q: "search", view: "trash", limit: 1 }).length, 1);
});

test("quotes, wildcards, dashes and parentheses are plain text, never syntax", () => {
  const s = new Store(":memory:");
  const a = add(s, "https://q.test/1", "C++ (fast) tool-kit", sum("Kit", { oneLiner: 'say "hello" to *wildcards*' }));
  for (const q of ['"', '""', "*", "foo*", "-bar", "(", ")", "a AND", "OR NOT", "NEAR(a b)", '"unbalanced', "col:val", "^x", "tool-kit", "'; DROP TABLE items; --"]) {
    assert.doesNotThrow(() => s.list({ q }), q);
  }
  assert.deepEqual(ids(s, "tool-kit"), [a.id]);
  assert.deepEqual(ids(s, '"hello"'), [a.id]);
  assert.deepEqual(ids(s, "*wildcards*"), [a.id]);
  assert.deepEqual(ids(s, "(fast)"), [a.id]);
  assert.equal(s.itemCount(), 1);
});
