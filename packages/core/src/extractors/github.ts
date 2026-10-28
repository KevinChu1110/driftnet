import type { Digest, MediaRef } from "../types.ts";
import { decodeEntities, fetchText, metaTags } from "./http.ts";
import { digestBudget, outlineMarkdown } from "../digest.ts";
import { mediaKindOf, normalizeMedia } from "../media.ts";
import { extractUrls } from "../url.ts";


export function matchGithub(url: string): { owner: string; repo: string } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/?#]+)/.exec(url);
  if (!m || ["orgs", "topics", "collections", "sponsors", "features"].includes(m[1]!)) return null;
  return { owner: m[1]!, repo: m[2]! };
}

export async function extractGithub(url: string): Promise<Digest | null> {
  const ref = matchGithub(url);
  if (!ref) return null;
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const api = `https://api.github.com/repos/${ref.owner}/${ref.repo}`;
  const repoRes = await fetchText(api, { headers });
  if (repoRes.status !== 200) return null;
  const repo = JSON.parse(repoRes.body) as {
    full_name: string; description: string | null; stargazers_count: number; language: string | null;
    topics?: string[]; homepage: string | null; pushed_at: string; license?: { spdx_id: string } | null;
    archived: boolean; default_branch?: string;
  };

  const readmeRes = await fetchText(`${api}/readme`, {
    headers: { ...headers, accept: "application/vnd.github.raw+json" },
  });
  const raw = readmeRes.status === 200 ? readmeRes.body : "";
  const readme = cleanReadme(raw);
  const media = readmeImages(raw, ref.owner, ref.repo, repo.default_branch ?? "HEAD");
  // No pictures in the README: the repo's own social preview (GitHub's generic card is low value, so last and alone).
  if (!media.length) {
    const og = await repoSocialImage(`https://github.com/${repo.full_name}`).catch(() => null);
    if (og) media.push({ url: og, kind: "image", alt: "" });
  }

  return {
    url: `https://github.com/${repo.full_name}`.toLowerCase(),
    kind: "repo",
    title: repo.full_name,
    text: [repo.description ?? "", outlineMarkdown(readme, digestBudget())].filter(Boolean).join("\n\n"),
    outlinks: repo.homepage ? extractUrls(repo.homepage) : [],
    meta: {
      stars: repo.stargazers_count,
      language: repo.language ?? "",
      topics: (repo.topics ?? []).join(","),
      license: repo.license?.spdx_id ?? "",
      pushedAt: repo.pushed_at.slice(0, 10),
      ...(repo.archived ? { archived: "yes" } : {}),
    },
    media,
  };
}

async function repoSocialImage(pageUrl: string): Promise<string | null> {
  const page = await fetchText(pageUrl);
  if (page.status !== 200) return null;
  const og = metaTags(page.body)["og:image"];
  return og && /^https?:\/\//i.test(og) ? og : null;
}

const BADGE_HOSTS = /(^|\.)(shields\.io|badge\.fury\.io|badgen\.net|travis-ci\.(org|com)|codecov\.io|coveralls\.io|circleci\.com|buymeacoffee\.com|ko-fi\.com|liberapay\.com|opencollective\.com|sonarcloud\.io|snyk\.io|bestpractices\.dev|app\.fossa\.com|api\.codacy\.com|readthedocs\.org|visitor-badge\.[\w.]+|hits\.seeyoufarm\.com|komarev\.com|api\.star-history\.com)$/i;
const BADGE_PATH = /badge|sponsor|buy-?me-?a-?coffee|donate|\/workflows\/.*\.svg|favicon|\/avatars?\//i;

/**
 * Pictures and GIFs a README shows, in order: markdown ![](x) and <img src>.
 * Relative paths resolve against raw.githubusercontent.com; badges, sponsor
 * buttons, SVGs (never proxied) and tiny icons are dropped. At most 6.
 */
export function readmeImages(md: string, owner: string, repo: string, branch: string): MediaRef[] {
  const text = md.replace(/<!--[\s\S]*?-->/g, "").replace(/```[\s\S]*?```/g, "");
  const found: { at: number; src: string; alt: string; w?: number; h?: number }[] = [];
  for (const m of text.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*)?\)/g)) found.push({ at: m.index!, src: m[2]!, alt: m[1]! });
  for (const m of text.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    const num = (k: string) => { const v = new RegExp(`\\b${k}\\s*=\\s*["']?(\\d+)(?!%)`, "i").exec(tag)?.[1]; return v ? Number(v) : undefined; };
    found.push({ at: m.index!, src: decodeEntities(src), alt: decodeEntities(/\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? ""), w: num("width"), h: num("height") });
  }
  found.sort((a, b) => a.at - b.at);
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/`;
  const out: MediaRef[] = [];
  for (const f of found) {
    if ((f.w !== undefined && f.w < 64) || (f.h !== undefined && f.h < 64)) continue;
    let url: string;
    try {
      url = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(f.src) ? new URL(f.src, "https://x/").href : new URL(f.src.replace(/^\.?\//, ""), base).href;
    } catch { continue; }
    // github.com/o/r/blob/main/x.png is an HTML page; /raw/ redirects to the file.
    url = url.replace(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/blob\//, "$1/raw/");
    if (!/^https?:\/\//.test(url)) continue;
    const u = new URL(url);
    if (BADGE_HOSTS.test(u.hostname) || BADGE_PATH.test(u.pathname) || /\.svg$/i.test(u.pathname)) continue;
    out.push({ url, kind: mediaKindOf(url), alt: f.alt.trim() });
  }
  return normalizeMedia(out);
}

/**
 * READMEs open with badges, logos and HTML. None of it helps the model, all of it
 * costs tokens.
 */
export function cleanReadme(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(picture|img|source|br|p|div|a|h\d)[^>]*>|<\/(picture|p|div|a|h\d)>/gi, "")
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "") // linked badges
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // keep link text only
    .replace(/```[\s\S]*?```/g, (block) => (block.length > 400 ? "```…```" : block))
    .replace(/^\s*[-*]\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Posts often name an open-source project without linking it ("link in comments").
 * GitHub search is free and good enough when the name is distinctive; we only
 * accept a hit whose repo name actually matches, to avoid confident wrong links.
 */
/**
 * Name → repo answers, kept for a day. Unauthenticated search allows only 10
 * requests a minute, and roundups name the same tools again and again.
 */
const repoByName = new Map<string, { at: number; repo: string | null }>();
const DAY = 86_400_000;

export async function findGithubRepo(name: string): Promise<string | null> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = norm(name);
  if (want.length < 3) return null;
  const hit = repoByName.get(want);
  if (hit && Date.now() - hit.at < DAY) return hit.repo;
  const repo = await searchGithubRepo(name, want, norm);
  // Remember misses too, but not failures (rate limit, network): those may work later.
  if (repo !== undefined) {
    if (repoByName.size > 5000) repoByName.clear();
    repoByName.set(want, { at: Date.now(), repo });
  }
  return repo ?? null;
}

async function searchGithubRepo(name: string, want: string, norm: (s: string) => string): Promise<string | null | undefined> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const q = encodeURIComponent(`${name} in:name`);
  const res = await fetchText(`https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=5`, { headers });
  if (res.status !== 200) {
    if (res.status === 403 || res.status === 429) console.warn("[driftnet] GitHub search rate-limited; set GITHUB_TOKEN to raise the limit");
    return undefined;
  }
  const { items } = JSON.parse(res.body) as { items: { full_name: string; name: string; stargazers_count: number }[] };
  const hit = items.find((r) => norm(r.name) === want && r.stargazers_count >= 5);
  return hit ? `https://github.com/${hit.full_name}`.toLowerCase() : null;
}
