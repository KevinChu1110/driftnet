const URL_RE = /https?:\/\/[^\s<>"'）)\]}，。、]+/giu;

/** Query params that only track who shared what; dropping them makes dedup work. */
const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "igshid", "igsh", "si", "feature", "ref", "ref_src", "ref_url",
  "mibextid", "rdid", "share_url", "fs", "xmt", "slof", "s", "t",
]);

export function extractUrls(text: string): string[] {
  // Pasting several links without spaces glues them together ("…?x=1https://…").
  const found = (text.match(URL_RE) ?? []).flatMap((m) => m.split(/(?=https?:\/\/)/));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of found) {
    const url = canonicalize(raw.replace(/[.,;:!?]+$/, ""));
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/**
 * Normalises a URL so the same resource shared from different apps maps to one
 * cache key. Returns null for anything that is not http(s).
 */
export function canonicalize(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  u.protocol = "https:";
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");

  for (const key of [...u.searchParams.keys()]) {
    if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) u.searchParams.delete(key);
  }

  // youtu.be/ID and youtube.com/shorts/ID → youtube.com/watch?v=ID
  if (u.hostname === "youtu.be") {
    const id = u.pathname.slice(1);
    return `https://youtube.com/watch?v=${id}`;
  }
  if (u.hostname === "youtube.com" && u.pathname.startsWith("/shorts/")) {
    return `https://youtube.com/watch?v=${u.pathname.split("/")[2]}`;
  }
  // github.com/owner/repo/tree/main/... → github.com/owner/repo
  if (u.hostname === "github.com") {
    const [owner, repo] = u.pathname.split("/").filter(Boolean);
    if (owner && repo) return `https://github.com/${owner}/${repo.replace(/\.git$/, "")}`.toLowerCase();
  }
  // threads.net and threads.com are the same site
  if (u.hostname === "threads.com") u.hostname = "threads.net";

  u.searchParams.sort();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
