import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { Semantic, embedText } from "../src/semantic.ts";
import { createEmbedder, normalize, type Embedder } from "../src/llm/embed.ts";

const j = { isAiTool: 1, category: "coding", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
const sum = (name: string, extra: Record<string, unknown> = {}) => ({
  name, oneLiner: `${name} one-liner`, highlights: [], useCases: [], tags: [], primaryUrl: "https://x.test", category: "coding", worth: "normal" as const, ...extra,
});
function add(store: Store, url: string, title: string, summary: ReturnType<typeof sum> | null, category = "coding") {
  return store.upsert({ url, aliases: [], title, judgement: { ...j, category }, summary, flags: [], source: "s" });
}

/** Deterministic "meaning": each concept is one axis, a text's vector counts its concept words. No network. */
const CONCEPTS = [["oauth", "login", "sso", "auth", "signin"], ["pdf", "markdown", "convert"], ["video", "reel", "caption"], ["database", "sql", "sqlite"]];
function vec(text: string): Float32Array {
  const t = text.toLowerCase();
  const v = CONCEPTS.map((words) => words.reduce((n, w) => n + t.split(w).length - 1, 0));
  return normalize([...v, 0.05]);
}
function fake(o: { model?: string; local?: boolean; calls?: { texts: string[]; kind: string }[]; fail?: () => boolean; hang?: boolean } = {}): Embedder {
  return {
    label: `fake:${o.model ?? "m1"}`, model: o.model ?? "m1", local: o.local ?? true,
    async embed(texts, kind) {
      o.calls?.push({ texts, kind });
      if (o.hang) return new Promise<never>(() => {});
      if (o.fail?.()) throw new Error("provider down");
      return texts.map(vec);
    },
  };
}
const setup = async (o: Parameters<typeof fake>[0] = {}, opts = {}) => {
  const store = new Store(":memory:");
  const sem = new Semantic(store, opts);
  return { store, sem, embedder: fake(o) };
};
const ids = (s: Store, q: string, sem: Awaited<ReturnType<Semantic["queryVec"]>>, rest = {}) => s.list({ q, ...(sem ? { semantic: sem } : {}), ...rest }).map((i) => i.id);

test("a query with no keyword hit still finds items by meaning (login -> OAuth), and unrelated ones stay out", async () => {
  const { store, sem, embedder } = await setup();
  const oauth = add(store, "https://a.test/1", "Sign in helper", sum("OAuth kit", { oneLiner: "OAuth flows for apps" }));
  const pdf = add(store, "https://a.test/2", "Doc", sum("PDF converter", { oneLiner: "Convert PDF to Markdown" }));
  sem.use(embedder);
  await sem.idle();
  assert.equal(store.vectors.count(), 2);
  assert.deepEqual(ids(store, "login", null), [], "keywords alone find nothing");
  const q = await sem.queryVec("login");
  assert.deepEqual(ids(store, "login", q), [oauth.id]);
  assert.notEqual(oauth.id, pdf.id);
  const out: { total?: number } = {};
  store.list({ q: "login", semantic: q! }, out);
  assert.equal(out.total, 1);
});

test("reciprocal-rank fusion: an item both lists like beats one only a single list likes", async () => {
  const { store, sem, embedder } = await setup();
  // keyword-only: mentions "login" in its name but is about video (vector far from the query)
  const kw = add(store, "https://a.test/1", "Login video", sum("Login reel maker", { oneLiner: "video captions" }));
  // both: keyword and meaning
  const both = add(store, "https://a.test/2", "Login", sum("Login OAuth", { oneLiner: "oauth sso signin" }));
  // meaning-only: no word "login"
  const sem1 = add(store, "https://a.test/3", "SSO", sum("SSO box", { oneLiner: "oauth sso auth" }));
  sem.use(embedder);
  await sem.idle();
  const q = (await sem.queryVec("login"))!;
  const order = ids(store, "login", q);
  assert.equal(order[0], both.id);
  assert.ok(order.includes(kw.id) && order.includes(sem1.id), "both single-list items are still returned");
});

test("filters, paging and the total stay consistent in hybrid mode", async () => {
  const { store, sem, embedder } = await setup();
  const a = add(store, "https://a.test/1", "x", sum("Auth one", { oneLiner: "oauth" }), "coding");
  add(store, "https://a.test/2", "y", sum("Auth two", { oneLiner: "oauth sso" }), "other");
  add(store, "https://a.test/3", "z", sum("Auth three", { oneLiner: "sso auth" }), "coding");
  sem.use(embedder);
  await sem.idle();
  const q = (await sem.queryVec("login"))!;
  const out: { total?: number } = {};
  assert.deepEqual(store.list({ q: "login", semantic: q, category: "coding" }, out).map((i) => i.category), ["coding", "coding"]);
  assert.equal(out.total, 2);
  const p1 = store.list({ q: "login", semantic: q, limit: 2, offset: 0 }, out).map((i) => i.id);
  const p2 = store.list({ q: "login", semantic: q, limit: 2, offset: 2 }, out).map((i) => i.id);
  assert.equal(out.total, 3);
  assert.equal(new Set([...p1, ...p2]).size, 3);
  store.setTrashed(a.id, true);
  assert.ok(!ids(store, "login", q).includes(a.id), "trashed items never come back through the vector side");
});

test("without vectors, or without a query vector, search is exactly the keyword search", async () => {
  const { store, sem } = await setup();
  const a = add(store, "https://a.test/1", "x", sum("Playwright"));
  add(store, "https://a.test/2", "y", sum("Other"));
  assert.equal(await sem.queryVec("playwright"), null, "off: no vector");
  const before = ids(store, "playwright", null);
  assert.deepEqual(before, [a.id]);
  sem.use(fake()); // on, but not embedded yet
  assert.equal(await sem.queryVec("playwright"), null, "nothing embedded: no call on the search path");
});

test("a failing provider falls back to keywords and is not retried on every search (cooldown)", async () => {
  const calls: { texts: string[]; kind: string }[] = [];
  let down = false;
  const { store, sem } = await setup({}, { cooldownMs: 10_000 });
  add(store, "https://a.test/1", "x", sum("OAuth kit", { oneLiner: "oauth" }));
  sem.use(fake({ calls, fail: () => down }));
  await sem.idle();
  down = true;
  const n = calls.length;
  assert.equal(await sem.queryVec("login"), null);
  assert.equal(await sem.queryVec("signin"), null);
  assert.equal(calls.length, n + 1, "the second search skipped the network");
  assert.deepEqual(ids(store, "oauth", null).length, 1, "keyword search is untouched");
});

test("a slow provider is cut off at the time budget", async () => {
  const { store, sem } = await setup({}, { queryTimeoutMs: 60 });
  add(store, "https://a.test/1", "x", sum("OAuth kit", { oneLiner: "oauth" }));
  sem.use(fake());
  await sem.idle();
  sem.use(fake({ hang: true })); // same model: vectors kept
  assert.equal(store.vectors.count(), 1);
  const t0 = Date.now();
  assert.equal(await sem.queryVec("login"), null);
  assert.ok(Date.now() - t0 < 500, `gave up after ${Date.now() - t0} ms`);
});

test("query embeddings are cached (LRU)", async () => {
  const calls: { texts: string[]; kind: string }[] = [];
  const { store, sem } = await setup({}, { cacheSize: 2 });
  add(store, "https://a.test/1", "x", sum("OAuth kit", { oneLiner: "oauth" }));
  sem.use(fake({ calls }));
  await sem.idle();
  const n = () => calls.filter((c) => c.kind === "query").length;
  await sem.queryVec("login"); await sem.queryVec("Login "); // same after trim/lowercase
  assert.equal(n(), 1);
  await sem.queryVec("pdf"); await sem.queryVec("sqlite"); // evicts "login"
  await sem.queryVec("login");
  assert.equal(n(), 4);
});

test("vectors are recomputed when the summary text changes and not otherwise", async () => {
  const calls: { texts: string[]; kind: string }[] = [];
  const { store, sem } = await setup();
  const a = add(store, "https://a.test/1", "Tool", sum("Tool", { oneLiner: "oauth" }));
  sem.use(fake({ calls }));
  await sem.idle();
  assert.equal(calls.length, 1);
  const before = store.vectors.meta(a.id)!.hash;
  // a write that changes no embedded text (re-saving the same summary, a favourite toggle path): no call
  store.enrich(a.id, sum("Tool", { oneLiner: "oauth" }), "agent:x");
  sem.enqueue(a.id);
  await sem.idle();
  assert.equal(calls.length, 1, "unchanged text is not embedded again");
  store.enrich(a.id, sum("Tool", { oneLiner: "pdf markdown" }), "agent:x");
  await sem.idle();
  assert.equal(calls.length, 2);
  assert.notEqual(store.vectors.meta(a.id)!.hash, before);
  assert.deepEqual([...store.vectors.vectorOf(a.id)!].map((x) => +x.toFixed(3)), [...vec(embedText(store.get(a.id)!, { includeNote: true }))].map((x) => +x.toFixed(3)));
});

test("items added after startup are embedded in the background, batched, one request at a time", async () => {
  const calls: { texts: string[]; kind: string }[] = [];
  const { store, sem } = await setup({}, { batch: 4 });
  for (let i = 0; i < 10; i++) add(store, `https://a.test/${i}`, `t${i}`, sum(`Tool ${i}`, { oneLiner: "sqlite" }));
  sem.use(fake({ calls }));
  const t = add(store, "https://a.test/new", "new", sum("New", { oneLiner: "sql" })); // returns before any embedding
  assert.equal(store.vectors.meta(t.id), undefined, "ingest did not wait for the embedding");
  await sem.idle();
  assert.equal(store.vectors.count(), 11);
  assert.ok(calls.every((c) => c.texts.length <= 4));
});

test("changing the model drops the old vectors and re-embeds", async () => {
  const { store, sem } = await setup();
  const a = add(store, "https://a.test/1", "x", sum("Tool", { oneLiner: "oauth" }));
  sem.use(fake({ model: "m1" }));
  await sem.idle();
  assert.equal(store.vectors.meta(a.id)!.model, "m1");
  const calls: { texts: string[]; kind: string }[] = [];
  sem.use(fake({ model: "m2", calls }));
  assert.equal(store.vectors.meta(a.id), undefined, "m1 vectors are gone at once");
  await sem.idle();
  assert.equal(store.vectors.meta(a.id)!.model, "m2");
  assert.equal(calls.length, 1);
  sem.use(undefined);
  assert.equal(store.vectors.count(), 0);
});

test("private notes and chat text never reach a cloud embedder; a local one may see the note, never the chat", async () => {
  const note = "my secret plan for the acme merger";
  const chat = "dave said this is the one for the payroll team";
  for (const local of [false, true]) {
    const calls: { texts: string[]; kind: string }[] = [];
    const { store, sem } = await setup();
    const a = add(store, "https://www.tool.test/p", "Tool page", sum("Tool", { oneLiner: "does oauth", tags: ["auth"], highlights: ["fast"], why: "because of the chat", demo: "a demo" }));
    store.setNote(a.id, note);
    store.recordShare(a.id, { platform: "tg", chatId: "c", note: chat });
    sem.use(fake({ local, calls }));
    await sem.idle();
    const sent = calls.flatMap((c) => c.texts).join("\n");
    assert.ok(sent.includes("Tool") && sent.includes("oauth") && sent.includes("tool.test"), "summary fields and the host are sent");
    assert.ok(!sent.includes("payroll"), `chat text is never embedded (local=${local})`);
    assert.ok(!sent.includes("because of the chat") && !sent.includes("a demo"), "why/demo derive from chat and notes: not embedded");
    assert.equal(sent.includes("acme"), local, `the note goes only to a local endpoint (local=${local})`);
    assert.ok(!sent.includes("https://"), "only the host, not the full URL");
    assert.ok(sent.length <= 400, "tiny input");
    // a note written later on a cloud embedder: still not sent
    if (!local) { calls.length = 0; store.setNote(a.id, "another private note"); await sem.idle(); assert.ok(!calls.flatMap((c) => c.texts).join("").includes("another private")); }
  }
});

test("related(): nearest by vector, excluding itself, trashed and flagged cards", async () => {
  const { store, sem, embedder } = await setup();
  const me = add(store, "https://a.test/1", "x", sum("OAuth kit", { oneLiner: "oauth" }));
  const near = add(store, "https://a.test/2", "y", sum("SSO box", { oneLiner: "sso auth" }));
  const gone = add(store, "https://a.test/3", "z", sum("Login thing", { oneLiner: "login signin" }));
  const far = add(store, "https://a.test/4", "w", sum("PDF tool", { oneLiner: "pdf" }));
  const bad = store.upsert({ url: "https://a.test/5", aliases: [], title: "v", judgement: j, summary: sum("Auth trap", { oneLiner: "auth oauth" }), flags: ["injection"], source: "s" });
  store.setTrashed(gone.id, true);
  sem.use(embedder);
  await sem.idle();
  const rel = store.related(me.id, 5);
  assert.deepEqual(rel, [{ id: near.id, name: "SSO box" }]);
  assert.ok(!rel.some((r) => [me.id, gone.id, far.id, bad.id].includes(r.id)));
});

test("related() without vectors falls back to shared tags and name words", () => {
  const store = new Store(":memory:");
  const me = add(store, "https://a.test/1", "x", sum("Docling", { tags: ["pdf", "tables", "extraction"] }));
  const twoTags = add(store, "https://a.test/2", "y", sum("Marker", { tags: ["pdf", "tables"] }));
  const oneTag = add(store, "https://a.test/3", "z", sum("Other", { tags: ["pdf"] }));
  const byName = add(store, "https://a.test/4", "w", sum("Docling Cloud", { tags: [] }));
  add(store, "https://a.test/5", "v", sum("Unrelated", { tags: ["video"] }));
  const rel = store.related(me.id, 5).map((r) => r.id);
  assert.deepEqual(rel.sort(), [twoTags.id, byName.id].sort());
  assert.ok(!rel.includes(oneTag.id), "a single shared tag is too weak");
  assert.ok(store.related(me.id, 1).length === 1 && store.related(9999).length === 0);
});

test("migration 4 creates the vector table and is the latest schema version here", () => {
  const dir = mkdtempSync(join(tmpdir(), "driftnet-mig4-"));
  const file = join(dir, "db.sqlite");
  new Store(file);
  const db = new DatabaseSync(file);
  try {
    assert.ok((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version >= 4);
    assert.deepEqual((db.prepare("PRAGMA table_info(item_vec)").all() as { name: string }[]).map((c) => c.name).sort(), ["dim", "hash", "item_id", "model", "updated_at", "vec"]);
  } finally { db.close(); }
});

test("embedding providers: request shapes, keys only in headers, same-vendor key reuse", async () => {
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  const stub = async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "nomic-embed-text:latest" }] });
    if (url.endsWith("/api/embed")) return Response.json({ embeddings: [[3, 4]] });
    if (url.endsWith("/embeddings")) return Response.json({ data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [2, 0] }] });
    return Response.json({ embeddings: [{ values: [1, 0] }] });
  };
  // openai with its own key
  const o = (await createEmbedder({ DRIFTNET_EMBED_PROVIDER: "openai", DRIFTNET_EMBED_API_KEY: "sk-embed" }, { fetch: stub }))!;
  const out = await o.embed(["a", "b"], "document");
  assert.equal(seen.at(-1)!.url, "https://api.openai.com/v1/embeddings");
  assert.equal(seen.at(-1)!.headers.authorization, "Bearer sk-embed");
  assert.equal(seen.at(-1)!.body.model, "text-embedding-3-small");
  assert.deepEqual([...out[0]!], [1, 0], "re-ordered by index and normalised");
  assert.ok(!o.label.includes("sk-"), "no key in the label");
  // an Anthropic summarizer's key is never reused for OpenAI embeddings
  await assert.rejects(createEmbedder({ DRIFTNET_EMBED_PROVIDER: "openai", DRIFTNET_LLM_PROVIDER: "anthropic", DRIFTNET_LLM_API_KEY: "sk-ant" }, { fetch: stub }), /needs DRIFTNET_EMBED_API_KEY/);
  // an openai summarizer's key and base URL are reused
  const o2 = (await createEmbedder({ DRIFTNET_EMBED_PROVIDER: "openai", DRIFTNET_LLM_PROVIDER: "openai", DRIFTNET_LLM_API_KEY: "sk-llm", DRIFTNET_EMBED_MODEL: "x" }, { fetch: stub }))!;
  await o2.embed(["a", "b"], "query");
  assert.equal(seen.at(-1)!.headers.authorization, "Bearer sk-llm");
  // ollama (OpenAI-compatible endpoint, no key) and native
  const o3 = (await createEmbedder({ DRIFTNET_EMBED_PROVIDER: "openai", DRIFTNET_EMBED_BASE_URL: "http://127.0.0.1:11434/v1", DRIFTNET_EMBED_MODEL: "nomic-embed-text" }, { fetch: stub }))!;
  assert.equal(o3.local, true);
  await o3.embed(["a", "b"], "query");
  assert.equal(seen.at(-1)!.url, "http://127.0.0.1:11434/v1/embeddings");
  assert.equal(seen.at(-1)!.headers.authorization, undefined);
  assert.match(seen.at(-1)!.body.input[0], /^search_query: /, "nomic prompt prefix only for nomic models");
  const o4 = (await createEmbedder({ DRIFTNET_EMBED_PROVIDER: "ollama" }, { fetch: stub }))!;
  assert.deepEqual([...(await o4.embed(["a"], "document"))[0]!].map((x) => +x.toFixed(1)), [0.6, 0.8]);
  assert.equal(seen.at(-1)!.url, "http://127.0.0.1:11434/api/embed");
  assert.match(seen.at(-1)!.body.input[0], /^search_document: /);
  // gemini: key in a header, never in the URL
  const g = (await createEmbedder({ DRIFTNET_EMBED_PROVIDER: "gemini", DRIFTNET_LLM_PROVIDER: "gemini", DRIFTNET_LLM_API_KEY: "g-key" }, { fetch: stub }))!;
  await g.embed(["a"], "query");
  const last = seen.at(-1)!;
  assert.ok(last.url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents"));
  assert.ok(!last.url.includes("g-key"));
  assert.equal(last.headers["x-goog-api-key"], "g-key");
  assert.equal(last.body.requests[0].taskType, "RETRIEVAL_QUERY");
});

test("auto mode turns on only for a local Ollama that has the model; off means off", async () => {
  const has = async (url: string) => (url.endsWith("/api/tags") ? Response.json({ models: [{ name: "nomic-embed-text:latest" }] }) : new Response("", { status: 404 }));
  const hasNot = async () => Response.json({ models: [{ name: "llama3" }] });
  const down = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal((await createEmbedder({}, { fetch: has }))?.label, "ollama:nomic-embed-text");
  assert.equal(await createEmbedder({}, { fetch: hasNot }), undefined);
  assert.equal(await createEmbedder({}, { fetch: down }), undefined);
  assert.equal(await createEmbedder({ DRIFTNET_EMBED: "off" }, { fetch: has }), undefined);
  const sem = new Semantic(new Store(":memory:"), { fetch: down });
  assert.match(await sem.configure({}), /^semantic search: off/);
  assert.equal(sem.enabled, false);
});

test("benchmark: search latency with 2,000 and 10,000 embedded items", { skip: process.env.DRIFTNET_BENCH !== "1" }, async () => {
  const DIM = 768;
  const rnd = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const rows: Record<number, { ms: number; keywordMs: number; tot: number }> = {};
  for (const n of [2000, 10000]) {
    const dir = mkdtempSync(join(tmpdir(), "driftnet-bench-"));
    const file = join(dir, "db.sqlite");
    let store = new Store(file);
    const words = ["oauth", "pdf", "video", "sql", "agent", "browser", "voice", "image", "search", "memory", "code", "chat"];
    const r = rnd(7);
    store.transaction(() => {
      for (let i = 0; i < n; i++) {
        const w = [0, 1, 2].map(() => words[Math.floor(r() * words.length)]).join(" ");
        add(store, `https://b.test/${i}`, `Tool ${i}`, sum(`Tool ${i} ${w}`, { oneLiner: `${w} helper number ${i}`, tags: [words[i % words.length]!] }));
      }
    });
    const r2 = rnd(11);
    store.transaction(() => { for (let i = 1; i <= n; i++) store.vectors.put(i, "bench", "h", normalize(Array.from({ length: DIM }, () => r2() - 0.5))); });
    // Reopen the file: a cold start, as after a restart (vectors must be read back from the BLOBs).
    store = new Store(file);
    const cold = performance.now(); store.vectors.setModel("bench"); store.vectors.count();
    const coldMs = performance.now() - cold;
    const q = normalize(Array.from({ length: DIM }, () => r2() - 0.5));
    const time = (fn: () => void, reps = 20) => { fn(); const t0 = performance.now(); for (let k = 0; k < reps; k++) fn(); return (performance.now() - t0) / reps; };
    const tot: { total?: number } = {};
    const keywordMs = time(() => store.list({ q: "oauth agent" }));
    const ms = time(() => store.list({ q: "oauth agent", semantic: { vec: q, floor: 0.0 } }, tot));
    rows[n] = { ms, keywordMs, tot: tot.total ?? 0 };
    console.log(`bench ${n}: keyword ${keywordMs.toFixed(2)} ms, hybrid ${ms.toFixed(2)} ms (total ${tot.total}), cold vector load ${coldMs.toFixed(1)} ms, related ${time(() => store.related(5, 5)).toFixed(2)} ms`);
  }
  assert.ok(rows[10000]!.ms < 250);
});
