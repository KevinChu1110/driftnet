import { extractUrls, messages, renderLink, renderText, type Driftnet, type ShareContext } from "@driftnet/core";
import { shareBase } from "../access.ts";

/** "👍 12", "👎#12 太舊了", "+#12", "-#12 wrong tool" — a bare "+1 for this" or "-3 degrees" is just chat. */
const VOTE_RE = /^\s*(?:(👍|👎)\s*#?|([+-])#)(\d+)(?:\s+(.{0,200}))?\s*$/su;

/**
 * Platform-independent message handling. Returns the reply text, or null to stay
 * silent — bots live in group chats, so anything without a link is ignored.
 */
export async function handleChatText(
  dn: Driftnet,
  text: string,
  ctx: Omit<ShareContext, "note">,
): Promise<string | null> {
  const t = messages();
  const vote = extractUrls(text).length === 0 ? VOTE_RE.exec(text) : null;
  if (vote) {
    const id = Number(vote[3]);
    if (!dn.store.get(id)) return t.noItem(id);
    const up = (vote[1] ?? vote[2]) !== "👎" && vote[2] !== "-";
    dn.store.vote(id, up ? 1 : -1, `${ctx.platform}:${ctx.userId ?? ctx.chatId}`, vote[4]?.trim() || undefined);
    return up ? t.votedUp(id) : t.votedDown(id);
  }

  if (extractUrls(text).length === 0) return null;
  const results = await dn.pipeline.ingestMessage(text, ctx);
  const base = shareBase(process.env);
  // DRIFTNET_REPLY: link (one line + where to read it), full (the summary in chat), off.
  const mode = process.env.DRIFTNET_REPLY ?? "link";
  if (mode === "off" || !results.length) return null;
  const label = (folder: string) => dn.folderLabel(folder, t.locale);
  if (mode === "full") return results.map((r) => `${renderText(r, base, t, label)}\n${t.footer(r.item.id)}`).join("\n\n");
  return results.map((r) => renderLink(r, base, t, label)).join("\n");
}
