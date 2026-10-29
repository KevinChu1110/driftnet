import { extractUrls, messages, renderLink, renderText, type Driftnet, type ShareContext } from "@driftnet/core";
import { shareBase } from "../access.ts";
import { itemIds, replyStyle, richItems, type RichReply } from "./rich.ts";

/** "👍 12", "👎#12 太舊了", "+#12", "-#12 wrong tool" — a bare "+1 for this" or "-3 degrees" is just chat. */
const VOTE_RE = /^\s*(?:(👍|👎)\s*#?|([+-])#)(\d+)(?:\s+(.{0,200}))?\s*$/su;

/** What a chat reply carries: the plain text (always), plus the rich form and item ids when there are items. */
export interface ChatReply {
  text: string;
  /** Items the reply is about (for voting by reaction). */
  ids: number[];
  rich?: RichReply;
}

/**
 * Platform-independent message handling. Returns the reply, or null to stay
 * silent — bots live in group chats, so anything without a link is ignored.
 */
export async function handleChat(
  dn: Driftnet,
  text: string,
  ctx: Omit<ShareContext, "note">,
): Promise<ChatReply | null> {
  const t = messages();
  const vote = extractUrls(text).length === 0 ? VOTE_RE.exec(text) : null;
  if (vote) {
    const id = Number(vote[3]);
    if (!dn.store.get(id)) return { text: t.noItem(id), ids: [] };
    const up = (vote[1] ?? vote[2]) !== "👎" && vote[2] !== "-";
    dn.store.vote(id, up ? 1 : -1, `${ctx.platform}:${ctx.userId ?? ctx.chatId}`, vote[4]?.trim() || undefined);
    return { text: up ? t.votedUp(id) : t.votedDown(id), ids: [] };
  }

  if (extractUrls(text).length === 0) return null;
  const results = await dn.pipeline.ingestMessage(text, ctx);
  const base = shareBase(process.env);
  // DRIFTNET_REPLY: link (one line + where to read it), full (the summary in chat), off.
  const mode = process.env.DRIFTNET_REPLY ?? "link";
  if (mode === "off" || !results.length) return null;
  const label = (folder: string) => dn.folderLabel(folder, t.locale);
  const full = mode === "full";
  const plain = full
    ? results.map((r) => `${renderText(r, base, t, label)}\n${t.footer(r.item.id)}`).join("\n\n")
    : results.map((r) => renderLink(r, base, t, label)).join("\n");
  const reply: ChatReply = { text: plain, ids: itemIds(results) };
  // DRIFTNET_REPLY_STYLE=text keeps today's plain replies; rich is shaped per platform by each adapter.
  if (replyStyle() === "rich") reply.rich = { items: richItems(results, { base, t, label, full }), full, t };
  return reply;
}

/** The plain-text reply (the HTTP chat endpoint, tests, and every platform's fallback). */
export async function handleChatText(
  dn: Driftnet,
  text: string,
  ctx: Omit<ShareContext, "note">,
): Promise<string | null> {
  return (await handleChat(dn, text, ctx))?.text ?? null;
}
