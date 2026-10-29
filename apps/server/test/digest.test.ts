import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { createDriftnet, messages, type Driftnet } from "@driftnet/core";
import { createApp } from "../src/app.ts";
import { Settings, SettingsError } from "../src/settings.ts";
import { digestDue, digestTick, lastSlot, LIMITS, parseTargets, renderDigest, runDigest, type DigestData } from "../src/digest.ts";

const READ_KEY = "digest-secret-read-key-123";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Sent { url: string; body: any; headers: Record<string, string> }
/** Every chat-platform call lands here instead of the network; `fail` makes URLs containing it answer 500. */
function mockNetwork(fail?: string): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (fail && url.includes(fail)) return new Response(JSON.stringify({ ok: false, error: "channel_not_found", description: "chat not found" }), { status: 500 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return sent;
}

function setup(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {
    DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-digest-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en",
    DRIFTNET_DIGEST: "weekly", DRIFTNET_PUBLIC_URL: "https://dn.example", ...extra,
  };
  const dn = createDriftnet(env);
  return { env, dn };
}

let n = 0;
function add(dn: Driftnet, name: string, worth: "low" | "normal" | "must-see" = "normal", shares = 1) {
  const item = dn.store.upsert({
    url: `https://example.com/${++n}`, aliases: [], title: name,
    judgement: { isAiTool: 1, category: "other", kind: "repo", worth, engine: "llm", confidence: 1 },
    summary: { name, oneLiner: `${name} does a thing`, highlights: [], useCases: [], tags: [], primaryUrl: `https://${name.toLowerCase()}.dev` },
    flags: [], source: "example.com",
  });
  for (let i = 0; i < shares; i++) dn.store.recordShare(item.id, { platform: "telegram", chatId: "1" });
  return item;
}
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");

// ---- due time (local-time Dates, so the test holds in any TZ) ----

test("daily: due once the time has passed and nothing was sent since", () => {
  const env = { DRIFTNET_DIGEST: "daily", DRIFTNET_DIGEST_AT: "09:00" };
  const last = new Date(2026, 9, 28, 9, 0);
  assert.equal(digestDue(new Date(2026, 9, 29, 8, 59), env, last), false);
  assert.equal(digestDue(new Date(2026, 9, 29, 9, 0), env, last), true);
  assert.equal(digestDue(new Date(2026, 9, 29, 15, 0), env, last), true);
  assert.equal(digestDue(new Date(2026, 9, 29, 15, 0), env, new Date(2026, 9, 29, 9, 0, 5)), false, "already sent today");
});

test("default time is 09:00, a bad time falls back to it, off is never due", () => {
  assert.equal(lastSlot(new Date(2026, 9, 29, 10, 0), { DRIFTNET_DIGEST: "daily" }).getHours(), 9);
  assert.equal(lastSlot(new Date(2026, 9, 29, 10, 0), { DRIFTNET_DIGEST: "daily", DRIFTNET_DIGEST_AT: "25:99" }).getHours(), 9);
  assert.equal(digestDue(new Date(2026, 9, 29, 10, 0), { DRIFTNET_DIGEST: "off" }, new Date(2026, 0, 1)), false);
  assert.equal(digestDue(new Date(2026, 9, 29, 10, 0), {}, new Date(2026, 0, 1)), false);
});

test("weekly: waits for the chosen day (default Monday)", () => {
  const env = { DRIFTNET_DIGEST: "weekly", DRIFTNET_DIGEST_AT: "08:30", DRIFTNET_DIGEST_DAY: "fri" };
  const lastFri = new Date(2026, 9, 23, 8, 30); // Fri 23 Oct 2026
  assert.equal(new Date(2026, 9, 29).getDay(), 4, "29 Oct 2026 is a Thursday");
  assert.equal(digestDue(new Date(2026, 9, 29, 12, 0), env, lastFri), false);
  assert.equal(digestDue(new Date(2026, 9, 30, 8, 29), env, lastFri), false);
  assert.equal(digestDue(new Date(2026, 9, 30, 8, 30), env, lastFri), true);
  assert.equal(digestDue(new Date(2026, 9, 31, 8, 30), env, new Date(2026, 9, 30, 8, 31)), false);
  assert.equal(lastSlot(new Date(2026, 9, 29, 12, 0), { DRIFTNET_DIGEST: "weekly" }).getDay(), 1, "Monday by default");
});

test("catch-up after downtime: due once however long it was off", () => {
  const env = { DRIFTNET_DIGEST: "daily", DRIFTNET_DIGEST_AT: "09:00" };
  assert.equal(digestDue(new Date(2026, 9, 29, 10, 0), env, new Date(2026, 9, 20, 9, 0)), true);
});

test("a changed time applies at once", () => {
  const last = new Date(2026, 9, 29, 9, 0, 30); // sent at 09:00 today
  const now = new Date(2026, 9, 29, 11, 0);
  assert.equal(digestDue(now, { DRIFTNET_DIGEST: "daily", DRIFTNET_DIGEST_AT: "09:00" }, last), false);
  assert.equal(digestDue(now, { DRIFTNET_DIGEST: "daily", DRIFTNET_DIGEST_AT: "10:30" }, last), true, "moved to a time that has passed since the last send");
  assert.equal(digestDue(now, { DRIFTNET_DIGEST: "daily", DRIFTNET_DIGEST_AT: "23:00" }, last), false);
});

// ---- scheduler ----

test("tick: seeds on first use, sends once when due, never twice, and respects off", async () => {
  const sent = mockNetwork();
  const { env, dn } = setup({ DRIFTNET_DIGEST: "daily", DRIFTNET_DIGEST_AT: "09:00", DRIFTNET_DIGEST_TO: "telegram:123", TELEGRAM_BOT_TOKEN: "tg" });
  const now = new Date();
  assert.equal(await digestTick(dn, env, now), null);
  assert.ok(dn.store.getState("digest:last"), "seeded, nothing sent");
  assert.equal(sent.length, 0);
  // The server was down: the last digest is two days old, a card arrived since.
  dn.store.setState("digest:last", iso(new Date(now.getTime() - 2 * 86_400_000)));
  add(dn, "Alpha");
  // Make "now" late enough that today's slot has passed whatever the real clock says.
  const later = new Date(now); later.setHours(23, 59, 0, 0);
  const run = await digestTick(dn, env, later);
  assert.equal(run?.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(await digestTick(dn, env, later), null, "no double send");
  assert.equal(await digestTick(dn, env, new Date(later.getTime() + 60_000)), null);
  assert.equal(sent.length, 1);
  env.DRIFTNET_DIGEST = "off";
  dn.store.setState("digest:last", iso(new Date(now.getTime() - 5 * 86_400_000)));
  assert.equal(await digestTick(dn, env, later), null);
  assert.equal(sent.length, 1);
});

test("tick with nothing new sends nothing but moves the marker", async () => {
  const sent = mockNetwork();
  const { env, dn } = setup({ DRIFTNET_DIGEST: "daily", DRIFTNET_DIGEST_TO: "telegram:123", TELEGRAM_BOT_TOKEN: "tg" });
  const later = new Date(); later.setHours(23, 59, 0, 0);
  dn.store.setState("digest:last", iso(new Date(later.getTime() - 3 * 86_400_000)));
  const run = await digestTick(dn, env, later);
  assert.equal(run?.sent, false);
  assert.equal(run?.reason, "empty");
  assert.equal(sent.length, 0);
  assert.equal(dn.store.getState("digest:last"), iso(later));
});

// ---- content ----

test("content: header, counts, top 5 by worth then shares, most shared 2+", async () => {
  const sent = mockNetwork();
  const { env, dn } = setup({ DRIFTNET_DIGEST_TO: "telegram:123,slack:C0123ABCD", TELEGRAM_BOT_TOKEN: "tg", SLACK_BOT_TOKEN: "sl" });
  dn.store.setState("digest:last", iso(hoursAgo(1)));
  add(dn, "Low1", "low");
  add(dn, "Normal1", "normal", 1);
  add(dn, "Normal3", "normal", 3);
  add(dn, "Must1", "must-see", 1);
  add(dn, "Normal2", "normal", 2);
  add(dn, "Normal4", "normal", 4);
  const run = await runDigest(dn, env);
  const text = run.texts["telegram:123"]!;
  assert.match(text, /^📬 This week in driftnet\n6 new cards · \d+ waiting in the Inbox/);
  const order = [...text.matchAll(/^\d\. \S+ (\w+) —/gm)].map((m) => m[1]);
  assert.deepEqual(order, ["Must1", "Normal4", "Normal3", "Normal2", "Normal1"], "worth, then shares; capped at 5");
  assert.match(text, /\+ 1 more on the page/);
  const shared = text.slice(text.indexOf("Most shared"));
  assert.match(shared, /Normal4 \(shared 4×\)[\s\S]*Normal3 \(shared 3×\)[\s\S]*Normal2 \(shared 2×\)/);
  assert.doesNotMatch(shared, /Must1|Normal1/);
  assert.match(text, /https:\/\/dn\.example\/#item-\d+/);
  assert.equal(sent.length, 2);
  assert.ok(sent[0]!.url.endsWith("/sendMessage") && sent[0]!.body.chat_id === "123");
  assert.ok(sent[1]!.url.endsWith("/chat.postMessage") && sent[1]!.body.channel === "C0123ABCD");
});

test("content: Chinese wording and the daily title", async () => {
  const { env, dn } = setup({ DRIFTNET_LOCALE: "zh-TW", DRIFTNET_DIGEST: "daily" });
  dn.store.setState("digest:last", iso(hoursAgo(1)));
  add(dn, "Alpha");
  const run = await runDigest(dn, env, { dryRun: true });
  assert.match(run.texts.preview!, /^📬 driftnet 今日\n新增 1 張卡片 · 收件匣還有 \d+ 張待整理/);
  env.DRIFTNET_DIGEST = "weekly";
  assert.match((await runDigest(dn, env, { dryRun: true })).texts.preview!, /driftnet 本週/);
});

test("content: shared items from before the period count when shared again inside it", async () => {
  const { env, dn } = setup();
  const old = add(dn, "Old", "normal", 0);
  await new Promise((r) => setTimeout(r, 1100));
  dn.store.setState("digest:last", iso(new Date()));
  await new Promise((r) => setTimeout(r, 1100));
  dn.store.recordShare(old.id, { platform: "slack", chatId: "c" });
  dn.store.recordShare(old.id, { platform: "slack", chatId: "c" });
  const run = await runDigest(dn, env, { dryRun: true });
  assert.equal(run.digest?.newCount, 0);
  assert.deepEqual(run.digest?.mostShared.map((e) => [e.name, e.sharesInPeriod]), [["Old", 2]]);
});

test("trimming: every platform's text fits its limit, the list shrinks first", () => {
  const t = messages("en");
  const entry = (i: number) => ({ id: i, name: "N".repeat(80), oneLiner: "x".repeat(140), worth: "normal" as const, shareCount: 5, url: "https://dn.example/" + "p".repeat(300) + `#item-${i}`, sharesInPeriod: 3 });
  const data: DigestData = { period: "weekly", from: "", to: "", newCount: 40, inbox: 9, top: [1, 2, 3, 4, 5].map(entry), mostShared: [6, 7, 8].map(entry) };
  const lengths: Record<string, number> = {};
  for (const [platform, limit] of Object.entries(LIMITS)) {
    const text = renderDigest(data, t, limit);
    lengths[platform] = text.length;
    assert.ok(text.length <= limit, `${platform}: ${text.length} > ${limit}`);
    assert.match(text, /^📬 This week in driftnet\n40 new cards/);
  }
  assert.ok(lengths.discord! < lengths.line!, "the roomier platform keeps more of the list");
  // A short digest is not touched.
  const small = renderDigest({ ...data, top: [entry(1)], mostShared: [] }, t, LIMITS.discord);
  assert.match(small, /1\. 📌/);
  // Even the bare header gets cut rather than overflowing.
  assert.ok(renderDigest(data, t, 40).length <= 40);
});

test("links are the bare public URL, never the read key", async () => {
  const { env, dn } = setup({ DRIFTNET_ACCESS: "private", DRIFTNET_TOKEN: "admin-password-123", DRIFTNET_READ_KEY: READ_KEY, DRIFTNET_DIGEST_TO: "discord:123456789", DISCORD_BOT_TOKEN: "dc" });
  const sent = mockNetwork();
  dn.store.setState("digest:last", iso(hoursAgo(1)));
  const a = add(dn, "Alpha", "normal", 2);
  const run = await runDigest(dn, env);
  const body = JSON.stringify([run, sent]);
  assert.ok(!body.includes(READ_KEY) && !body.includes("key="), "no key anywhere");
  assert.match(run.texts["discord:123456789"]!, new RegExp(`https://dn\\.example/#item-${a.id}`));
  assert.equal(sent[0]!.headers.authorization, "Bot dc");
});

test("no public URL: the card's own source link is used", async () => {
  const { env, dn } = setup({ DRIFTNET_PUBLIC_URL: "" });
  dn.store.setState("digest:last", iso(hoursAgo(1)));
  add(dn, "Alpha");
  assert.match((await runDigest(dn, env, { dryRun: true })).texts.preview!, /https:\/\/alpha\.dev/);
});

test("empty period: nothing is sent and the marker stays for a manual run", async () => {
  const sent = mockNetwork();
  const { env, dn } = setup({ DRIFTNET_DIGEST_TO: "telegram:123", TELEGRAM_BOT_TOKEN: "tg" });
  const last = iso(hoursAgo(1));
  dn.store.setState("digest:last", last);
  const run = await runDigest(dn, env);
  assert.deepEqual([run.sent, run.reason, sent.length], [false, "empty", 0]);
  assert.equal(dn.store.getState("digest:last"), last);
});

test("dry run sends nothing and does not move the marker", async () => {
  const sent = mockNetwork();
  const { env, dn } = setup({ DRIFTNET_DIGEST_TO: "telegram:123", TELEGRAM_BOT_TOKEN: "tg" });
  const last = iso(hoursAgo(1));
  dn.store.setState("digest:last", last);
  add(dn, "Alpha");
  const run = await runDigest(dn, env, { dryRun: true });
  assert.equal(sent.length, 0);
  assert.equal(dn.store.getState("digest:last"), last);
  assert.match(run.texts["telegram:123"]!, /Alpha/);
});

// ---- targets ----

test("targets: parsing, de-duplication and rejection", () => {
  const { targets, invalid } = parseTargets(" telegram:-1001234 , Discord:123456789012, slack:C0123ABCD, line:U1234abcd, telegram:-1001234, telegram:@mychannel ");
  assert.deepEqual(targets.map((t) => `${t.platform}:${t.id}`), ["telegram:-1001234", "discord:123456789012", "slack:C0123ABCD", "line:U1234abcd", "telegram:@mychannel"]);
  assert.deepEqual(invalid, []);
  const bad = parseTargets("telegram:abc, matrix:1, discord:12, slack:c0123, nocolon, line:");
  assert.deepEqual(bad.targets, []);
  assert.equal(bad.invalid.length, 6);
  assert.deepEqual(parseTargets(undefined), { targets: [], invalid: [] });
});

test("each platform is called the way its API wants", async () => {
  const sent = mockNetwork();
  const { env, dn } = setup({
    DRIFTNET_DIGEST_TO: "telegram:1,discord:123456789,slack:C0123ABCD,line:Uabc123",
    TELEGRAM_BOT_TOKEN: "tg", DISCORD_BOT_TOKEN: "dc", SLACK_BOT_TOKEN: "sl", LINE_CHANNEL_ACCESS_TOKEN: "ln",
  });
  dn.store.setState("digest:last", iso(hoursAgo(1)));
  add(dn, "A&B <x>");
  await runDigest(dn, env);
  const by = (part: string) => sent.find((s) => s.url.includes(part))!;
  assert.equal(by("api.telegram.org/bottg/sendMessage").body.chat_id, "1");
  assert.equal(by("discord.com/api/v10/channels/123456789/messages").body.allowed_mentions.parse.length, 0);
  assert.match(by("chat.postMessage").body.text, /A&amp;B &lt;x&gt;/, "Slack control characters are escaped");
  assert.equal(by("api.line.me/v2/bot/message/push").body.to, "Uabc123");
  assert.equal(by("api.line.me/v2/bot/message/push").headers.authorization, "Bearer ln");
});

test("a failing or unconfigured target is logged and the others still get it", async () => {
  const sent = mockNetwork("discord.com");
  const { env, dn } = setup({
    DRIFTNET_DIGEST_TO: "discord:123456789,slack:C0123ABCD,line:Uabc123,telegram:5",
    DISCORD_BOT_TOKEN: "dc", SLACK_BOT_TOKEN: "sl", TELEGRAM_BOT_TOKEN: "tg", // LINE token missing
  });
  dn.store.setState("digest:last", iso(hoursAgo(1)));
  add(dn, "Alpha");
  const warn = console.warn; const warnings: string[] = [];
  console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
  let run;
  try { run = await runDigest(dn, env); } finally { console.warn = warn; }
  assert.deepEqual(run.results.map((r) => [r.target, r.ok]), [["discord:123456789", false], ["slack:C0123ABCD", true], ["line:Uabc123", false], ["telegram:5", true]]);
  assert.match(run.results[2]!.error!, /LINE_CHANNEL_ACCESS_TOKEN/);
  assert.equal(run.sent, true);
  assert.equal(sent.filter((s) => !s.url.includes("discord")).length, 2);
  assert.equal(warnings.length, 2);
});

test("settings: the four keys validate", () => {
  const home = mkdtempSync(join(tmpdir(), "driftnet-digest-settings-"));
  const env: NodeJS.ProcessEnv = { DRIFTNET_HOME: home };
  const s = new Settings(env, new Set());
  assert.deepEqual(s.update({ DRIFTNET_DIGEST: "weekly", DRIFTNET_DIGEST_AT: "07:45", DRIFTNET_DIGEST_DAY: "sun", DRIFTNET_DIGEST_TO: "telegram:1, slack:C0123ABCD" }).length, 4);
  assert.equal(env.DRIFTNET_DIGEST_AT, "07:45");
  for (const bad of [{ DRIFTNET_DIGEST: "hourly" }, { DRIFTNET_DIGEST_AT: "7:45" }, { DRIFTNET_DIGEST_AT: "24:00" }, { DRIFTNET_DIGEST_DAY: "someday" }, { DRIFTNET_DIGEST_TO: "telegram:1, matrix:2" }]) {
    assert.throws(() => s.update(bad), SettingsError, JSON.stringify(bad));
  }
  assert.ok(s.view().settings.some((x) => x.key === "DRIFTNET_DIGEST_TO" && x.group === "digest"));
});

// ---- webhook ----

test("digest.sent webhook: one event per run with the digest and every target's result", async () => {
  mockNetwork("discord.com");
  const calls: any[] = [];
  const hook = createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    calls.push(JSON.parse(b));
    res.writeHead(200).end("ok");
  });
  await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
  try {
    const { env, dn } = setup({
      DRIFTNET_DIGEST_TO: "discord:123456789,telegram:5", DISCORD_BOT_TOKEN: "dc", TELEGRAM_BOT_TOKEN: "tg",
      DRIFTNET_WEBHOOK_URL: `http://127.0.0.1:${(hook.address() as { port: number }).port}/h`, DRIFTNET_WEBHOOK_ALLOW_LOCAL: "1",
    });
    dn.store.setState("digest:last", iso(hoursAgo(1)));
    add(dn, "Alpha", "normal", 2);
    await runDigest(dn, env);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event, "digest.sent");
    assert.equal(calls[0].digest.newCount, 1);
    assert.equal(calls[0].digest.top[0].name, "Alpha");
    assert.deepEqual(calls[0].targets.map((t: any) => t.ok), [false, true]);
    // A dry run or an empty period emits nothing.
    await runDigest(dn, env, { dryRun: true });
    dn.store.setState("digest:last", iso(new Date(Date.now() + 5000)));
    await runDigest(dn, env);
    assert.equal(calls.length, 1);
  } finally { hook.close(); }
});

// ---- route ----

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

test("POST /api/digest/send: needs write access; dryRun returns the texts, a real run sends", async () => {
  const sent = mockNetwork();
  const env: NodeJS.ProcessEnv = {
    DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-digest-route-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en", DRIFTNET_TOKEN: "digest-route-password-1A!",
    DRIFTNET_DIGEST_TO: "telegram:123", TELEGRAM_BOT_TOKEN: "tg", DRIFTNET_PUBLIC_URL: "https://dn.example",
  };
  const dn = createDriftnet(env);
  const server = createApp({ dn, env, port: 0 });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  const post = (headers: Record<string, string>, body: unknown) => new Promise<{ status: number; json: any }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method: "POST", path: "/api/digest/send", headers: { "x-forwarded-for": "203.0.113.9", "content-type": "application/json", ...headers } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok({ status: res.statusCode!, json: b ? JSON.parse(b) : null }));
    });
    r.on("error", fail); r.end(JSON.stringify(body));
  });
  const auth = { authorization: `Bearer ${env.DRIFTNET_TOKEN}` };
  add(dn, "Alpha");
  assert.equal((await post({}, { dryRun: true })).status, 401);
  const dry = await post(auth, { dryRun: true });
  assert.equal(dry.status, 200);
  assert.match(dry.json.texts["telegram:123"], /Alpha/);
  assert.equal(sent.length, 0);
  assert.equal(dn.store.getState("digest:last"), undefined);
  const real = await post(auth, {});
  assert.equal(real.json.sent, true);
  assert.equal(sent.length, 1);
  assert.ok(dn.store.getState("digest:last"));
});
