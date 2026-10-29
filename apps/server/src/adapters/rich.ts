import { cardLink, publicMedia, type IngestResult, type Messages } from "@driftnet/core";

/**
 * Rich chat replies: the same IngestResult as the plain text, shaped per platform
 * (Discord embeds, Slack Block Kit, LINE Flex, Telegram HTML + inline keyboard).
 * Everything here is pure, so the structure and the platform limits are testable.
 */

export type ReplyStyle = "rich" | "text";
/** DRIFTNET_REPLY_STYLE: `text` keeps the plain replies; anything else is rich. */
export const replyStyle = (env: NodeJS.ProcessEnv = process.env): ReplyStyle => (env.DRIFTNET_REPLY_STYLE === "text" ? "text" : "rich");

const WORTH_MARK = { skip: "🗑", low: "·", normal: "📌", "must-see": "⭐" } as const;

export interface RichItem {
  id: number;
  name: string;
  /** Card link (with the share key when reading is private: same as the plain reply) or the primary URL. */
  url: string;
  oneLiner: string;
  mark: string;
  worthName: string;
  folder: string;
  tags: string[];
  highlights: string[];
  warning?: string;
  /** Public proxy URL of the first picture; only set when a public https/http address is configured. Never carries the share key. */
  thumb?: string;
  badge?: string;
}

export interface RichReply {
  items: RichItem[];
  /** DRIFTNET_REPLY=full: with highlights and tags. */
  full: boolean;
  t: Messages;
}

const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?(::1|f[cd][0-9a-f]{2}:|fe80:))/i;

/** The address pictures may be served from: public only (no key, no localhost, no LAN). */
export function publicBase(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.DRIFTNET_TUNNEL_URL || env.DRIFTNET_PUBLIC_URL;
  if (!raw) return undefined;
  let u: URL;
  try { u = new URL(raw); } catch { return undefined; }
  const host = u.hostname;
  if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(host) || !host.includes(".") || /\.(local|internal|lan|home|localdomain)$/i.test(host)) return undefined;
  return u.origin + u.pathname.replace(/\/$/, "");
}

export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, Math.max(0, n - 1)).trimEnd() + "…" : s);

/** Every item a reply mentions, repos found inside a post included. */
export function flatten(results: IngestResult[]): IngestResult[] {
  return results.flatMap((r) => [r, ...flatten(r.related ?? [])]);
}
export const itemIds = (results: IngestResult[]): number[] => [...new Set(flatten(results).map((r) => r.item.id))];

export function richItems(
  results: IngestResult[],
  o: { base?: string; env?: NodeJS.ProcessEnv; t: Messages; label: (folder: string) => string; full: boolean },
): RichItem[] {
  const pub = publicBase(o.env);
  return flatten(results).map((r) => {
    const { item } = r;
    const s = item.summary;
    const picture = publicMedia(item.id, item.media)[0];
    return {
      id: item.id,
      name: (s?.name ?? item.title).slice(0, 80),
      url: o.base ? cardLink(o.base, item.id) : s?.primaryUrl || item.url,
      oneLiner: s?.oneLiner ?? (item.pending ? o.t.queued : ""),
      mark: WORTH_MARK[item.worth],
      worthName: o.t.rich.worthName[item.worth],
      folder: o.label(item.category),
      tags: (s?.tags ?? []).slice(0, 5),
      highlights: o.full ? (s?.highlights ?? []).slice(0, 5) : [],
      ...(item.flags.includes("injection") ? { warning: o.t.injection } : item.flags.includes("low-reputation") ? { warning: o.t.lowReputation } : {}),
      ...(pub && picture ? { thumb: pub + picture.src } : {}),
      ...(r.cached ? { badge: o.t.seenBefore } : {}),
    };
  });
}

const warned = new Set<string>();
/** One log line per platform, so a missing permission doesn't flood the console. */
export function warnOnce(platform: string, why: string): void {
  if (warned.has(platform)) return;
  warned.add(platform);
  console.warn(`[${platform}] rich reply refused (${why}); falling back to plain text`);
}
export const resetWarnings = (): void => warned.clear();

// ---- Discord -------------------------------------------------------------

export interface DiscordEmbed {
  title: string;
  url: string;
  description?: string;
  fields: { name: string; value: string; inline: boolean }[];
  thumbnail?: { url: string };
}

/** ≤ 10 embeds (Discord's cap); the sum of all text stays under its 6000-character limit. */
export function discordEmbeds(rep: RichReply): { embeds: DiscordEmbed[]; extra: number } {
  const shown = rep.items.slice(0, 10);
  const descMax = Math.min(rep.full ? 900 : 350, Math.floor(4200 / Math.max(1, shown.length)));
  const embeds = shown.map((it): DiscordEmbed => {
    const desc = [it.warning, it.oneLiner, ...it.highlights.map((h) => `• ${h}`), it.badge].filter(Boolean).join("\n");
    const fields: DiscordEmbed["fields"] = [
      { name: rep.t.rich.worth, value: clip(`${it.mark} ${it.worthName}`, 200), inline: true },
      { name: rep.t.rich.folder, value: clip(it.folder, 200) || "-", inline: true },
    ];
    if (rep.full && it.tags.length) fields.push({ name: rep.t.rich.tags, value: clip(it.tags.join(", "), 200), inline: false });
    return {
      title: clip(`${it.mark} ${it.name}`, 256),
      url: it.url,
      ...(desc ? { description: clip(desc, descMax) } : {}),
      fields,
      ...(it.thumb ? { thumbnail: { url: it.thumb } } : {}),
    };
  });
  return { embeds, extra: rep.items.length - shown.length };
}

// ---- Slack ---------------------------------------------------------------

/** Slack's control characters, so a card name can't become a mention or a link. */
export const slackEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slackUrl = (u: string) => slackEscape(u).replace(/\|/g, "%7C");

export function slackBlocks(rep: RichReply): any[] {
  const shown = rep.items.slice(0, 12);
  const blocks: any[] = [];
  for (const it of shown) {
    const lines = [`*<${slackUrl(it.url)}|${slackEscape(it.mark + " " + it.name)}>*`];
    if (it.warning) lines.push(slackEscape(it.warning));
    if (it.oneLiner) lines.push(slackEscape(it.oneLiner));
    for (const h of it.highlights) lines.push(`• ${slackEscape(h)}`);
    const section: any = { type: "section", text: { type: "mrkdwn", text: clip(lines.join("\n"), 2900) } };
    if (it.thumb?.startsWith("https://")) section.accessory = { type: "image", image_url: it.thumb, alt_text: clip(it.name, 200) };
    blocks.push(section);
    const ctx = [`${it.mark} ${it.worthName}`, `📁 ${it.folder}`, ...(rep.full && it.tags.length ? [`🏷 ${it.tags.join(", ")}`] : []), ...(it.badge ? [it.badge] : [])];
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: clip(slackEscape(ctx.join(" · ")), 2900) }] });
  }
  if (rep.items.length > shown.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: slackEscape(rep.t.digest.more(rep.items.length - shown.length)) }] });
  return blocks;
}

// ---- LINE ----------------------------------------------------------------

/** A Flex message: one bubble, or a carousel of up to 12. Buttons: open, 👍, 👎 (postback `v=<id>&d=up|down`). */
export function lineFlex(rep: RichReply, altText: string): any {
  const shown = rep.items.slice(0, 12);
  const solo = shown.length === 1;
  const bubbles = shown.map((it) => {
    const body: any[] = [{ type: "text", text: clip(`${it.mark} ${it.name}`, 100), weight: "bold", wrap: true, maxLines: 2 }];
    if (it.warning) body.push({ type: "text", text: clip(it.warning, 120), size: "xs", wrap: true, color: "#B45309" });
    if (it.oneLiner) body.push({ type: "text", text: clip(it.oneLiner, rep.full ? 300 : 140), size: "sm", wrap: true, color: "#555555", maxLines: rep.full ? 6 : 4 });
    for (const h of it.highlights) body.push({ type: "text", text: clip(`• ${h}`, 120), size: "xs", wrap: true, color: "#555555", maxLines: 3 });
    body.push({ type: "text", text: clip([`${it.mark} ${it.worthName}`, it.folder, ...(it.badge ? [it.badge] : [])].join(" · "), 120), size: "xs", wrap: true, color: "#888888" });
    return {
      type: "bubble",
      size: solo ? "mega" : "kilo",
      ...(it.thumb?.startsWith("https://") ? { hero: { type: "image", url: it.thumb, size: "full", aspectRatio: "20:13", aspectMode: "cover", action: { type: "uri", uri: it.url } } } : {}),
      body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "button", style: "primary", height: "sm", action: { type: "uri", label: clip(rep.t.rich.open, 20), uri: it.url } },
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            contents: [
              { type: "button", height: "sm", action: { type: "postback", label: "👍", data: `v=${it.id}&d=up` } },
              { type: "button", height: "sm", action: { type: "postback", label: "👎", data: `v=${it.id}&d=down` } },
            ],
          },
        ],
      },
    };
  });
  return { type: "flex", altText: clip(altText, 400), contents: solo ? bubbles[0] : { type: "carousel", contents: bubbles } };
}

// ---- Telegram ------------------------------------------------------------

export const htmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const htmlAttr = (s: string) => htmlEscape(s).replace(/"/g, "&quot;");

/** parse_mode HTML text (≤ 4096) plus one 👍 / 👎 row per item (`v:<id>:up|down`). */
export function telegramRich(rep: RichReply): { text: string; reply_markup: { inline_keyboard: any[][] } } {
  const blocks: string[] = [];
  const kept: RichItem[] = [];
  let used = 0;
  for (const it of rep.items.slice(0, 10)) {
    const lines = [`<b>${htmlEscape(it.mark)} <a href="${htmlAttr(it.url)}">${htmlEscape(it.name)}</a></b>｜${htmlEscape(it.folder)}`];
    if (it.warning) lines.push(htmlEscape(it.warning));
    if (it.oneLiner) lines.push(htmlEscape(clip(it.oneLiner, 300)));
    for (const h of it.highlights) lines.push(`• ${htmlEscape(clip(h, 200))}`);
    const meta = [`${it.mark} ${it.worthName}`, ...(rep.full && it.tags.length ? [it.tags.map((x) => "#" + x.replace(/\W+/gu, "_")).join(" ")] : []), ...(it.badge ? [it.badge] : [])];
    lines.push(`<i>${htmlEscape(meta.join(" · "))}</i>`);
    const block = lines.join("\n");
    if (kept.length && used + block.length + 2 > 3900) break;
    blocks.push(block);
    kept.push(it);
    used += block.length + 2;
  }
  return {
    text: blocks.join("\n\n").slice(0, 4096),
    reply_markup: {
      inline_keyboard: kept.map((it) => [
        { text: `👍 #${it.id}`, callback_data: `v:${it.id}:up` },
        { text: `👎 #${it.id}`, callback_data: `v:${it.id}:down` },
      ]),
    },
  };
}
