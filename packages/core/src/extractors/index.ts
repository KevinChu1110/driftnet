import type { Digest } from "../types.ts";
import { extractGithub, matchGithub } from "./github.ts";
import { extractWeb } from "./web.ts";
import { extractYoutube, matchYoutube } from "./youtube.ts";
import { BlockedUrl } from "./net.ts";

export { BlockedUrl } from "./net.ts";

export { isSocial } from "./web.ts";
export { cleanReadme } from "./github.ts";

export interface Extractor {
  name: string;
  matches(url: string): boolean;
  extract(url: string): Promise<Digest | null>;
}

/**
 * Extractors are tried in order; the first match wins. Plug in your own (e.g. a
 * logged-in browser for Threads/Facebook) with `registerExtractor` — it goes
 * before the built-ins.
 */
const extractors: Extractor[] = [
  { name: "github", matches: (u) => matchGithub(u) !== null, extract: extractGithub },
  { name: "youtube", matches: (u) => matchYoutube(u) !== null, extract: extractYoutube },
  { name: "web", matches: () => true, extract: extractWeb },
];

export function registerExtractor(extractor: Extractor): void {
  extractors.unshift(extractor);
}

export async function extract(url: string): Promise<Digest> {
  for (const ex of extractors) {
    if (!ex.matches(url)) continue;
    try {
      const digest = await ex.extract(url);
      if (digest) return digest;
    } catch (err) {
      // A private/local target is refused outright, not catalogued as an empty item.
      if (err instanceof BlockedUrl) throw err;
      console.warn(`[driftnet] extractor ${ex.name} failed for ${url}:`, (err as Error).message);
    }
  }
  // Unreachable or blocked: still worth keeping, the chat note may explain it.
  return { url, kind: "other", title: url, text: "", outlinks: [], meta: {} };
}
