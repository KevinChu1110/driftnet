import type { Driftnet } from "@driftnet/core";
import { handleChatText } from "./handle.ts";

/**
 * Telegram via long polling — no public URL needed, so it is the easiest adapter
 * to run on a laptop. Set TELEGRAM_BOT_TOKEN (from @BotFather). In groups, turn
 * off privacy mode (/setprivacy) so the bot sees links that don't mention it.
 */
export function startTelegram(dn: Driftnet, token: string): () => void {
  const api = (method: string, body: unknown) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<{ ok: boolean; result: any }>);

  // Persisted so a restart doesn't hand the last batch out again (double replies).
  let offset = Number(dn.store.getState("telegram:offset") ?? 0);
  let running = true;
  (async () => {
    while (running) {
      try {
        const res = await api("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
        for (const u of res.ok ? res.result : []) {
          offset = u.update_id + 1;
          dn.store.setState("telegram:offset", String(offset));
          const msg = u.message;
          const text: string | undefined = msg?.text ?? msg?.caption;
          if (!text) continue;
          const reply = await handleChatText(dn, text, {
            platform: "telegram",
            chatId: String(msg.chat.id),
            userId: String(msg.from?.id ?? ""),
          });
          if (reply) {
            await api("sendMessage", {
              chat_id: msg.chat.id,
              text: reply,
              reply_parameters: { message_id: msg.message_id },
              link_preview_options: { is_disabled: true },
            });
          }
        }
      } catch (err) {
        console.warn("[telegram]", (err as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
  console.log("[telegram] polling");
  return () => { running = false; };
}
