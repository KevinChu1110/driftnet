import type { MediaRef } from "./types.ts";

export const MAX_MEDIA = 6;

/** Clean a candidate list: http(s) only, no duplicates, no SVG (never proxied), at most 6. */
export function normalizeMedia(list: unknown): MediaRef[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: MediaRef[] = [];
  for (const m of list as Partial<MediaRef>[]) {
    const url = typeof m?.url === "string" ? m.url.trim() : "";
    if (!url || url.length > 2000 || seen.has(url) || !/^https?:\/\//i.test(url)) continue;
    if (/\.svg(?:[?#]|$)/i.test(url)) continue;
    seen.add(url);
    const kind = m.kind === "gif" || m.kind === "video" ? m.kind : "image";
    out.push({ url, kind, alt: typeof m.alt === "string" ? m.alt.slice(0, 200) : "" });
    if (out.length >= MAX_MEDIA) break;
  }
  return out;
}

export function mediaKindOf(url: string): "image" | "gif" {
  return /\.gif(?:[?#]|$)/i.test(url) ? "gif" : "image";
}

/** The shape the page and API clients get: a proxy path, never the third-party URL. */
export interface PublicMedia { src: string; kind: MediaRef["kind"]; alt: string }

export function publicMedia(id: number, media: MediaRef[] | undefined): PublicMedia[] {
  return (media ?? []).map((m, i) => ({ src: `/api/media/${id}/${i}`, kind: m.kind, alt: m.alt }));
}

/** An item as served to clients: `media` becomes proxy paths. */
export function publicItem<T extends { id: number; media?: MediaRef[] }>(item: T): Omit<T, "media"> & { media: PublicMedia[] } {
  return { ...item, media: publicMedia(item.id, item.media) };
}
