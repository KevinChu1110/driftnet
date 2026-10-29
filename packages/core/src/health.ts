import { isIP } from "node:net";
import { UA } from "./extractors/http.ts";
import { isPublicAddress, safeFetch } from "./extractors/net.ts";
import { matchGithub } from "./extractors/github.ts";
import type { Store } from "./store.ts";
import type { Health, Item } from "./types.ts";

/**
 * Link health: is the page or repo a card points at still there?
 * Off unless DRIFTNET_HEALTH=weekly. Every request goes through safeFetch (SSRF guard).
 */
const DAY = 86_400_000;
const RECHECK_AFTER = 7 * DAY;
/** An inconclusive answer (5xx, timeout, first DNS miss) is retried after ~a day instead of a week. */
const RETRY_AFTER = DAY;
const STALE_AFTER = 548 * DAY; // ~18 months
const TICK_MS = 10 * 60_000;
const BATCH = 20;
const CONCURRENCY = 2;

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface CheckResult {
  /** undefined: could not tell (leave the stored state, retry soon). */
  health?: Health;
  stars?: number;
  pushedAt?: string;
  /** Epoch ms until which GitHub asked us to stop. */
  pauseUntil?: number;
}

export interface CheckerOptions {
  fetch?: FetchFn;
  now?: () => number;
  /** Token override; defaults to GITHUB_TOKEN. */
  githubToken?: () => string | undefined;
  log?: (msg: string) => void;
}

/** Literal private IPs and local names are never fetched, whatever the fetch function is. */
export function isPrivateTarget(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DRIFTNET_ALLOW_PRIVATE_URLS === "1") return false;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return true; }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  return isIP(host) !== 0 && !isPublicAddress(host);
}

const errCode = (err: unknown): string | undefined => {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const c = e?.cause?.code ?? e?.code;
  return typeof c === "string" ? c : undefined;
};

export class HealthChecker {
  private readonly fetch: FetchFn;
  private readonly now: () => number;
  private readonly token: () => string | undefined;
  private readonly log: (msg: string) => void;
  /** Item ids whose last check ended in a DNS miss; the second one in a row means dead. */
  private readonly dnsMisses = new Set<number>();
  pausedUntil = 0;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly store: Store, opts: CheckerOptions = {}) {
    this.fetch = opts.fetch ?? safeFetch;
    this.now = opts.now ?? Date.now;
    this.token = opts.githubToken ?? (() => process.env.GITHUB_TOKEN);
    this.log = opts.log ?? ((m) => console.log(`[driftnet] health: ${m}`));
  }

  /** The link worth checking: the tool the card points to, else the shared link. */
  static targetOf(item: Item): string {
    return item.summary?.primaryUrl || item.url;
  }

  async probe(item: Item): Promise<CheckResult> {
    const url = HealthChecker.targetOf(item);
    if (isPrivateTarget(url)) return {};
    return matchGithub(url) ? this.probeGithub(url) : this.probeUrl(url, item.id);
  }

  private async probeGithub(url: string): Promise<CheckResult> {
    const ref = matchGithub(url)!;
    const name = ref.repo.replace(/\.git$/, "");
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": UA };
    const token = this.token();
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetch(`https://api.github.com/repos/${ref.owner}/${name}`, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    } catch { return {}; }

    // When GitHub says stop (limit used up, or 403/429), wait for the reset it names.
    const retryAfter = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const until = retryAfter > 0 ? this.now() + retryAfter * 1000 : reset > 0 ? reset * 1000 : this.now() + 15 * 60_000;
    const pauseUntil = Math.max(until, this.now() + 1000);
    if (res.status === 403 || res.status === 429) { await res.body?.cancel(); return { pauseUntil }; }
    const out: CheckResult = res.headers.get("x-ratelimit-remaining") === "0" ? { pauseUntil } : {};

    if (res.status === 404 || res.status === 410 || res.status === 451) { await res.body?.cancel(); return { ...out, health: "dead" }; }
    if (res.status >= 300 && res.status < 400) {
      this.log(`${ref.owner}/${name} moved to ${res.headers.get("location") ?? "(unknown)"}`);
      await res.body?.cancel();
      return { ...out, health: "moved" };
    }
    if (res.status !== 200) { await res.body?.cancel(); return out; }

    const repo = (await res.json()) as { full_name?: string; archived?: boolean; pushed_at?: string; stargazers_count?: number };
    const facts: CheckResult = {
      ...out,
      ...(typeof repo.stargazers_count === "number" ? { stars: repo.stargazers_count } : {}),
      ...(repo.pushed_at ? { pushedAt: repo.pushed_at } : {}),
    };
    if (repo.full_name && repo.full_name.toLowerCase() !== `${ref.owner}/${name}`.toLowerCase()) {
      this.log(`${ref.owner}/${name} is now ${repo.full_name}`);
      return { ...facts, health: "moved" };
    }
    const pushedMs = repo.pushed_at ? Date.parse(repo.pushed_at) : NaN;
    const stale = Number.isFinite(pushedMs) && this.now() - pushedMs > STALE_AFTER;
    return { ...facts, health: repo.archived ? "archived" : stale ? "stale" : "ok" };
  }

  private async probeUrl(url: string, id: number): Promise<CheckResult> {
    const headers = { "user-agent": UA, accept: "*/*" };
    try {
      let res = await this.fetch(url, { method: "HEAD", headers, signal: AbortSignal.timeout(10_000) });
      // Many servers refuse HEAD: ask for the first bytes instead of the whole page.
      if ([400, 403, 405, 501].includes(res.status)) {
        await res.body?.cancel();
        res = await this.fetch(url, { method: "GET", headers: { ...headers, range: "bytes=0-1023" }, signal: AbortSignal.timeout(10_000) });
      }
      await res.body?.cancel();
      this.dnsMisses.delete(id);
      if (res.status === 404 || res.status === 410) return { health: "dead" };
      if (res.status >= 200 && res.status < 400) return { health: "ok" };
      return {};
    } catch (err) {
      if (errCode(err) === "ENOTFOUND") {
        if (this.dnsMisses.has(id)) { this.dnsMisses.delete(id); return { health: "dead" }; }
        this.dnsMisses.add(id);
      }
      return {};
    }
  }

  /** Check one item now and store the outcome. Returns the stored item (null if it vanished). */
  async check(item: Item): Promise<Item | null> {
    const r = await this.probe(item);
    if (r.pauseUntil) this.pausedUntil = Math.max(this.pausedUntil, r.pauseUntil);
    // Rate-limited with nothing learned: leave the row untouched, the next batch tries again after the pause.
    if (r.pauseUntil && !r.health) return this.store.get(item.id);
    // Inconclusive (5xx, timeout, first DNS miss): keep the state, look again in a day rather than a week.
    const checkedAt = new Date(r.health ? this.now() : this.now() - (RECHECK_AFTER - RETRY_AFTER)).toISOString();
    return this.store.setHealth(item.id, {
      ...(r.health ? { health: r.health } : {}),
      ...(r.stars !== undefined ? { stars: r.stars } : {}),
      ...(r.pushedAt ? { pushedAt: r.pushedAt } : {}),
      checkedAt,
    });
  }

  /** One round: the oldest-checked batch, two at a time. Returns how many were looked at. */
  async runBatch(limit = BATCH): Promise<number> {
    if (this.now() < this.pausedUntil) return 0;
    const due = this.store.healthDue(limit, new Date(this.now() - RECHECK_AFTER).toISOString());
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < due.length && this.now() >= this.pausedUntil) {
        const item = due[next++]!;
        try { await this.check(item); done++; } catch (err) { this.log(`item ${item.id}: ${(err as Error).message}`); }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return done;
  }

  /** Ticks for the life of the process but only works while DRIFTNET_HEALTH=weekly; the setting is read on every tick, so ⚙ Settings changes apply live. */
  start(env: NodeJS.ProcessEnv = process.env, tickMs = TICK_MS): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running || env.DRIFTNET_HEALTH !== "weekly") return;
      this.running = true;
      try { await this.runBatch(); } catch (err) { this.log((err as Error).message); } finally { this.running = false; }
    };
    this.timer = setInterval(() => void tick(), tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

const checkers = new WeakMap<Store, HealthChecker>();
/** One checker per store, so the manual button and the job share the rate-limit pause. */
export function healthFor(store: Store): HealthChecker {
  let c = checkers.get(store);
  if (!c) checkers.set(store, (c = new HealthChecker(store)));
  return c;
}
