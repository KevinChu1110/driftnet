import type { Driftnet } from "@driftnet/core";
import { handleChat, type ChatReply } from "./handle.ts";
import { reactionVote, rememberReply, voteOnReply } from "./reactions.ts";
import { discordEmbeds, warnOnce } from "./rich.ts";
import type { Report } from "../chats.ts";

const LAST = "discord:last:";
const MAX_CATCH_UP = 1000; // per channel
const DEFAULT_API_URL = "https://discord.com/api/v10";
const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const USER_AGENT = "DiscordBot (https://github.com/KevinChu1110/driftnet, 1.0)";
const SUPPRESS_EMBEDS = 1 << 2; // 4
const RECONNECT_MS = 3_000;

// Guilds (1<<0) | GuildMessages (1<<9) | GuildMessageReactions (1<<10) |
// DirectMessages (1<<12) | DirectMessageReactions (1<<13) | MessageContent (1<<15)
const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 13) | (1 << 15); // 46593

const FATAL_CLOSE_CODES: Record<number, string> = {
  4004: "Authentication failed (invalid DISCORD_BOT_TOKEN)",
  4010: "Invalid shard",
  4011: "Sharding required",
  4012: "Invalid API version",
  4013: "Invalid intents",
  4014: "Disallowed intents (enable Message Content Intent in the Discord Developer Portal)",
};

const api = (path: string) => `${(process.env.DISCORD_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "")}${path}`;

const authHeaders = (token: string, json = false): Record<string, string> => ({
  authorization: `Bot ${token}`,
  "user-agent": USER_AGENT,
  ...(json ? { "content-type": "application/json" } : {}),
});

interface RawDiscordMessage {
  id: string;
  channel_id: string;
  content?: string;
  author?: { id?: string; bot?: boolean };
  timestamp?: string;
  message_snapshots?: Array<{
    content?: string;
    embeds?: Array<{ url?: string }>;
    message?: {
      content?: string;
      embeds?: Array<{ url?: string }>;
    };
  }>;
}

/** The parts of a Discord message driftnet uses, so catch-up can be tested without a gateway. */
export interface ChatMessage {
  id: string;
  channelId: string;
  content: string;
  authorId: string;
  fromBot: boolean;
  createdAt: number;
  /** Where a forwarded message's text lives (message_snapshots). */
  forwardedContent?: string[];
}

/**
 * DISCORD_CHANNELS (comma-separated channel ids) limits driftnet to those
 * channels — needed when the bot token is shared with another bot (e.g. a
 * Hermes profile restricted to its own channels), so the two never answer the
 * same message. Empty: every channel the bot can read.
 */
export function channelFilter(env: NodeJS.ProcessEnv = process.env): (channelId: string) => boolean {
  const ids = new Set((env.DISCORD_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  return (channelId) => ids.size === 0 || ids.has(channelId);
}

/** Handle one message and remember it as the channel's latest. Returns the reply, if any. */
export async function processDiscordMessage(dn: Driftnet, msg: ChatMessage, allowed = channelFilter()): Promise<ChatReply | null> {
  if (!allowed(msg.channelId)) return null;
  let reply: ChatReply | null = null;
  if (!msg.fromBot) {
    // Forwarded messages arrive with empty content; the text is in the snapshot.
    const text = msg.content || (msg.forwardedContent ?? []).filter(Boolean).join("\n");
    if (text) {
      try {
        reply = await handleChat(dn, text, { platform: "discord", chatId: msg.channelId, userId: msg.authorId });
      } catch (err) {
        console.warn("[discord]", (err as Error).message);
        return null; // not remembered as handled: the next catch-up retries it
      }
    }
  }
  dn.store.setState(LAST + msg.channelId, msg.id);
  return reply;
}

/** The plain reply text (catch-up, tests). */
export async function handleDiscordMessage(dn: Driftnet, msg: ChatMessage, allowed = channelFilter()): Promise<string | null> {
  return (await processDiscordMessage(dn, msg, allowed))?.text ?? null;
}

/** What a Discord reply sender takes and returns, as far as we use it. */
export type DiscordSend = (options: Record<string, unknown>) => Promise<{ id: string; react: (emoji: string) => Promise<unknown> }>;

/**
 * Reply with one embed per item (≤ 10, no mentions); if Discord refuses the
 * embeds (a missing Embed Links permission), send the plain text instead.
 * Rich replies get 👍 / 👎 seeded on them so voting is one click.
 */
export async function sendDiscordReply(dn: Driftnet, send: DiscordSend, reply: ChatReply): Promise<void> {
  const allowedMentions = { parse: [] };
  let sent: Awaited<ReturnType<DiscordSend>> | undefined;
  let rich = false;
  if (reply.rich?.items.length) {
    const { embeds, extra } = discordEmbeds(reply.rich);
    try {
      sent = await send({ ...(extra ? { content: reply.rich.t.digest.more(extra) } : {}), embeds, allowedMentions });
      rich = true;
    } catch (err) {
      warnOnce("discord", (err as Error).message);
    }
  }
  sent ??= await send({ content: reply.text.slice(0, 2000), flags: ["SuppressEmbeds"], allowedMentions });
  rememberReply(dn.store, `discord:${sent.id}`, reply.ids);
  if (rich) {
    try {
      await sent.react("👍");
      await sent.react("👎");
    } catch { /* no Add Reactions permission: people can still add their own */ }
  }
}

/**
 * A 👍 / 👎 reaction on one of the bot's replies votes on its items as
 * `discord:<user id>`. Removing a reaction is ignored: the store keeps one vote
 * per person and has no "unvote", so react with the other emoji to change it.
 */
export function onDiscordReaction(
  dn: Driftnet,
  r: { messageId: string; channelId: string; emoji: string | null; userId: string; fromBot: boolean },
  allowed = channelFilter(),
): number[] {
  if (r.fromBot || !allowed(r.channelId)) return [];
  const vote = reactionVote(r.emoji);
  if (!vote) return [];
  return voteOnReply(dn, `discord:${r.messageId}`, `discord:${r.userId}`, vote);
}

/**
 * The gateway does not replay what happened while driftnet was off. For every
 * channel driftnet has seen before (never a whole server's history), read what
 * came after the last message it handled, oldest first, without replying —
 * answering hours-old messages would flood the channel.
 */
export async function catchUp(
  dn: Driftnet,
  fetchAfter: (channelId: string, afterId: string) => Promise<ChatMessage[]>,
): Promise<number> {
  let handled = 0;
  const allowed = channelFilter();
  for (const { key, value: after } of dn.store.stateWithPrefix(LAST)) {
    const channelId = key.slice(LAST.length);
    if (!allowed(channelId)) continue;
    try {
      // The API returns at most 100 per call: keep paging until a short batch.
      let cursor = after;
      let total = 0;
      for (;;) {
        const batch = (await fetchAfter(channelId, cursor)).sort((a, b) => a.createdAt - b.createdAt);
        if (batch.length && total === 0) console.log(`[discord] catching up in ${channelId}`);
        for (const msg of batch) {
          await handleDiscordMessage(dn, msg);
          handled++;
          total++;
        }
        if (batch.length < 100 || total >= MAX_CATCH_UP) break;
        cursor = batch[batch.length - 1]!.id;
      }
    } catch (err) {
      // One deleted channel or missing permission must not stop the others.
      console.warn(`[discord] catch-up failed for ${channelId}:`, (err as Error).message);
    }
  }
  return handled;
}

const toChatMessage = (m: RawDiscordMessage): ChatMessage => {
  const ts = m.timestamp ? Date.parse(m.timestamp) : 0;
  const forwardedContent = (m.message_snapshots ?? []).flatMap((snap) => {
    const inner = snap.message ?? snap;
    return [
      ...(inner.content ? [inner.content] : []),
      ...(inner.embeds ?? []).map((e) => e.url).filter((u): u is string => Boolean(u)),
    ];
  });
  return {
    id: m.id,
    channelId: m.channel_id,
    content: m.content ?? "",
    authorId: m.author?.id ?? "",
    fromBot: Boolean(m.author?.bot),
    createdAt: Number.isNaN(ts) ? 0 : ts,
    forwardedContent,
  };
};

function toRestPayload(options: Record<string, unknown>, replyToId: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { message_reference: { message_id: replyToId } };
  if (options.content !== undefined) payload.content = options.content;
  if (options.embeds !== undefined) payload.embeds = options.embeds;
  if (options.allowedMentions !== undefined) payload.allowed_mentions = options.allowedMentions;
  else if (options.allowed_mentions !== undefined) payload.allowed_mentions = options.allowed_mentions;
  if (Array.isArray(options.flags)) {
    let bits = 0;
    if (options.flags.includes("SuppressEmbeds")) bits |= SUPPRESS_EMBEDS;
    if (bits) payload.flags = bits;
  } else if (typeof options.flags === "number") {
    payload.flags = options.flags;
  }
  return payload;
}

function makeDiscordReplySender(token: string, channelId: string, msgId: string): DiscordSend {
  return async (options) => {
    const res = await fetch(api(`/channels/${encodeURIComponent(channelId)}/messages`), {
      method: "POST",
      headers: authHeaders(token, true),
      body: JSON.stringify(toRestPayload(options, msgId)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Discord answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const sent = (await res.json()) as { id: string };
    return {
      id: sent.id,
      react: async (emoji: string) => {
        const r = await fetch(
          api(`/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(sent.id)}/reactions/${encodeURIComponent(emoji)}/@me`),
          {
            method: "PUT",
            headers: authHeaders(token),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!r.ok) throw new Error(`Discord react answered ${r.status}`);
        await r.body?.cancel();
      },
    };
  };
}

async function fetchMessagesAfter(token: string, channelId: string, afterId: string): Promise<ChatMessage[]> {
  const res = await fetch(
    api(`/channels/${encodeURIComponent(channelId)}/messages?after=${encodeURIComponent(afterId)}&limit=100`),
    {
      method: "GET",
      headers: authHeaders(token),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`Discord answered ${res.status}`);
  const rows = (await res.json()) as RawDiscordMessage[];
  return Array.isArray(rows) ? rows.map(toChatMessage) : [];
}

async function resolveGatewayUrl(token: string): Promise<string> {
  try {
    const res = await fetch(api("/gateway/bot"), {
      method: "GET",
      headers: authHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) throw new Error(FATAL_CLOSE_CODES[4004]!);
    if (res.ok) {
      const data = (await res.json()) as { url?: string };
      if (data.url && (/^wss:\/\//i.test(data.url) || (process.env.DISCORD_API_URL && /^ws:\/\//i.test(data.url)))) {
        return data.url.includes("?") ? data.url : `${data.url.replace(/\/+$/, "")}/?v=10&encoding=json`;
      }
    }
  } catch (err) {
    if ((err as Error).message === FATAL_CLOSE_CODES[4004]) throw err;
  }
  return DEFAULT_GATEWAY_URL;
}

/**
 * Discord via the gateway (no public URL needed). Needs DISCORD_BOT_TOKEN and the
 * Message Content intent enabled in the developer portal.
 */
export function startDiscord(dn: Driftnet, token: string, report: Report = () => {}): () => void {
  let stopped = false;
  let ws: WebSocket | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let seq: number | null = null;
  let botUserId: string | undefined;
  let caughtUp = false;

  const clearHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  const sendJson = (socket: WebSocket, payload: unknown) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, RECONNECT_MS);
  };

  const connect = async () => {
    if (stopped) return;
    let url: string;
    try {
      url = await resolveGatewayUrl(token);
    } catch (err) {
      if (stopped) return;
      console.warn("[discord]", (err as Error).message);
      report("error", (err as Error).message);
      return;
    }
    if (stopped) return;

    seq = null;
    const socket = new WebSocket(url);
    ws = socket;

    socket.onmessage = (ev) => {
      try {
        const payload = JSON.parse(String(ev.data)) as { op: number; d?: any; s?: number | null; t?: string | null };
        if (typeof payload.s === "number") seq = payload.s;

        switch (payload.op) {
          case 10: {
            const interval = Number(payload.d?.heartbeat_interval) || 41_250;
            clearHeartbeat();
            heartbeatTimer = setInterval(() => sendJson(socket, { op: 1, d: seq }), interval);
            sendJson(socket, {
              op: 2,
              d: {
                token,
                intents: GATEWAY_INTENTS,
                properties: { os: process.platform, browser: "driftnet", device: "driftnet" },
              },
            });
            break;
          }
          case 1:
            sendJson(socket, { op: 1, d: seq });
            break;
          case 7:
          case 9:
            clearHeartbeat();
            socket.close();
            break;
          case 0: {
            const d = payload.d;
            if (payload.t === "READY") {
              botUserId = d?.user?.id;
              const tag = d?.user?.discriminator && d.user.discriminator !== "0"
                ? `${d.user.username}#${d.user.discriminator}`
                : (d?.user?.username ?? "bot");
              console.log(`[discord] ready as ${tag}`);
              report("connected", tag);
              if (!caughtUp) {
                caughtUp = true;
                void catchUp(dn, (channelId, after) => fetchMessagesAfter(token, channelId, after));
              }
            } else if (payload.t === "MESSAGE_CREATE") {
              if (!d || d.author?.id === botUserId || d.author?.bot) break;
              const msg = toChatMessage(d as RawDiscordMessage);
              void processDiscordMessage(dn, msg)
                .catch((err) => {
                  console.warn("[discord]", (err as Error).message);
                  return null;
                })
                .then((reply) => {
                  if (reply) {
                    return sendDiscordReply(dn, makeDiscordReplySender(token, msg.channelId, msg.id), reply).catch((err) =>
                      console.warn("[discord]", (err as Error).message),
                    );
                  }
                });
            } else if (payload.t === "MESSAGE_REACTION_ADD") {
              if (!d || d.user_id === botUserId || d.member?.user?.bot) break;
              try {
                onDiscordReaction(dn, {
                  messageId: String(d.message_id ?? ""),
                  channelId: String(d.channel_id ?? ""),
                  emoji: d.emoji?.name ?? null,
                  userId: String(d.user_id ?? ""),
                  fromBot: Boolean(d.member?.user?.bot),
                });
              } catch (err) {
                console.warn("[discord]", (err as Error).message);
              }
            }
            break;
          }
        }
      } catch (err) {
        console.warn("[discord] gateway message:", (err as Error).message);
      }
    };

    socket.onerror = () => {
      if (!stopped) report("error", "Discord gateway connection error");
    };

    socket.onclose = (ev) => {
      clearHeartbeat();
      if (ws === socket) ws = undefined;
      if (stopped) return;
      const fatal = FATAL_CLOSE_CODES[ev.code];
      if (fatal) {
        console.warn("[discord]", fatal);
        report("error", fatal);
        return;
      }
      scheduleReconnect();
    };
  };

  void connect();

  return () => {
    stopped = true;
    clearHeartbeat();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    ws?.close();
    ws = undefined;
  };
}

/** Post a message to a channel over REST with the bot token (a scheduled digest); no gateway needed. Throws on refusal. */
export async function sendDiscordMessage(token: string, channelId: string, text: string): Promise<void> {
  const res = await fetch(api(`/channels/${encodeURIComponent(channelId)}/messages`), {
    method: "POST",
    headers: authHeaders(token, true),
    // flags 4: no link embeds. No @-mentions from card text.
    body: JSON.stringify({ content: text.slice(0, 2000), flags: SUPPRESS_EMBEDS, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Discord answered ${res.status}`);
  await res.body?.cancel();
}
