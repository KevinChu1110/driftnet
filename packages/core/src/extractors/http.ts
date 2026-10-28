import { BlockedUrl, safeFetch } from "./net.ts";

export interface FetchResult {
  status: number;
  url: string;
  /** Lower-cased media type without parameters, e.g. "text/html". */
  contentType: string;
  /** Empty for non-text responses (PDF, video, images): never parsed as text. */
  body: string;
}

/**
 * Text is text/*, any JSON or XML flavour (GitHub's README endpoint answers
 * application/vnd.github.raw+json), or anything that declares a charset.
 * Binaries (PDF, video, images) do none of these.
 */
function isTextual(header: string): boolean {
  const type = header.split(";")[0]!.trim().toLowerCase();
  return /^text\//.test(type) || /[/+](json|xml|javascript)$/.test(type) || /;\s*charset=/i.test(header);
}

const UA =
  "Mozilla/5.0 (compatible; driftnet/0.1; +https://github.com/KevinChu1110/driftnet)";
const MAX_BYTES = 1_500_000;

export async function fetchText(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<FetchResult> {
  try {
    return await fetchOnce(url, init);
  } catch (err) {
    // Links are canonicalised to https; some sites still only speak http.
    if (err instanceof BlockedUrl || !url.startsWith("https://")) throw err;
    return fetchOnce("http://" + url.slice("https://".length), init);
  }
}

async function fetchOnce(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<FetchResult> {
  const res = await safeFetch(url, {
    headers: { "user-agent": UA, "accept-language": "zh-TW,en;q=0.8", ...init.headers },
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
  });
  const header = res.headers.get("content-type") ?? "text/html";
  const contentType = header.split(";")[0]!.trim().toLowerCase();
  // A PDF or a video is not text: reading it would feed binary to the model.
  if (!isTextual(header)) {
    await res.body?.cancel();
    return { status: res.status, url: res.url, contentType, body: "" };
  }
  // Read at most MAX_BYTES; some "articles" are 20 MB single-page apps.
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return { status: res.status, url: res.url, contentType, body: Buffer.concat(chunks).toString("utf8") };
}

export function metaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0];
    const key = /(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const value = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && value && !(key in out)) out[key] = decodeEntities(value);
  }
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  if (title && !out["title"]) out["title"] = decodeEntities(title.trim());
  return out;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&(middot|bull|mdash|ndash|hellip|lsquo|rsquo|ldquo|rdquo|copy|reg|trade|laquo|raquo);/g, (_, n: string) =>
      ({ middot: "·", bull: "•", mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
         copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»" })[n]!)
    .replace(/&amp;/g, "&");
}

