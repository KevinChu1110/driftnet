import type { Digest, Kind, MediaRef } from "../types.ts";
import { decodeEntities, fetchText, metaTags } from "./http.ts";
import { mediaKindOf, normalizeMedia } from "../media.ts";
import { clipTokens, digestBudget, outlineHtml } from "../digest.ts";
import { canonicalize, extractUrls, hostOf } from "../url.ts";
import { attrs, bodyBlock, firstBlock, stripBlocks, Tags } from "../html.ts";


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

  // Facebook no longer puts the caption in og:title for anonymous readers; the slug of og:url still carries it.
  const fallbackTitle = social && !caption && !short && /(^|\.)facebook\.com$/.test(hostOf(url)) ? slugTitle(meta["og:url"]) : "";
  const kind: Kind = social
    ? (meta["og:type"]?.startsWith("video") ? "video" : "post")
    : meta["og:type"]?.startsWith("video") ? "video"
    : meta["og:type"] === "article" ? "article"
    : "product";

  return {
    url: canonicalize(page.url) ?? url,
    kind,
    title: firstLine(social ? caption || short || fallbackTitle : meta["og:title"] ?? meta["twitter:title"] ?? meta["title"] ?? "") || hostOf(url),
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
    const body = stripBlocks(firstBlock(html, ["article", "main"]) ?? "", SIDE_BLOCKS);
    const scan = new Tags(body);
    let n = 0;
    for (let t = scan.next(0); t; t = scan.next(t.end)) {
      if (t.closing || t.name !== "img") continue;
      const a = attrs(t.raw);
      const src = a["src"];
      if (!src || src.startsWith("data:") || JUNK_IMG.test(src)) continue;
      const w = pixels(a["width"]), h = pixels(a["height"]);
      if (w < 300 || h < 150) continue; // unknown size (NaN) passes
      const url = abs(src);
      if (url) {
        out.push({ url, kind: mediaKindOf(url), alt: decodeEntities(a["alt"] ?? "") });
        if (++n >= 2) break;
      }
    }
  }
  return normalizeMedia(out);
}

const SIDE_BLOCKS = ["nav", "header", "footer", "aside", "script", "style"];

/** The leading number of a width/height attribute ("640", "640px"); NaN when absent. */
const pixels = (v: string | undefined) => Number(/^\s*(\d+)/.exec(v ?? "")?.[1] ?? NaN);

/** Links inside the main content (not nav, header, footer, sidebars), absolute and canonical. */
function contentLinks(html: string, base: string): string[] {
  const body = stripBlocks(firstBlock(html, ["article", "main"]) ?? bodyBlock(html) ?? html, SIDE_BLOCKS);
  const out: string[] = [];
  const scan = new Tags(body);
  for (let t = scan.next(0); t; t = scan.next(t.end)) {
    if (t.closing || t.name !== "a") continue;
    const href = attrs(t.raw)["href"];
    if (!href || href.startsWith("#")) continue;
    try {
      const u = canonicalize(new URL(decodeEntities(href), base).href);
      if (u) out.push(u);
    } catch {
      // relative junk, javascript: links
    }
  }
  return out;
}

/**
 * The caption a Facebook og:url carries as a slug: ".../videos/1分鐘帶你看完本週-ai-大事/123/" → "1分鐘帶你看完本週 ai 大事".
 * Only a segment with hyphens or CJK counts; "videos", "reel" and ids do not.
 */
export function slugTitle(ogUrl: string | undefined): string {
  if (!ogUrl || !URL.canParse(ogUrl)) return "";
  const segments = new URL(ogUrl).pathname.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const slug = segments.filter((p) => /\p{L}/u.test(p) && /-|[぀-ヿ㐀-鿿가-힯]/u.test(p)).sort((a, b) => b.length - a.length)[0] ?? "";
  return slug.replace(/-+/g, " ").trim();
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
