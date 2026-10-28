import { extract, isSocial } from "./extractors/index.ts";
import { findGithubRepo, matchGithub } from "./extractors/github.ts";
import { guard } from "./guard.ts";
import type { Judge } from "./judge/index.ts";
import type { Store } from "./store.ts";
import type { Summarizer } from "./summarize.ts";
import type { Digest, IngestResult, Judgement, ShareContext } from "./types.ts";
import { extractUrls, hostOf } from "./url.ts";

export interface PipelineOptions {
  store: Store;
  categories: Record<string, string>;
  judge?: Judge;
  summarizer?: Summarizer;
  /** Below this, a judge's answer is not trusted and the LLM classifies instead. */
  minConfidence?: number;
  /** Sources whose reputation falls below this (with ≥ 3 votes) are stored but not summarized. */
  minReputation?: number;
}

/**
 * Link in → item out, spending as little as possible:
 *   1. cache      — a URL seen before costs nothing
 *   2. extract    — APIs and meta tags, clipped to a fixed budget (no model)
 *   3. guard      — strip hidden text, flag prompt injection (no model)
 *   4. reputation — sources the community keeps voting down skip the LLM
 *   5. judge      — Jev answers category/kind/worth for fractions of a cent
 *   6. summarize  — the only LLM call, and only for items worth reading
 */
export class Pipeline {
  constructor(private readonly opts: PipelineOptions) {}

  /** Ingest every link in a chat message. The rest of the message becomes the note. */
  async ingestMessage(text: string, ctx: Omit<ShareContext, "note">): Promise<IngestResult[]> {
    const urls = extractUrls(text);
    const note = urls.reduce((t, u) => t.replace(u, ""), text).replace(/https?:\/\/\S+/g, "").trim() || undefined;
    const results: IngestResult[] = [];
    for (const url of urls) results.push(await this.ingest(url, { ...ctx, ...(note ? { note } : {}) }));
    return results;
  }

  async ingest(url: string, ctx: ShareContext, depth = 0): Promise<IngestResult> {
    const { store } = this.opts;

    const hit = store.findByUrl(url);
    if (hit) {
      store.recordShare(hit.id, ctx);
      return { item: store.get(hit.id)!, cached: true };
    }

    let digest = await extract(url);
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

    const cleaned = guard(digest.text);
    const cleanedNote = ctx.note ? guard(ctx.note) : { text: undefined, flags: [] };
    digest = { ...digest, text: cleaned.text };
    const flags = [...new Set([...cleaned.flags, ...cleanedNote.flags])];
    const source = sourceOf(digest);

    const rep = store.reputation(source);
    const distrusted = rep.up + rep.down >= 3 && rep.score < (this.opts.minReputation ?? 0.25);
    if (distrusted) flags.push("low-reputation");

    let judgement: Judgement | null = null;
    const judged = await this.opts.judge?.judge(digest, cleanedNote.text, this.opts.categories);
    if (judged?.flags) flags.push(...judged.flags.filter((f) => !flags.includes(f)));
    // Low confidence → let the LLM classify instead, unless there is no LLM to ask.
    const trusted = judged && (judged.judgement.confidence >= (this.opts.minConfidence ?? 0.4) || !this.opts.summarizer);
    if (judged && trusted) {
      judgement = judged.judgement;
    }

    let summary = null;
    const worthReading = judgement ? judgement.worth !== "skip" && judgement.isAiTool >= 0.3 : true;
    if (this.opts.summarizer && worthReading && !distrusted && !flags.includes("injection")) {
      const r = await this.opts.summarizer.summarize(
        digest, cleanedNote.text, judgement ? undefined : this.opts.categories,
      );
      summary = r.summary;
      judgement ??= r.judgement ?? null;
    }

    judgement ??= heuristicJudgement(digest, distrusted || flags.includes("injection"));

    const item = store.upsert({
      url: digest.url, aliases: [url], title: summary?.name ?? digest.title, judgement, summary,
      flags, source,
    });
    store.recordShare(item.id, ctx);
    const related = await this.resolveMentions(summary?.mentions ?? [], digest, ctx, depth);
    return { item: store.get(item.id)!, cached: false, ...(related.length ? { related } : {}) };
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
      out.push(await this.ingest(repo, { ...ctx, note: `Mentioned in ${digest.url}` }, depth + 1));
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
