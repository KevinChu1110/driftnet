import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "@driftnet/core";
import { checkForUpdate, compareSemver, parseSemver, updateNotice, UPDATE_URL } from "../src/update.ts";

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ DRIFTNET_VERSION: "0.9.0", ...extra });
const reply = (version: unknown, status = 200) => new Response(JSON.stringify({ version, name: "driftnet" }), { status });

test("semver: numeric order, pre-releases below their release, junk is null", () => {
  assert.equal(compareSemver("0.10.0", "0.9.2"), 1);
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareSemver("1.0.0-alpha", "1.0.0-1"), 1);
  assert.equal(compareSemver("v2.0.0", "1.9.9"), 1);
  assert.equal(compareSemver("dev", "1.0.0"), null);
  assert.equal(parseSemver("1.2.3; rm -rf /"), null);
  assert.equal(parseSemver("1.2"), null);
});

test("update check: plain GET to the fixed host, newer version is saved and shown, nothing else is kept", async () => {
  const store = new Store(":memory:");
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return reply("0.9.2"); }) as unknown as typeof fetch;
  assert.equal(await checkForUpdate(store, env(), { fetch: f }), "0.9.2");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, UPDATE_URL);
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(calls[0]!.init.credentials, "omit");
  assert.deepEqual(Object.keys(calls[0]!.init.headers as object), ["accept"]);
  assert.deepEqual(updateNotice(store, env()), { latest: "0.9.2", current: "0.9.0" });
  assert.deepEqual(updateNotice(store, env({ DRIFTNET_VERSION: "0.9.2" })), undefined);
  assert.deepEqual(updateNotice(store, env({ DRIFTNET_UPDATE_CHECK: "0" })), undefined);
});

test("update check: at most once in 24 h, survives a restart (state in the store), then asks again", async () => {
  const store = new Store(":memory:");
  let n = 0;
  const f = (async () => { n++; return reply("0.9.2"); }) as unknown as typeof fetch;
  const t0 = 1_700_000_000_000;
  await checkForUpdate(store, env(), { fetch: f, now: t0 });
  await checkForUpdate(store, env(), { fetch: f, now: t0 + 23 * 3600_000 });
  assert.equal(n, 1);
  await checkForUpdate(store, env(), { fetch: f, now: t0 + 25 * 3600_000 });
  assert.equal(n, 2);
});

test("update check: a failure, a timeout, a bad body and junk versions are all quiet, and a failure is not retried for a day", async () => {
  const t0 = 1_700_000_000_000;
  let n = 0;
  for (const f of [
    async () => { n++; throw new Error("offline"); },
    async () => { n++; return reply("0.9.2", 500); },
    async () => { n++; return new Response("<html>", { status: 200 }); },
    async () => { n++; return reply("9.9.9; <script>"); },
    async () => { n++; return reply(42); },
  ]) {
    const store = new Store(":memory:");
    assert.equal(await checkForUpdate(store, env(), { fetch: f as unknown as typeof fetch, now: t0 }), undefined);
    assert.equal(updateNotice(store, env()), undefined);
    const before = n;
    await checkForUpdate(store, env(), { fetch: f as unknown as typeof fetch, now: t0 + 3600_000 });
    assert.equal(n, before, "no second try within the day");
  }
});

test("update check: a slow registry is cut off by the timeout", async () => {
  const store = new Store(":memory:");
  const slow = ((_: string, init: RequestInit) => new Promise((_ok, fail) => init.signal!.addEventListener("abort", () => fail(new Error("aborted"))))) as unknown as typeof fetch;
  const started = Date.now();
  assert.equal(await checkForUpdate(store, env(), { fetch: slow, timeoutMs: 50 }), undefined);
  assert.ok(Date.now() - started < 2000);
});

test("update check: DRIFTNET_UPDATE_CHECK=0 and a checkout ('dev') never touch the network", async () => {
  const store = new Store(":memory:");
  const f = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
  assert.equal(await checkForUpdate(store, env({ DRIFTNET_UPDATE_CHECK: "0" }), { fetch: f }), undefined);
  assert.equal(await checkForUpdate(store, {}, { fetch: f }), undefined);
  assert.equal(store.getState("update_check"), undefined);
});

test("update check: an older or equal registry version shows nothing", async () => {
  const store = new Store(":memory:");
  const f = (async () => reply("0.8.0")) as unknown as typeof fetch;
  assert.equal(await checkForUpdate(store, env(), { fetch: f }), undefined);
});
