import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDriftnet, registerExtractor } from "@driftnet/core";
import { catchUp, handleDiscordMessage, sendDiscordMessage, startDiscord, type ChatMessage } from "../src/adapters/discord.ts";

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

test("DISCORD_CHANNELS keeps driftnet out of channels it shares with another bot", async () => {
  const dn = createDriftnet({ DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-discord-")), DRIFTNET_JUDGE: "off" });
  process.env.DISCORD_CHANNELS = "OURS, ALSO";
  try {
    assert.equal(await handleDiscordMessage(dn, msg("1", "HERMES", "https://discord.test/h")), null);
    assert.equal(dn.store.getState("discord:last:HERMES"), undefined, "not even remembered");
    assert.ok(await handleDiscordMessage(dn, msg("2", "OURS", "https://discord.test/o")));
    assert.ok(await handleDiscordMessage(dn, msg("3", "ALSO", "https://discord.test/p")));
  } finally {
    delete process.env.DISCORD_CHANNELS;
  }
});

test("sendDiscordMessage posts to DISCORD_API_URL with Bot auth, User-Agent, flags=4 and allowed_mentions", async () => {
  const realFetch = globalThis.fetch;
  process.env.DISCORD_API_URL = "https://mock-discord.test/api/v10";
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status: calls.length === 1 ? 200 : 403 });
  }) as typeof fetch;
  try {
    await sendDiscordMessage("tok-123", "chan-9", "hello world");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://mock-discord.test/api/v10/channels/chan-9/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bot tok-123");
    assert.match(headers["user-agent"]!, /^DiscordBot /);
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      content: "hello world",
      flags: 4,
      allowed_mentions: { parse: [] },
    });
    await assert.rejects(() => sendDiscordMessage("tok-123", "chan-9", "fail"), /Discord answered 403/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.DISCORD_API_URL;
  }
});

test("startDiscord runs Gateway v10 lifecycle: Identify, Heartbeat, READY + catchUp, MESSAGE_CREATE, MESSAGE_REACTION_ADD", async () => {
  const dn = createDriftnet({ DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-discord-gw-")), DRIFTNET_JUDGE: "off" });
  // Seed a channel so READY triggers catchUp
  dn.store.setState("discord:last:C1", "10");

  const realFetch = globalThis.fetch;
  const realWS = globalThis.WebSocket;
  process.env.DISCORD_API_URL = "https://mock-discord.test/api/v10";

  const restCalls: { method: string; url: string; body?: any }[] = [];
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    restCalls.push({ method, url, body });

    if (url.endsWith("/gateway/bot")) {
      return new Response(JSON.stringify({ url: "wss://mock-gw.test" }), { status: 200 });
    }
    if (url.includes("/channels/C1/messages?after=10")) {
      return new Response(JSON.stringify([
        {
          id: "11",
          channel_id: "C1",
          content: "",
          author: { id: "u2", bot: false },
          timestamp: "2026-01-01T00:00:01.000Z",
          message_snapshots: [{ message: { content: "forwarded https://discord.test/f", embeds: [] } }],
        },
      ]), { status: 200 });
    }
    if (method === "POST" && url.endsWith("/channels/C1/messages")) {
      return new Response(JSON.stringify({ id: "reply-1" }), { status: 200 });
    }
    if (method === "PUT" && url.includes("/reactions/")) {
      return new Response(null, { status: 204 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  let socket: FakeWebSocket | undefined;
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    sent: any[] = [];
    closed = false;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((ev: { code: number }) => void) | null = null;
    constructor(public url: string) {
      socket = this;
    }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; this.readyState = 3; }
    emit(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  }
  (globalThis as any).WebSocket = FakeWebSocket;

  const reports: [string, string | undefined][] = [];
  const stop = startDiscord(dn, "bot-token", (state, detail) => reports.push([state, detail]));
  try {
    // Wait for async resolveGatewayUrl -> FakeWebSocket creation
    for (let i = 0; i < 50 && !socket; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(socket, "WebSocket created");
    assert.equal(socket.url, "wss://mock-gw.test/?v=10&encoding=json");

    // 1. Hello (op 10) -> Identify (op 2) with intents 46593
    socket.emit({ op: 10, d: { heartbeat_interval: 60_000 } });
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0].op, 2);
    assert.equal(socket.sent[0].d.intents, 46593);
    assert.equal(socket.sent[0].d.token, "bot-token");

    // 2. Heartbeat request (op 1) -> Heartbeat reply (op 1)
    socket.emit({ op: 1, d: null });
    assert.deepEqual(socket.sent[1], { op: 1, d: null });

    // 3. READY -> report connected + catchUp
    socket.emit({ op: 0, s: 1, t: "READY", d: { user: { id: "bot-1", username: "driftbot", discriminator: "0" } } });
    assert.deepEqual(reports, [["connected", "driftbot"]]);
    for (let i = 0; i < 50 && !dn.store.findByUrl("https://discord.test/f"); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(dn.store.findByUrl("https://discord.test/f"), "catchUp ingested forwarded snapshot");
    assert.equal(dn.store.getState("discord:last:C1"), "11");

    // 4. MESSAGE_CREATE -> ingest + reply + seed reactions
    socket.emit({
      op: 0,
      s: 2,
      t: "MESSAGE_CREATE",
      d: { id: "12", channel_id: "C1", content: "check https://discord.test/g", author: { id: "u3", bot: false }, timestamp: "2026-01-01T00:00:02.000Z" },
    });
    for (let i = 0; i < 50 && !restCalls.some((c) => c.method === "PUT" && c.url.includes("%F0%9F%91%8E")); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const post = restCalls.find((c) => c.method === "POST" && c.url.endsWith("/channels/C1/messages"));
    assert.ok(post, "reply posted via REST");
    assert.deepEqual(post.body.message_reference, { message_id: "12" });
    assert.deepEqual(post.body.allowed_mentions, { parse: [] });

    // 5. MESSAGE_REACTION_ADD -> votes on replied item
    socket.emit({
      op: 0,
      s: 3,
      t: "MESSAGE_REACTION_ADD",
      d: { message_id: "reply-1", channel_id: "C1", user_id: "u3", emoji: { name: "👍" }, member: { user: { bot: false } } },
    });
    const item = dn.store.findByUrl("https://discord.test/g");
    assert.ok(item);
    assert.equal(dn.store.reputation(item.source).up, 1);

    // 6. Stop closes socket cleanly
    stop();
    assert.equal(socket.closed, true);
  } finally {
    stop();
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWS;
    delete process.env.DISCORD_API_URL;
  }
});
