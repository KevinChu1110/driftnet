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

test("a link is catalogued and the reply ends with how to vote", async () => {
  const reply = await handleChatText(dn, "nice one https://chat.test/a", ctx);
  assert.match(reply!, /Fixture tool/);
  assert.match(reply!, /#1 · reply 👍1 \/ 👎1$/);
});

test("votes in every spelling are recorded, once per person", async () => {
  assert.match((await handleChatText(dn, "👎1 spam", ctx))!, /👎 #1/);
  assert.match((await handleChatText(dn, "+1", ctx))!, /👍 #1/); // same voter changes their mind
  assert.match((await handleChatText(dn, "-1", { ...ctx, userId: "u2" }))!, /👎 #1/);
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
