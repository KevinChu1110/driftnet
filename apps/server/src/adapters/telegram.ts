import type { Driftnet } from "@driftnet/core";
import { handleChatText } from "./handle.ts";

/**
 * Telegram via long polling — no public URL needed, so it is the easiest adapter
 * to run on a laptop. Set TELEGRAM_BOT_TOKEN (from @BotFather). In groups, turn
 * off privacy mode (/setprivacy) so the bot sees links that don't mention it.
 */
/** DRIFTNET_TELEGRAM_CHATS (comma-separated chat ids): only those chats may use the bot. Unset: all. */
export function chatAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const ids = (env.DRIFTNET_TELEGRAM_CHATS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

/** URLs of text_link entities. */
export function linkEntityUrls(entities: any): string[] {
  return (Array.isArray(entities) ? entities : []).filter((e) => e?.type === "text_link" && typeof e.url === "string").map((e) => e.url);
}

export function startTelegram(dn: Driftnet, token: string): () => void {
  const api = (method: string, body: unknown) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<{ ok: boolean; result: any }>);

  // Persisted after each handled update, so a restart doesn't hand it out again (double replies).
  let offset = Number(dn.store.getState("telegram:offset") ?? 0);
  let running = true;
  const allowed = chatAllowlist();
  const seenChats = new Set<string>();

  const handle = async (msg: any) => {
    let text: string | undefined = msg?.text ?? msg?.caption;
    if (!text) return;
    const chatId = String(msg.chat.id);
    if (allowed) {
      if (!allowed.has(chatId)) return;
    } else if (!seenChats.has(chatId)) {
      seenChats.add(chatId);
      console.log(`[telegram] message from chat ${chatId}; set DRIFTNET_TELEGRAM_CHATS to limit who can use the bot`);
    }
    // Hidden links ("text_link") carry their URL in the entity, not in the text.
    const hidden = linkEntityUrls(msg.entities ?? msg.caption_entities);
    if (hidden.length) text += "\n" + hidden.join("\n");
    const reply = await handleChatText(dn, text, { platform: "telegram", chatId, userId: String(msg.from?.id ?? "") });
    if (reply) {
      await api("sendMessage", {
        chat_id: msg.chat.id,
        text: reply,
        reply_parameters: { message_id: msg.message_id },
        link_preview_options: { is_disabled: true },
      });
    }
  };

  (async () => {
    while (running) {
      try {
        const res = await api("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
        for (const u of res.ok ? res.result : []) {
          try {
            await handle(u.message);
          } catch (err) {
            console.warn("[telegram] update", u.update_id, (err as Error).message);
          }
          offset = u.update_id + 1;
          dn.store.setState("telegram:offset", String(offset));
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

/** Post a plain message to a chat (a scheduled digest); throws when Telegram refuses it. */
export async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || !body.ok) throw new Error(body.description ?? `Telegram answered ${res.status}`);
}
