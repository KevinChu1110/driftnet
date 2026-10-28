import { extractUrls, renderText, type Driftnet, type ShareContext } from "@driftnet/core";

/** "👍 12", "+12", "👎12 太舊了", "-12 spam" */
const VOTE_RE = /^\s*(👍|👎|\+|-)\s*#?(\d+)\s*(.*)$/su;

/**
 * Platform-independent message handling. Returns the reply text, or null to stay
 * silent — bots live in group chats, so anything without a link is ignored.
 */
export async function handleChatText(
  dn: Driftnet,
  text: string,
  ctx: Omit<ShareContext, "note">,
): Promise<string | null> {
  const vote = VOTE_RE.exec(text);
  if (vote) {
    const id = Number(vote[2]);
    if (!dn.store.get(id)) return `No item #${id}.`;
    const up = vote[1] === "👍" || vote[1] === "+";
    dn.store.vote(id, up ? 1 : -1, `${ctx.platform}:${ctx.userId ?? ctx.chatId}`, vote[3]?.trim() || undefined);
    return up ? `👍 #${id}` : `👎 #${id} — noted, similar items will cost less next time`;
  }

  if (extractUrls(text).length === 0) return null;
  const results = await dn.pipeline.ingestMessage(text, ctx);
  const base = process.env.DRIFTNET_PUBLIC_URL;
  return results
    .map((r) => `${renderText(r, base)}\n#${r.item.id} · reply 👍${r.item.id} / 👎${r.item.id}`)
    .join("\n\n");
}
