import { Client, Events, GatewayIntentBits, type Message } from "discord.js";
import type { Driftnet } from "@driftnet/core";
import { handleChatText } from "./handle.ts";

const LAST = "discord:last:";
const MAX_CATCH_UP = 1000; // per channel

/** The parts of a Discord message driftnet uses, so catch-up can be tested without a gateway. */
export interface ChatMessage {
  id: string;
  channelId: string;
  content: string;
  authorId: string;
  fromBot: boolean;
  createdAt: number;
  /** Where a forwarded message's text lives (messageSnapshots). */
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

/** Handle one message and remember it as the channel's latest. Returns the reply text, if any. */
export async function handleDiscordMessage(dn: Driftnet, msg: ChatMessage, allowed = channelFilter()): Promise<string | null> {
  if (!allowed(msg.channelId)) return null;
  let reply: string | null = null;
  if (!msg.fromBot) {
    // Forwarded messages arrive with empty content; the text is in the snapshot.
    const text = msg.content || (msg.forwardedContent ?? []).filter(Boolean).join("\n");
    if (text) {
      try {
        reply = await handleChatText(dn, text, { platform: "discord", chatId: msg.channelId, userId: msg.authorId });
      } catch (err) {
        console.warn("[discord]", (err as Error).message);
        return null; // not remembered as handled: the next catch-up retries it
      }
    }
  }
  dn.store.setState(LAST + msg.channelId, msg.id);
  return reply;
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

const toChatMessage = (m: Message): ChatMessage => ({
  id: m.id,
  channelId: m.channelId,
  content: m.content,
  authorId: m.author.id,
  fromBot: m.author.bot,
  createdAt: m.createdTimestamp,
  forwardedContent: [...(((m as any).messageSnapshots?.values?.() ?? []) as Iterable<any>)].flatMap((snap) => [
    snap.content,
    ...(snap.embeds ?? []).map((e: any) => e.url),
  ]),
});

/**
 * Discord via the gateway (no public URL needed). Needs DISCORD_BOT_TOKEN and the
 * Message Content intent enabled in the developer portal.
 */
export function startDiscord(dn: Driftnet, token: string): () => void {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  });

  client.on(Events.MessageCreate, async (msg) => {
    const reply = await handleDiscordMessage(dn, toChatMessage(msg)).catch((err) => {
      console.warn("[discord]", (err as Error).message);
      return null;
    });
    if (reply) {
      await msg
        .reply({ content: reply.slice(0, 2000), flags: ["SuppressEmbeds"], allowedMentions: { parse: [] } })
        .catch((err) => console.warn("[discord]", (err as Error).message));
    }
  });
  client.once(Events.ClientReady, async (c) => {
    console.log(`[discord] ready as ${c.user.tag}`);
    await catchUp(dn, async (channelId, after) => {
      const channel = await c.channels.fetch(channelId);
      if (!channel?.isTextBased()) return [];
      return [...(await channel.messages.fetch({ after, limit: 100 })).values()].map(toChatMessage);
    });
  });
  void client.login(token);
  return () => void client.destroy();
}

/** Post a message to a channel over REST with the bot token (a scheduled digest); no gateway needed. Throws on refusal. */
export async function sendDiscordMessage(token: string, channelId: string, text: string): Promise<void> {
  const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    // flags 4: no link embeds. No @-mentions from card text.
    body: JSON.stringify({ content: text.slice(0, 2000), flags: 4, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Discord answered ${res.status}`);
  await res.body?.cancel();
}
