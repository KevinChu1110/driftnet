import { messages, type Driftnet } from "@driftnet/core";
import { handleChat, type ChatReply } from "./handle.ts";
import { reactionVote, rememberReply, voteOnItem, voteOnReply } from "./reactions.ts";
import { telegramRich, warnOnce } from "./rich.ts";

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

type Api = (method: string, body: unknown) => Promise<{ ok: boolean; result?: any; description?: string }>;

/**
 * Send a reply: rich (HTML + 👍/👎 inline keyboard) when the reply has it, and
 * the plain text when Telegram refuses that. Remembers message → items so the
 * message_reaction update can vote.
 */
export async function sendTelegramReply(api: Api, dn: Driftnet, chatId: string | number, messageId: number, reply: ChatReply): Promise<void> {
  const base = { chat_id: chatId, reply_parameters: { message_id: messageId }, link_preview_options: { is_disabled: true } };
  let res: Awaited<ReturnType<Api>> | undefined;
  if (reply.rich?.items.length) {
    const r = telegramRich(reply.rich);
    res = await api("sendMessage", { chat_id: chatId, text: r.text, parse_mode: "HTML", reply_markup: r.reply_markup, reply_parameters: base.reply_parameters, link_preview_options: base.link_preview_options }).catch(() => undefined);
    if (!res?.ok) {
      warnOnce("telegram", res?.description ?? "request failed");
      res = undefined;
    }
  }
  res ??= await api("sendMessage", { chat_id: chatId, text: reply.text, reply_parameters: base.reply_parameters, link_preview_options: base.link_preview_options });
  const sent = res?.result?.message_id;
  if (res?.ok && sent) rememberReply(dn.store, `telegram:${chatId}:${sent}`, reply.ids);
}

/** An inline-button press (`v:<id>:up|down`). Returns the toast to show, or null when it isn't one of ours. */
export function onTelegramCallback(dn: Driftnet, cq: any, allowed: Set<string> | null = chatAllowlist()): string | null {
  const m = /^v:(\d+):(up|down)$/.exec(String(cq?.data ?? ""));
  if (!m || !cq.from || cq.from.is_bot) return null;
  const chat = cq.message?.chat?.id;
  if (allowed && !allowed.has(String(chat))) return null;
  const id = Number(m[1]);
  const t = messages();
  const up = m[2] === "up";
  if (!voteOnItem(dn, id, `telegram:${cq.from.id}`, up ? 1 : -1)) return t.noItem(id);
  return up ? t.votedUp(id) : t.votedDown(id);
}

/** A message_reaction update: a newly added 👍 / 👎 on one of the bot's messages votes. Returns the item ids voted on. */
export function onTelegramReaction(dn: Driftnet, mr: any, allowed: Set<string> | null = chatAllowlist()): number[] {
  if (!mr?.user || mr.user.is_bot) return [];
  if (allowed && !allowed.has(String(mr.chat?.id))) return [];
  const had = new Set((mr.old_reaction ?? []).filter((r: any) => r.type === "emoji").map((r: any) => r.emoji));
  const added = (mr.new_reaction ?? []).filter((r: any) => r.type === "emoji" && !had.has(r.emoji)).map((r: any) => reactionVote(r.emoji)).filter(Boolean) as (1 | -1)[];
  const vote = added.at(-1);
  if (!vote) return [];
  return voteOnReply(dn, `telegram:${mr.chat.id}:${mr.message_id}`, `telegram:${mr.user.id}`, vote);
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
    const reply = await handleChat(dn, text, { platform: "telegram", chatId, userId: String(msg.from?.id ?? "") });
    if (reply) await sendTelegramReply(api, dn, msg.chat.id, msg.message_id, reply);
  };

  const handleCallback = async (cq: any) => {
    const toast = onTelegramCallback(dn, cq, allowed);
    // Always answer, or the button spins.
    await api("answerCallbackQuery", { callback_query_id: cq.id, ...(toast ? { text: toast.slice(0, 200) } : {}) });
  };

  (async () => {
    while (running) {
      try {
        const res = await api("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query", "message_reaction"] });
        for (const u of res.ok ? res.result : []) {
          try {
            if (u.callback_query) await handleCallback(u.callback_query);
            else if (u.message_reaction) onTelegramReaction(dn, u.message_reaction, allowed);
            else await handle(u.message);
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
