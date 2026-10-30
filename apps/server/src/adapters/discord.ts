import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import type { Driftnet } from "@driftnet/core";
import { handleChat, type ChatReply } from "./handle.ts";
import { reactionVote, rememberReply, voteOnReply } from "./reactions.ts";
import { discordEmbeds, warnOnce } from "./rich.ts";
import type { Report } from "../chats.ts";

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

/** What discord.js's `message.reply` takes and returns, as far as we use it. */
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
export function startDiscord(dn: Driftnet, token: string, report: Report = () => {}): () => void {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      // Voting by reaction (enable nothing extra in the portal: these are not privileged).
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ],
    // Reactions on messages the bot hasn't cached (after a restart) still arrive.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  });

  client.on(Events.MessageCreate, async (msg) => {
    const reply = await processDiscordMessage(dn, toChatMessage(msg)).catch((err) => {
      console.warn("[discord]", (err as Error).message);
      return null;
    });
    if (reply) {
      await sendDiscordReply(dn, (o) => msg.reply(o as any), reply).catch((err) => console.warn("[discord]", (err as Error).message));
    }
  });
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (user.bot || user.id === client.user?.id) return;
      onDiscordReaction(dn, {
        messageId: reaction.message.id,
        channelId: reaction.message.channelId,
        emoji: reaction.emoji.name,
        userId: user.id,
        fromBot: !!user.bot,
      });
    } catch (err) {
      console.warn("[discord]", (err as Error).message);
    }
  });
  client.once(Events.ClientReady, async (c) => {
    console.log(`[discord] ready as ${c.user.tag}`);
    report("connected", c.user.tag);
    await catchUp(dn, async (channelId, after) => {
      const channel = await c.channels.fetch(channelId);
      if (!channel?.isTextBased()) return [];
      return [...(await channel.messages.fetch({ after, limit: 100 })).values()].map(toChatMessage);
    });
  });
  client.on(Events.Error, (err) => report("error", err.message));
  // A wrong token, or the Message Content intent left off ("Used disallowed intents").
  client.login(token).catch((err: Error) => {
    console.warn("[discord]", err.message);
    report("error", err.message);
  });
  return () => void client.destroy().catch(() => {});
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
