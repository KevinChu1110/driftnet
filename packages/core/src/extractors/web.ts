import type { Digest, Kind } from "../types.ts";
import { clip, fetchText, metaTags, visibleText } from "./http.ts";
import { canonicalize, extractUrls, hostOf } from "../url.ts";

const TEXT_BUDGET = 2000;

/** Sites that hide the post behind a login wall for anonymous fetches. */
const SOCIAL_HOSTS = [
  "threads.net", "facebook.com", "fb.watch", "instagram.com", "x.com", "twitter.com",
  "linkedin.com", "tiktok.com",
];

export function isSocial(url: string): boolean {
  const host = hostOf(url);
  return SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Generic page: meta tags + visible text. For social sites the anonymous page is
 * usually a login wall, but og:description often still carries the post text —
 * and the user's own chat note fills the rest.
 */
export async function extractWeb(url: string): Promise<Digest | null> {
  const page = await fetchText(url);
  if (page.status >= 400) return null;
  const meta = metaTags(page.body);
  const social = isSocial(url);
  // Facebook/Instagram put the full caption in og:title (prefixed with view counts)
  // and a truncated copy in og:description.
  const caption = (meta["og:title"] ?? "").replace(/^[^|]*(?:views|觀看|reactions|心情)[^|]*\|\s*/i, "");
  const short = meta["og:description"] ?? meta["description"] ?? "";
  const description = social && caption.length > short.length ? caption : short;
  const body = social ? "" : visibleText(page.body);
  const text = [description, body].filter(Boolean).join("\n\n");

  const kind: Kind = social
    ? (meta["og:type"]?.startsWith("video") ? "video" : "post")
    : meta["og:type"]?.startsWith("video") ? "video"
    : meta["og:type"] === "article" ? "article"
    : "product";

  return {
    url: canonicalize(page.url) ?? url,
    kind,
    title: firstLine(social ? caption || short : meta["og:title"] ?? meta["twitter:title"] ?? meta["title"] ?? "") || hostOf(url),
    text: clip(text, TEXT_BUDGET),
    outlinks: extractUrls(text).filter((u) => hostOf(u) !== hostOf(url)).slice(0, 10),
    meta: { site: meta["og:site_name"] ?? hostOf(url) },
  };
}

function firstLine(s: string): string {
  const line = s.split("\n")[0]!.trim();
  return line.length > 120 ? line.slice(0, 117) + "…" : line;
}
