import { createHash } from "node:crypto";
import { createEmbedder, EmbedConfigError, type Embedder, type FetchLike } from "./llm/embed.ts";
import { DEFAULT_FLOOR, type Store } from "./store.ts";
import type { Item } from "./types.ts";

/** What gets embedded is small on purpose: a few hundred characters per item, so it is fast and cheap. */
export const EMBED_TEXT_MAX = 400;

/**
 * The text an item is embedded from. Only what already went to the summarizer (name, one-liner, tags,
 * highlights, title, the URL's host). The reader's own note is added ONLY for an endpoint on this
 * machine; chat text is never embedded, and nothing private goes to a cloud embedder.
 */
export function embedText(item: Item, opts: { includeNote: boolean }): string {
  const s = item.summary;
  let host = "";
  try { host = new URL(item.url).hostname.replace(/^www\./, ""); } catch { /* not a URL */ }
  const name = s?.name || item.title;
  const parts = [
    name, s?.oneLiner, s?.tags?.length ? s.tags.join(", ") : "", ...(s?.highlights ?? []).slice(0, 3),
    item.title !== name ? item.title : "", host, opts.includeNote ? (item.note ?? "").slice(0, 120) : "",
  ].filter((p): p is string => !!p?.trim());
  return parts.join(". ").replace(/\s+/g, " ").slice(0, EMBED_TEXT_MAX);
}

const hashOf = (model: string, text: string) => createHash("sha256").update(`${model}\n${text}`).digest("hex").slice(0, 24);

export interface SemanticOptions {
  /** Longest a search waits for the query's embedding before falling back to keywords (default 1500 ms). */
  queryTimeoutMs?: number;
  /** Items per embedding request in the background queue (default 16). */
  batch?: number;
  /** Cache of recent query embeddings (default 200). */
  cacheSize?: number;
  /** After a failed call, no query embedding is attempted for this long (default 30 s) so search stays fast. */
  cooldownMs?: number;
  fetch?: FetchLike;
  log?: (line: string) => void;
}

/**
 * Optional semantic search: item vectors computed in the background, one query vector per search.
 * Every failure path degrades to plain keyword search; nothing here can block ingest or a reply.
 */
export class Semantic {
  private embedder: Embedder | undefined;
  private floorOverride: number | undefined;
  private readonly queue = new Set<number>();
  private running: Promise<void> | null = null;
  private retryAt = 0;
  private failures = 0;
  private timer: NodeJS.Timeout | undefined;
  private coolUntil = 0;
  private readonly cache = new Map<string, Float32Array>();
  private readonly opts: Required<Omit<SemanticOptions, "fetch" | "log">> & Pick<SemanticOptions, "fetch" | "log">;
  private generation = 0;

  constructor(private readonly store: Store, opts: SemanticOptions = {}) {
    this.opts = { queryTimeoutMs: 1500, batch: 16, cacheSize: 200, cooldownMs: 30_000, ...opts };
    store.onIndexed = (id) => this.enqueue(id);
  }

  /** True once configure() has run (the server started it); reconfigure() then keeps it in step with the settings. */
  configured = false;

  get enabled(): boolean { return !!this.embedder; }
  get label(): string { return this.embedder?.label ?? "off"; }
  /** Cosine similarity a vector-only hit needs to join a search (setting, else the model's default). */
  get floor(): number { return this.floorOverride ?? this.embedder?.floor ?? DEFAULT_FLOOR; }

  /** Cards like this one: vectors need to be this similar (0.15 stricter than a search hit). */
  related(id: number, limit = 5): { id: number; name: string }[] {
    return this.store.related(id, limit, this.floor + 0.15);
  }

  /** (Re)read settings; returns the startup line. Safe to call again when the settings page saves. */
  async configure(env: NodeJS.ProcessEnv): Promise<string> {
    this.configured = true;
    let embedder: Embedder | undefined;
    let problem = "";
    try { embedder = await createEmbedder(env, this.opts.fetch ? { fetch: this.opts.fetch } : {}); }
    catch (e) { if (!(e instanceof EmbedConfigError)) throw e; problem = e.message; }
    const f = Number(env.DRIFTNET_EMBED_FLOOR);
    this.floorOverride = env.DRIFTNET_EMBED_FLOOR && f > 0 && f < 1 ? f : undefined;
    // Saving an unrelated setting must not throw away the cache or restart the backfill.
    if (embedder?.label !== this.embedder?.label || embedder?.model !== this.embedder?.model) this.use(embedder);
    return embedder
      ? `semantic search: on (${embedder.label}${embedder.local ? ", local" : ""}); ${this.store.vectors.count()} items embedded, the rest in the background`
      : `semantic search: off${problem ? ` (${problem})` : (env.DRIFTNET_EMBED ?? "auto").toLowerCase() === "off" ? "" : " (no local embedding model found; see README \"Search by meaning\")"}`;
  }

  /** Install an embedder (tests, plugins). Vectors of another model are dropped, then the backfill starts. */
  use(embedder: Embedder | undefined): void {
    this.embedder = embedder;
    this.generation++;
    this.cache.clear();
    this.queue.clear();
    this.coolUntil = 0; this.failures = 0; this.retryAt = 0;
    this.store.vectors.setModel(embedder?.model ?? null);
    if (!embedder) return;
    for (const id of this.store.vectors.missing(1_000_000)) this.queue.add(id);
    this.kick();
  }

  /** Queue one item for (re)embedding; a no-op when off. The text hash decides whether it is really embedded. */
  enqueue(id: number): void {
    if (!this.embedder) return;
    this.queue.add(id);
    this.kick();
  }

  /** Resolves when the queue is empty (or stalled by an error). For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private kick(): void {
    if (this.running || !this.queue.size || !this.embedder || Date.now() < this.retryAt) return;
    // setImmediate: never on the caller's stack, so ingest returns first.
    this.running = new Promise<void>((resolve) => setImmediate(() => { void this.drain().finally(() => { this.running = null; resolve(); this.kick(); }); }));
  }

  private async drain(): Promise<void> {
    const gen = this.generation;
    while (this.queue.size && this.embedder && gen === this.generation) {
      const embedder = this.embedder;
      const ids = [...this.queue].slice(0, this.opts.batch);
      const work: { id: number; text: string; hash: string }[] = [];
      for (const id of ids) {
        this.queue.delete(id);
        const item = this.store.get(id);
        if (!item) continue;
        const text = embedText(item, { includeNote: embedder.local });
        const hash = hashOf(embedder.model, text);
        const have = this.store.vectors.meta(id);
        if (have && have.model === embedder.model && have.hash === hash) continue; // text unchanged: nothing to compute
        work.push({ id, text, hash });
      }
      if (!work.length) continue;
      try {
        const vecs = await embedder.embed(work.map((w) => w.text), "document");
        if (gen !== this.generation) return;
        work.forEach((w, i) => this.store.vectors.put(w.id, embedder.model, w.hash, vecs[i]!));
        this.failures = 0;
      } catch (e) {
        if (gen !== this.generation) return;
        for (const w of work) this.queue.add(w.id);
        this.failures++;
        const wait = Math.min(600_000, 15_000 * 2 ** Math.min(this.failures, 6));
        this.retryAt = Date.now() + wait;
        this.opts.log?.(`semantic: embedding failed (${e instanceof Error ? e.message : "error"}); retrying in ${Math.round(wait / 1000)}s`);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.kick(), wait);
        this.timer.unref();
        return;
      }
    }
  }

  /**
   * The query's vector, or null when search should stay keyword-only: embeddings off, nothing embedded
   * yet, a very short query, a recent failure (cooldown), or the provider taking longer than the budget.
   * Repeated queries come from a small LRU and cost no call.
   */
  async queryVec(q: string): Promise<{ vec: Float32Array; floor: number } | null> {
    const embedder = this.embedder;
    const text = q.trim().slice(0, 200);
    if (!embedder || [...text].length < 2 || this.store.vectors.count() === 0) return null;
    const key = `${embedder.model}\n${text.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return { vec: hit, floor: this.floor }; }
    if (Date.now() < this.coolUntil) return null;
    const budget = this.opts.queryTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      const vec = await Promise.race([
        embedder.embed([text], "query", budget).then((v) => v[0]!),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), budget); }),
      ]);
      if (embedder !== this.embedder) return null;
      this.cache.set(key, vec);
      if (this.cache.size > this.opts.cacheSize) this.cache.delete(this.cache.keys().next().value!);
      return { vec, floor: this.floor };
    } catch {
      this.coolUntil = Date.now() + this.opts.cooldownMs;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
