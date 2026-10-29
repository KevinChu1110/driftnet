import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HealthChecker, isPrivateTarget } from "../src/health.ts";
import { MIGRATIONS, migrate, schemaVersion } from "../src/migrations.ts";
import { Store } from "../src/store.ts";

const j = { isAiTool: 1, category: "other", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
const add = (store: Store, url: string, extra: object = {}) =>
  store.upsert({ url, aliases: [], title: url, judgement: j, summary: null, flags: [], source: "s", ...extra });
const NOW = Date.parse("2026-10-29T00:00:00Z");
const quiet = () => {};

type Reply = { status?: number; headers?: Record<string, string>; json?: unknown; throws?: string };
/** A fetch that answers from a script and records what it was asked. */
function fakeFetch(answer: (url: string, init: RequestInit) => Reply) {
  const calls: { url: string; method: string; headers: Headers }[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers) });
    const r = answer(url, init);
    if (r.throws) throw Object.assign(new TypeError("fetch failed"), { cause: { code: r.throws } });
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : null, { status: r.status ?? 200, headers: r.headers });
  };
  return { fn, calls };
}
const checker = (store: Store, f: ReturnType<typeof fakeFetch>, now = NOW) =>
  new HealthChecker(store, { fetch: f.fn, now: () => now, githubToken: () => undefined, log: quiet });

test("migration 3 adds the health columns to an existing v2 database and keeps its rows", () => {
  const path = join(mkdtempSync(join(tmpdir(), "dn-health-")), "v2.db");
  // A real v2 file: only the first two migrations applied.
  const db = new DatabaseSync(path);
  migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= 2) });
  db.exec("INSERT INTO items (url, title, kind, category, worth, is_ai_tool, judge_engine) VALUES ('https://old.test/x', 'Old', 'repo', 'other', 'normal', 1, 'jev')");
  assert.equal(schemaVersion(db), 2);
  assert.equal((db.prepare("PRAGMA table_info(items)").all() as { name: string }[]).some((c) => c.name === "health"), false);
  db.close();

  const store = new Store(path);
  const old = store.get(1)!;
  assert.equal(old.title, "Old");
  assert.deepEqual([old.health, old.stars, old.pushedAt, old.healthCheckedAt], [null, null, null, null]);
  const check = new DatabaseSync(path);
  assert.equal(schemaVersion(check), MIGRATIONS[MIGRATIONS.length - 1]!.version);
  assert.ok(MIGRATIONS.some((m) => m.version === 3));
  check.close();
});

test("a repo's stars, last push and archived state are stored when it is first saved", () => {
  const store = new Store(":memory:");
  const a = add(store, "https://github.com/o/live", { repo: { stars: 1234, pushedAt: "2026-10-01" } });
  assert.equal(a.stars, 1234);
  assert.equal(a.pushedAt, "2026-10-01");
  assert.equal(a.health, null);
  const b = add(store, "https://github.com/o/gone", { repo: { stars: 5, archived: true } });
  assert.equal(b.health, "archived");
  assert.ok(b.healthCheckedAt);
  // Saving the same repo again without facts keeps what is known.
  assert.equal(add(store, "https://github.com/o/live").stars, 1234);
});

const repoJson = (over: object = {}) => ({ archived: false, pushed_at: "2026-09-01T00:00:00Z", stargazers_count: 42, ...over });

test("GitHub: ok, archived, stale, moved (redirect and rename), dead", async () => {
  const store = new Store(":memory:");
  const run = async (reply: Reply) => {
    const item = add(store, `https://github.com/o/r${Math.random().toString(36).slice(2)}`);
    const f = fakeFetch(() => reply);
    return { out: await checker(store, f).check(item), f };
  };
  const ok = await run({ json: repoJson() });
  assert.equal(ok.out!.health, "ok");
  assert.equal(ok.out!.stars, 42);
  assert.equal(ok.out!.pushedAt, "2026-09-01T00:00:00Z");
  assert.match(ok.f.calls[0]!.url, /^https:\/\/api\.github\.com\/repos\/o\/r/);
  assert.equal((await run({ json: repoJson({ archived: true }) })).out!.health, "archived");
  assert.equal((await run({ json: repoJson({ pushed_at: "2024-01-01T00:00:00Z" }) })).out!.health, "stale");
  assert.equal((await run({ json: repoJson({ pushed_at: "2025-05-01T00:00:00Z" }) })).out!.health, "ok", "17 months is not stale yet");
  assert.equal((await run({ status: 301, headers: { location: "https://api.github.com/repositories/9" } })).out!.health, "moved");
  assert.equal((await run({ json: repoJson({ full_name: "new/name" }) })).out!.health, "moved");
  assert.equal((await run({ status: 404 })).out!.health, "dead");
});

test("GitHub: sends the token when set, and pauses until the rate limit resets", async () => {
  const store = new Store(":memory:");
  const items = [1, 2, 3].map((n) => add(store, `https://github.com/o/limit${n}`));
  let calls = 0;
  // Two checks run side by side; both hit the limit, the third item is never tried.
  const f = fakeFetch(() => (++calls <= 2 ? { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 600) } } : { json: repoJson() }));
  let now = NOW;
  const c = new HealthChecker(store, { fetch: f.fn, now: () => now, githubToken: () => "tok", log: quiet });
  await c.runBatch();
  assert.equal(calls, 2, "no request after the rate limit is seen");
  assert.equal(f.calls[0]!.headers.get("authorization"), "Bearer tok");
  assert.equal(c.pausedUntil, NOW + 600_000);
  assert.ok(items.every((i) => store.get(i.id)!.healthCheckedAt === null), "rate-limited items are untouched");
  assert.equal(await c.runBatch(), 0, "still paused");
  assert.equal(calls, 2);
  now += 601_000;
  assert.equal(await c.runBatch(), 3, "after the reset the batch goes through");
  assert.ok(items.every((i) => store.get(i.id)!.health === "ok"));
});

test("GitHub: a 200 that used up the limit is kept, then the job pauses", async () => {
  const store = new Store(":memory:");
  const a = add(store, "https://github.com/o/last");
  const f = fakeFetch(() => ({ json: repoJson(), headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 60) } }));
  const c = checker(store, f);
  assert.equal((await c.check(a))!.health, "ok");
  assert.equal(c.pausedUntil, NOW + 60_000);
});

test("other links: 404 and 410 are dead, 2xx/3xx ok, 5xx and timeouts leave the state alone", async () => {
  const store = new Store(":memory:");
  const state = async (status: number | string, seed?: "ok") => {
    const item = add(store, `https://site.test/p${Math.random().toString(36).slice(2)}`);
    if (seed) store.setHealth(item.id, { health: "ok", checkedAt: new Date(NOW - 9 * 86_400_000).toISOString() });
    const f = fakeFetch(() => (typeof status === "number" ? { status } : { throws: status }));
    const out = (await checker(store, f).check(item))!;
    return { out, calls: f.calls };
  };
  assert.equal((await state(404)).out.health, "dead");
  assert.equal((await state(410)).out.health, "dead");
  assert.equal((await state(200)).out.health, "ok");
  assert.equal((await state(302)).out.health, "ok");
  const e500 = await state(503, "ok");
  assert.equal(e500.out.health, "ok", "5xx keeps the previous state");
  const retry = Date.parse(e500.out.healthCheckedAt!);
  assert.ok(NOW - retry > 5 * 86_400_000, "an inconclusive check is due again within about a day");
  assert.equal((await state("ETIMEDOUT")).out.health, null);
  assert.equal((await state(200)).calls[0]!.method, "HEAD");
  assert.match((await state(200)).calls[0]!.headers.get("user-agent")!, /driftnet/);
});

test("other links: a HEAD that is refused falls back to a small ranged GET", async () => {
  const store = new Store(":memory:");
  const item = add(store, "https://picky.test/page");
  const f = fakeFetch((_u, init) => ({ status: init.method === "HEAD" ? 405 : 206 }));
  assert.equal((await checker(store, f).check(item))!.health, "ok");
  assert.deepEqual(f.calls.map((c) => c.method), ["HEAD", "GET"]);
  assert.equal(f.calls[1]!.headers.get("range"), "bytes=0-1023");
  const gone = add(store, "https://picky.test/gone");
  const g = fakeFetch((_u, init) => ({ status: init.method === "HEAD" ? 405 : 404 }));
  assert.equal((await checker(store, g).check(gone))!.health, "dead");
});

test("other links: a name that does not resolve twice in a row is dead", async () => {
  const store = new Store(":memory:");
  const item = add(store, "https://no-such-host.test/");
  const c = checker(store, fakeFetch(() => ({ throws: "ENOTFOUND" })));
  assert.equal((await c.check(store.get(item.id)!))!.health, null, "once could be a blip");
  assert.equal((await c.check(store.get(item.id)!))!.health, "dead");
  // A success in between resets the count.
  const flaky = add(store, "https://flaky.test/");
  let n = 0;
  const f = fakeFetch(() => (++n === 2 ? { status: 200 } : { throws: "ENOTFOUND" }));
  const c2 = checker(store, f);
  for (let i = 0; i < 3; i++) await c2.check(store.get(flaky.id)!);
  assert.equal(store.get(flaky.id)!.health, "ok");
});

test("the card's own tool link is checked when the summary has one", async () => {
  const store = new Store(":memory:");
  const item = add(store, "https://post.test/thread", {
    summary: { name: "T", oneLiner: "", highlights: [], useCases: [], tags: [], primaryUrl: "https://github.com/o/tool" },
  });
  const f = fakeFetch(() => ({ json: repoJson({ full_name: "o/tool" }) }));
  assert.equal((await checker(store, f).check(item))!.health, "ok");
  assert.match(f.calls[0]!.url, /api\.github\.com\/repos\/o\/tool$/);
});

test("private and local addresses are never fetched", async () => {
  const store = new Store(":memory:");
  const urls = ["http://127.0.0.1/x", "http://10.0.0.5/", "http://192.168.1.2/a", "http://localhost:8080/", "http://[::1]/", "http://169.254.169.254/latest", "http://nas.local/", "http://db.internal/"];
  const f = fakeFetch(() => ({ status: 200 }));
  const c = checker(store, f);
  for (const u of urls) {
    assert.equal(isPrivateTarget(u), true, u);
    const out = (await c.check(add(store, u, { kind: "other" })))!;
    assert.equal(out.health, null, u);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(isPrivateTarget("https://example.com/"), false);
  assert.equal(isPrivateTarget("http://10.0.0.5/", { DRIFTNET_ALLOW_PRIVATE_URLS: "1" }), false);
});

test("batches take never-checked items first, then the oldest check, skip fresh ones and the trash", async () => {
  const store = new Store(":memory:");
  const day = 86_400_000;
  const at = (d: number) => new Date(NOW - d * day).toISOString();
  const mk = (n: string, ago: number | null) => {
    const i = add(store, `https://order.test/${n}`);
    if (ago !== null) store.setHealth(i.id, { health: "ok", checkedAt: at(ago) });
    return i;
  };
  const a = mk("a", 20), b = mk("b", null), c = mk("c", 10), fresh = mk("fresh", 2), edge = mk("edge", 8), trashed = mk("trashed", null);
  store.setTrashed(trashed.id, true);
  const due = store.healthDue(10, at(7)).map((i) => i.id);
  assert.deepEqual(due, [b.id, a.id, c.id, edge.id]);
  assert.ok(!due.includes(fresh.id) && !due.includes(trashed.id));
  assert.deepEqual(store.healthDue(2, at(7)).map((i) => i.id), [b.id, a.id], "the batch size caps it");

  const f = fakeFetch(() => ({ status: 200 }));
  assert.equal(await checker(store, f).runBatch(2), 2);
  assert.deepEqual(f.calls.map((x) => x.url).sort(), ["https://order.test/a", "https://order.test/b"]);
});

test("the health filter lists only the marked items", () => {
  const store = new Store(":memory:");
  const dead = add(store, "https://f.test/dead"), ok = add(store, "https://f.test/ok");
  store.setHealth(dead.id, { health: "dead" });
  store.setHealth(ok.id, { health: "ok" });
  assert.deepEqual(store.list({ health: ["dead", "archived", "stale"], minWorth: "skip" }).map((i) => i.id), [dead.id]);
  assert.equal(store.reviewCount(), 1);
});

test("ingesting a repo keeps the stars, last push and archived state the extractor fetched", async () => {
  const { Pipeline, registerExtractor, Summarizer } = await import("../src/index.ts");
  const { DEFAULT_CATEGORIES } = await import("../src/categories.ts");
  registerExtractor({
    name: "health-fixture",
    matches: (u) => u.startsWith("https://repo-fixture.test/"),
    extract: async (url) => ({
      url, kind: "repo", title: "r", text: "A repo", outlinks: [],
      meta: { stars: 321, pushedAt: "2026-08-02", ...(url.endsWith("/old") ? { archived: "yes" } : {}) },
    }),
  });
  const p = new Pipeline({ store: new Store(":memory:"), categories: DEFAULT_CATEGORIES, summarizer: new Summarizer({ label: "x", complete: async () => { throw new Error("no model"); } } as never, "English") });
  const live = (await p.ingest("https://repo-fixture.test/live", { platform: "t", chatId: "c" })).item;
  assert.deepEqual([live.stars, live.pushedAt, live.health], [321, "2026-08-02", null]);
  const old = (await p.ingest("https://repo-fixture.test/old", { platform: "t", chatId: "c" })).item;
  assert.equal(old.health, "archived");
});
