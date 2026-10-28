import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDriftnet, registerExtractor } from "@driftnet/core";
import { catchUp, handleDiscordMessage, type ChatMessage } from "../src/adapters/discord.ts";

registerExtractor({
  name: "discord-fixture",
  matches: (u) => u.startsWith("https://discord.test/"),
  extract: async (url) => ({ url, kind: "repo", title: url.slice(-1), text: "", outlinks: [], meta: {} }),
});

const msg = (id: string, channelId: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, channelId, content, authorId: "u1", fromBot: false, createdAt: Number(id), ...extra,
});

test("Discord catch-up reads what was missed, in order, only in channels seen before", async () => {
  const dn = createDriftnet({ DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-discord-")), DRIFTNET_JUDGE: "off" });
  // While running: one message in each of two channels.
  assert.ok(await handleDiscordMessage(dn, msg("100", "A", "https://discord.test/a")));
  assert.equal(await handleDiscordMessage(dn, msg("200", "B", "hello")), null);

  const asked: [string, string][] = [];
  const handled = await catchUp(dn, async (channel, after) => {
    asked.push([channel, after]);
    if (channel === "B") throw new Error("Missing Access"); // one broken channel
    // Out of order on purpose, plus a bot message.
    return [
      msg("103", "A", "https://discord.test/c"),
      msg("101", "A", "https://discord.test/b"),
      msg("102", "A", "https://discord.test/x", { fromBot: true }),
    ];
  });

  assert.deepEqual(asked.sort(), [["A", "100"], ["B", "200"]]);
  assert.equal(handled, 3);
  const titles = dn.store.list({ limit: 10 }).map((i) => i.title).sort();
  assert.deepEqual(titles, ["a", "b", "c"]); // the bot's link was not catalogued
  assert.equal(dn.store.getState("discord:last:A"), "103"); // next catch-up starts after the newest
  assert.equal(dn.store.getState("discord:last:B"), "200"); // untouched after the error
});
