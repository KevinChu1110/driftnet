import { createHash } from "node:crypto";

/**
 * Embedding providers for optional semantic search. Embeddings are a different call from the
 * summarizer's, with their own (small) settings, and they are OFF unless a local endpoint answers or
 * the reader names a provider. Nothing here logs a key; the key only ever goes to the provider's fixed
 * host or to the base URL the reader typed.
 *
 *   openai  POST {base}/embeddings     OpenAI, and Ollama's OpenAI-compatible endpoint (…/v1), LM Studio…
 *   ollama  POST {base}/api/embed      Ollama's native API (local; no key)
 *   gemini  POST …:batchEmbedContents  Google's Gemini API (key in a header, never in the URL)
 */
export interface Embedder {
  /** Hash of (provider, base URL, local flag, model, key hash): lets configure() notice a changed key or endpoint. Never contains the key. */
  readonly fingerprint?: string;
  /** For the startup line and logs, e.g. "ollama:nomic-embed-text". Never contains a key. */
  readonly label: string;
  /** What the vector table records, so vectors of another model are dropped. */
  readonly model: string;
  /**
   * Cosine a vector-only search hit needs. Models differ a lot in how similar unrelated texts look:
   * measured with nomic-embed-text, unrelated cards score 0.43-0.52 and good matches 0.56-0.72.
   */
  readonly floor?: number;
  /** True when the endpoint is on this machine: then the reader's note may be embedded too. */
  readonly local: boolean;
  /** L2-normalised vectors, one per text. `kind` matters to models trained with query/document prompts. */
  embed(texts: string[], kind: "query" | "document", timeoutMs?: number): Promise<Float32Array[]>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_MODELS = { ollama: "nomic-embed-text", openai: "text-embedding-3-small", gemini: "gemini-embedding-001" } as const;
export const OLLAMA_URL = "http://127.0.0.1:11434";
const GEMINI_HOST = "https://generativelanguage.googleapis.com";
const GEMINI_DIMS = 768;

/** Starting point per model family; DRIFTNET_EMBED_FLOOR overrides it. Only nomic-embed-text was measured. */
export function defaultFloor(model: string): number {
  return /nomic/i.test(model) ? 0.55 : /text-embedding-3/i.test(model) ? 0.3 : /gemini/i.test(model) ? 0.5 : 0.4;
}

export function normalize(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

/** Exactly this machine: localhost, ::1, or a dotted 127.x.y.z (so 127.0.0.1.evil.com is not local). */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (h === "localhost" || h === "::1") return true;
    const m = /^127((?:\.\d{1,3}){3})$/.exec(h);
    return !!m && m[1]!.slice(1).split(".").every((o) => Number(o) <= 255);
  } catch {
    return false;
  }
}

/** What identifies an embedder's wiring: a change in any part (even the key) means a fresh embedder. The key is only hashed. */
const fingerprint = (provider: string, base: string, local: boolean, model: string, key = ""): string =>
  createHash("sha256").update([provider, base, local ? 1 : 0, model, createHash("sha256").update(key).digest("hex")].join("\n")).digest("hex");

/** nomic-embed-text is trained with task prefixes; without them quality drops noticeably. */
function prompt(model: string, kind: "query" | "document", text: string): string {
  return /nomic/i.test(model) ? `${kind === "query" ? "search_query" : "search_document"}: ${text}` : text;
}

async function post(fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // The body of an error can echo the request; keep a short status only.
  if (!res.ok) throw new Error(`embedding request failed: HTTP ${res.status}`);
  return res.json();
}

const asVectors = (rows: unknown, want: number): Float32Array[] => {
  if (!Array.isArray(rows) || rows.length !== want || rows.some((r) => !Array.isArray(r) || !r.length)) throw new Error("embedding reply has the wrong shape");
  return rows.map((r) => normalize(r as number[]));
};

export function openaiEmbedder(o: { baseUrl: string; model: string; apiKey?: string | undefined; fetch?: FetchLike }): Embedder {
  const base = o.baseUrl.replace(/\/+$/, "");
  const f = o.fetch ?? fetch;
  return {
    label: `openai:${o.model} @ ${new URL(base).host}`, model: o.model, fingerprint: fingerprint("openai", base, isLocalUrl(base), o.model, o.apiKey), floor: defaultFloor(o.model), local: isLocalUrl(base),
    async embed(texts, kind, timeoutMs = 30_000) {
      const data = (await post(f, `${base}/embeddings`, o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {},
        { model: o.model, input: texts.map((t) => prompt(o.model, kind, t)), encoding_format: "float" }, timeoutMs)) as { data?: { index?: number; embedding?: number[] }[] };
      const rows = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
      return asVectors(rows, texts.length);
    },
  };
}

export function ollamaEmbedder(o: { baseUrl: string; model: string; fetch?: FetchLike }): Embedder {
  const base = o.baseUrl.replace(/\/+$/, "");
  const f = o.fetch ?? fetch;
  return {
    label: `ollama:${o.model}`, model: o.model, fingerprint: fingerprint("ollama", base, isLocalUrl(base), o.model), floor: defaultFloor(o.model), local: isLocalUrl(base),
    async embed(texts, kind, timeoutMs = 30_000) {
      const data = (await post(f, `${base}/api/embed`, {}, { model: o.model, input: texts.map((t) => prompt(o.model, kind, t)) }, timeoutMs)) as { embeddings?: number[][] };
      return asVectors(data.embeddings, texts.length);
    },
  };
}

export function geminiEmbedder(o: { apiKey: string; model: string; fetch?: FetchLike }): Embedder {
  const f = o.fetch ?? fetch;
  return {
    label: `gemini:${o.model}`, model: o.model, fingerprint: fingerprint("gemini", GEMINI_HOST, false, o.model, o.apiKey), floor: defaultFloor(o.model), local: false,
    async embed(texts, kind, timeoutMs = 30_000) {
      const data = (await post(f, `${GEMINI_HOST}/v1beta/models/${encodeURIComponent(o.model)}:batchEmbedContents`, { "x-goog-api-key": o.apiKey }, {
        requests: texts.map((t) => ({
          model: `models/${o.model}`, content: { parts: [{ text: t }] },
          taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT", outputDimensionality: GEMINI_DIMS,
        })),
      }, timeoutMs)) as { embeddings?: { values?: number[] }[] };
      return asVectors((data.embeddings ?? []).map((e) => e.values), texts.length);
    },
  };
}

export class EmbedConfigError extends Error {}

/** Where a local Ollama would be: the LLM base URL when that is loopback (minus /v1), else the default port. */
function localCandidates(env: NodeJS.ProcessEnv): string[] {
  const llm = env.DRIFTNET_LLM_BASE_URL?.trim().replace(/\/+(v1)?\/*$/, "");
  return [...new Set([...(llm && isLocalUrl(llm) ? [llm] : []), OLLAMA_URL])];
}

/**
 * Settings → an embedder, or undefined when semantic search is off.
 *   DRIFTNET_EMBED            off | auto (default)
 *   DRIFTNET_EMBED_PROVIDER   openai | ollama | gemini — naming one turns it on
 *   DRIFTNET_EMBED_MODEL      default per provider (nomic-embed-text, text-embedding-3-small, gemini-embedding-001)
 *   DRIFTNET_EMBED_BASE_URL   openai/ollama endpoint; DRIFTNET_EMBED_API_KEY its key
 * The summarizer's key and base URL are reused only for the SAME vendor (an Anthropic key is never sent
 * to OpenAI). With no provider named, auto mode asks a local Ollama (1 s) whether it has the model.
 */
export async function createEmbedder(env: NodeJS.ProcessEnv, opts: { fetch?: FetchLike } = {}): Promise<Embedder | undefined> {
  const mode = (env.DRIFTNET_EMBED ?? "auto").trim().toLowerCase();
  if (mode === "off") return undefined;
  const f = opts.fetch ?? fetch;
  const named = env.DRIFTNET_EMBED_PROVIDER?.trim().toLowerCase();
  const llm = env.DRIFTNET_LLM_PROVIDER?.trim().toLowerCase();
  const model = (d: string) => env.DRIFTNET_EMBED_MODEL?.trim() || d;
  const withBase = (v: { fetch?: FetchLike }) => (opts.fetch ? { ...v, fetch: opts.fetch } : v);

  if (named === "gemini") {
    const key = env.DRIFTNET_EMBED_API_KEY || (llm === "gemini" ? env.DRIFTNET_LLM_API_KEY : "") || env.GEMINI_API_KEY;
    if (!key) throw new EmbedConfigError("DRIFTNET_EMBED_PROVIDER=gemini needs DRIFTNET_EMBED_API_KEY (or the Gemini summarizer's key)");
    return geminiEmbedder({ apiKey: key, model: model(DEFAULT_MODELS.gemini), ...withBase({}) });
  }
  if (named === "openai") {
    const sameVendor = llm === "openai";
    const baseUrl = env.DRIFTNET_EMBED_BASE_URL?.trim() || (sameVendor ? env.DRIFTNET_LLM_BASE_URL?.trim() : "") || "https://api.openai.com/v1";
    const key = env.DRIFTNET_EMBED_API_KEY || (sameVendor ? env.DRIFTNET_LLM_API_KEY : "");
    if (!key && !isLocalUrl(baseUrl)) throw new EmbedConfigError("DRIFTNET_EMBED_PROVIDER=openai needs DRIFTNET_EMBED_API_KEY (a local base URL needs none)");
    return openaiEmbedder({ baseUrl, model: model(DEFAULT_MODELS.openai), apiKey: key || undefined, ...withBase({}) });
  }
  if (named === "ollama") {
    return ollamaEmbedder({ baseUrl: env.DRIFTNET_EMBED_BASE_URL?.trim() || localCandidates(env)[0]!, model: model(DEFAULT_MODELS.ollama), ...withBase({}) });
  }
  if (named) throw new EmbedConfigError(`Unknown DRIFTNET_EMBED_PROVIDER=${named} (expected openai, ollama or gemini)`);

  // auto: only a local endpoint that already has the model switches it on.
  const want = model(DEFAULT_MODELS.ollama);
  for (const base of env.DRIFTNET_EMBED_BASE_URL && isLocalUrl(env.DRIFTNET_EMBED_BASE_URL) ? [env.DRIFTNET_EMBED_BASE_URL.replace(/\/+$/, "")] : localCandidates(env)) {
    try {
      const res = await f(`${base}/api/tags`, { method: "GET", signal: AbortSignal.timeout(1000) });
      if (!res.ok) continue;
      const { models } = (await res.json()) as { models?: { name?: string }[] };
      if (models?.some((m) => m.name === want || m.name === `${want}:latest` || m.name?.startsWith(`${want}:`))) {
        return ollamaEmbedder({ baseUrl: base, model: want, ...withBase({}) });
      }
    } catch { /* nothing local answered */ }
  }
  return undefined;
}
