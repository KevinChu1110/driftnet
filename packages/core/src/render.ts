import { categoryLabel, messages, type Messages } from "./i18n.ts";
import type { IngestResult } from "./types.ts";

const WORTH_MARK = { skip: "🗑", low: "·", normal: "📌", "must-see": "⭐" } as const;

/**
 * Plain-text reply that works on every chat platform. Adapters may render richer
 * components (Slack blocks, LINE Flex, Discord embeds) from the same IngestResult.
 */
export function renderText(
  r: IngestResult,
  baseUrl?: string,
  t: Messages = messages(),
  label: (folder: string) => string = (f) => categoryLabel(f, t.locale),
): string {
  const { item } = r;
  const s = item.summary;
  const lines = [`${WORTH_MARK[item.worth]} ${s?.name ?? item.title}｜${label(item.category)}`];
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
  for (const rel of r.related ?? []) lines.push("", "↳ " + renderText(rel, baseUrl, t, label).replace(/\n/g, "\n  "));
  return lines.join("\n");
}

/**
 * One line per link: what it is and where to read it. The summary lives on the
 * web page; a group chat only needs to know the link was caught. Repos found
 * inside a post are named on the same line.
 */
export function renderLink(
  r: IngestResult,
  baseUrl?: string,
  t: Messages = messages(),
  label: (folder: string) => string = (f) => categoryLabel(f, t.locale),
): string {
  const { item } = r;
  const name = (item.summary?.name ?? item.title).slice(0, 80);
  const where = baseUrl ? `${baseUrl}/#item-${item.id}` : item.summary?.primaryUrl || item.url;
  const found = (r.related ?? []).map((x) => x.item.summary?.name ?? x.item.title);
  return [
    `${WORTH_MARK[item.worth]} ${name}｜${label(item.category)}`,
    found.length ? ` ${t.alsoFound}${found.join(t.listSep)}` : "",
    item.pending ? " ⏳" : "",
    r.cached ? ` ${t.seenBefore}` : "",
    `\n${where}`,
  ].join("");
}
