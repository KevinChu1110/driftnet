import type { Digest, Kind, MediaRef } from "../types.ts";
import { decodeEntities, fetchText, metaTags } from "./http.ts";
import { mediaKindOf, normalizeMedia } from "../media.ts";
import { clipTokens, digestBudget, outlineHtml } from "../digest.ts";
import { canonicalize, extractUrls, hostOf } from "../url.ts";


/** Sites that hide the post behind a login wall for anonymous fetches. */
const SOCIAL_HOSTS = [
  "threads.net", "threads.com", "facebook.com", "fb.watch", "instagram.com", "x.com", "twitter.com",
  "linkedin.com", "tiktok.com", "xiaohongshu.com", "xhslink.com", "douyin.com", "iesdouyin.com",
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
  // Redirected to a login wall: the page tells us nothing, and its URL is not
  // the item's URL. Keep the shared one so a browser capture can fill it in.
  if (isLoginWall(page.url)) {
    return { url, kind: isSocial(url) ? "post" : "other", title: hostOf(url), text: "", outlinks: [], meta: { site: hostOf(url) } };
  }
  if (!page.body) {
    // Not a web page: a PDF, a video file, an image. Name it after the file.
    const file = decodeURIComponent(new URL(page.url).pathname.split("/").filter(Boolean).pop() ?? "") || hostOf(url);
    const kind: Kind = page.contentType.startsWith("video/") ? "video" : page.contentType === "application/pdf" ? "article" : "other";
    return { url: canonicalize(page.url) ?? url, kind, title: file, text: "", outlinks: [], meta: { site: hostOf(url), type: page.contentType } };
  }
  const meta = metaTags(page.body);
  const social = isSocial(url);
  // Facebook/Instagram put the full caption in og:title (prefixed with view counts)
  // and a truncated copy in og:description.
  const caption = (meta["og:title"] ?? "").replace(/^[^|]*(?:views|觀看|reactions|心情)[^|]*\|\s*/i, "");
  const short = meta["og:description"] ?? meta["description"] ?? "";
  const description = social && caption.length > short.length ? caption : short;
  // Social pages are login walls apart from their meta caption; others get an outline.
  const budget = digestBudget();
  const lead = clipTokens(description, Math.floor(budget / 3));
  const body = social ? "" : outlineHtml(page.body, budget - (lead ? Math.ceil(lead.length / 2) : 0));
  const text = [lead, body].filter(Boolean).join("\n\n");

  const kind: Kind = social
    ? (meta["og:type"]?.startsWith("video") ? "video" : "post")
    : meta["og:type"]?.startsWith("video") ? "video"
    : meta["og:type"] === "article" ? "article"
    : "product";

  return {
    url: canonicalize(page.url) ?? url,
    kind,
    title: firstLine(social ? caption || short : meta["og:title"] ?? meta["twitter:title"] ?? meta["title"] ?? "") || hostOf(url),
    text,
    outlinks: [...new Set([...extractUrls(text), ...(social ? [] : contentLinks(page.body, page.url))])]
      .filter((u) => hostOf(u) !== hostOf(url))
      .slice(0, 10),
    meta: { site: meta["og:site_name"] ?? hostOf(url) },
    media: pageImages(page.body, page.url, meta, kind === "video", social),
  };
}

const JUNK_IMG = /logo|icon|avatar|sprite|pixel|tracking|spacer|badge|emoji|favicon|1x1|blank/i;

/** og:image / twitter:image first, then (articles only) the first couple of large pictures in the body. */
export function pageImages(html: string, base: string, meta: Record<string, string>, video: boolean, social: boolean): MediaRef[] {
  const abs = (src: string): string | null => {
    try {
      const u = new URL(decodeEntities(src.trim()), base);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch { return null; }
  };
  const out: MediaRef[] = [];
  for (const key of ["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"]) {
    const url = meta[key] ? abs(meta[key]!) : null;
    if (url) out.push({ url, kind: video ? "video" : mediaKindOf(url), alt: meta["og:image:alt"] ?? meta["twitter:image:alt"] ?? "" });
  }
  if (!social) {
    const main = /<(article|main)[\s>][\s\S]*?<\/\1>/i.exec(html)?.[0] ?? "";
    const body = main.replace(/<(nav|header|footer|aside|script|style)[\s>][\s\S]*?<\/\1>/gi, " ");
    let n = 0;
    for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
      const tag = m[0];
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (!src || src.startsWith("data:") || JUNK_IMG.test(src)) continue;
      const dim = (k: string) => Number(new RegExp(`\\b${k}\\s*=\\s*["']?(\\d+)`, "i").exec(tag)?.[1] ?? NaN);
      const w = dim("width"), h = dim("height");
      if (w < 300 || h < 150) continue; // unknown size (NaN) passes
      const url = abs(src);
      if (url) {
        out.push({ url, kind: mediaKindOf(url), alt: decodeEntities(/\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "") });
        if (++n >= 2) break;
      }
    }
  }
  return normalizeMedia(out);
}

/** Links inside the main content (not nav, header, footer, sidebars), absolute and canonical. */
function contentLinks(html: string, base: string): string[] {
  const main =
    /<(article|main)[\s>][\s\S]*?<\/\1>/i.exec(html)?.[0] ?? /<body[\s>][\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
  const body = main.replace(/<(nav|header|footer|aside|script|style)[\s>][\s\S]*?<\/\1>/gi, " ");
  const out: string[] = [];
  for (const m of body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    try {
      const u = canonicalize(new URL(decodeEntities(m[1]!), base).href);
      if (u) out.push(u);
    } catch {
      // relative junk, javascript: links
    }
  }
  return out;
}

export function isLoginWall(url: string): boolean {
  try {
    return /^\/(login|signin|sign-in|accounts\/login|i\/flow\/login|checkpoint)(\.php)?(\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function firstLine(s: string): string {
  const line = s.split("\n")[0]!.trim();
  return line.length > 120 ? line.slice(0, 117) + "…" : line;
}
