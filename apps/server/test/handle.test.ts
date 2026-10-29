import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDriftnet, registerExtractor } from "@driftnet/core";
import { handleChatText } from "../src/adapters/handle.ts";

registerExtractor({
  name: "chat-fixture",
  matches: (u) => u.startsWith("https://chat.test/"),
  extract: async (url) => ({ url, kind: "repo", title: "Fixture tool", text: "", outlinks: [], meta: {} }),
});

const dn = createDriftnet({
  DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-chat-")),
  DRIFTNET_JUDGE: "off",
  DRIFTNET_LOCALE: "en",
});
const ctx = { platform: "telegram", chatId: "group", userId: "u1" };

test("messages without a link get no reply", async () => {
  assert.equal(await handleChatText(dn, "good morning", ctx), null);
});

test("a link is catalogued; by default the reply is one line and where to read it", async () => {
  process.env.DRIFTNET_PUBLIC_URL = "https://driftnet.example";
  try {
    const reply = await handleChatText(dn, "nice one https://chat.test/a", ctx);
    assert.equal(reply, "📌 Fixture tool｜Other ⏳\nhttps://driftnet.example/#item-1");
    // The same link again is marked as seen before.
    assert.match((await handleChatText(dn, "https://chat.test/a", ctx))!, /\(already saved\)/);
  } finally {
    delete process.env.DRIFTNET_PUBLIC_URL;
  }
});

test("DRIFTNET_REPLY=full puts the summary and voting help in the chat; off stays silent", async () => {
  process.env.DRIFTNET_REPLY = "full";
  try {
    const reply = await handleChatText(dn, "https://chat.test/full", ctx);
    assert.match(reply!, /Fixture tool/);
    assert.match(reply!, /reply 👍\d+ \/ 👎\d+$/);
    process.env.DRIFTNET_REPLY = "off";
    assert.equal(await handleChatText(dn, "https://chat.test/quiet", ctx), null);
    assert.ok(dn.store.findByUrl("https://chat.test/quiet"), "still catalogued");
  } finally {
    delete process.env.DRIFTNET_REPLY;
  }
});

test("votes in every spelling are recorded, once per person", async () => {
  assert.match((await handleChatText(dn, "👎1 spam", ctx))!, /👎 #1/);
  assert.match((await handleChatText(dn, "+#1", ctx))!, /👍 #1/); // same voter changes their mind
  assert.match((await handleChatText(dn, "-#1 wrong tool", { ...ctx, userId: "u2" }))!, /👎 #1/);
  assert.equal((await handleChatText(dn, "👍99", ctx))!, "No item #99.");
  const rep = dn.store.reputation(dn.store.get(1)!.source);
  assert.deepEqual([rep.up, rep.down], [1, 1]);
});

test("a link to a private address gets no reply and is not stored", async () => {
  const before = dn.store.stats().items;
  const reply = await handleChatText(dn, "http://127.0.0.1:8650/admin", ctx);
  assert.ok(!reply);
  assert.equal(dn.store.stats().items, before);
});

test("only explicit votes count; chatter and anything with a link is not a vote", async () => {
  for (const t of ["+1 for this", "-3 degrees", "+12", "-12 spam", "👍 nice"]) assert.equal(await handleChatText(dn, t, ctx), null, t);
  const reply = await handleChatText(dn, "-3 degrees https://chat.test/degrees", ctx);
  assert.ok(reply, "the link is ingested, not treated as a vote");
  assert.ok(dn.store.findByUrl("https://chat.test/degrees"));
  assert.match((await handleChatText(dn, "👍 #1", ctx))!, /👍 #1/);
});
