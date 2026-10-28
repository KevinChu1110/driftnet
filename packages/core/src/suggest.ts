import type { Item, Suggestion } from "./types.ts";

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "your", "tools", "tool", "any", "anything", "into", "how", "are"]);

/** Lowercase words (Latin runs, and CJK characters as bigrams) worth matching on. */
function words(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9][a-z0-9+#.-]{1,}/g) ?? []) if (w.length > 2 && !STOP.has(w)) out.add(w);
  for (const run of lower.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/**
 * Folder suggestions without a model: overlap between a card's name and tags and
 * each folder's path and description (`choices` is Store.folderChoices). The
 * card's current folder, when it is a real one, always comes first. At most `limit`.
 */
export function keywordSuggestions(choices: Record<string, string>, card: { name: string; tags: string[]; current?: string }, limit = 3): Suggestion[] {
  const cardWords = words(`${card.name} ${card.tags.join(" ")}`);
  const scored: Suggestion[] = [];
  for (const [id, text] of Object.entries(choices)) {
    if (id === "other") continue;
    const folderWords = words(`${id.replace(/-/g, " ")} ${text}`);
    let hits = 0;
    for (const w of cardWords) if (folderWords.has(w)) hits++;
    if (hits) scored.push({ folder: id, score: Math.round((hits / Math.max(cardWords.size, 1)) * 100) / 100 });
  }
  scored.sort((a, b) => b.score - a.score);
  const first = card.current && card.current !== "other" && card.current in choices ? [{ folder: card.current, score: 1 }] : [];
  const rest = scored.filter((s) => s.folder !== card.current);
  return [...first, ...rest].slice(0, limit);
}

/** Clean model output: known folders only, no repeats, best first, at most `limit`, scores clamped to 0..1. */
export function cleanSuggestions(raw: unknown, known: (id: string) => boolean, limit = 3): Suggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: Suggestion[] = [];
  for (const s of raw) {
    const folder = typeof s?.folder === "string" ? s.folder : typeof s?.category === "string" ? s.category : "";
    const score = Number(s?.score);
    if (!folder || !known(folder) || out.some((o) => o.folder === folder)) continue;
    out.push({ folder, score: Number.isFinite(score) ? Math.round(Math.min(Math.max(score, 0), 1) * 100) / 100 : 0 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * What the Inbox offers for a card: the stored suggestions that still point at a folder
 * (`choices` is Store.folderChoices), or keyword overlap when there are none.
 */
export function suggestionsFor(item: Item, choices: Record<string, string>): Suggestion[] {
  const kept = (item.suggestions ?? []).filter((s) => s.folder in choices);
  if (kept.length) return kept;
  return keywordSuggestions(choices, { name: item.summary?.name ?? item.title, tags: item.summary?.tags ?? [], current: item.category });
}
