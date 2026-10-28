import { BlockedUrl, extract, isSocial } from "./extractors/index.ts";
import { findGithubRepo, matchGithub } from "./extractors/github.ts";
import { safeFetch } from "./extractors/net.ts";
import { normalizeMedia } from "./media.ts";
import { guard } from "./guard.ts";
import type { Judge } from "./judge/index.ts";
import type { Store } from "./store.ts";
import { enrichSchema, normalizeSummary, type Summarizer } from "./summarize.ts";
import type { Digest, IngestResult, Item, Judgement, PageContent, ShareContext, Suggestion, Summary } from "./types.ts";
import { keywordSuggestions } from "./suggest.ts";
import { canonicalize, extractUrls, hostOf } from "./url.ts";
import { clipTokens, digestBudget } from "./digest.ts";

/** A refresh of this item is already running. */
export class RefreshBusy extends Error {}
/** The same item was refreshed less than a minute ago. */
export class RefreshTooSoon extends Error {}
const REFRESH_COOLDOWN_MS = 60_000;

export interface PipelineOptions {
  store: Store;
  categories: Record<string, string>;
  judge?: Judge;
  summarizer?: Summarizer;
  /** Below this, a judge's answer is not trusted and the LLM classifies instead. */
  minConfidence?: number;
  /** Sources whose reputation falls below this (with ≥ 3 votes) are stored but not summarized. */
  minReputation?: number;
  /** Links on these domains (and their subdomains) are refused. */
  blockedDomains?: string[];
}

/** The parts of a pipeline that settings can change while it runs. */
export type Engines = Pick<PipelineOptions, "judge" | "summarizer" | "minConfidence" | "blockedDomains">;

/**
 * Link in → item out, spending as little as possible:
 *   1. cache      — a link seen before (or being processed right now) costs nothing
 *   2. extract    — APIs, meta tags or the browser's view of the page; private
 *                   addresses refused; non-text responses never parsed
 *   3. outline    — headings and section openings within a token budget
 *   4. guard      — strip hidden text, flag prompt injection
 *   5. reputation — sources the community keeps voting down skip the paid steps
 *   6. judge      — Jev answers category/kind/worth for fractions of a cent
 *   7. summarize  — the only LLM call, only for items worth reading (or the agent queue)
 *   8. follow     — repos linked or named in the content are catalogued too
 */
export class Pipeline {
  /** Links being processed right now, so simultaneous shares pay once. */
  private readonly inflight = new Map<string, Promise<IngestResult>>();
  private readonly refreshing = new Set<number>();
  private readonly lastRefresh = new Map<number, number>();

  /** Called (never awaited) whenever an item is finished: summarised, or stored without a model. One place for webhooks and the like. */
  onItem?: (item: Item, event: "item.added" | "item.updated") => void;

  constructor(private readonly opts: PipelineOptions) {}

  private done(item: Item, event: "item.added" | "item.updated"): void {
    try { this.onItem?.(item, event); } catch (err) { console.warn(`[driftnet] item hook failed: ${(err as Error).message}`); }
  }

  /** Swap the judge, model and rules in place; work already running finishes with the old ones. */
  configure(engines: Engines): void {
    for (const key of ["judge", "summarizer", "minConfidence", "blockedDomains"] as const) {
      if (engines[key] === undefined) delete this.opts[key];
      else (this.opts as unknown as Record<string, unknown>)[key] = engines[key];
    }
  }

  private refused(url: string): boolean {
    const host = URL.canParse(url) ? new URL(url).hostname.toLowerCase() : "";
    return (this.opts.blockedDomains ?? []).some((d) => host === d || host.endsWith(`.${d}`));
  }

  /** Ingest every link in a chat message. The rest of the message becomes the note. */
  async ingestMessage(text: string, ctx: Omit<ShareContext, "note">): Promise<IngestResult[]> {
    const urls = extractUrls(text);
    const note = urls.reduce((t, u) => t.replace(u, ""), text).replace(/https?:\/\/\S+/g, "").trim() || undefined;
    // A few links at a time: five links in one message shouldn't take five times
    // as long (LINE reply tokens expire), nor hit every API at once. Order is kept.
    const results: (IngestResult | null)[] = new Array(urls.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < urls.length) {
        const i = next++;
        try {
          results[i] = await this.ingest(urls[i]!, { ...ctx, ...(note ? { note } : {}) });
        } catch (err) {
          if (!(err instanceof BlockedUrl)) throw err;
          console.warn(`[driftnet] refused ${urls[i]}: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, urls.length) }, worker));
    return results.filter((r): r is IngestResult => r !== null);
  }

  async ingest(url: string, ctx: ShareContext, depth = 0, page?: PageContent): Promise<IngestResult> {
    if (this.refused(url)) throw new BlockedUrl(`${new URL(url).hostname} is blocked in your settings`);
    const running = this.inflight.get(url);
    if (running && !page) {
      // Same link shared while it is being processed: wait, then count this share.
      const first = await running.catch(() => null);
      if (first) {
        this.opts.store.recordShare(first.item.id, ctx);
        return { item: this.opts.store.get(first.item.id)!, cached: true };
      }
    }
    const work = this.ingestOnce(url, ctx, depth, page);
    this.inflight.set(url, work);
    try {
      return await work;
    } finally {
      if (this.inflight.get(url) === work) this.inflight.delete(url);
    }
  }

  private async ingestOnce(url: string, ctx: ShareContext, depth: number, page?: PageContent): Promise<IngestResult> {
    const { store } = this.opts;

    const hit = store.findByUrl(url);
    // Page content from a logged-in browser can rescue an item that was stored
    // without a summary (login wall); otherwise a repeat link costs nothing.
    if (hit && (!page?.text || hit.summary)) {
      store.recordShare(hit.id, ctx);
      // The browser may see what the first pass could not, e.g. a repo linked
      // in the comments: catalogue that alongside.
      const related = depth === 0 ? await this.newReposFrom(page, hit.url, ctx) : [];
      for (const r of related) store.linkFound(hit.id, r.item.id);
      return { item: store.get(hit.id)!, cached: true, ...(related.length ? { related } : {}) };
    }

    let digest = withPage(await extract(url), page);
    digest = await this.followToTool(digest);

    // A post that points at a repo we already have: just link them up.
    const known = digest.url !== url ? store.findByUrl(digest.url) : null;
    if (known) {
      const item = store.upsert({
        url: known.url, aliases: [url], title: known.title,
        judgement: { ...known, engine: known.judgeEngine, confidence: 1 },
        summary: known.summary, flags: known.flags, source: known.source,
      });
      store.recordShare(item.id, ctx);
      return { item: store.get(item.id)!, cached: true };
    }

    const a = await this.analyze(digest, ctx.note);
    digest = a.digest;
    const { summary } = a;
    const item = store.upsert({
      url: digest.url, aliases: [url], title: summary?.name ?? digest.title, judgement: a.judgement, summary,
      flags: a.flags, source: a.source, suggestions: a.suggestions,
      media: normalizeMedia(digest.media),
    });
    store.recordShare(item.id, ctx);
    // Stored without a model counts too (an agent's later summary is announced as item.updated by enrich()).
    this.done(store.get(item.id)!, hit ? "item.updated" : "item.added");
    const related = await this.resolveMentions(summary?.mentions ?? [], digest, ctx, depth);
    for (const r of related) store.linkFound(item.id, r.item.id);
    return { item: store.get(item.id)!, cached: false, ...(related.length ? { related } : {}) };
  }

  /** Guard → reputation → judge → summarise: everything between "page fetched" and "ready to store". */
  private async analyze(digest: Digest, note: string | undefined) {
    const { store } = this.opts;
    const cleaned = guard(digest.text);
    const cleanedNote = note ? guard(note) : { text: undefined, flags: [] };
    digest = { ...digest, text: cleaned.text };
    const flags = [...new Set([...cleaned.flags, ...cleanedNote.flags])];
    const source = sourceOf(digest);

    const rep = store.reputation(source);
    const distrusted = rep.up + rep.down >= 3 && rep.score < (this.opts.minReputation ?? 0.25);
    if (distrusted) flags.push("low-reputation");

    let judgement: Judgement | null = null;
    // Distrusted or injected items are never summarised: don't pay to judge them either.
    const blocked = distrusted || flags.includes("injection");
    const judged = blocked ? null : await this.opts.judge?.judge(digest, cleanedNote.text, this.opts.categories);
    if (judged?.flags) flags.push(...judged.flags.filter((f) => !flags.includes(f)));
    // Low confidence → let the LLM classify instead, unless there is no LLM to ask.
    const trusted = judged && (judged.judgement.confidence >= (this.opts.minConfidence ?? 0.4) || !this.opts.summarizer);
    if (judged && trusted) {
      judgement = judged.judgement;
    }

    let summary = null;
    let modelPicks: Suggestion[] = [];
    // Only "worth" gates the model. Not-quite-AI tools (a web library, a design
    // trick) are what people share too, so isAiTool is informational.
    const worthReading = judgement ? judgement.worth !== "skip" : true;
    if (this.opts.summarizer && worthReading && !distrusted && !flags.includes("injection")) {
      const r = await this.opts.summarizer.summarize(
        digest, cleanedNote.text, judgement ? undefined : this.opts.categories,
      );
      summary = r.summary ? await this.verifyPrimaryUrl(r.summary, digest, r.repoGuess) : null;
      // Only a classification the model itself made brings its runners-up along.
      if (!judgement && r.suggestions) modelPicks = r.suggestions.filter((x) => x.folder in this.opts.categories);
      judgement ??= r.judgement ?? null;
    }

    judgement ??= heuristicJudgement(digest, distrusted || flags.includes("injection"));

    // The Inbox's chips: the model's top folders, or keyword overlap when there is no model answer.
    const suggestions = modelPicks.length ? modelPicks : keywordSuggestions(this.opts.categories, {
      name: summary?.name ?? digest.title, tags: summary?.tags ?? [], current: judgement.category,
    });
    return { digest, judgement, summary, flags, source, suggestions };
  }

  /**
   * Fetch an item's page again and redo the analysis. The reader's own data
   * (shares, note, favorite, trash, a folder they chose) is untouched.
   */
  async refresh(id: number): Promise<Item | null> {
    const { store } = this.opts;
    const old = store.get(id);
    if (!old) return null;
    if (this.refreshing.has(id)) throw new RefreshBusy(`Item ${id} is already being refreshed.`);
    if (Date.now() - (this.lastRefresh.get(id) ?? 0) < REFRESH_COOLDOWN_MS) throw new RefreshTooSoon(`Item ${id} was refreshed a moment ago; try again in a minute.`);
    this.refreshing.add(id);
    this.lastRefresh.set(id, Date.now());
    try {
      if (this.refused(old.url)) throw new BlockedUrl(`${hostOf(old.url)} is blocked in your settings`);
      const digest = await this.followToTool(await extract(old.url));
      // A page that is down or walled now must not wipe a good summary.
      if (!digest.text.trim() && old.summary) throw new Error("The page returned no content; kept the existing summary.");
      const a = await this.analyze(digest, store.notes(id, 1)[0]);
      const item = store.refreshItem(id, {
        title: a.summary?.name ?? a.digest.title, judgement: a.judgement, summary: a.summary,
        flags: a.flags, source: a.source, suggestions: a.suggestions,
        media: normalizeMedia(a.digest.media),
      });
      if (item) this.done(item, "item.updated");
      return item;
    } finally {
      this.refreshing.delete(id);
    }
  }

  /**
   * Re-extract only the pictures of an item: no summary, no judge, no model call.
   * Keeps the old pictures when the page now offers none.
   */
  async refreshMedia(id: number): Promise<Item | null> {
    const { store } = this.opts;
    const old = store.get(id);
    if (!old) return null;
    if (this.refused(old.url)) throw new BlockedUrl(`${hostOf(old.url)} is blocked in your settings`);
    const digest = await this.followToTool(await extract(old.url));
    return store.setMedia(id, normalizeMedia(digest.media));
  }

  /**
   * Models invent plausible links ("github.com/<some-org>/<tool>") when a post
   * names a tool without linking it. Keep the model's link only if it appears in
   * what we actually fetched; otherwise ask GitHub for an exact-name match.
   */
  private async verifyPrimaryUrl(summary: Summary, digest: Digest, repoGuess?: string): Promise<Summary> {
    const seen = new Set(
      [digest.url, ...digest.outlinks, ...extractUrls(digest.text)].map((u) => canonicalize(u)).filter(Boolean),
    );
    const claimed = summary.primaryUrl ? canonicalize(summary.primaryUrl) : null;
    const { primaryUrl: _dropped, ...rest } = summary;
    if (claimed && seen.has(claimed)) return { ...rest, primaryUrl: claimed };
    if (digest.kind === "post" || digest.kind === "video") {
      // The name as written (may be translated in the post), then the model's guess
      // of the repo name; either only counts if GitHub has an exact match.
      for (const name of [summary.name, repoGuess]) {
        if (!name) continue;
        const repo = await findGithubRepo(name).catch(() => null);
        if (repo) return { ...rest, primaryUrl: repo };
      }
    }
    return rest;
  }

  private async newReposFrom(page: PageContent | undefined, from: string, ctx: ShareContext): Promise<IngestResult[]> {
    const repos = [...new Set((page?.links ?? []).map((l) => canonicalize(l)).filter((l): l is string => !!l && !!matchGithub(l)))]
      .filter((repo) => repo !== from && !this.refused(repo) && !this.opts.store.findByUrl(repo))
      .slice(0, 3);
    const out: IngestResult[] = [];
    for (const repo of repos) out.push(await this.ingest(repo, { ...ctx, note: `Linked from ${from}` }, 1));
    return out;
  }

  /**
   * An agent's summary for a pending item. Everything it sends is untrusted:
   * hidden text and prompt injection are rejected, and a primary link must
   * actually resolve (a GitHub repo must exist) so invented URLs never land.
   */
  async enrich(
    id: number,
    input: unknown,
    agent: string,
  ): Promise<{ ok: true; result: IngestResult } | { ok: false; error: string }> {
    const item = this.opts.store.get(id);
    if (!item) return { ok: false, error: `No item ${id}.` };
    if (!item.pending) return { ok: false, error: `Item ${id} is not pending (already summarised, skipped or blocked).` };

    const parsed = enrichSchema(Object.keys(this.opts.categories)).safeParse(input);
    if (!parsed.success) return { ok: false, error: `Invalid summary: ${parsed.error.message.slice(0, 300)}` };
    const { category, worth, ...fields } = parsed.data;

    const text = JSON.stringify(fields);
    const g = guard(text);
    if (g.flags.length) return { ok: false, error: `Rejected: ${g.flags.join(", ")} in the summary.` };

    const summary = normalizeSummary(fields);
    if (summary.primaryUrl && !(await urlExists(summary.primaryUrl))) delete summary.primaryUrl;

    const saved = this.opts.store.enrich(id, summary, agent, { ...(category ? { category } : {}), ...(worth ? { worth } : {}) });
    this.done(saved, "item.updated");
    const digest: Digest = { url: saved.url, kind: saved.kind, title: saved.title, text: "", outlinks: [], meta: {} };
    const related = await this.resolveMentions(summary.mentions ?? [], digest, { platform: "agent", chatId: agent }, 0);
    for (const r of related) this.opts.store.linkFound(id, r.item.id);
    return { ok: true, result: { item: saved, cached: false, ...(related.length ? { related } : {}) } };
  }

  /** Named open-source projects without a link → look them up on GitHub and catalogue them too. */
  private async resolveMentions(
    mentions: { name: string; openSource: boolean }[],
    digest: Digest,
    ctx: ShareContext,
    depth: number,
  ): Promise<IngestResult[]> {
    if (depth > 0) return [];
    const out: IngestResult[] = [];
    for (const m of mentions.filter((m) => m.openSource).slice(0, 4)) {
      const repo = await findGithubRepo(m.name).catch(() => null);
      if (!repo || repo === digest.url) continue;
      if (!this.refused(repo)) out.push(await this.ingest(repo, { ...ctx, note: `Mentioned in ${digest.url}` }, depth + 1));
    }
    return out;
  }

  /**
   * Social posts and videos are usually *about* a tool. If the content links to a
   * GitHub repo, catalogue the repo instead and keep the post text as context.
   */
  private async followToTool(digest: Digest): Promise<Digest> {
    if (digest.kind !== "post" && digest.kind !== "video" && !isSocial(digest.url)) return digest;
    const repo = digest.outlinks.find((u) => matchGithub(u));
    if (!repo) return digest;
    const target = await extract(repo);
    if (target.kind !== "repo") return digest;
    return {
      ...target,
      text: `${target.text}\n\nShared via ${digest.url}:\n${digest.text.slice(0, 500)}`,
      meta: { ...target.meta, via: hostOf(digest.url) },
    };
  }
}

/** Prefer what the browser saw when it says more than the anonymous fetch did. */
function withPage(digest: Digest, page: PageContent | undefined): Digest {
  if (!page) return digest;
  const text = (page.text ?? "").trim();
  const links = (page.links ?? [])
    .map((l) => canonicalize(l))
    .filter((l): l is string => Boolean(l) && hostOf(l!) !== hostOf(digest.url));
  return {
    ...digest,
    title: digest.title === digest.url || !digest.title ? page.title?.trim() || digest.title : digest.title,
    text: text.length > digest.text.length ? clipTokens(text, digestBudget()) : digest.text,
    outlinks: [...new Set([...digest.outlinks, ...links])].slice(0, 20),
  };
}

/** A GitHub repo must exist; any other link must answer. Agents can invent both. */
async function urlExists(url: string): Promise<boolean> {
  try {
    const gh = matchGithub(canonicalize(url) ?? url);
    if (gh) {
      const res = await safeFetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}`, {
        method: "HEAD",
        headers: process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      return res.status === 200;
    }
    // Agents choose this URL: it gets the same SSRF guard as any shared link.
    const res = await safeFetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    return res.status < 400 || res.status === 405;
  } catch {
    return false;
  }
}

function sourceOf(digest: Digest): string {
  const gh = matchGithub(digest.url);
  if (gh) return `github:${gh.owner.toLowerCase()}`;
  if (digest.meta.channel) return `youtube:${digest.meta.channel}`;
  return hostOf(digest.url);
}

/** Last resort when no judge and no LLM are configured (or the item was blocked). */
function heuristicJudgement(digest: Digest, blocked: boolean): Judgement {
  return {
    isAiTool: 0.5,
    category: "other",
    kind: digest.kind,
    worth: blocked ? "skip" : "normal",
    engine: "heuristic",
    confidence: 0,
  };
}
