import { Client, Events, GatewayIntentBits, type Message } from "discord.js";
import type { Driftnet } from "@driftnet/core";
import { handleChatText } from "./handle.ts";

const LAST = "discord:last:";

/** The parts of a Discord message driftnet uses, so catch-up can be tested without a gateway. */
export interface ChatMessage {
  id: string;
  channelId: string;
  content: string;
  authorId: string;
  fromBot: boolean;
  createdAt: number;
}

/** Handle one message and remember it as the channel's latest. Returns the reply text, if any. */
export async function handleDiscordMessage(dn: Driftnet, msg: ChatMessage): Promise<string | null> {
  dn.store.setState(LAST + msg.channelId, msg.id);
  if (msg.fromBot || !msg.content) return null;
  try {
    return await handleChatText(dn, msg.content, { platform: "discord", chatId: msg.channelId, userId: msg.authorId });
  } catch (err) {
    console.warn("[discord]", (err as Error).message);
    return null;
  }
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
  for (const { key, value: after } of dn.store.stateWithPrefix(LAST)) {
    const channelId = key.slice(LAST.length);
    try {
      const missed = (await fetchAfter(channelId, after)).sort((a, b) => a.createdAt - b.createdAt);
      if (missed.length) console.log(`[discord] catching up ${missed.length} message(s) in ${channelId}`);
      for (const msg of missed) {
        await handleDiscordMessage(dn, msg);
        handled++;
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
    const reply = await handleDiscordMessage(dn, toChatMessage(msg));
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
