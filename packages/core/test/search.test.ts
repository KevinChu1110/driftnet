import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { editDistance } from "../src/search-index.ts";

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

test("“#47” finds card 47 by its number; a bare number is still a text search", () => {
  const s = new Store(":memory:");
  add(s, "https://n.test/1", "First", sum("First"));
  const b = add(s, "https://n.test/2", "Tool 1", sum("Tool 1"));
  assert.deepEqual(ids(s, `#${b.id}`), [b.id]);
  assert.deepEqual(ids(s, " #999 "), []);
  assert.deepEqual(ids(s, "#2", { view: "trash" }), [], "filters still apply");
});

function shelves() {
  const s = new Store(":memory:");
  s.seedFolders({ "coding-agent": "agents that write code", news: "n" });
  const inFolder = (url: string, name: string, category: string, worth: "low" | "normal" | "must-see" = "normal", extra = {}) =>
    s.upsert({ url, aliases: [], title: name, judgement: { ...j, category, worth }, summary: sum(name, { category, ...extra }), flags: [], source: "s" }).id;
  return { s, inFolder };
}
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

test("a card is found by the names on its folder path, in every language, below what it's called", () => {
  const { s, inFolder } = shelves();
  const a = inFolder("https://fo.test/1", "Aider", "coding-agent");
  const b = inFolder("https://fo.test/2", "Cline", "coding-agent");
  const named = inFolder("https://fo.test/3", "Coding agents roundup", "news");
  inFolder("https://fo.test/4", "Unrelated", "news");
  const hits = ids(s, "Coding agents");
  assert.equal(hits[0], named, "the card named so ranks first");
  assert.deepEqual(sorted(hits), sorted([named, a, b]));
  assert.deepEqual(sorted(ids(s, "寫程式")), sorted([a, b]), "the zh-TW label (trigram path)");
  assert.deepEqual(sorted(ids(s, "AI 寫程式")), sorted([a, b]), "with a 2-letter term (LIKE path)");
  const sub = s.createFolder({ name: "Terminal tools", parent: "coding-agent" });
  s.moveItem(a, sub.id);
  assert.deepEqual(ids(s, "terminal"), [a], "a reader-made folder by its own name");
  assert.deepEqual(sorted(ids(s, "coding agents")), sorted([named, a, b]), "a card in a sub-folder still matches its parent's name");
});

test("renaming, moving, merging or deleting a folder updates the cards it holds", () => {
  const { s, inFolder } = shelves();
  const a = inFolder("https://re.test/1", "Aider", "coding-agent");
  const b = inFolder("https://re.test/2", "Ticker", "news");
  s.updateFolder("coding-agent", { name: "Pair programmers" });
  assert.deepEqual(ids(s, "pair programmers"), [a]);
  assert.deepEqual(ids(s, "coding agents"), [], "the built-in label is gone once renamed");
  assert.deepEqual(ids(s, "寫程式"), []);
  const top = s.createFolder({ name: "Zettelkasten" });
  s.updateFolder("coding-agent", { parent: top.id });
  assert.deepEqual(ids(s, "zettelkasten"), [a], "moving a folder carries its cards along");
  s.mergeFolders("news", "coding-agent");
  assert.deepEqual(sorted(ids(s, "pair programmers")), sorted([a, b]), "merged cards take the new path");
  assert.deepEqual(ids(s, "新聞動態"), []);
  s.deleteFolder("coding-agent");
  assert.deepEqual(ids(s, "pair programmers"), [], "deleted: the cards sit in the parent now");
  assert.deepEqual(sorted(ids(s, "zettelkasten")), sorted([a, b]));
  s.moveItems([a], "other");
  assert.deepEqual(ids(s, "zettelkasten"), [b], "a moved card leaves the old folder's name behind");
  assert.deepEqual(ids(s, "其他"), [a]);
  const snap = s.snapshotFolders();
  s.updateFolder(top.id, { name: "Renamed" });
  s.restoreFolders(snap);
  assert.deepEqual(ids(s, "zettelkasten"), [b], "an undone rename is searchable again");
});

test("must-see cards are found by “must-see” and “必看”", () => {
  const { s, inFolder } = shelves();
  const a = inFolder("https://ms.test/1", "Gem", "news", "must-see");
  inFolder("https://ms.test/2", "Plain", "news", "normal");
  assert.deepEqual(ids(s, "must-see"), [a]);
  assert.deepEqual(ids(s, "Must-See"), [a]);
  assert.deepEqual(ids(s, "必看"), [a]);
  s.refreshItem(a, { title: "Gem", judgement: { ...j, category: "news", worth: "low" }, summary: sum("Gem"), flags: [], source: "s" });
  assert.deepEqual(ids(s, "必看"), [], "follows a change of worth");
});

test("a misspelt word that matches nothing is corrected, and the correction is reported", () => {
  const { s, inFolder } = shelves();
  const d = inFolder("https://ty.test/1", "Figma kit", "news", "normal", { oneLiner: "design system starter" });
  const a = inFolder("https://ty.test/2", "Aider", "coding-agent");
  inFolder("https://ty.test/3", "Unrelated", "news");
  const out: { total?: number; corrected?: string } = {};
  assert.deepEqual(s.list({ q: "desgin" }, out).map((i) => i.id), [d], "a swap of two letters");
  assert.equal(out.corrected, "design");
  assert.equal(out.total, 1);
  const o2: { corrected?: string } = {};
  assert.deepEqual(s.list({ q: "codng agnets" }, o2).map((i) => i.id), [a], "folder names are part of the vocabulary");
  assert.equal(o2.corrected, "coding agents");
  const o3: { corrected?: string } = {};
  assert.deepEqual(s.list({ q: "Figma desgin" }, o3).map((i) => i.id), [d], "a word that matches stays as typed");
  assert.equal(o3.corrected, "Figma design");
  assert.deepEqual(ids(s, "desgin", { fuzzy: false }), [], "off when asked");
  assert.deepEqual(ids(s, "xqzvbn"), [], "nothing close: still nothing");
  const o4: { corrected?: string } = {};
  assert.deepEqual(s.list({ q: "desgin", offset: 5 }, o4), [], "a page past the end of the corrected results");
  assert.equal(o4.corrected, "design");
});

test("no correction when the typed query has results", () => {
  const { s, inFolder } = shelves();
  const typo = inFolder("https://nf.test/1", "Desing", "news");
  inFolder("https://nf.test/2", "Design kit", "news");
  const out: { corrected?: string } = {};
  assert.deepEqual(s.list({ q: "desing" }, out).map((i) => i.id), [typo], "what was typed is what is searched");
  assert.equal(out.corrected, undefined);
});

test("CJK and short words are never fuzzed", () => {
  const { s, inFolder } = shelves();
  inFolder("https://cj.test/1", "工具", "news", "normal", { oneLiner: "設計系統工具" });
  inFolder("https://cj.test/2", "tool", "news", "normal", { oneLiner: "abcd" });
  const out: { corrected?: string } = {};
  assert.deepEqual(s.list({ q: "設計系統工貝" }, out), []);
  assert.equal(out.corrected, undefined);
  assert.deepEqual(s.list({ q: "tol" }, out), [], "3 letters: left alone");
  assert.equal(out.corrected, undefined);
});

test("many re-indexes in a row never trip over FTS5's own huge page rowids", () => {
  const { s, inFolder } = shelves();
  const all = Array.from({ length: 40 }, (_, i) => inFolder(`https://bi.test/${i}`, `Card ${i}`, "news"));
  assert.doesNotThrow(() => { for (let k = 0; k < 600; k++) s.setNote(all[k % all.length]!, `note number ${k}`); });
  assert.doesNotThrow(() => { for (let k = 0; k < 300; k++) { s.moveItem(all[k % all.length]!, k % 2 ? "news" : "coding-agent"); s.updateFolder("news", { name: `News ${k}` }); } });
  assert.doesNotThrow(() => { for (const id of all.slice(0, 20)) { s.setTrashed(id, true); s.purgeItem(id); } });
  assert.equal(ids(s, "note number 599").length, 1);
});

test("editDistance counts a swap as one and gives up past the limit", () => {
  assert.equal(editDistance("desgin", "design", 2), 1);
  assert.equal(editDistance("agnet", "agent", 1), 1);
  assert.equal(editDistance("kitten", "sitting", 2), 3, "3 edits: past the limit of 2");
  assert.equal(editDistance("same", "same", 1), 0);
});

test("benchmark: a corrected search on 10,000 cards with a large vocabulary", { skip: process.env.DRIFTNET_BENCH !== "1" }, () => {
  const s = new Store(":memory:");
  s.seedFolders({ "coding-agent": "a", "design-frontend": "d", news: "n" });
  let seed = 3;
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const word = () => Array.from({ length: 4 + Math.floor(r() * 8) }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(r() * 26)]).join("");
  const pool = Array.from({ length: 60000 }, word).concat(["design", "agent", "browser", "memory", "search"]);
  const pick = () => pool[Math.floor(r() * pool.length)]!;
  const cats = ["coding-agent", "design-frontend", "news"];
  const t0 = performance.now();
  s.transaction(() => {
    for (let i = 0; i < 10000; i++) {
      const category = cats[i % 3]!;
      s.upsert({ url: `https://bench.test/${i}`, aliases: [], title: `Tool ${i}`, judgement: { ...j, category },
        summary: sum(`Tool ${i} ${pick()}`, { oneLiner: Array.from({ length: 12 }, pick).join(" "), tags: [pick(), pick()], highlights: [Array.from({ length: 10 }, pick).join(" ")] }), flags: [], source: "s" });
    }
  });
  const buildMs = performance.now() - t0;
  const time = (fn: () => void, reps = 10) => { fn(); const t = performance.now(); for (let k = 0; k < reps; k++) fn(); return (performance.now() - t) / reps; };
  const out: { corrected?: string; total?: number } = {};
  const exact = time(() => s.list({ q: "design" }));
  const fuzzy = time(() => s.list({ q: "desgin" }, out));
  const long = time(() => s.list({ q: "brwoserzz" }));
  const none = time(() => s.list({ q: "qqqqzzzz" }));
  const rename = time(() => s.updateFolder("design-frontend", { name: `Design ${Math.random()}` }), 3);
  console.log(`bench 10k: build ${buildMs.toFixed(0)} ms; exact ${exact.toFixed(2)} ms, corrected ${fuzzy.toFixed(2)} ms (→ ${out.corrected}, ${out.total}), ` +
    `9-letter typo ${long.toFixed(2)} ms, nothing close ${none.toFixed(2)} ms, rename a 3,333-card folder ${rename.toFixed(1)} ms`);
  assert.equal(out.corrected, "design");
  assert.ok(fuzzy < 50, `corrected search took ${fuzzy} ms`);
});
