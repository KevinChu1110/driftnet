import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createDriftnet, messages, registerExtractor, type IngestResult } from "@driftnet/core";
import { handleChat } from "../src/adapters/handle.ts";
import { onDiscordReaction, sendDiscordReply } from "../src/adapters/discord.ts";
import { onLinePostback, sendLineReply } from "../src/adapters/line.ts";
import { repliedItems, reactionVote, rememberReply, REPLY_TTL_MS } from "../src/adapters/reactions.ts";
import { discordEmbeds, lineFlex, publicBase, replyStyle, resetWarnings, richItems, slackBlocks, telegramRich, type RichReply } from "../src/adapters/rich.ts";
import { onSlackReaction, sendSlackReply } from "../src/adapters/slack.ts";
import { onTelegramCallback, onTelegramReaction, sendTelegramReply } from "../src/adapters/telegram.ts";

registerExtractor({
  name: "rich-fixture",
  matches: (u) => u.startsWith("https://rich.test/"),
  extract: async (url) => ({ url, kind: "repo", title: "Fixture tool", text: "", outlinks: [], meta: {} }),
});

const t = messages("en");
const realFetch = globalThis.fetch;
const realWarn = console.warn;
let warnings: string[] = [];
beforeEach(() => {
  warnings = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  resetWarnings();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  for (const k of ["DRIFTNET_REPLY", "DRIFTNET_REPLY_STYLE", "DRIFTNET_PUBLIC_URL", "DRIFTNET_ACCESS", "DRIFTNET_READ_KEY"]) delete process.env[k];
});

const fresh = () => createDriftnet({ DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-rich-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en" });
const ctx = { platform: "telegram", chatId: "g", userId: "u" };

/** A finished card, built by hand so every field a renderer reads is present. */
const fake = (id: number, over: Record<string, unknown> = {}, summary: Record<string, unknown> = {}): IngestResult =>
  ({
    item: {
      id, url: `https://x.test/${id}`, title: `Tool ${id}`, category: "coding-agent", worth: "must-see", flags: [], source: "x.test", shareCount: 1, pending: false,
      summary: { name: `Tool ${id}`, oneLiner: `Does thing ${id}`, highlights: ["fast", "free"], useCases: [], tags: ["cli", "ai"], primaryUrl: `https://x.test/${id}` },
      media: [{ url: "https://origin.example/p.png", kind: "image", alt: "pic" }],
      ...over,
      ...(Object.keys(summary).length ? { summary: { name: `Tool ${id}`, oneLiner: "", highlights: [], useCases: [], tags: [], ...summary } } : {}),
    },
    cached: false,
  }) as unknown as IngestResult;
const label = (f: string) => f;
const rep = (results: IngestResult[], full = false, env: NodeJS.ProcessEnv = { DRIFTNET_PUBLIC_URL: "https://dn.example" }, base?: string): RichReply => ({
  items: richItems(results, { base, env, t, label, full }), full, t,
});

// ---- text style is today's reply, byte for byte -----------------------------------

test("DRIFTNET_REPLY_STYLE=text: the plain replies are exactly what they were; rich is the default", async () => {
  const dn = fresh();
  process.env.DRIFTNET_PUBLIC_URL = "https://dn.example";
  process.env.DRIFTNET_REPLY_STYLE = "text";
  const link = await handleChat(dn, "https://rich.test/a https://rich.test/b", ctx);
  assert.equal(link!.text, "📌 Fixture tool｜Other ⏳\nhttps://dn.example/#item-1\n📌 Fixture tool｜Other ⏳\nhttps://dn.example/#item-2");
  assert.equal(link!.rich, undefined);
  process.env.DRIFTNET_REPLY = "full";
  const full = await handleChat(dn, "https://rich.test/c", ctx);
  assert.equal(full!.text, "📌 Fixture tool｜Other\n⏳ Waiting for a summary (queued for your agent)\nhttps://rich.test/c\nhttps://dn.example/#item-3\n#3 · reply 👍3 / 👎3");
  assert.equal(full!.rich, undefined);

  delete process.env.DRIFTNET_REPLY_STYLE;
  assert.equal(replyStyle({}), "rich");
  const again = await handleChat(dn, "https://rich.test/d", ctx);
  assert.ok(again!.rich?.full);
  assert.match(again!.text, /reply 👍4 \/ 👎4$/, "the plain text is still carried, as the fallback");
  process.env.DRIFTNET_REPLY = "off";
  assert.equal(await handleChat(dn, "https://rich.test/e", ctx), null);
});

// ---- the shared item model ---------------------------------------------------------

test("pictures: only through a public address, and never with the read key", () => {
  assert.equal(publicBase({ DRIFTNET_PUBLIC_URL: "http://localhost:8650" }), undefined);
  assert.equal(publicBase({ DRIFTNET_PUBLIC_URL: "http://192.168.1.5:8650" }), undefined);
  assert.equal(publicBase({ DRIFTNET_PUBLIC_URL: "http://10.0.0.2" }), undefined);
  assert.equal(publicBase({ DRIFTNET_PUBLIC_URL: "https://mac.local" }), undefined);
  assert.equal(publicBase({ DRIFTNET_PUBLIC_URL: "https://dn.example/" }), "https://dn.example");
  assert.equal(publicBase({ DRIFTNET_TUNNEL_URL: "https://abc.trycloudflare.com", DRIFTNET_PUBLIC_URL: "http://localhost:1" }), "https://abc.trycloudflare.com");
  assert.equal(publicBase({}), undefined);

  assert.equal(rep([fake(1)], false, { DRIFTNET_PUBLIC_URL: "http://localhost:8650" }).items[0]!.thumb, undefined);
  assert.equal(rep([fake(1)], false, {}).items[0]!.thumb, undefined);
  // Private reading: the card link carries the key (as in the plain reply), the picture does not.
  const key = "k".repeat(24);
  const r = rep([fake(1)], false, { DRIFTNET_PUBLIC_URL: "https://dn.example", DRIFTNET_READ_KEY: key }, `https://dn.example/?key=${key}`);
  assert.match(r.items[0]!.url, new RegExp(`key=${key}`));
  assert.match(r.items[0]!.thumb!, /^https:\/\/dn\.example\/api\/media\/1\/0/);
  assert.ok(!r.items[0]!.thumb!.includes(key));
  for (const json of [discordEmbeds(r), slackBlocks(r), lineFlex(r, "x")]) assert.ok(!JSON.stringify(json).includes("origin.example"), "the third-party original is never exposed");
});

test("related repos become items of their own; a pending card says it is queued", () => {
  const parent = { ...fake(1), related: [fake(2), fake(3)] } as IngestResult;
  assert.deepEqual(rep([parent]).items.map((i) => i.id), [1, 2, 3]);
  const pending = rep([fake(4, { pending: true, summary: null })]).items[0]!;
  assert.equal(pending.oneLiner, t.queued);
  assert.equal(pending.name, "Tool 4");
});

// ---- per platform rendering --------------------------------------------------------

test("discord: an embed per item with name link, one-liner, worth and folder; ≤ 10; sized; link vs full", () => {
  const compact = discordEmbeds(rep([fake(1)]));
  const e = compact.embeds[0]!;
  assert.equal(e.title, "⭐ Tool 1");
  assert.equal(e.url, "https://x.test/1");
  assert.equal(e.description, "Does thing 1");
  assert.deepEqual(e.fields.map((f) => f.name), ["Worth", "Folder"]);
  assert.equal(e.fields[1]!.value, "coding-agent");
  assert.match(e.thumbnail!.url, /^https:\/\/dn\.example\/api\/media\/1\/0/);
  const full = discordEmbeds(rep([fake(1)], true)).embeds[0]!;
  assert.match(full.description!, /• fast\n• free/);
  assert.deepEqual(full.fields.map((f) => f.name), ["Worth", "Folder", "Tags"]);

  const many = Array.from({ length: 14 }, (_, i) => fake(i + 1, {}, { oneLiner: "x".repeat(500), highlights: Array(5).fill("y".repeat(300)) }));
  for (const full of [false, true]) {
    const { embeds, extra } = discordEmbeds(rep(many, full));
    assert.equal(embeds.length, 10);
    assert.equal(extra, 4);
    const size = embeds.reduce((n, x) => n + x.title.length + (x.description?.length ?? 0) + x.fields.reduce((m, f) => m + f.name.length + f.value.length, 0), 0);
    assert.ok(size <= 6000, `embed text ${size} must fit Discord's 6000`);
    assert.ok(embeds.every((x) => x.title.length <= 256 && (x.description?.length ?? 0) <= 4096));
  }
});

test("slack: Block Kit with escaped mrkdwn, a context line and an https-only image", () => {
  const hostile = fake(1, { url: "https://x.test/a|b" }, { name: "<!channel> & <@U1>", oneLiner: "see <https://evil.test|click> & more", highlights: [] });
  const blocks = slackBlocks(rep([hostile]));
  assert.deepEqual(blocks.map((b) => b.type), ["section", "context"]);
  const text: string = blocks[0].text.text;
  assert.ok(text.startsWith("*<"));
  assert.ok(!/<!channel>|<@U1>|<https:\/\/evil/.test(text), text);
  assert.match(text, /&lt;!channel&gt; &amp; &lt;@U1&gt;/);
  assert.match(text, /see &lt;https:\/\/evil\.test\|click&gt; &amp; more/);
  assert.equal(blocks[0].accessory.type, "image");
  assert.match(blocks[1].elements[0].text, /Must-see · 📁 coding-agent/);
  assert.equal(slackBlocks(rep([fake(1)], false, { DRIFTNET_PUBLIC_URL: "http://pics.example.com" }))[0].accessory, undefined);
  assert.equal(slackBlocks(rep([fake(1)], false, {}))[0].accessory, undefined);
  const many = slackBlocks(rep(Array.from({ length: 20 }, (_, i) => fake(i + 1))));
  assert.ok(many.length <= 50);
});

test("line: a bubble for one item, a carousel of at most 12, vote postbacks, alt text capped", () => {
  const one = lineFlex(rep([fake(7)]), "plain");
  assert.equal(one.type, "flex");
  assert.equal(one.contents.type, "bubble");
  const buttons = JSON.stringify(one.contents.footer);
  assert.match(buttons, /"label":"Open","uri":"https:\/\/x\.test\/7"/);
  assert.match(buttons, /"data":"v=7&d=up"/);
  assert.match(buttons, /"data":"v=7&d=down"/);
  assert.equal(one.contents.hero.url.startsWith("https://dn.example/api/media/7/0"), true);

  const many = lineFlex(rep(Array.from({ length: 15 }, (_, i) => fake(i + 1))), "a".repeat(900));
  assert.equal(many.contents.type, "carousel");
  assert.equal(many.contents.contents.length, 12);
  assert.equal(many.altText.length, 400);
  const labels = JSON.stringify(many).match(/"label":"([^"]*)"/g)!.map((l) => [...l.slice(9, -1)].length);
  assert.ok(labels.every((n) => n <= 20));
  assert.equal(lineFlex(rep([fake(1)], false, { DRIFTNET_PUBLIC_URL: "http://pics.example.com" }), "x").contents.hero, undefined);
});

test("telegram: HTML with escaped text and links, a 👍 / 👎 row per item, within 4096", () => {
  const r = telegramRich(rep([fake(1, {}, { name: "A <b>&</b> \"q\"", oneLiner: "1 < 2 && 3 > 2", highlights: [] }), fake(2)]));
  assert.match(r.text, /^<b>⭐ <a href="https:\/\/x\.test\/1">A &lt;b&gt;&amp;&lt;\/b&gt; "q"<\/a><\/b>｜coding-agent\n1 &lt; 2 &amp;&amp; 3 &gt; 2/);
  assert.deepEqual(r.reply_markup.inline_keyboard.map((row) => row.map((b: any) => b.callback_data)), [["v:1:up", "v:1:down"], ["v:2:up", "v:2:down"]]);
  assert.equal(r.reply_markup.inline_keyboard[0]![0].text, "👍 #1");
  const href = telegramRich(rep([fake(1, { url: 'https://x.test/?a="1"&b=<2>' }, { primaryUrl: 'https://x.test/?a="1"&b=<2>' })])).text;
  assert.match(href, /href="https:\/\/x\.test\/\?a=&quot;1&quot;&amp;b=&lt;2&gt;"/);
  const big = telegramRich(rep(Array.from({ length: 10 }, (_, i) => fake(i + 1, {}, { oneLiner: "z".repeat(400), highlights: Array(5).fill("h".repeat(300)) })), true));
  assert.ok(big.text.length <= 4096);
  assert.equal(big.reply_markup.inline_keyboard.length, (big.text.match(/<b>/g) ?? []).length, "a button row only for items that fit");
});

// ---- fallback when a platform refuses rich content ---------------------------------

const replyFor = async (dn: ReturnType<typeof fresh>, url: string, full = false) => {
  process.env.DRIFTNET_REPLY = full ? "full" : "link";
  return (await handleChat(dn, url, ctx))!;
};

test("discord: rich reply, seeded reactions, remembered; refused embeds fall back to plain text and log once", async () => {
  const dn = fresh();
  const reply = await replyFor(dn, "https://rich.test/a");
  const calls: Record<string, unknown>[] = [];
  const reacted: string[] = [];
  await sendDiscordReply(dn, async (o) => { calls.push(o); return { id: "m1", react: async (e) => void reacted.push(e) }; }, reply);
  assert.equal(calls.length, 1);
  assert.equal((calls[0]!.embeds as unknown[]).length, 1);
  assert.deepEqual(calls[0]!.allowedMentions, { parse: [] });
  assert.deepEqual(reacted, ["👍", "👎"]);
  assert.deepEqual(repliedItems(dn.store, "discord:m1"), [1]);

  for (const n of [2, 3]) {
    const calls2: Record<string, unknown>[] = [];
    const r2 = await replyFor(dn, `https://rich.test/f${n}`);
    await sendDiscordReply(dn, async (o) => {
      calls2.push(o);
      if (o.embeds) throw new Error("Missing Permissions");
      return { id: `p${n}`, react: async () => { throw new Error("should not react"); } };
    }, r2);
    assert.equal(calls2.length, 2);
    assert.equal(calls2[1]!.content, r2.text);
    assert.deepEqual(calls2[1]!.flags, ["SuppressEmbeds"]);
    assert.deepEqual(repliedItems(dn.store, `discord:p${n}`), r2.ids);
  }
  assert.equal(warnings.filter((w) => w.includes("[discord]")).length, 1, "logged once");

  // Text style: one plain message, exactly the old options, nothing seeded.
  process.env.DRIFTNET_REPLY_STYLE = "text";
  const plain = await replyFor(dn, "https://rich.test/t");
  const calls3: Record<string, unknown>[] = [];
  await sendDiscordReply(dn, async (o) => { calls3.push(o); return { id: "t1", react: async () => { throw new Error("no"); } }; }, plain);
  assert.deepEqual(calls3, [{ content: plain.text.slice(0, 2000), flags: ["SuppressEmbeds"], allowedMentions: { parse: [] } }]);
});

test("telegram: rich send with a button keyboard; a refusal retries as plain text", async () => {
  const dn = fresh();
  const reply = await replyFor(dn, "https://rich.test/a");
  const sent: any[] = [];
  await sendTelegramReply(async (m, b) => { sent.push([m, b]); return { ok: true, result: { message_id: 55 } }; }, dn, 9, 3, reply);
  assert.equal(sent[0][1].parse_mode, "HTML");
  assert.deepEqual(sent[0][1].reply_markup.inline_keyboard[0].map((b: any) => b.callback_data), ["v:1:up", "v:1:down"]);
  assert.deepEqual(repliedItems(dn.store, "telegram:9:55"), [1]);

  const sent2: any[] = [];
  const r2 = await replyFor(dn, "https://rich.test/b");
  await sendTelegramReply(async (m, b: any) => {
    sent2.push(b);
    return b.parse_mode ? { ok: false, description: "can't parse entities" } : { ok: true, result: { message_id: 56 } };
  }, dn, 9, 4, r2);
  assert.equal(sent2.length, 2);
  assert.deepEqual(Object.keys(sent2[1]).sort(), ["chat_id", "link_preview_options", "reply_parameters", "text"]);
  assert.equal(sent2[1].text, r2.text);
  assert.equal(warnings.length, 1);
  assert.deepEqual(repliedItems(dn.store, "telegram:9:56"), r2.ids);
});

test("slack: blocks plus a plain text fallback; invalid_blocks retries as plain text", async () => {
  const dn = fresh();
  const bodies: any[] = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    const bad = b.blocks && b.text.includes("REFUSE");
    return new Response(JSON.stringify(bad ? { ok: false, error: "invalid_blocks" } : { ok: true, ts: `9${bodies.length}`, channel: "C1" }));
  }) as typeof fetch;
  const reply = await replyFor(dn, "https://rich.test/a");
  await sendSlackReply(dn, "xoxb", "C1", "1.0", reply);
  assert.ok(Array.isArray(bodies[0].blocks) && bodies[0].text.length > 0);
  assert.equal(bodies[0].thread_ts, "1.0");
  assert.deepEqual(repliedItems(dn.store, "slack:C1:91"), [1]);

  const r2 = await replyFor(dn, "https://rich.test/b");
  r2.text += " REFUSE";
  await sendSlackReply(dn, "xoxb", "C1", "2.0", r2);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2].blocks, undefined);
  assert.equal(bodies[2].text, r2.text);
  assert.equal(warnings.length, 1);

  process.env.DRIFTNET_REPLY_STYLE = "text";
  const plain = await replyFor(dn, "https://rich.test/c");
  await sendSlackReply(dn, "xoxb", "C1", "3.0", plain);
  assert.deepEqual(bodies[3], { channel: "C1", thread_ts: "3.0", text: plain.text, unfurl_links: false });
});

test("line: a Flex reply; a rejected Flex retries the same token with plain text", async () => {
  const dn = fresh();
  const sent: any[] = [];
  let reject = false;
  globalThis.fetch = (async (_u: any, init: any) => {
    const b = JSON.parse(init.body);
    sent.push(b);
    return new Response("{}", { status: reject && b.messages[0].type === "flex" ? 400 : 200 });
  }) as typeof fetch;
  const reply = await replyFor(dn, "https://rich.test/a");
  await sendLineReply("tok", "rt", reply);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].messages[0].type, "flex");
  assert.equal(sent[0].messages[0].altText, reply.text);

  reject = true;
  await sendLineReply("tok", "rt2", await replyFor(dn, "https://rich.test/b"));
  assert.deepEqual(sent.slice(1).map((s) => [s.replyToken, s.messages[0].type]), [["rt2", "flex"], ["rt2", "text"]]);
  assert.equal(warnings.length, 1);

  process.env.DRIFTNET_REPLY_STYLE = "text";
  const plain = await replyFor(dn, "https://rich.test/c");
  await sendLineReply("tok", "rt3", plain);
  assert.deepEqual(sent.at(-1), { replyToken: "rt3", messages: [{ type: "text", text: plain.text }] });
});

// ---- voting -------------------------------------------------------------------------

const tally = (dn: ReturnType<typeof fresh>, id: number) => {
  const r = dn.store.reputation(dn.store.get(id)!.source);
  return [r.up, r.down];
};

test("reaction emoji: thumbs in every spelling, nothing else", () => {
  for (const e of ["👍", "👍🏽", "+1", "thumbsup", ":+1:", "+1::skin-tone-3"]) assert.equal(reactionVote(e), 1, e);
  for (const e of ["👎", "-1", "thumbsdown", "👎🏿"]) assert.equal(reactionVote(e), -1, e);
  for (const e of ["❤️", "tada", "", null, undefined]) assert.equal(reactionVote(e), null, String(e));
});

test("the message → items map expires after 30 days", () => {
  const dn = fresh();
  rememberReply(dn.store, "discord:old", [1, 2], 1_000);
  assert.deepEqual(repliedItems(dn.store, "discord:old", 1_000 + REPLY_TTL_MS - 1), [1, 2]);
  assert.deepEqual(repliedItems(dn.store, "discord:old", 1_000 + REPLY_TTL_MS + 1), []);
  assert.equal(dn.store.getState("reply:discord:old"), undefined, "removed on lookup");
  rememberReply(dn.store, "discord:a", [1], 2_000);
  rememberReply(dn.store, "discord:b", [1], 2_000 + REPLY_TTL_MS + 7_200_000); // sweeps `a`
  assert.equal(dn.store.getState("reply:discord:a"), undefined);
});

test("discord: reacting 👍 / 👎 on the bot's reply votes on all its items, once per person; bots and strangers are ignored", async () => {
  const dn = fresh();
  const reply = await replyFor(dn, "https://rich.test/a https://rich.test/b");
  await sendDiscordReply(dn, async () => ({ id: "M", react: async () => {} }), reply);
  const r = (over: Partial<Parameters<typeof onDiscordReaction>[1]> = {}) =>
    onDiscordReaction(dn, { messageId: "M", channelId: "C", emoji: "👍", userId: "u1", fromBot: false, ...over }, () => true);
  // (both cards share a source, so the source's tally counts each vote twice)
  assert.deepEqual(r(), [1, 2]);
  assert.deepEqual(tally(dn, 1), [2, 0]);
  assert.deepEqual(r({ emoji: "👎" }), [1, 2]); // same person changes their mind
  assert.deepEqual(tally(dn, 1), [0, 2]);
  r({ userId: "u2" });
  assert.deepEqual(tally(dn, 2), [2, 2]);
  assert.deepEqual(r({ fromBot: true, userId: "bot" }), []);
  assert.deepEqual(r({ emoji: "❤️" }), []);
  assert.deepEqual(r({ messageId: "someone else's message" }), []);
  assert.deepEqual(r({ channelId: "X" }) && onDiscordReaction(dn, { messageId: "M", channelId: "X", emoji: "👍", userId: "u3", fromBot: false }, (c) => c === "C"), []);
  assert.ok(dn.store.get(1) && dn.store.stateWithPrefix("reply:").length === 1);
});

test("slack: reaction_added +1 / -1 on the bot's message votes; own and unrelated reactions don't", async () => {
  const dn = fresh();
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, ts: "170.1", channel: "C1" }))) as typeof fetch;
  await sendSlackReply(dn, "xoxb", "C1", "1.0", await replyFor(dn, "https://rich.test/a"));
  const ev = (over: Record<string, unknown> = {}) => ({ type: "reaction_added", user: "U1", reaction: "+1", item: { type: "message", channel: "C1", ts: "170.1" }, item_user: "UBOT", ...over });
  assert.deepEqual(onSlackReaction(dn, ev()), [1]);
  assert.deepEqual(tally(dn, 1), [1, 0]);
  assert.deepEqual(onSlackReaction(dn, ev({ reaction: "thumbsdown" })), [1]);
  assert.deepEqual(tally(dn, 1), [0, 1]);
  assert.deepEqual(onSlackReaction(dn, ev({ user: "UBOT" })), []);
  assert.deepEqual(onSlackReaction(dn, ev({ reaction: "eyes" })), []);
  assert.deepEqual(onSlackReaction(dn, ev({ item: { type: "message", channel: "C1", ts: "999" } })), []);
  assert.deepEqual(onSlackReaction(dn, ev({ item: { type: "file", channel: "C1", ts: "170.1" } })), []);
  assert.deepEqual(onSlackReaction(dn, { type: "message" }), []);
});

test("telegram: inline buttons vote and answer with a toast; message_reaction votes on the bot's message", async () => {
  const dn = fresh();
  const reply = await replyFor(dn, "https://rich.test/a");
  await sendTelegramReply(async () => ({ ok: true, result: { message_id: 70 } }), dn, -100, 1, reply);
  const cq = (data: string, over: Record<string, unknown> = {}) => ({ id: "q", data, from: { id: 5 }, message: { chat: { id: -100 } }, ...over });
  assert.equal(onTelegramCallback(dn, cq("v:1:up"), null), "👍 #1");
  assert.deepEqual(tally(dn, 1), [1, 0]);
  assert.match(onTelegramCallback(dn, cq("v:1:down"), null)!, /^👎 #1/);
  assert.deepEqual(tally(dn, 1), [0, 1]);
  assert.equal(onTelegramCallback(dn, cq("v:99:up"), null), "No item #99.");
  assert.equal(onTelegramCallback(dn, cq("other"), null), null);
  assert.equal(onTelegramCallback(dn, cq("v:1:up", { from: { id: 6, is_bot: true } }), null), null);
  assert.equal(onTelegramCallback(dn, cq("v:1:up"), new Set(["42"])), null, "chat allowlist applies");

  const mr = (over: Record<string, unknown> = {}) => ({
    chat: { id: -100 }, message_id: 70, user: { id: 8 }, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👍" }], ...over,
  });
  assert.deepEqual(onTelegramReaction(dn, mr(), null), [1]);
  assert.deepEqual(tally(dn, 1), [1, 1]);
  assert.deepEqual(onTelegramReaction(dn, mr({ old_reaction: [{ type: "emoji", emoji: "👍" }], new_reaction: [{ type: "emoji", emoji: "👍" }] }), null), [], "no new reaction");
  assert.deepEqual(onTelegramReaction(dn, mr({ new_reaction: [] }), null), [], "removal is ignored");
  assert.deepEqual(onTelegramReaction(dn, mr({ new_reaction: [{ type: "emoji", emoji: "🔥" }] }), null), []);
  assert.deepEqual(onTelegramReaction(dn, mr({ message_id: 1 }), null), []);
  assert.deepEqual(onTelegramReaction(dn, mr({ user: { id: 1, is_bot: true } }), null), []);
  assert.deepEqual(onTelegramReaction(dn, mr(), new Set(["1"])), []);
});

test("line: 👍 / 👎 postbacks vote as line:<user>; junk and missing items are handled", async () => {
  const dn = fresh();
  await replyFor(dn, "https://rich.test/a");
  const pb = (data: string, userId: string | null = "Uabc") => ({ type: "postback", replyToken: "r", source: { userId: userId ?? undefined }, postback: { data } });
  assert.equal(onLinePostback(dn, pb("v=1&d=up")), "👍 #1");
  assert.deepEqual(tally(dn, 1), [1, 0]);
  assert.match(onLinePostback(dn, pb("v=1&d=down"))!, /^👎 #1/);
  assert.deepEqual(tally(dn, 1), [0, 1]);
  assert.equal(onLinePostback(dn, pb("v=77&d=up")), "No item #77.");
  for (const bad of ["", "v=x&d=up", "v=1&d=sideways", "d=up", "v=0&d=up"]) assert.equal(onLinePostback(dn, pb(bad)), null, bad);
  assert.equal(onLinePostback(dn, pb("v=1&d=up", null)), null);
});
