import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store.ts";

/**
 * Signed links: a link that opens one thing (a card, a folder's pack) and nothing
 * else, without the share key. The secret is made once and kept in the catalogue's
 * own state, so links survive a restart and die with the catalogue.
 */
function secretOf(store: Store): string {
  let s = store.getState("pack_secret");
  if (!s) { s = randomBytes(32).toString("base64url"); store.setState("pack_secret", s); }
  return s;
}

export const signLink = (store: Store, subject: string): string => createHmac("sha256", secretOf(store)).update(subject).digest("base64url").slice(0, 27);

export function linkSigOk(store: Store, subject: string, sig: string | null | undefined): boolean {
  if (!sig) return false;
  const want = Buffer.from(signLink(store, subject)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * A card's own signature: a chat reply on a private catalogue links each card this way
 * (`/?card=<id>&s=<sig>`), so the group gets that one card to read, never the share key.
 */
export const cardSig = (store: Store, id: number): string => signLink(store, `card/${id}`);
export const cardSigOk = (store: Store, id: number, sig: string | null | undefined): boolean => linkSigOk(store, `card/${id}`, sig);
