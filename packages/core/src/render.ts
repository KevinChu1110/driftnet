import { categoryLabel, messages, type Messages } from "./i18n.ts";
import type { IngestResult } from "./types.ts";

const WORTH_MARK = { skip: "🗑", low: "·", normal: "📌", "must-see": "⭐" } as const;

/**
 * Plain-text reply that works on every chat platform. Adapters may render richer
 * components (Slack blocks, LINE Flex, Discord embeds) from the same IngestResult.
 */
export function renderText(r: IngestResult, baseUrl?: string, t: Messages = messages()): string {
  const { item } = r;
  const s = item.summary;
  const lines = [`${WORTH_MARK[item.worth]} ${s?.name ?? item.title}｜${categoryLabel(item.category, t.locale)}`];
  if (s) {
    lines.push(s.oneLiner);
    for (const h of s.highlights) lines.push(`• ${h}`);
  }
  if (item.flags.includes("injection")) lines.push(t.injection);
  else if (item.flags.includes("low-reputation")) lines.push(t.lowReputation);
  if (item.pending) lines.push(t.queued);
  lines.push(s?.primaryUrl || item.url);
  if (s?.mentions?.length) lines.push(t.mentions + s.mentions.map((m) => m.name).join(t.listSep));
  if (r.cached) lines.push(t.cached(item.shareCount));
  if (baseUrl) lines.push(`${baseUrl}/#item-${item.id}`);
  for (const rel of r.related ?? []) lines.push("", "↳ " + renderText(rel, baseUrl, t).replace(/\n/g, "\n  "));
  return lines.join("\n");
}
