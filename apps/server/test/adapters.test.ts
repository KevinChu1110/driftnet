import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDriftnet, registerExtractor } from "@driftnet/core";
import { catchUp, handleDiscordMessage, type ChatMessage } from "../src/adapters/discord.ts";
import { chatAllowlist, linkEntityUrls } from "../src/adapters/telegram.ts";

registerExtractor({
  name: "adapters-fixture",
  matches: (u) => u.startsWith("https://adapters.test/"),
  extract: async (url) => ({ url, kind: "repo", title: url.split("/").pop()!, text: "", outlinks: [], meta: {} }),
});

const msg = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, channelId: "C", content, authorId: "u1", fromBot: false, createdAt: Number(id), ...extra,
});
const fresh = () => createDriftnet({ DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-adapters-")), DRIFTNET_JUDGE: "off" });

test("telegram: hidden text_link URLs are picked up; the chat allowlist parses", () => {
  const entities = [{ type: "bold" }, { type: "text_link", url: "https://adapters.test/hidden" }, { type: "text_link" }];
  assert.deepEqual(linkEntityUrls(entities), ["https://adapters.test/hidden"]);
  assert.deepEqual(linkEntityUrls(undefined), []);
  assert.equal(chatAllowlist({}), null);
  assert.deepEqual([...chatAllowlist({ DRIFTNET_TELEGRAM_CHATS: " 1, -100 ,," })!], ["1", "-100"]);
});

test("discord: catch-up keeps paging until a short batch", async () => {
  const dn = fresh();
  await handleDiscordMessage(dn, msg("1", "hi"));
  const calls: string[] = [];
  const handled = await catchUp(dn, async (_c, after) => {
    calls.push(after);
    const start = Number(after);
    const n = start === 1 ? 100 : 5;
    return Array.from({ length: n }, (_, i) => msg(String(start + 1 + i), "chatter"));
  });
  assert.deepEqual(calls, ["1", "101"]);
  assert.equal(handled, 105);
  assert.equal(dn.store.getState("discord:last:C"), "106");
});

test("discord: a forwarded message is read from its snapshot; a failed message is not marked handled", async () => {
  const dn = fresh();
  await handleDiscordMessage(dn, msg("5", "", { forwardedContent: ["look https://adapters.test/fwd"] }));
  assert.ok(dn.store.findByUrl("https://adapters.test/fwd"));
  assert.equal(dn.store.getState("discord:last:C"), "5");
  const broken = { ...dn, pipeline: { ingestMessage: async () => { throw new Error("boom"); } } } as unknown as typeof dn;
  await handleDiscordMessage(broken, msg("6", "https://adapters.test/x"));
  assert.equal(dn.store.getState("discord:last:C"), "5");
});
