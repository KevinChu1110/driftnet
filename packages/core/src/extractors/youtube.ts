import type { Digest } from "../types.ts";
import { clip, fetchText, metaTags } from "./http.ts";
import { extractUrls } from "../url.ts";

const DESCRIPTION_BUDGET = 1500;

export function matchYoutube(url: string): string | null {
  return /^https:\/\/youtube\.com\/watch\?(?:.*&)?v=([\w-]{6,})/.exec(url)?.[1] ?? null;
}

// TODO(contrib): pull captions for videos with a short description — the tool
// name is often only spoken, never written.
export async function extractYoutube(url: string): Promise<Digest | null> {
  const id = matchYoutube(url);
  if (!id) return null;
  const page = await fetchText(`https://www.youtube.com/watch?v=${id}`);
  if (page.status !== 200) return null;
  const meta = metaTags(page.body);
  // The full description lives in the player JSON; meta only has the first ~160 chars.
  const full = /"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(page.body)?.[1];
  const description = full ? (JSON.parse(`"${full}"`) as string) : meta["og:description"] ?? "";
  const channel = /"ownerChannelName":"((?:[^"\\]|\\.)*)"/.exec(page.body)?.[1] ?? "";

  return {
    url: `https://youtube.com/watch?v=${id}`,
    kind: "video",
    title: meta["og:title"] ?? meta["title"] ?? id,
    text: clip(description, DESCRIPTION_BUDGET),
    outlinks: extractUrls(description).filter((u) => !u.includes("youtube.com")).slice(0, 10),
    meta: { channel },
  };
}
