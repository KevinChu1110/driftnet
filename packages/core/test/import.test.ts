import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, importFolder, parseImport, planImport, runImport, type IngestResult } from "../src/index.ts";
import { parseCsv } from "../src/import.ts";

const NETSCAPE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3 ADD_DATE="1600000000">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://a.example/one?utm_source=x" ADD_DATE="1600000100">One &amp; Only</A>
    <DD>my note about one
    <DT><H3>Tools</H3>
    <DL><p>
      <DT><A HREF="https://b.example/two" ADD_DATE="1600000200">Two</A>
      <DT><H3>Deep</H3>
      <DL><p><DT><A HREF="https://c.example/three">Three</A></DL><p>
    </DL><p>
    <DT><A HREF="https://d.example/four">Four</A>
  </DL><p>
  <DT><A HREF="https://e.example/top">Top level</A>
</DL><p>`;

test("Netscape HTML: nested folders, entities, dates and notes", () => {
  const { format, entries } = parseImport(NETSCAPE);
  assert.equal(format, "html");
  assert.equal(entries.length, 5);
  assert.deepEqual(entries[0], { url: "https://a.example/one?utm_source=x", title: "One & Only", note: "my note about one", addedAt: "2020-09-13T12:28:20.000Z" });
  assert.deepEqual(entries[1]!.folderPath, ["Tools"], "the browser's own bookmarks bar is not a folder of the reader's");
  assert.deepEqual(entries[2]!.folderPath, ["Tools", "Deep"]);
  assert.equal(entries[3]!.folderPath, undefined, "back at the bar's top level");
  assert.equal(entries[4]!.folderPath, undefined);
});

test("Pocket HTML list is found by time_added", () => {
  const html = `<h1>Unread</h1><ul><li><a href="https://p.example/1" time_added="1600000000" tags="a,b">Pocket one</a></li></ul>
<h1>Read Archive</h1><ul><li><a href="https://p.example/2" time_added="1600000001" tags="">Pocket two</a></li></ul>`;
  const { format, entries } = parseImport(html);
  assert.equal(format, "pocket");
  assert.deepEqual(entries.map((e) => e.url), ["https://p.example/1", "https://p.example/2"]);
  assert.equal(entries[0]!.title, "Pocket one");
  assert.equal(entries[0]!.addedAt, "2020-09-13T12:26:40.000Z");
});

test("CSV: quoted commas, doubled quotes, line breaks inside a field, CRLF and BOM", () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z\n'), [["a", "b"], ["x, y", 'say "hi"'], ["two\nlines", "z"]]);
  const raindrop = [
    "id,title,note,excerpt,url,folder,tags,created,cover,favorite",
    '1,"Hello, world","a note, with comma\nand a break","ex",https://r.example/1,Reading,"x, y",2021-05-01T10:00:00.000Z,,false',
    '2,"Quote ""q""",,,https://r.example/2,,,,,',
  ].join("\n");
  const { format, entries } = parseImport(raindrop);
  assert.equal(format, "raindrop");
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.title, "Hello, world");
  assert.equal(entries[0]!.note, "a note, with comma\nand a break");
  assert.deepEqual(entries[0]!.folderPath, ["Reading"]);
  assert.equal(entries[0]!.addedAt, "2021-05-01T10:00:00.000Z");
  assert.equal(entries[1]!.title, 'Quote "q"');
});

test("Pocket CSV", () => {
  const csv = "title,url,time_added,tags,status\n\"A, B\",https://p.example/c,1600000000,\"t1,t2\",unread\n";
  const { format, entries } = parseImport(csv);
  assert.equal(format, "pocket");
  assert.equal(entries[0]!.title, "A, B");
  assert.equal(entries[0]!.addedAt, "2020-09-13T12:26:40.000Z");
});

test("driftnet's own JSON: a list or { items } round-trips title, note, folder and date", () => {
  const items = [
    { id: 1, url: "https://j.example/1", title: "J1", note: "n1", folderPath: ["A", "B"], createdAt: "2024-01-02T03:04:05.000Z" },
    { id: 2, url: "https://j.example/2", summary: { name: "Named" }, folder: "X › Y" },
    { id: 3, title: "no url" },
  ];
  for (const doc of [JSON.stringify(items), JSON.stringify({ items })]) {
    const { format, entries } = parseImport(doc);
    assert.equal(format, "json");
    assert.deepEqual(entries, [
      { url: "https://j.example/1", title: "J1", note: "n1", folderPath: ["A", "B"], addedAt: "2024-01-02T03:04:05.000Z" },
      { url: "https://j.example/2", title: "Named", folderPath: ["X", "Y"] },
    ]);
  }
});

test("text and Markdown: any URLs, with Markdown link titles", () => {
  const { format, entries } = parseImport("see [The Post](https://t.example/post) and also https://u.example/x, plus https://u.example/x again.\nftp://nope");
  assert.equal(format, "text");
  assert.deepEqual(entries, [{ url: "https://t.example/post", title: "The Post" }, { url: "https://u.example/x" }]);
  assert.equal(parseImport("a,b\nhttps://z.example", "text").format, "text", "a given format wins");
});

const j = { isAiTool: 1, category: "other", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
const seed = (store: Store, url: string) => store.upsert({ url, aliases: [], title: url, judgement: j, summary: null, flags: [], source: "s" });

test("plan: dedupe by canonical URL, skip non-http, private and already catalogued", () => {
  const store = new Store(":memory:");
  seed(store, "https://have.example/a");
  const plan = planImport(store, [
    { url: "https://new.example/a?utm_source=x" }, { url: "http://www.new.example/a" },
    { url: "https://have.example/a" }, { url: "javascript:alert(1)" }, { url: "ftp://f.example/x" }, { url: "not a url" },
    { url: "http://localhost:8080/x" }, { url: "http://192.168.1.5/x" }, { url: "http://[::1]/x" }, { url: "http://nas.local/x" },
    { url: "https://other.example/b" },
  ]);
  assert.deepEqual(plan.entries.map((e) => e.url), ["https://new.example/a", "https://other.example/b"]);
  assert.equal(plan.duplicates, 2, "one repeat in the file, one already catalogued");
  assert.equal(plan.skipped, 7);
});

test("plan: the cap keeps the first links and says so", () => {
  const store = new Store(":memory:");
  const plan = planImport(store, Array.from({ length: 7 }, (_, i) => ({ url: `https://cap.example/${i}` })), 5);
  assert.equal(plan.entries.length, 5);
  assert.equal(plan.skipped, 2);
  assert.equal(plan.capped, true);
});

function stubDn(store: Store, fail: (url: string) => boolean = () => false) {
  const seen: string[] = [];
  return {
    store, seen,
    pipeline: {
      async ingest(url: string, ctx: { platform: string; chatId: string; note?: string }): Promise<IngestResult> {
        seen.push(`${url}|${ctx.platform}|${ctx.chatId}|${ctx.note ?? ""}`);
        if (fail(url)) throw new Error("boom");
        return { item: seed(store, url), cached: false };
      },
    },
  };
}

test("folders=keep builds Imported › A › B once, reuses existing folders, and places items as the reader's own choice", async () => {
  const store = new Store(":memory:");
  store.seedFolders({ news: "AI news" });
  const reuse = store.createFolder({ name: "Imported" });
  const a = store.createFolder({ name: "a", parent: reuse.id });
  const dn = stubDn(store);
  const p = await runImport(dn, [
    { url: "https://k.example/1", title: "T1", folderPath: ["A", "B"] },
    { url: "https://k.example/2", folderPath: ["A", "B"], note: "n" },
    { url: "https://k.example/3", folderPath: ["A"] },
    { url: "https://k.example/4" },
  ], { folders: "keep" });
  assert.equal(p.done, 4);
  assert.equal(p.added, 4);
  const named = (name: string, parent: string | null) => store.folders().filter((f) => f.name?.toLowerCase() === name.toLowerCase() && (f.parent ?? null) === parent);
  assert.equal(named("Imported", null).length, 1);
  assert.equal(named("A", reuse.id).length, 1);
  assert.equal(named("A", reuse.id)[0]!.id, a.id, "an existing folder of that name is reused");
  const b = named("B", a.id)[0]!;
  assert.ok(b);
  for (const u of ["1", "2"]) {
    const it = store.findByUrl(`https://k.example/${u}`)!;
    assert.equal(it.category, b.id);
    assert.equal(it.placed, true, "user-placed, so automatic sorting leaves it");
  }
  assert.equal(store.findByUrl("https://k.example/3")!.category, a.id);
  assert.notEqual(store.findByUrl("https://k.example/4")!.placed, true, "no folder in the file: sorted as usual");
  assert.ok(dn.seen.includes("https://k.example/1|import|import|T1"));
  assert.ok(dn.seen.includes("https://k.example/2|import|import|n"));
  assert.equal(importFolder(store, ["A", "B"]), b.id);
});

test("folders=none leaves placement to the classifier; a throw counts as failed and the run goes on", async () => {
  const store = new Store(":memory:");
  const dn = stubDn(store, (u) => u.endsWith("/bad"));
  const p = await runImport(dn, [
    { url: "https://n.example/1", folderPath: ["A"] }, { url: "https://n.example/bad" }, { url: "https://n.example/2" },
  ], { folders: "none" });
  assert.deepEqual([p.done, p.added, p.failed], [3, 2, 1]);
  assert.match(p.errors[0]!, /n\.example\/bad: boom/);
  assert.equal(store.folders().some((f) => f.name === "Imported"), false);
  assert.notEqual(store.findByUrl("https://n.example/1")!.placed, true);
});
