import type { Driftnet } from "@driftnet/core";

/**
 * Voting by reaction needs to know which items a bot message was about:
 * a small message → item ids map in the state table, kept for 30 days.
 */
export const REPLY_TTL_MS = 30 * 24 * 3600 * 1000;
const PREFIX = "reply:";
const PRUNED = "replyprune";

export function rememberReply(store: Driftnet["store"], key: string, ids: number[], now = Date.now()): void {
  if (!ids.length) return;
  store.setState(PREFIX + key, JSON.stringify({ ids, exp: now + REPLY_TTL_MS }));
  // Sweep expired rows at most hourly.
  if (now - Number(store.getState(PRUNED) ?? 0) > 3600_000) {
    store.setState(PRUNED, String(now));
    for (const { key: k, value } of store.stateWithPrefix(PREFIX)) {
      if ((safeParse(value)?.exp ?? 0) < now) store.deleteState(k);
    }
  }
}

export function repliedItems(store: Driftnet["store"], key: string, now = Date.now()): number[] {
  const v = store.getState(PREFIX + key);
  if (!v) return [];
  const row = safeParse(v);
  if (!row || row.exp < now) {
    store.deleteState(PREFIX + key);
    return [];
  }
  return row.ids;
}

function safeParse(v: string): { ids: number[]; exp: number } | undefined {
  try {
    const r = JSON.parse(v);
    return Array.isArray(r?.ids) && typeof r.exp === "number" ? r : undefined;
  } catch {
    return undefined;
  }
}

/** 👍 / 👎 / +1 / -1 / thumbsup / thumbsdown (with or without a skin tone); anything else is not a vote. */
export function reactionVote(emoji: string | null | undefined): 1 | -1 | null {
  const e = (emoji ?? "").replace(/::skin-tone-\d/, "").replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, "").replace(/^:|:$/g, "");
  if (e === "👍" || e === "+1" || e === "thumbsup") return 1;
  if (e === "👎" || e === "-1" || e === "thumbsdown") return -1;
  return null;
}

/** Vote on every item of a bot message. Returns the ids voted on (empty: not a bot message we remember, or items gone). */
export function voteOnReply(dn: Driftnet, key: string, voter: string, vote: 1 | -1): number[] {
  const done: number[] = [];
  for (const id of repliedItems(dn.store, key)) {
    if (!dn.store.get(id)) continue;
    dn.store.vote(id, vote, voter);
    done.push(id);
  }
  return done;
}

/** Vote on one item (an inline button / postback). Returns false when the item is gone. */
export function voteOnItem(dn: Driftnet, id: number, voter: string, vote: 1 | -1): boolean {
  if (!dn.store.get(id)) return false;
  dn.store.vote(id, vote, voter);
  return true;
}
