import { Client, Events, GatewayIntentBits, type Message } from "discord.js";
import type { Driftnet } from "@driftnet/core";
import { handleChatText } from "./handle.ts";

const LAST = "discord:last:";

/**
 * Discord via the gateway (no public URL needed). Needs DISCORD_BOT_TOKEN and the
 * Message Content intent enabled in the developer portal.
 *
 * The gateway does not replay what happened while driftnet was off, so the last
 * message handled per channel is remembered and anything newer is read back on
 * startup. Only channels driftnet has seen before are caught up, never a whole
 * server's history.
 */
export function startDiscord(dn: Driftnet, token: string): () => void {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  });

  const handle = async (msg: Message, reply: boolean) => {
    if (msg.author.bot) return;
    try {
      const text = await handleChatText(dn, msg.content, { platform: "discord", chatId: msg.channelId, userId: msg.author.id });
      if (text && reply) await msg.reply({ content: text.slice(0, 2000), flags: ["SuppressEmbeds"], allowedMentions: { parse: [] } });
    } catch (err) {
      console.warn("[discord]", (err as Error).message);
    }
    dn.store.setState(LAST + msg.channelId, msg.id);
  };

  client.on(Events.MessageCreate, (msg) => void handle(msg, true));
  client.once(Events.ClientReady, async (c) => {
    console.log(`[discord] ready as ${c.user.tag}`);
    for (const { key, value: after } of dn.store.stateWithPrefix(LAST)) {
      try {
        const channel = await c.channels.fetch(key.slice(LAST.length));
        if (!channel?.isTextBased()) continue;
        const missed = [...(await channel.messages.fetch({ after, limit: 100 })).values()]
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        if (missed.length) console.log(`[discord] catching up ${missed.length} message(s) in ${key.slice(LAST.length)}`);
        // Catch-up is quiet: replying to hours-old messages would flood the channel.
        for (const msg of missed) await handle(msg, false);
      } catch (err) {
        console.warn("[discord] catch-up failed:", (err as Error).message);
      }
    }
  });
  void client.login(token);
  return () => void client.destroy();
}
