import type { Digest } from "../types.ts";
import { clip, fetchText } from "./http.ts";
import { extractUrls } from "../url.ts";

const README_BUDGET = 2500;

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
    archived: boolean;
  };

  const readmeRes = await fetchText(`${api}/readme`, {
    headers: { ...headers, accept: "application/vnd.github.raw+json" },
  });
  const readme = readmeRes.status === 200 ? cleanReadme(readmeRes.body) : "";

  return {
    url: `https://github.com/${repo.full_name}`.toLowerCase(),
    kind: "repo",
    title: repo.full_name,
    text: [repo.description ?? "", clip(readme, README_BUDGET)].filter(Boolean).join("\n\n"),
    outlinks: repo.homepage ? extractUrls(repo.homepage) : [],
    meta: {
      stars: repo.stargazers_count,
      language: repo.language ?? "",
      topics: (repo.topics ?? []).join(","),
      license: repo.license?.spdx_id ?? "",
      pushedAt: repo.pushed_at.slice(0, 10),
      ...(repo.archived ? { archived: "yes" } : {}),
    },
  };
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
export async function findGithubRepo(name: string): Promise<string | null> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = norm(name);
  if (want.length < 3) return null;
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const q = encodeURIComponent(`${name} in:name`);
  const res = await fetchText(`https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=5`, { headers });
  if (res.status !== 200) return null;
  const { items } = JSON.parse(res.body) as { items: { full_name: string; name: string; stargazers_count: number }[] };
  const hit = items.find((r) => norm(r.name) === want && r.stargazers_count >= 5);
  return hit ? `https://github.com/${hit.full_name}`.toLowerCase() : null;
}
