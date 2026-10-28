import { createHmac } from "node:crypto";
import { BlockedUrl, safeFetch } from "./extractors/net.ts";
import { categoryLabel, resolveLocale } from "./i18n.ts";
import { cardLink } from "./render.ts";
import type { Store } from "./store.ts";
import type { Item } from "./types.ts";

export type WebhookEvent = "item.added" | "item.updated";

/** What leaves the machine: the card as a reader would describe it, nothing internal. */
export function webhookPayload(store: Store, item: Item, event: WebhookEvent, env: NodeJS.ProcessEnv = process.env) {
  const folders = new Map(store.folders().map((f) => [f.id, f]));
  const label = (id: string) => folders.get(id)?.name ?? categoryLabel(id, resolveLocale(env));
  const path: string[] = [];
  for (let id: string | null = item.category, n = 0; id && n < 20; id = folders.get(id)?.parent ?? null, n++) path.unshift(label(id));
  const base = (env.DRIFTNET_TUNNEL_URL || env.DRIFTNET_PUBLIC_URL)?.replace(/\/$/, "");
  return {
    event,
    item: {
      id: item.id,
      name: item.summary?.name ?? item.title,
      url: item.url,
      primaryUrl: item.summary?.primaryUrl || item.url,
      folder: item.category,
      folderPath: path,
      kind: item.kind,
      worth: item.worth,
      oneLiner: item.summary?.oneLiner ?? null,
      highlights: item.summary?.highlights ?? [],
      tags: item.summary?.tags ?? [],
      pageUrl: base ? cardLink(base, item.id) : null,
      added: item.createdAt,
    },
  };
}

/** Skipped, trashed and injection-flagged items never leave. */
export function shouldNotify(item: Item): boolean {
  return !item.trashedAt && item.worth !== "skip" && !item.flags.includes("injection");
}

export const signBody = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/**
 * POST the event to DRIFTNET_WEBHOOK_URL: 5 s timeout, one retry, never throws
 * (resolves to whether it was delivered). Private addresses are refused unless
 * DRIFTNET_WEBHOOK_ALLOW_LOCAL=1, and then only for the host the user typed.
 */
export async function sendWebhook(store: Store, item: Item, event: WebhookEvent, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const target = env.DRIFTNET_WEBHOOK_URL?.trim();
  if (!target || !shouldNotify(item)) return false;
  try {
    const url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrl("webhook must be http(s)");
    const body = JSON.stringify(webhookPayload(store, item, event, env));
    const secret = env.DRIFTNET_WEBHOOK_SECRET;
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "driftnet", ...(secret ? { "x-driftnet-signature": signBody(body, secret) } : {}) };
    const allow = env.DRIFTNET_WEBHOOK_ALLOW_LOCAL === "1" ? url.hostname : undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await safeFetch(target, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) }, allow);
        await res.body?.cancel();
        if (res.ok) return true;
        if (res.status < 500) break;
      } catch (err) {
        if (err instanceof BlockedUrl) throw err;
      }
    }
    console.warn(`[driftnet] webhook for #${item.id} failed`);
  } catch (err) {
    console.warn(`[driftnet] webhook for #${item.id} not sent: ${(err as Error).message}`);
  }
  return false;
}
