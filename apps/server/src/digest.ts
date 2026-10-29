import { cardLink, messages, resolveLocale, sendDigestWebhook, type Driftnet, type Item, type Messages } from "@driftnet/core";
import { sendDiscordMessage } from "./adapters/discord.ts";
import { pushLineMessage } from "./adapters/line.ts";
import { sendSlackMessage } from "./adapters/slack.ts";
import { sendTelegramMessage } from "./adapters/telegram.ts";

/**
 * Scheduled digests: every day or week, one short message into the chats you choose.
 *
 * Lives in the server (not core) because it needs the bot tokens and the
 * adapters' outbound calls; the wording is in core's i18n and the `digest.sent`
 * event in core's webhook. Times are the server's local time (TZ is respected).
 */

export type Mode = "off" | "daily" | "weekly";
export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const PLATFORMS = ["telegram", "discord", "slack", "line"] as const;
export type Platform = (typeof PLATFORMS)[number];
export interface Target { platform: Platform; id: string }

/** Characters each platform accepts in one message. */
export const LIMITS: Record<Platform, number> = { telegram: 4096, discord: 2000, slack: 3000, line: 5000 };
const LAST = "digest:last";
const TOP = 5;
const SHARED = 3;
const WORTH_RANK = { skip: 0, low: 1, normal: 2, "must-see": 3 } as const;
const WORTH_MARK = { skip: "🗑", low: "·", normal: "📌", "must-see": "⭐" } as const;

const ID_PATTERN: Record<Platform, RegExp> = {
  telegram: /^(?:-?\d{1,20}|@\w{3,64})$/,
  discord: /^\d{5,25}$/,
  slack: /^[A-Z0-9]{4,24}$/,
  line: /^[A-Za-z0-9_-]{3,64}$/,
};

/** "telegram:123, slack:C0123" → targets, plus the entries that didn't parse. */
export function parseTargets(raw: string | undefined): { targets: Target[]; invalid: string[] } {
  const targets: Target[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    const platform = part.slice(0, i).toLowerCase() as Platform;
    const id = part.slice(i + 1).trim();
    if (i < 1 || !PLATFORMS.includes(platform) || !ID_PATTERN[platform].test(id)) { invalid.push(part); continue; }
    if (seen.has(`${platform}:${id}`)) continue;
    seen.add(`${platform}:${id}`);
    targets.push({ platform, id });
  }
  return { targets, invalid };
}

export const validTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

export function digestMode(env: NodeJS.ProcessEnv): Mode {
  const m = (env.DRIFTNET_DIGEST ?? "").trim().toLowerCase();
  return m === "daily" || m === "weekly" ? m : "off";
}

/** The most recent scheduled moment at or before `now` (local time). */
export function lastSlot(now: Date, env: NodeJS.ProcessEnv): Date {
  const at = validTime((env.DRIFTNET_DIGEST_AT ?? "").trim()) ? env.DRIFTNET_DIGEST_AT!.trim() : "09:00";
  const [h, m] = at.split(":").map(Number) as [number, number];
  const weekly = digestMode(env) === "weekly";
  const slot = new Date(now);
  slot.setHours(h, m, 0, 0);
  if (weekly) {
    const named = DAYS.indexOf((env.DRIFTNET_DIGEST_DAY ?? "").trim().toLowerCase() as (typeof DAYS)[number]);
    const day = named < 0 ? 1 : named; // unset or unknown: Monday
    slot.setDate(slot.getDate() - ((slot.getDay() - day + 7) % 7));
  }
  if (slot > now) slot.setDate(slot.getDate() - (weekly ? 7 : 1));
  return slot;
}

/**
 * Due when the latest scheduled moment has passed and no digest went out since it.
 * That one rule gives catch-up after downtime (once, however long it was), no
 * double send after a restart, and live reaction to a changed time.
 * `last` null means the digest was never sent: not due (the scheduler seeds it).
 */
export function digestDue(now: Date, env: NodeJS.ProcessEnv, last: Date | null): boolean {
  if (digestMode(env) === "off" || !last) return false;
  return last < lastSlot(now, env);
}

const stamp = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");

export interface DigestEntry {
  id: number;
  name: string;
  oneLiner: string | null;
  worth: Item["worth"];
  shareCount: number;
  url: string;
  /** Times shared inside the period (most-shared list only). */
  sharesInPeriod?: number;
}
export interface DigestData {
  period: "daily" | "weekly";
  from: string;
  to: string;
  newCount: number;
  inbox: number;
  top: DigestEntry[];
  mostShared: DigestEntry[];
}

/** Cards open on the page by their bare public address: never the read key, since the text goes into a group. */
export function publicBase(env: NodeJS.ProcessEnv): string | undefined {
  return (env.DRIFTNET_TUNNEL_URL || env.DRIFTNET_PUBLIC_URL)?.replace(/\/$/, "") || undefined;
}

const entry = (item: Item, env: NodeJS.ProcessEnv, sharesInPeriod?: number): DigestEntry => {
  const base = publicBase(env);
  return {
    id: item.id,
    name: (item.summary?.name ?? item.title).slice(0, 80),
    oneLiner: item.summary?.oneLiner?.slice(0, 140) || null,
    worth: item.worth,
    shareCount: item.shareCount,
    url: base ? cardLink(base, item.id) : item.summary?.primaryUrl || item.url,
    ...(sharesInPeriod ? { sharesInPeriod } : {}),
  };
};

/** What happened between `since` and `now`. */
export function collectDigest(dn: Driftnet, env: NodeJS.ProcessEnv, since: Date, now: Date): DigestData {
  const from = stamp(since);
  const fresh = dn.store.list({ since: from, minWorth: "low", limit: 200 });
  const top = fresh
    .sort((a, b) => WORTH_RANK[b.worth] - WORTH_RANK[a.worth] || b.shareCount - a.shareCount || b.createdAt.localeCompare(a.createdAt))
    .slice(0, TOP)
    .map((i) => entry(i, env));
  // Total of every clean card in the window, skipped ones included: the number the page shows.
  const out: { total?: number } = {};
  dn.store.list({ since: from, limit: 1 }, out);
  const mostShared: DigestEntry[] = [];
  for (const s of dn.store.sharedSince(from, 2, 20)) {
    const item = dn.store.get(s.id);
    if (!item || item.trashedAt || item.worth === "skip" || item.flags.includes("injection")) continue;
    mostShared.push(entry(item, env, s.shares));
    if (mostShared.length >= SHARED) break;
  }
  return { period: digestMode(env) === "daily" ? "daily" : "weekly", from, to: stamp(now), newCount: out.total ?? 0, inbox: dn.store.inboxCount(), top, mostShared };
}

/** Plain text that fits `limit` characters: the pick list shrinks first. */
export function renderDigest(d: DigestData, t: Messages, limit: number): string {
  const build = (picks: number) => {
    const lines = [`📬 ${t.digest.title(d.period)}`, t.digest.counts(d.newCount, d.inbox)];
    const shown = d.top.slice(0, picks);
    if (shown.length) {
      lines.push("", t.digest.top);
      shown.forEach((e, i) => lines.push(`${i + 1}. ${WORTH_MARK[e.worth]} ${e.name}${e.oneLiner ? ` — ${e.oneLiner}` : ""}`, `   ${e.url}`));
      if (d.newCount > shown.length) lines.push(t.digest.more(d.newCount - shown.length));
    }
    if (d.mostShared.length) {
      lines.push("", t.digest.shared);
      for (const e of d.mostShared.slice(0, picks ? SHARED : 1)) lines.push(`• ${e.name} (${t.digest.sharedTimes(e.sharesInPeriod ?? e.shareCount)})`, `  ${e.url}`);
    }
    return lines.join("\n");
  };
  for (let n = d.top.length; n >= 0; n--) {
    const text = build(n);
    if (text.length <= limit) return text;
  }
  return build(0).slice(0, limit - 1) + "…";
}

export interface TargetResult { target: string; ok: boolean; error?: string }
export interface DigestRun {
  sent: boolean;
  /** Why nothing went out. */
  reason?: "off" | "empty" | "no-targets";
  digest?: DigestData;
  /** The rendered text per target (`telegram:123`), or `preview` when no target is set. */
  texts: Record<string, string>;
  results: TargetResult[];
}

async function deliverTo(t: Target, text: string, env: NodeJS.ProcessEnv): Promise<void> {
  const need = (key: string) => env[key] || (() => { throw new Error(`${key} is not set`); })();
  switch (t.platform) {
    case "telegram": return sendTelegramMessage(need("TELEGRAM_BOT_TOKEN"), t.id, text);
    case "discord": return sendDiscordMessage(need("DISCORD_BOT_TOKEN"), t.id, text);
    case "slack": return sendSlackMessage(need("SLACK_BOT_TOKEN"), t.id, text);
    case "line": return pushLineMessage(need("LINE_CHANNEL_ACCESS_TOKEN"), t.id, text);
  }
}

const PERIOD_MS = { daily: 86_400_000, weekly: 7 * 86_400_000 };

/**
 * Build the digest for the period since the last one and send it. `dryRun` renders only and
 * touches nothing. `scheduled` runs also advance `digest:last` when there was nothing to send,
 * so an empty day isn't retried every minute. The marker moves before delivery: a crash
 * mid-send skips a digest rather than sending it twice.
 */
export async function runDigest(dn: Driftnet, env: NodeJS.ProcessEnv, opts: { dryRun?: boolean; scheduled?: boolean; now?: Date } = {}): Promise<DigestRun> {
  const now = opts.now ?? new Date();
  const t = messages(resolveLocale(env));
  const { targets } = parseTargets(env.DRIFTNET_DIGEST_TO);
  const mode = digestMode(env);
  const lastRaw = dn.store.getState(LAST);
  const last = lastRaw ? new Date(lastRaw) : null;
  const since = last && !Number.isNaN(last.getTime()) ? last : new Date(now.getTime() - PERIOD_MS[mode === "daily" ? "daily" : "weekly"]);
  const digest = collectDigest(dn, env, since, now);
  const empty = digest.newCount === 0;
  const texts: Record<string, string> = {};
  for (const x of targets) texts[`${x.platform}:${x.id}`] = renderDigest(digest, t, LIMITS[x.platform]);
  if (!targets.length) texts.preview = renderDigest(digest, t, LIMITS.discord);
  if (opts.dryRun) return { sent: false, digest, texts, results: [], ...(empty ? { reason: "empty" as const } : targets.length ? {} : { reason: "no-targets" as const }) };

  if (empty || !targets.length) {
    if (opts.scheduled) dn.store.setState(LAST, stamp(now));
    console.log(`[digest] nothing sent: ${empty ? "no new cards in the period" : "no targets in DRIFTNET_DIGEST_TO"}`);
    return { sent: false, reason: empty ? "empty" : "no-targets", digest, texts, results: [] };
  }
  dn.store.setState(LAST, stamp(now));
  const results: TargetResult[] = [];
  for (const x of targets) {
    const target = `${x.platform}:${x.id}`;
    try {
      await deliverTo(x, texts[target]!, env);
      results.push({ target, ok: true });
    } catch (err) {
      const error = (err as Error).message;
      console.warn(`[digest] ${target}: ${error}`);
      results.push({ target, ok: false, error });
    }
  }
  console.log(`[digest] sent to ${results.filter((r) => r.ok).length}/${results.length} targets`);
  if (env.DRIFTNET_WEBHOOK_URL) await sendDigestWebhook({ digest, targets: results }, env);
  return { sent: results.some((r) => r.ok), digest, texts, results };
}

/** One scheduler step: seed on first use, then send when due. Reads the env fresh, so Settings changes apply at once. */
export async function digestTick(dn: Driftnet, env: NodeJS.ProcessEnv, now = new Date()): Promise<DigestRun | null> {
  if (digestMode(env) === "off") return null;
  const raw = dn.store.getState(LAST);
  const last = raw ? new Date(raw) : null;
  if (!last || Number.isNaN(last.getTime())) {
    // Turned on just now: the first digest is the next scheduled one, not a backlog.
    dn.store.setState(LAST, stamp(now));
    console.log(`[digest] ${digestMode(env)} digest on; first one at the next scheduled time`);
    return null;
  }
  if (!digestDue(now, env, last)) return null;
  return runDigest(dn, env, { scheduled: true, now });
}

/** Check once a minute (and once right away, for catch-up after downtime). Returns a stop function. */
export function startDigestScheduler(dn: Driftnet, env: NodeJS.ProcessEnv = process.env, everyMs = 60_000): () => void {
  let busy = false;
  const step = () => {
    if (busy) return;
    busy = true;
    digestTick(dn, env).catch((err) => console.warn("[digest]", (err as Error).message)).finally(() => { busy = false; });
  };
  const timer = setInterval(step, everyMs);
  timer.unref();
  step();
  return () => clearInterval(timer);
}
