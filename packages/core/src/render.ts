import { categoryLabel, messages, type Messages } from "./i18n.ts";
import type { IngestResult } from "./types.ts";

const WORTH_MARK = { skip: "🗑", low: "·", normal: "📌", "must-see": "⭐" } as const;

/**
 * Plain-text reply that works on every chat platform. Adapters may render richer
 * components (Slack blocks, LINE Flex, Discord embeds) from the same IngestResult.
 */
export function renderText(
  r: IngestResult,
  baseUrl?: string | CardLinker,
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
  if (item.pending) lines.push(item.flags.includes("needs-page") ? t.needsPage : t.queued);
  lines.push(s?.primaryUrl || item.url);
  if (s?.mentions?.length) lines.push(t.mentions + s.mentions.map((m) => m.name).join(t.listSep));
  if (r.cached) lines.push(t.cached(item.shareCount));
  const where = linkTo(baseUrl, item.id);
  if (where) lines.push(where);
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
  baseUrl?: string | CardLinker,
  t: Messages = messages(),
  label: (folder: string) => string = (f) => categoryLabel(f, t.locale),
): string {
  const { item } = r;
  const name = (item.summary?.name ?? item.title).slice(0, 80);
  const where = linkTo(baseUrl, item.id) ?? (item.summary?.primaryUrl || item.url);
  const found = (r.related ?? []).map((x) => x.item.summary?.name ?? x.item.title);
  return [
    `${WORTH_MARK[item.worth]} ${name}｜${label(item.category)}`,
    found.length ? ` ${t.alsoFound}${found.join(t.listSep)}` : "",
    item.pending ? " ⏳" : "",
    r.cached ? ` ${t.seenBefore}` : "",
    `\n${where}`,
  ].join("");
}

/**
 * The item's card on the web page. The base may carry a query (a read-only
 * share key, `https://host/?key=…`) so a phone can open it without a password.
 * With `sig` (see sign.ts) the link opens that one card on a private catalogue
 * and nothing else: `https://host/?card=12&s=…#item-12`.
 */
export function cardLink(baseUrl: string, id: number, sig?: string): string {
  const u = new URL(baseUrl.replace(/\/$/, "") + (baseUrl.includes("?") ? "" : "/"));
  if (sig) { u.searchParams.set("card", String(id)); u.searchParams.set("s", sig); }
  u.hash = `item-${id}`;
  return u.toString();
}

/** Where a card's link points: a plain base (`cardLink`), or a function that signs each card (a private catalogue). */
export type CardLinker = (id: number) => string;
export function linkTo(base: string | CardLinker | undefined, id: number): string | undefined {
  return typeof base === "function" ? base(id) : base ? cardLink(base, id) : undefined;
}
