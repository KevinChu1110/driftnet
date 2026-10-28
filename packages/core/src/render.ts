import type { IngestResult } from "./types.ts";

const WORTH_MARK = { skip: "🗑", low: "·", normal: "📌", "must-see": "⭐" } as const;

/**
 * Plain-text reply that works on every chat platform. Adapters may render richer
 * components (Slack blocks, LINE Flex, Discord embeds) from the same IngestResult.
 */
export function renderText(r: IngestResult, baseUrl?: string): string {
  const { item } = r;
  const s = item.summary;
  const lines = [`${WORTH_MARK[item.worth]} ${s?.name ?? item.title}｜${item.category}`];
  if (s) {
    lines.push(s.oneLiner);
    for (const h of s.highlights) lines.push(`• ${h}`);
  }
  if (item.flags.includes("injection")) lines.push("⚠️ Contains instructions aimed at AI — hidden from agent feeds");
  else if (item.flags.includes("low-reputation")) lines.push("⚠️ Source often voted down — not summarized");
  lines.push(s?.primaryUrl || item.url);
  if (s?.mentions?.length) lines.push(`Mentions: ${s.mentions.map((m) => m.name).join(", ")}`);
  if (r.cached) lines.push(`(already saved · shared ${item.shareCount}×)`);
  if (baseUrl) lines.push(`${baseUrl}/#item-${item.id}`);
  for (const rel of r.related ?? []) lines.push("", "↳ " + renderText(rel, baseUrl).replace(/\n/g, "\n  "));
  return lines.join("\n");
}
