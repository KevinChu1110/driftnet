import { Client, Events, GatewayIntentBits } from "discord.js";
import type { Driftnet } from "@driftnet/core";
import { handleChatText } from "./handle.ts";

/**
 * Discord via the gateway (no public URL needed). Needs DISCORD_BOT_TOKEN and the
 * Message Content intent enabled in the developer portal.
 */
export function startDiscord(dn: Driftnet, token: string): () => void {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  });
  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || !msg.content) return;
    try {
      const reply = await handleChatText(dn, msg.content, {
        platform: "discord",
        chatId: msg.channelId,
        userId: msg.author.id,
      });
      if (reply) await msg.reply({ content: reply.slice(0, 2000), flags: ["SuppressEmbeds"], allowedMentions: { parse: [] } });
    } catch (err) {
      console.warn("[discord]", (err as Error).message);
    }
  });
  client.once(Events.ClientReady, (c) => console.log(`[discord] ready as ${c.user.tag}`));
  void client.login(token);
  return () => void client.destroy();
}
